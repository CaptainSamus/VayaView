import { useEffect, useRef, useState, type ReactNode } from "react";
import { serverNow } from "@/lib/server-clock";
import { useCompleteSync } from "@/lib/shared";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/cn";
import { durable } from "@/lib/durable";
import { isRemote, isTv, nativeHls } from "@/lib/remote";
import { formatDuration, formatStation, formatTime } from "@/lib/format";
import type { PlayRequest } from "@/lib/player/seam";
import { streamCues, type Cue } from "@/lib/player/subs";
import type { Airing, Channel } from "@/lib/schedule/types";
import type { Film, SubTrack } from "@/lib/library/types";
import { LiftFilter, videoFilter, type Adjust } from "./picture-adjust";

type PictureProps = {
  powered: boolean;
  channel: Channel | null;
  airing: Airing | null;
  film: Film | null;
  request: PlayRequest | null;
  digits: string;
  notice: string | null;
  /** Position of the chosen sound track among the file's audio streams. */
  audio: number;
  sub: SubTrack | null;
  /** This film's own black level, brightness and contrast. Absent or neutral: the picture as it is. */
  adjust?: Adjust;
  /** Small picture inside the guide. The guide shows the title, so the card stays off. */
  compact: boolean;
  /** Controls shown with the title card in full view. */
  toolbar?: ReactNode;
  /** Shown along the bottom of the card in full view. */
  footer?: ReactNode;
  /** Goes up each time the viewer scrubs or returns to live, so the picture jumps at once. */
  seekToken: number;
  onToggleView: () => void;
  /** On-demand play only: hold the picture still. */
  paused?: boolean;
  /**
   * On-demand play (the Streaming view). The video is its own clock: no rejoining a
   * wall clock, a click pauses instead of muting, and no station number is shown.
   * `request.offsetMs` is only where to start, and changes only on a seek.
   */
  onDemand?: { onTime: (ms: number) => void; onTogglePause: () => void; onEnded: () => void; onStream?: () => void; /** Complete Sync: where the film should be now (ms), to nudge the speed toward. */ targetMs?: () => number | null };
  /** A volume of its own (Music mode, src/lib/music-volume.ts) instead of the saved parlor.volume. */
  ownVolume?: { start: number; onChange: (volume: number) => void };
  className?: string;
};

/** How long the title card stays up once real frames are showing. */
const CARD_MS = 5000;

/** This phone page. Each tune gets its own stream under it, so an old stream's last pieces never mix into a new one. */
const HLS_SESSION = Math.random().toString(36).slice(2, 12);
let hlsTune = 0;

/**
 * Where a stream comes from. On the PC: the file, or one ffmpeg stream. On a phone
 * (an iPhone wants Apple's HLS format): the same choices, cut into HLS pieces.
 */
const safeFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

function streamUrl(mediaId: string, query: string): string {
  return nativeHls ? `/hls/${HLS_SESSION}-${++hlsTune}/${mediaId}/index.m3u8?${query}` : `/media/${mediaId}?${query}`;
}

/**
 * How the file reaches the screen, cheapest first.
 * 0 plays the file as it is. 1 keeps the picture and converts only the sound.
 * 2 re-encodes the picture too. A refusal moves one step down the list.
 */
type Level = 0 | 1 | 2;

/** Seconds a new piped stream is aimed ahead of the clock (it takes that long to start). Learned per device. */
function streamLead(kind: "copy" | "enc"): number {
  try {
    const saved = Number(localStorage.getItem(`vv.streamLead.${kind}`));
    if (saved > 0) return saved;
  } catch {
    // no storage
  }
  return (isRemote ? 0.9 : 0.4) * (kind === "enc" ? 2 : 1);
}
function learnLead(kind: "copy" | "enc", behind: number) {
  const next = Math.max(0.3, Math.min(5, streamLead(kind) + behind * 0.3));
  try {
    localStorage.setItem(`vv.streamLead.${kind}`, next.toFixed(2));
  } catch {
    // no storage
  }
}

