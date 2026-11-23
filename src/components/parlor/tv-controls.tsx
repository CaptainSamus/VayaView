import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useCompleteSync } from "@/lib/shared";
import { formatDuration, formatStation, formatTime } from "@/lib/format";
import type { Airing, Channel } from "@/lib/schedule/types";
import { audioLabel, subLabel, type Tracks } from "./tracks";

/**
 * VayaView on a TV (Fire Stick): the picture always fills the screen, and everything else is a
 * few big buttons driven by the remote.
 * - The remote's channel buttons change channel (the user did not want up/down to); a banner says what is on.
 * - Select (or ≡) opens the button bar: Guide, Subtitles, Audio, Sound, Last, Sync, Reconnect.
 * - Guide (the bar's button or the remote's Guide key) shows the PC-style guide with the picture in the
 *   corner; up/down move through stations, Select tunes there, Back returns to the full picture.
 * tv-nav.ts sends "tv-wake" for Select/Menu while watching and "tv-back" for Back.
 * The Fire TV app sends the channel keys as ChannelUp/ChannelDown and the Guide key as Guide.
 */
type Props = {
  channel: Channel | null;
  airing: Airing | null;
  powered: boolean;
  tracks: Tracks;
  synced: boolean;
  onSync: () => void;
  lastLabel: string | null;
  onLast: () => void;
  /** The other modes (Live TV, Streaming, Music), one press away. */
  modes?: { label: string; go: () => void }[];
  /** The guide view (picture in the corner) is showing. */
  guideOpen: boolean;
  onGuide: (open: boolean) => void;
  /** One station up (1) or down (-1). */
  onStep: (dir: 1 | -1) => void;
  /** Skip back or ahead in the programme (ms; negative = back). */
  onSeek?: (byMs: number) => void;
  /** Live TV paused on this TV; Play carries on from the same spot. */
  paused?: boolean;
  onPause?: () => void;
  /** How far behind live the picture is (after a pause or a skip back), or null when live. */
  behindMs?: number | null;
  onLive?: () => void;
};

/** The highlight goes to the station being watched in the guide. */
function focusTuned() {
  const row = document.querySelector<HTMLElement>('[role="button"][aria-current="true"]');
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: "nearest" });
}

/** Small TV pills; the highlighted one turns solid (tv-nav's outline is off inside the bar). */
const pill = "rounded-full bg-cream/10 px-3.5 py-1.5 text-xs font-medium text-cream outline-none focus:bg-cream focus:text-room disabled:opacity-40";
/** The two main round skip buttons. */
const round = "flex size-10 flex-col items-center justify-center rounded-full bg-cream/15 text-cream outline-none transition-transform focus:scale-110 focus:bg-cream focus:text-room";

const clock = (ms: number) => {
  const all = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(all / 3600);
  const m = Math.floor((all % 3600) / 60);
  const sec = String(all % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

function SkipIcon({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-3.5", back && "-scale-x-100")} fill="currentColor">
      <path d="M4 5.5v13l8.5-6.5zM12.5 5.5v13l8.5-6.5z" />
    </svg>
  );
}

export function TvControls({ channel, airing, powered, tracks, synced, onSync, lastLabel, onLast, modes = [], guideOpen, onGuide, onStep, onSeek, paused = false, onPause, behindMs = null, onLive }: Props) {
  const [menu, setMenu] = useState(false);
  const [completeSync, setCompleteSync] = useCompleteSync();
  const setGuideOpen = onGuide;
  const [banner, setBanner] = useState(true);
  const first = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const aheadRef = useRef<HTMLButtonElement>(null);
  /** Which button the menu opens on: Left → ⏪, Right → ⏩, Select → Guide. */
  const openWith = useRef<"back" | "ahead" | "guide">("guide");
  // For remotes without channel buttons: Up/Down change channel. Each TV box remembers its own choice
  // (on for the 2nd Fire Stick, whose remote has no channel keys; off by default).
  const [upDown, setUpDown] = useState(() => {
    try {
      return localStorage.getItem("vv.tvUpDownChannels") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("vv.tvUpDownChannels", upDown ? "1" : "0");
    } catch {
      // no storage: it lasts until the app restarts
    }
  }, [upDown]);

  // A new station or programme: say what is on for a few seconds.
  useEffect(() => {
    setBanner(true);
    const timer = window.setTimeout(() => setBanner(false), 5000);
    return () => window.clearTimeout(timer);
  }, [channel?.id, airing?.slot.mediaId]);

  useEffect(() => {
    const wake = (event: Event) => {
      event.preventDefault();
      if (guideOpen) focusTuned();
      else if (menu) (aheadRef.current ?? first.current)?.focus(); // open but nothing highlighted: pick it up again
      else setMenu(true);
    };
    const back = (event: Event) => {
      // Back never leaves the picture on a TV; it only closes what is open.
      event.preventDefault();
      if (menu) setMenu(false);
      else setGuideOpen(false);
    };
    // Channel keys change channel; Guide opens or closes the guide; up/down while watching only show
    // what is on (they must not change channel). Capture phase, so the app's own up/down never see them.
    const keys = (event: KeyboardEvent) => {
      const key = event.key;
      const watching = document.activeElement == null || document.activeElement === document.body;
      // The bar is open but nothing in it is highlighted (the highlight got dropped): any arrow puts it back
      // on a skip button (Left on ⏪, the rest on ⏩), so the remote never goes dead with the bar showing.
      if (menu && watching && !guideOpen && (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        ((key === "ArrowLeft" ? backRef.current : aheadRef.current) ?? first.current)?.focus();
        return;
      }
      if (key === "ChannelUp" || key === "ChannelDown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onStep(key === "ChannelUp" ? 1 : -1);
        return;
      }
      if (key === "Guide") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMenu(false);
        setGuideOpen(!guideOpen);
        return;
      }
      // The remote's own rewind / fast-forward buttons skip (the TV app sends them as MediaRewind /
      // MediaFastForward). Left/Right while watching open the button bar instead of skipping, so the
      // ring is free for moving between buttons; skipping is a button in the bar (user, 2026-11-16).
      if (key === "MediaRewind" || key === "MediaFastForward") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onSeek?.(key === "MediaRewind" ? -5_000 : 5_000);
        return;
      }
      // The remote's Play/Pause pauses live TV (and plays on from the same spot).
      if (key === "MediaPlayPause" && onPause) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onPause();
        setBanner(true);
        return;
      }
      if ((key === "ArrowLeft" || key === "ArrowRight") && watching && !guideOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openWith.current = key === "ArrowLeft" ? "back" : "ahead";
        setMenu(true);
        return;
      }
      if ((key === "ArrowUp" || key === "ArrowDown") && watching) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (guideOpen) focusTuned();
        else if (upDown) onStep(key === "ArrowUp" ? 1 : -1);
        else setBanner(true);
      }
    };
    window.addEventListener("tv-wake", wake);
    window.addEventListener("tv-back", back);
    window.addEventListener("keydown", keys, true);
    return () => {
      window.removeEventListener("tv-wake", wake);
      window.removeEventListener("tv-back", back);
      window.removeEventListener("keydown", keys, true);
    };
  }, [guideOpen, menu, onStep, onSeek, onPause, setGuideOpen, upDown]);

  // The banner shown by up/down hides again after a while.
  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(false), 5000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    if (!menu) return;
    const target = openWith.current === "back" ? backRef.current : openWith.current === "ahead" ? aheadRef.current : first.current;
    (target ?? first.current)?.focus();
    openWith.current = "guide";
  }, [menu]);
  // Like a TV: the bar hides itself after 8 s without a button press.
  useEffect(() => {
    if (!menu) return;
    let timer = window.setTimeout(() => setMenu(false), 8000);
    const again = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMenu(false), 8000);
    };
    // TV navigation swallows the arrow keys before this would see them, so count highlight moves and presses too.
    window.addEventListener("keydown", again, true);
    document.addEventListener("focusin", again, true);
    document.addEventListener("click", again, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", again, true);
      document.removeEventListener("focusin", again, true);
      document.removeEventListener("click", again, true);
    };
  }, [menu]);
  // Subtitles move up above the bar while it is open (tv-nav.ts has the rule).
  useEffect(() => {
    document.documentElement.classList.toggle("tv-osd-open", menu);
    return () => document.documentElement.classList.remove("tv-osd-open");
  }, [menu]);
  // The bar's progress line moves while it is open.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!menu) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [menu]);

  useEffect(() => {
    if (!guideOpen) return;
    const timer = window.setTimeout(focusTuned, 120);
    return () => window.clearTimeout(timer);
  }, [guideOpen]);

  const subOptions = [null, ...tracks.subTracks.map((track) => track.key)];
  const subIndex = subOptions.indexOf(tracks.sub?.key ?? null);
  const subName = tracks.sub ? subLabel(tracks.sub, tracks.subTracks.indexOf(tracks.sub)) : tracks.subTracks.length ? "Off" : "None";
  const audioName = tracks.audioTracks[tracks.audio] ? audioLabel(tracks.audioTracks[tracks.audio], tracks.audio) : "";

  const close = () => setMenu(false);
  const showBanner = (banner || menu || paused) && !guideOpen;

  return (
    <>
      {showBanner && channel ? (
        <div className="pointer-events-none fixed top-6 left-8 z-50 max-w-[60%] rounded-xl bg-black/45 px-5 py-3 text-cream backdrop-blur">
          <div className="flex items-center gap-4">
            <p className="font-title text-4xl leading-none font-semibold text-accent tabular-nums">{formatStation(channel.number)}</p>
            <div className="min-w-0">
              <p className="truncate text-[11px] tracking-[0.2em] text-cream/60 uppercase">{channel.name}</p>
              <p className="font-title truncate text-xl font-semibold">{!powered ? "Standby" : (airing?.slot.title ?? "Joining the broadcast")}</p>
            </div>
          </div>
          {paused ? <p className="mt-1.5 text-xs font-semibold text-accent">❚❚ Paused · Play/Pause to carry on</p> : null}
          {airing && powered ? (
            <p className="mt-1.5 text-xs text-cream/70 tabular-nums">
              {formatDuration(airing.remainingMs)} left · ends {formatTime(airing.endsAtMs)}
              {airing.next ? ` · Next: ${airing.next.title}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      {menu ? (
        // A TV-style bar along the bottom: progress, the two skip buttons in the middle, then small pills.
        <div data-tv-overlay data-tv-osd className="fixed inset-x-0 bottom-0 z-50 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-10 pt-16 pb-6 text-cream">
          {airing && powered ? (
            <div className="mx-auto flex max-w-4xl items-center gap-3 text-[11px] text-cream/70 tabular-nums">
              <span>{clock(airing.offsetMs)}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-cream/20">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (airing.offsetMs / Math.max(1, airing.slot.durationMs)) * 100)}%` }} />
              </div>
              <span>{clock(airing.slot.durationMs)}</span>
            </div>
          ) : null}

          {onSeek ? (
            <div data-tv-row className="mt-3 flex items-center justify-center gap-5">
              <button ref={backRef} type="button" aria-label="Back 5 seconds" className={round} onClick={() => onSeek(-5_000)}>
                <SkipIcon back />
                <span className="text-[8px] leading-none font-semibold">5s</span>
              </button>
              {onPause ? (
                <button type="button" aria-label={paused ? "Play" : "Pause"} className={round} onClick={onPause}>
                  <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill="currentColor">
                    <path d={paused ? "M7 4.5v15l12-7.5z" : "M6.5 5h4v14h-4zM13.5 5h4v14h-4z"} />
                  </svg>
                </button>
              ) : null}
              <button ref={aheadRef} type="button" aria-label="Ahead 5 seconds" className={round} onClick={() => onSeek(5_000)}>
                <SkipIcon />
                <span className="text-[8px] leading-none font-semibold">5s</span>
              </button>
              {onLive && (paused || (behindMs != null && behindMs > 1500)) ? (
                <button type="button" className={cn(pill, "bg-accent/80 text-room")} onClick={onLive}>
                  ● Live{!paused && behindMs ? ` (${clock(behindMs)} behind)` : ""}
                </button>
              ) : null}
            </div>
          ) : null}

          <div data-tv-row className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button
              ref={first}
              type="button"
              className={pill}
              onClick={() => {
                setMenu(false);
                setGuideOpen(true);
              }}
            >
              Guide
            </button>
            <button type="button" className={pill} disabled={tracks.subTracks.length === 0} onClick={() => tracks.setSub(subOptions[(subIndex + 1) % subOptions.length] ?? null)}>
              Subtitles: {subName}
            </button>
            {tracks.audioTracks.length > 1 ? (
              <button type="button" className={pill} onClick={() => tracks.setAudio((tracks.audio + 1) % tracks.audioTracks.length)}>
                Audio: {audioName}
              </button>
            ) : null}
            <button type="button" className={pill} onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }))}>
              Sound on/off
            </button>
            {lastLabel ? (
              <button
                type="button"
                className={pill}
                onClick={() => {
                  onLast();
                  close();
                }}
              >
                ↩ {lastLabel}
              </button>
            ) : null}
            <span className="mx-1 h-4 w-px bg-cream/25" />
            {modes.map((mode) => (
              <button key={mode.label} type="button" className={pill} onClick={mode.go}>
                {mode.label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-cream/25" />
            <button type="button" className={cn(pill, "text-cream/60")} onClick={() => setUpDown(!upDown)}>
              Up/Down: {upDown ? "channels" : "info"}
            </button>
            <button type="button" className={cn(pill, completeSync && "bg-accent/80 text-room")} onClick={() => setCompleteSync(!completeSync)}>
              Complete Sync: {completeSync ? "on" : "off"}
            </button>
            <button type="button" className={cn(pill, "text-cream/60")} onClick={onSync}>
              Sync with PC: {synced ? "on" : "off"}
            </button>
            <button
              type="button"
              className={cn(pill, "text-cream/60")}
              onClick={() => {
                // The Fire TV app reconnects from scratch (finds the PC again); a browser just reloads.
                const app = (window as unknown as { VayaTV?: { restart?: () => void } }).VayaTV;
                if (app?.restart) app.restart();
                else window.location.reload();
              }}
            >
              Reconnect
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