export function Picture(props: PictureProps) {
  const { powered, channel, airing, film, request, digits, notice, audio, sub, adjust, compact, toolbar, footer, seekToken, onToggleView, paused = false, onDemand, ownVolume, className } = props;
  const ownVolumeRef = useRef(ownVolume);
  ownVolumeRef.current = ownVolume;
  const onDemandRef = useRef(onDemand);
  onDemandRef.current = onDemand;
  const station = channel ? formatStation(channel.number) : "--";
  const missing = request?.status === "missing";

  const videoRef = useRef<HTMLVideoElement>(null);
  // The clock owns the offset. The player only reads it when it tunes.
  const offsetRef = useRef(0);
  offsetRef.current = request?.offsetMs ?? 0;
  /** Seconds into the film where the current ffmpeg session began. 0 for direct play. */
  const baseRef = useRef(0);
  const cuesRef = useRef<Cue[]>([]);
  const [bump, setBump] = useState<{ key: string; level: Level } | null>(null);
  const [reload, setReload] = useState(0);
  /** The stream this player was last told to play. An error from any older one is old news. */
  const srcRef = useRef("");
  /** When the picture was last tuned, and to what, to notice fast flipping. */
  const lastTune = useRef({ key: "" as string | null, at: 0 });
  const retries = useRef(0);
  const [muted, setMuted] = useState(false);
  /** Muted by the viewer (M, the mute button, or Play/Pause on a TV remote), as opposed to by the browser. */
  const userMuted = useRef(false);
  /** Which tune the loaded stream belongs to. Until the new one starts, the old stream is still playing. */
  const streamKey = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [card, setCard] = useState(true);
  const [poke, setPoke] = useState(0);
  const lastPoke = useRef(0);
  const [line, setLine] = useState("");

  const mediaId = powered && request && request.status === "ready" && request.filePath ? request.mediaId : null;
  const tuneKey = mediaId && channel && airing ? `${channel.id}:${mediaId}:${airing.cycleIndex}:${airing.slotIndex}` : null;
  const burn = sub && !sub.text ? sub.key : null;
  // The 2018 Fire TV Stick 4K (AFTMM) garbles ANY 4K copy in the WebView (tested Dunkirk SDR, Arrival, Dune, Loki HDR; 2026-11-16), so on
  // such a box anything above 1080p is converted by the PC to 1080p (HDR toned down) instead of copied.
  const tvMax1080 = isTv && (/AFTMM/.test(navigator.userAgent) || safeFlag("vv.tvMax1080"));
  const canCopy = (film?.vcodec === "h264" || film?.vcodec === "hevc") && !(tvMax1080 && (film?.height ?? 0) > 1080);
  // A phone never plays the file directly (an iPhone cannot open MKV); it starts at the copy step.
  const startLevel: Level = burn != null ? 2 : !isRemote && film?.direct !== false && audio === 0 ? 0 : canCopy ? 1 : 2;
  const playKey = tuneKey ? `${tuneKey}:${audio}:${burn ?? ""}` : null;
  const level: Level = bump && bump.key === playKey && bump.level > startLevel ? bump.level : startLevel;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setFailed(false);
    if (!playKey || !mediaId) {
      video.removeAttribute("src");
      video.load();
      return;
    }
    let cancelled = false;
    const control = new AbortController();
    // Removed when this stream is replaced, so a late one can never seek the next stream (an ffmpeg
    // stream that is seeked starts over, at the cost of a second encode).
    const onLoaded: Array<() => void> = [];
    const whenLoaded = (fn: () => void) => {
      const once = () => {
        video.removeEventListener("loadedmetadata", once);
        if (!cancelled) fn();
      };
      onLoaded.push(once);
      video.addEventListener("loadedmetadata", once);
    };
    const begin = (src: string, base: number) => {
      if (cancelled) return;
      baseRef.current = base;
      srcRef.current = src;
      streamKey.current = playKey;
      onDemandRef.current?.onStream?.();
      // A TV has no way to click the picture, so it is never left muted by anything but the viewer.
      if (isTv && video.muted && !userMuted.current) {
        video.muted = false;
        setMuted(false);
      }
      video.src = src;
      if (nativeHls) {
        // A stream starts on the keyframe at or before the moment asked for. Skip ahead to the clock,
        // so the phone is not seconds behind the PC.
        whenLoaded(() => {
          const ahead = offsetRef.current / 1000 - baseRef.current;
          if (ahead > 0.5) video.currentTime = ahead;
        });
      }
      video.play().catch((error: unknown) => {
        // A play cut short by the next channel change is not a refusal. Only "sound not allowed before
        // the first click" is, and then the picture starts silent instead of black (never on a TV).
        if (cancelled || (error as DOMException)?.name !== "NotAllowedError") return;
        if (isTv) {
          window.setTimeout(() => !cancelled && video.play().catch(() => {}), 300);
          return;
        }
        video.muted = true;
        setMuted(true);
        video.play().catch(() => {});
      });
    };
    const go = () => {
      const start = offsetRef.current / 1000;
      const synced = onDemandRef.current?.targetMs?.() != null;
      if (level === 0) {
        whenLoaded(() => (video.currentTime = offsetRef.current / 1000));
        begin(`/media/${mediaId}`, 0);
      } else if (level === 1) {
        // A copied picture can only start on a keyframe. Ask which one, so subtitles and the clock stay honest.
        // No keyframe nearby means no honest starting point, so that file is re-encoded instead.
        // A channel change cancels the question, and the server stops ffprobe.
        // Live: aim where the clock will be once the stream is playing (about a second on a TV), and take the
        // nearest keyframe; if it lands ahead the picture waits on its first frame (see the step-keeping above).
        // A film under Complete Sync (targetMs answers) is aimed ahead the same way, so after a skip the
        // screens meet in ~2 s instead of ~10; a film watched alone starts exactly where asked.
        const aim = onDemandRef.current && !synced ? start : start + streamLead("copy");
        fetch(`/api/keyframe/${mediaId}?t=${aim.toFixed(2)}&near=1`, { signal: control.signal })
          .then((response) => response.json() as Promise<{ found: boolean; t: number; base: number }>)
          .catch(() => null)
          .then((body) => {
            if (cancelled) return;
            if (body?.found) kfGap.current = aim - body.t; // the keyframe's own distance from the aim (not start-up time)
            if (body?.found) begin(streamUrl(mediaId, `v=copy&a=${audio}&t=${body.t.toFixed(3)}`), body.base);
            else setBump({ key: playKey, level: 2 });
          });
      } else {
        // Encoding starts slower still; aimed ahead by its own learned lead (live, or a film under Complete Sync).
        const at = onDemandRef.current && !synced ? start : start + streamLead("enc");
        kfGap.current = 0;
        begin(streamUrl(mediaId, `v=enc&a=${audio}&t=${at.toFixed(2)}${burn != null ? `&burn=${burn}` : ""}`), at);
      }
    };
    // Flipping through stations: a station passed within a moment of the last is opened only once the
    // keys stop, so no stream is started for each one on the way.
    const quick = lastTune.current.key !== playKey && Date.now() - lastTune.current.at < 400;
    lastTune.current = { key: playKey, at: Date.now() };
    const timer = quick ? window.setTimeout(go, 300) : null;
    if (!quick) go();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      control.abort();
      for (const once of onLoaded) video.removeEventListener("loadedmetadata", once);
    };
  }, [playKey, mediaId, level, audio, burn, reload]);

  useEffect(() => {
    retries.current = 0;
  }, [playKey]);

  // On a TV nobody can click "try again": a station that would not play (the PC busy or restarting) is
  // tried again from the top every ten seconds until it does.
  useEffect(() => {
    if (!failed || !isTv) return;
    const timer = window.setTimeout(() => {
      setBump(null);
      setReload((value) => value + 1);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [failed]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onDemand) return;
    const time = () => {
      if (!video.seeking && video.readyState >= 2) onDemandRef.current?.onTime((baseRef.current + video.currentTime) * 1000);
    };
    const ended = () => onDemandRef.current?.onEnded();
    video.addEventListener("timeupdate", time);
    video.addEventListener("ended", ended);
    return () => {
      video.removeEventListener("timeupdate", time);
      video.removeEventListener("ended", ended);
    };
  }, [Boolean(onDemand)]);

  // Keeping every screen in step (2026-11-17). Four times a second: where should the picture be by the
  // PC's clock (serverNow), and where is it? Behind: play a little faster; ahead: a little slower; well
  // ahead (a new stream that began past the spot): hold the picture still until the clock reaches it.
  // Pitch is kept, and the change is in proportion to the gap, so it can't be heard.
  const airingRef = useRef(airing);
  airingRef.current = airing;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const playKeyRef = useRef(playKey);
  playKeyRef.current = playKey;
  const holdingRef = useRef(false);
  const learnedSrc = useRef("");
  const kfGap = useRef(0);
  const [syncOn] = useCompleteSync();
  // The "● Complete Sync" label only shows while the controls are up (user, 2026-11-17: not over a
  // full-screen film): the PC's card/toolbar (mouse), the TV's button bar, or a few seconds after any key.
  const [osdOpen, setOsdOpen] = useState(false);
  const [keyAwake, setKeyAwake] = useState(0);
  useEffect(() => {
    const html = document.documentElement;
    const read = () => setOsdOpen(html.classList.contains("tv-osd-open"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(html, { attributes: true, attributeFilter: ["class"] });
    let timer = 0;
    const onKey = () => {
      setKeyAwake(Date.now());
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setKeyAwake(0), CARD_MS);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(timer);
    };
  }, []);
  // Shown in the top-right corner while the picture is catching up (user: "I need to know when it is doing it").
  const [catching, setCatching] = useState<string | null>(null);
  const catchingRef = useRef<string | null>(null);
  const showCatching = (label: string | null) => {
    if (catchingRef.current === label) return;
    catchingRef.current = label;
    setCatching(label);
  };
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const timer = window.setInterval(() => {
      const release = () => {
        if (holdingRef.current) {
          holdingRef.current = false;
          if (!pausedRef.current) video.play().catch(() => {});
        }
        if (video.playbackRate !== 1) video.playbackRate = 1;
      };
      if (pausedRef.current || nativeHls || video.seeking || video.readyState < 2 || video.ended) {
        if (pausedRef.current) holdingRef.current = false;
        showCatching(null);
        return;
      }
      let target: number | null;
      if (onDemandRef.current) {
        const ms = onDemandRef.current.targetMs?.() ?? null;
        target = ms == null ? null : ms / 1000 - baseRef.current;
      } else {
        const on = airingRef.current;
        target = on && streamKey.current === playKeyRef.current ? (serverNow() - on.startedAtMs) / 1000 - baseRef.current : null;
      }
      if (target == null) {
        showCatching(null);
        return release();
      }
      const behind = target - video.currentTime;
      (window as unknown as { __vvBehind?: number }).__vvBehind = behind; // for checking sync over DevTools
      // Learn how long this device takes to start a piped stream: the first look at each new one says
      // whether the lead was too short (behind) or too long (ahead), and the next one is aimed better.
      const src = video.currentSrc;
      if (src !== learnedSrc.current && /[?&]v=(copy|enc)/.test(src) && Math.abs(behind) < 6) {
        learnedSrc.current = src;
        learnLead(src.includes("v=enc") ? "enc" : "copy", behind - kfGap.current);
      }
      if (behind < -0.25 && behind > -6) {
        // Ahead: wait here (the picture stays on this frame) until the clock catches up.
        if (!holdingRef.current) {
          holdingRef.current = true;
          video.pause();
        }
        showCatching("hold");
        return;
      }
      if (holdingRef.current) release();
      if (Math.abs(behind) > 6) return showCatching(null); // the player / reload handles big gaps
      const step = Math.max(-0.15, Math.min(0.3, behind * 0.5));
      const rate = Math.abs(behind) < 0.025 ? 1 : behind > 1.5 ? 1.5 : Math.round((1 + Math.sign(step) * Math.max(0.02, Math.abs(step))) * 100) / 100;
      if (Math.abs(video.playbackRate - rate) > 0.005) video.playbackRate = rate;
      showCatching(rate > 1 ? `fast:${rate}` : rate < 1 ? `slow:${rate}` : null);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  // Once a second: if the picture drifted from the clock (pause, sleep, stall), rejoin.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playKey) return;
    if (paused) {
      if (!video.paused) video.pause();
      return;
    }
    if (onDemandRef.current) {
      if (video.paused && !video.ended && video.readyState >= 2 && !holdingRef.current) video.play().catch(() => {});
      return;
    }
    if (video.readyState < 3 || video.seeking) return;
    // Just tuned: the old stream is still on screen while the new one is asked for. Comparing it with the
    // new programme's clock looked like a big drift and restarted the new stream two or three times.
    if (streamKey.current !== playKey) return;
    const expected = offsetRef.current / 1000 - baseRef.current;
    if (level === 0) {
      // A file played directly can jump straight to the spot; small gaps are evened out by speed (below).
      if (Math.abs(video.currentTime - expected) > 1.5 && expected < video.duration) video.currentTime = expected;
    } else if (nativeHls && Math.abs(video.currentTime - expected) > 3 && video.seekable.length > 0 && expected <= video.seekable.end(video.seekable.length - 1)) {
      // On a phone the stream runs ahead of playback, so a small slip is fixed by skipping, not by starting over.
      video.currentTime = expected;
    } else if (Math.abs(video.currentTime - expected) > (nativeHls ? 25 : 8)) {
      // Far out (a long stall): a fresh stream lands within a few seconds, and the speed evens out the rest.
      setReload((value) => value + 1);
    }
    if (holdingRef.current) return;
    if (video.paused && !video.ended) video.play().catch(() => {});
  }, [airing?.offsetMs, playKey, level, paused]);

  // A scrub, or a return to live: jump now. A session cannot seek, so it is restarted at the new spot.
  const lastSeek = useRef({ token: seekToken, key: playKey });
  useEffect(() => {
    const before = lastSeek.current;
    lastSeek.current = { token: seekToken, key: playKey };
    // A new programme loads at the right place by itself.
    if (before.token === seekToken || before.key !== playKey) return;
    const video = videoRef.current;
    if (!video || !playKey) return;
    const target = offsetRef.current / 1000 - baseRef.current;
    if (level === 0) video.currentTime = offsetRef.current / 1000;
    // Already loaded (a short skip back or forward): jump there at once instead of starting a new stream.
    // (Only where the browser calls it seekable: a piped ffmpeg stream usually is not, and setting
    // currentTime on one starts the download over from its beginning.)
    else if (
      onDemandRef.current &&
      target >= 0 &&
      [...Array(video.seekable.length).keys()].some((i) => target >= video.seekable.start(i) && target <= video.seekable.end(i) - 0.5) &&
      [...Array(video.buffered.length).keys()].some((i) => target >= video.buffered.start(i) && target <= video.buffered.end(i) - 0.5)
    ) {
      video.currentTime = target;
      onDemandRef.current.onStream?.();
    }
    else setReload((value) => value + 1);
  }, [seekToken, playKey, level]);

  // Text subtitles: the lines from just before now, drawn here, not by the browser. The first time a
  // track is asked for, the server sends the next stretch while it copies the whole track once; the
  // copy is fetched as soon as it is ready.
  const textSub = sub?.text ? sub.key : null;
  useEffect(() => {
    cuesRef.current = [];
    setLine("");
    if (!mediaId || textSub == null) return;
    const from = Math.max(0, offsetRef.current / 1000 - 15);
    const control = new AbortController();
    const url = `/subs/${mediaId}?s=${textSub}&t=${from.toFixed(1)}`;
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, ms);
        control.signal.addEventListener("abort", () => (window.clearTimeout(timer), resolve()), { once: true });
      });
    void (async () => {
      let result = await streamCues(url, from, control.signal, (cue) => cuesRef.current.push(cue));
      for (let tries = 0; (result === "partial" || result === "waiting") && tries < 120; tries++) {
        await pause(10_000);
        if (control.signal.aborted) return;
        const fresh: Cue[] = [];
        result = await streamCues(`${url}&cached=1`, from, control.signal, (cue) => fresh.push(cue));
        if (result === "whole" && !control.signal.aborted) cuesRef.current = fresh;
      }
    })();
    return () => control.abort();
  }, [tuneKey, mediaId, textSub, seekToken]);

  function onTime() {
    const video = videoRef.current;
    if (!video || cuesRef.current.length === 0) return;
    const at = video.currentTime + baseRef.current;
    let text = "";
    for (const cue of cuesRef.current) if (cue.start <= at && at < cue.end) text = text ? `${text}\n${cue.text}` : cue.text;
    setLine(text);
  }

  useEffect(() => {
    setCard(true);
    const timer = window.setTimeout(() => setCard(false), CARD_MS);
    return () => window.clearTimeout(timer);
  }, [tuneKey, poke]);

  // Volume: a slider at the bottom left of the picture, and the scroll wheel while over the picture
  // (and nowhere else). Remembered between runs. A phone uses its own volume buttons instead.
  const frameRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(() => {
    if (ownVolume) return ownVolume.start;
    const saved = durable.getItem("parlor.volume");
    const value = Number(saved);
    return saved != null && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
  });
  const [volumeShown, setVolumeShown] = useState(false);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  function changeVolume(next: number) {
    const value = Math.min(1, Math.max(0, Math.round(next * 100) / 100));
    setVolume(value);
    setVolumeShown(true);
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    if (value > 0 && video.muted) {
      video.muted = false;
      setMuted(false);
    }
  }
  const changeRef = useRef(changeVolume);
  changeRef.current = changeVolume;

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume, playKey]);

  useEffect(() => {
    if (ownVolumeRef.current) return ownVolumeRef.current.onChange(volume);
    const timer = window.setTimeout(() => durable.setItem("parlor.volume", volume.toFixed(2)), 400);
    return () => window.clearTimeout(timer);
  }, [volume]);

  useEffect(() => {
    if (!volumeShown) return;
    const timer = window.setTimeout(() => setVolumeShown(false), 1500);
    return () => window.clearTimeout(timer);
  }, [volumeShown, volume]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || isRemote) return;
    // A native listener, so the wheel can be kept from doing anything else while over the picture.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      changeRef.current(volumeRef.current + (event.deltaY < 0 ? 0.05 : -0.05));
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, []);

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    userMuted.current = video.muted;
    setMuted(video.muted);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "m" || event.key === "M") toggleMute();
      if (event.key === "f" || event.key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const live = mediaId != null && !failed;
  const showing = powered && !digits && airing != null && film != null && !missing && !failed;
  const hideCard = live && !digits && !notice && (compact || !card);
  const uiUp = osdOpen || keyAwake > 0 || (!isTv && !hideCard);
  const filter = adjust ? videoFilter(adjust) : undefined;

  return (
    <div
      onMouseMove={() => {
        // Keep the card up while the mouse is in use, without restarting the timer on every pixel.
        if (!live || compact || (card && Date.now() - lastPoke.current < 800)) return;
        lastPoke.current = Date.now();
        setPoke((value) => value + 1);
      }}
      ref={frameRef}
      onClick={live ? (onDemand ? onDemand.onTogglePause : toggleMute) : undefined}
      onDoubleClick={onToggleView}
      className={cn("group relative h-full w-full overflow-hidden bg-screen text-cream [container-type:inline-size]", hideCard && !compact ? "cursor-none" : "", className)}
    >
      {/* With a filter on, the black bars sit behind the video instead of in it, so they stay black. */}
      {filter ? (
        <>
          <LiftFilter lift={adjust?.lift ?? 0} />
          <div className={cn("absolute inset-0 bg-black", live ? "" : "hidden")} />
        </>
      ) : null}
      <video
        ref={videoRef}
        playsInline
        onTimeUpdate={onTime}
        className={cn("absolute inset-0 h-full w-full object-contain", filter ? "" : "bg-black", live ? "" : "hidden")}
        style={filter ? { filter } : undefined}
        onError={() => {
          if (!playKey) return;
          // A stream being replaced can still report a failure after the new one has started. Ignore it.
          if (srcRef.current && !video_src_matches(videoRef.current, srcRef.current)) return;
          // A phone stream sometimes stumbles while it starts. Try the same way again before trying a heavier one.
          if (nativeHls && retries.current < 2) {
            retries.current += 1;
            window.setTimeout(() => setReload((value) => value + 1), 800);
            return;
          }
          if (level === 0) setBump({ key: playKey, level: canCopy ? 1 : 2 });
          else if (level === 1) setBump({ key: playKey, level: 2 });
          else setFailed(true);
        }}
      />

      {live ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/35 transition-opacity duration-500",
            hideCard ? "opacity-0" : "opacity-100",
          )}
        />
      ) : null}

      {(catching || (syncOn && uiUp && !compact)) && live ? (
        // Complete Sync on (only while the controls are up), and catching up with the other screens: sped up (⏩), slowed (⏪) or waiting a moment (⏸).
        <div className={cn("pointer-events-none absolute z-30 flex items-center gap-1", compact ? "right-1.5 top-1.5" : toolbar && !isTv ? "right-3 top-14" : "right-3 top-3")}>
          {syncOn && uiUp && !compact ?<span className="rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-semibold text-accent">● Complete Sync</span> : null}
          {catching ? (
            <span className="rounded-full bg-black/50 px-1.5 py-px text-[9px] font-semibold text-white/85 tabular-nums">
              {catching === "hold" ? "⏸ syncing" : `${catching.startsWith("fast") ? "⏩" : "⏪"} ${catching.split(":")[1]}×`}
            </span>
          ) : null}
        </div>
      ) : null}

      {live && line ? (
        <p
          data-subs
          className="pointer-events-none absolute inset-x-0 bottom-[7%] z-20 px-[6%] transition-[bottom] duration-200 text-center leading-snug font-medium whitespace-pre-line text-white"
          style={{ fontSize: "clamp(0.6rem, 1.6cqw, 1.75rem)", textShadow: "0 0 4px #000, 0 2px 6px #000, 0 0 2px #000" }}
        >
          {line}
        </p>
      ) : null}

      {live && !isRemote ? (
        <div
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            "absolute left-3 z-30 flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-cream transition-opacity duration-300",
            compact ? "bottom-3" : "bottom-24",
            volumeShown || muted || (!compact && !hideCard) ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <button type="button" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title="Mute (M)" className="text-cream/90 hover:text-cream">
            {muted || volume === 0 ? <VolumeX className="size-4" /> : volume < 0.5 ? <Volume1 className="size-4" /> : <Volume2 className="size-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : Math.round(volume * 100)}
            onChange={(event) => changeVolume(Number(event.target.value) / 100)}
            aria-label="Volume"
            title="Volume (or scroll over the picture)"
            className="h-1 w-24 cursor-pointer accent-accent"
          />
          <span className="w-7 text-right text-xs text-cream/80 tabular-nums">{muted ? "0" : Math.round(volume * 100)}</span>
        </div>
      ) : null}

      {live && muted ? (
        <p className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-cream">
          {onDemand ? "Muted · press M for sound" : "Muted · click the picture for sound"}
        </p>
      ) : null}

      <div
        className={cn(
          // Titles in the plain face, not the serif: it read too loud over the picture.
          "relative z-10 flex h-full flex-col justify-between p-4 transition-opacity duration-500 sm:p-6 [&_h1]:font-sans [&_h1]:font-semibold [&_h1]:tracking-tight",
          hideCard ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        {/* Top left: the station number, and beside it what is on. Top right: the controls. */}
        <div className="flex items-start justify-between gap-3">
          {/* A TV shows its own banner for this (tv-controls.tsx); showing both doubled it. */}
          <div className={cn("flex min-w-0 items-start gap-4", isTv && "invisible")}>
            {onDemand ? null : <p className="font-title shrink-0 text-3xl leading-none font-semibold tracking-tight tabular-nums sm:text-4xl">{station}</p>}
            <div className="min-w-0">
              <p className="text-xs tracking-[0.22em] text-cream/70 uppercase">
                {onDemand ? (channel?.name ?? "") : channel ? `${channel.callSign} · ${channel.name}` : "VayaView"}
              </p>
              {showing && airing && film ? (
                <div key={`${airing.slot.mediaId}-${airing.cycleIndex}`} className="parlor-in mt-1.5">
                  <h1 className="font-title text-xl leading-tight sm:text-3xl">{film.title}</h1>
                  <p className={cn("mt-1 text-sm text-cream/70 tabular-nums", onDemand && "hidden")}>
                    {formatDuration(airing.offsetMs)} in · {formatDuration(airing.remainingMs)} left
                    {airing.next ? ` · Next ${airing.next.title} at ${formatTime(airing.endsAtMs)}` : ""}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
          {toolbar && !compact && !isTv ? (
            <div className="shrink-0" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
              {toolbar}
            </div>
          ) : null}
        </div>

        <div key={airing ? `${airing.slot.mediaId}-${airing.cycleIndex}` : "idle"} className="parlor-in max-w-3xl">
          {digits ? (
            <p className="font-title text-6xl font-semibold tracking-tight tabular-nums sm:text-7xl">{digits}</p>
          ) : !powered ? (
            <>
              <h1 className="text-3xl leading-tight sm:text-5xl">Standby</h1>
              <p className="mt-3 max-w-md text-sm text-cream/70">The stations keep their clock. P turns the set back on.</p>
            </>
          ) : !airing || !film ? (
            <h1 className="text-3xl leading-tight sm:text-4xl">Joining the broadcast</h1>
          ) : missing ? (
            <>
              <p className="text-xs tracking-[0.18em] text-accent uppercase">Not on this computer</p>
              <h1 className="mt-2 text-2xl leading-tight sm:text-4xl">{film.title}</h1>
              <p className="mt-3 max-w-lg text-sm text-pretty text-cream/75">
                The slot stays on the schedule so the station does not skip ahead.
                {airing.next ? ` Next is ${airing.next.title}.` : ""}
              </p>
            </>
          ) : failed ? (
            <p className="text-sm text-accent">This file would not play, even through ffmpeg.</p>
          ) : null}
          {notice ? <p className="mt-4 text-sm text-accent">{notice}</p> : null}
        </div>
        <div onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          {live && !compact && !isTv ? footer : null}
        </div>
      </div>
    </div>
  );
}

function video_src_matches(video: HTMLVideoElement | null, src: string): boolean {
  return Boolean(video && video.src.endsWith(src.replace(/^https?:\/\/[^/]+/, "")));
}
