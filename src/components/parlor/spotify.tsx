import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { durable } from "@/lib/durable";
import { isRemote, isTv } from "@/lib/remote";
import { ModeSwitch, type AppMode } from "./mode-switch";

/**
 * Spotify party mode. The server (server/spotify.mjs) keeps the queue and tells the Spotify app what to
 * play; this screen shows what is on, the QR code guests scan (server/party.html), and the queue. When a
 * song coming up is in the music library and "Play my music video" is on, Spotify pauses and the video
 * plays here, sound and all, start to finish; then the queue carries on (the user picked this over
 * syncing a muted video to Spotify, because videos are usually longer than the song).
 */
type Art = { big: string; small: string };
type Track = { key?: string; id: string; uri: string; name: string; artists: string[]; album: string; art: Art; durationMs: number; by?: string; hasVideo?: boolean };
type NowItem = Track & { key: string; mode: "spotify" | "video"; video?: { id: string; direct: boolean; durationMs: number }; progressMs: number; paused?: boolean; fromPlaylist?: string };
type PartyState = {
  now: NowItem | null;
  queue: (Track & { key: string })[];
  history: Track[];
  playing: boolean;
  error: string;
  code: string;
  /** Where songs come from: the queue, or the chosen playlist (which also takes over when the queue runs out). */
  source: "queue" | "playlist";
  playlist: { id: string; name: string; art: string; count: number; shuffle: boolean } | null;
  playlistNext: Track[];
  autoPlaylist: boolean;
};
type Status = { clientId: string; connected: boolean; name: string; deviceId: string; videos: boolean; redirect: string };
type Phone = { enabled: boolean; addresses: string[]; available: boolean };
type Playlist = { id: string; name: string; art: string; count: number };
type Device = { id: string; name: string; type: string; active: boolean };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
  return json as T;
}

/** What the VayaView Fire TV app offers the page (older installs have only some of it). */
type TvBridge = { deviceName?: () => string; openSpotify?: () => void; hasSpotify?: () => boolean; stayInFront?: (on: boolean) => void };
const tvBridge = (globalThis as unknown as { VayaTV?: TvBridge }).VayaTV;
const sleep = (ms: number) => new Promise((done) => window.setTimeout(done, ms));

const time = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const button = "rounded-full bg-cream/10 px-4 py-2 text-sm font-semibold text-cream hover:bg-cream/20 disabled:opacity-40";
const bold = "rounded-full bg-accent px-4 py-2 text-sm font-bold text-room hover:brightness-110 disabled:opacity-40";

export default function SpotifyMode({ onMode }: { onMode: (mode: AppMode) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [party, setParty] = useState<PartyState | null>(null);
  const [partyAt, setPartyAt] = useState(0);
  const [error, setError] = useState("");

  const loadStatus = useCallback(() => call<Status>("/api/spotify/status").then(setStatus, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  // While signing in (in the browser), check back until Spotify is connected.
  useEffect(() => {
    if (status?.connected) return;
    const timer = window.setInterval(loadStatus, 2500);
    return () => window.clearInterval(timer);
  }, [status?.connected, loadStatus]);

  // The queue, every second. ui=1 tells the server this screen is open (so it may hand songs to videos).
  const applyParty = useCallback((next: PartyState) => {
    setParty(next);
    setPartyAt(Date.now());
  }, []);
  useEffect(() => {
    if (!status?.connected) return;
    let alive = true;
    const load = () => call<PartyState>("/api/party/state?ui=1").then((next) => alive && applyParty(next), () => {});
    void load();
    const timer = window.setInterval(load, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [status?.connected, applyParty]);

  const act = useCallback(
    async (path: string, body?: unknown) => {
      try {
        setError("");
        applyParty(await call<PartyState>(path, body ?? {}));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [applyParty],
  );

  // On a TV, Spotify jumps in front of VayaView when it starts a song; the TV app brings VayaView back.
  useEffect(() => {
    tvBridge?.stayInFront?.(true);
    return () => tvBridge?.stayInFront?.(false);
  }, []);

  // The remote's Play/Pause button plays or pauses the party.
  const playingRef = useRef(false);
  playingRef.current = Boolean(party?.playing);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "MediaPlayPause") return;
      event.preventDefault();
      void act(playingRef.current ? "/api/party/pause" : "/api/party/play");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  return (
    <main className="flex h-dvh flex-col bg-[#0f1510] text-cream">
      <header className="flex shrink-0 items-center gap-4 px-5 py-3">
        <ModeSwitch mode="spotify" onMode={onMode} />
        <p className="font-title text-lg font-semibold">Spotify Party</p>
        {status?.connected ? <p className="ml-auto text-xs text-cream/50">Signed in{status.name ? ` as ${status.name}` : ""}</p> : null}
      </header>
      {!status ? (
        <p className="m-auto text-cream/60">{error || "Loading…"}</p>
      ) : !status.connected ? (
        isRemote ? (
          <p className="m-auto max-w-md text-center text-cream/70">Connect Spotify once in VayaView on the PC (the Spotify tab there). This screen picks it up by itself.</p>
        ) : (
          <Setup status={status} reload={loadStatus} />
        )
      ) : (
        <div className="flex min-h-0 flex-1">
          <Stage party={party} partyAt={partyAt} act={act} error={error || party?.error || ""} />
          <Side party={party} status={status} act={act} reload={loadStatus} />
        </div>
      )}
    </main>
  );
}

/** First time: make a Spotify developer app, paste its Client ID, sign in. */
function Setup({ status, reload }: { status: Status; reload: () => void }) {
  const [clientId, setClientId] = useState(status.clientId);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const saveId = async () => {
    try {
      setMsg("");
      await call("/api/spotify/settings", { clientId });
      reload();
      setMsg("Saved. Now press Connect Spotify.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="mx-auto max-w-2xl overflow-y-auto px-6 pb-10">
      <h2 className="font-title mt-6 text-2xl font-semibold">Connect Spotify</h2>
      <p className="mt-2 text-cream/70">Once, about two minutes. Spotify only lets apps like this in through a free developer app of your own (you need Premium).</p>
      <ol className="mt-5 list-decimal space-y-4 pl-6 text-cream/90">
        <li>
          Open{" "}
          <a className="text-accent underline" href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
            developer.spotify.com/dashboard
          </a>
          , sign in, and press <b>Create app</b>. Any name and description.
        </li>
        <li>
          Under <b>Redirect URIs</b> add exactly this, then press Add:
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded-lg bg-black/40 px-3 py-2 text-sm select-all">{status.redirect}</code>
            <button
              type="button"
              className={button}
              onClick={() => {
                void navigator.clipboard.writeText(status.redirect);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </li>
        <li>
          Tick <b>Web API</b>, agree to the terms, press <b>Save</b>.
        </li>
        <li>
          Copy the app's <b>Client ID</b> and paste it here:
          <div className="mt-2 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg bg-black/40 px-3 py-2 text-sm text-cream ring-1 ring-cream/15 outline-none focus:ring-accent"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Client ID"
              spellCheck={false}
            />
            <button type="button" className={bold} disabled={!clientId.trim()} onClick={saveId}>
              Apply
            </button>
          </div>
        </li>
        <li>
          <button type="button" className={bold} disabled={!status.clientId} onClick={() => window.open("/api/spotify/login", "_blank")}>
            Connect Spotify
          </button>
          <span className="ml-3 text-sm text-cream/60">Opens your browser to sign in; this page notices when you're done.</span>
        </li>
      </ol>
      {msg ? <p className="mt-4 text-sm text-accent">{msg}</p> : null}
    </div>
  );
}

/** What is on: the music video, or the album art with the song's progress. */
function Stage({ party, partyAt, act, error }: { party: PartyState | null; partyAt: number; act: (path: string, body?: unknown) => Promise<void>; error: string }) {
  const now = party?.now ?? null;
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(timer);
  }, []);
  const [volume, setVolume] = useState(() => Number(durable.getItem("parlor.spotifyVideoVolume") ?? 0.8));
  useEffect(() => durable.setItem("parlor.spotifyVideoVolume", String(volume)), [volume]);

  const progress = now ? now.progressMs + (party?.playing && now.mode === "spotify" && !now.paused ? Date.now() - partyAt : 0) : 0;
  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {now?.mode === "video" && now.video ? (
          <PartyVideo key={now.key} item={now} playing={Boolean(party?.playing)} volume={volume} act={act} />
        ) : now ? (
          <>
            {now.art.big ? <img src={now.art.big} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-35 blur-3xl" /> : null}
            <div className="relative flex size-full flex-col items-center justify-center gap-5 p-8">
              {now.art.big ? <img src={now.art.big} alt="" className="aspect-square max-h-[55%] rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.6)]" /> : null}
              <div className="max-w-[80%] text-center">
                <p className="font-title text-4xl leading-tight font-bold">{now.name}</p>
                <p className="mt-1 text-lg text-cream/75">{now.artists.join(", ")}</p>
                <p className="text-sm text-cream/45">
                  {now.album}
                  {now.fromPlaylist ? ` · from the playlist ${now.fromPlaylist}` : now.by ? ` · added by ${now.by}` : ""}
                </p>
              </div>
              <div className="w-full max-w-xl">
                <div className="h-1.5 overflow-hidden rounded-full bg-cream/15">
                  <div className="h-full bg-accent" style={{ width: `${Math.min(100, (progress / now.durationMs) * 100)}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-xs text-cream/50 tabular-nums">
                  <span>{time(progress)}</span>
                  <span>{time(now.durationMs)}</span>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-center text-cream/60">
            <p className="font-title text-3xl text-cream">Nothing playing yet</p>
            <p>Scan the code with a phone, or search on the right, to add songs.</p>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 px-5 py-3">
        {party?.playing ? (
          <button type="button" className={bold} onClick={() => act("/api/party/pause")}>
            ❚❚ Pause
          </button>
        ) : (
          <button type="button" className={bold} disabled={!now && !party?.queue.length && !party?.playlist} onClick={() => act("/api/party/play")}>
            ▶ Play
          </button>
        )}
        <button type="button" className={button} disabled={!now && !party?.queue.length && !party?.playlist} onClick={() => act("/api/party/next")}>
          Skip ⏭
        </button>
        {now?.mode === "video" ? (
          <label className="ml-2 flex items-center gap-2 text-xs text-cream/60">
            Video volume
            <input type="range" min={0} max={1} step={0.02} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="accent-[var(--color-accent)]" />
          </label>
        ) : null}
        {error ? <p className="ml-auto truncate text-sm text-accent">{error}</p> : null}
      </div>
    </section>
  );
}

/** A music video from the library, with its own sound. When it ends the queue moves on. */
function PartyVideo({ item, playing, volume, act }: { item: NowItem; playing: boolean; volume: number; act: (path: string, body?: unknown) => Promise<void> }) {
  const ref = useRef<HTMLVideoElement>(null);
  const video = item.video!;
  const [src, setSrc] = useState(video.direct ? `/media/${video.id}` : `/media/${video.id}?v=copy&a=0&t=0`);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = volume;
    if (playing) void el.play().catch(() => {});
    else el.pause();
  }, [playing, volume, src]);
  return (
    <div className="absolute inset-0 bg-black">
      <video
        ref={ref}
        src={src}
        autoPlay
        className="size-full object-contain"
        onEnded={() => act("/api/party/video-ended", { key: item.key })}
        onError={() => {
          if (!src.includes("v=enc")) setSrc(`/media/${video.id}?v=enc&a=0&t=0`);
          else void act("/api/party/video-failed", { key: item.key });
        }}
      />
      <div className="pointer-events-none absolute bottom-6 left-8 drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
        <p className="text-sm font-semibold tracking-[0.25em] text-accent uppercase">{item.artists.join(", ")}</p>
        <p className="font-title text-3xl font-bold">{item.name}</p>
        <p className="text-sm text-cream/70">Music video from your library{item.by ? ` · added by ${item.by}` : ""}</p>
      </div>
    </div>
  );
}

/** The QR code, settings, search and the queue. */
function Side({ party, status, act, reload }: { party: PartyState | null; status: Status; act: (path: string, body?: unknown) => Promise<void>; reload: () => void }) {
  const [phone, setPhone] = useState<Phone | null>(null);
  const [qr, setQr] = useState("");
  const loadPhone = useCallback(() => (isRemote ? Promise.resolve() : call<Phone>("/api/phone").then(setPhone, () => {})), []);
  useEffect(() => {
    void loadPhone();
  }, [loadPhone]);
  const address = isRemote ? location.origin : phone?.enabled ? phone.addresses[0] : undefined;
  const link = address && party?.code ? `${address}/party?c=${party.code}` : "";
  useEffect(() => {
    if (!link) return setQr("");
    void QRCode.toString(link, { type: "svg", margin: 1, color: { dark: "#000000", light: "#ffffff" } }).then(setQr);
  }, [link]);

  const [devices, setDevices] = useState<Device[]>([]);
  const loadDevices = () => call<{ devices: Device[] }>("/api/spotify/devices").then((r) => setDevices(r.devices), () => {});
  useEffect(() => {
    void loadDevices();
  }, []);

  // Leaving this screen (Music, Live TV…) pauses the party when its sound is on THIS device: otherwise the
  // other mode's video and Spotify fight over the speaker (on a Fire TV only one app plays at a time) and
  // the party ran through songs. A party playing on another device carries on.
  const soundHere = useRef(false);
  const tvPlayer = useRef("");
  useEffect(() => {
    const chosen = devices.find((d) => d.id === status.deviceId);
    soundHere.current = isTv ? Boolean(tvPlayer.current) && status.deviceId === tvPlayer.current : !chosen || chosen.type === "Computer";
  }, [devices, status.deviceId]);
  useEffect(
    () => () => {
      if (soundHere.current) void fetch("/api/party/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", keepalive: true }).catch(() => {});
    },
    [],
  );

  // On a TV: the sound comes from the Spotify app on this TV. Find it (opening Spotify in the background
  // if it isn't running) and play through it.
  const [tvSound, setTvSound] = useState("");
  useEffect(() => {
    if (!isTv) return;
    let alive = true;
    void (async () => {
      if (tvBridge?.hasSpotify && !tvBridge.hasSpotify()) return setTvSound("No Spotify app on this TV, so the sound plays where you chose below.");
      // Spotify names a Fire Stick its own way ("Amazon FireTV Stick Gen 3"), not by the TV's name, so:
      // the TV's name if it matches, else the one TV-type player on the account.
      const own = (tvBridge?.deviceName?.() ?? "").trim().toLowerCase();
      const find = (list: Device[]) => {
        const tvs = list.filter((d) => d.type === "TV");
        return list.find((d) => own && d.name.trim().toLowerCase() === own) ?? (tvs.length === 1 ? tvs[0] : undefined);
      };
      const list = async () => (await call<{ devices: Device[] }>("/api/spotify/devices").catch(() => ({ devices: [] as Device[] }))).devices;
      let mine = find(await list());
      if (!mine && tvBridge?.openSpotify) {
        setTvSound("Starting Spotify on this TV…");
        tvBridge.openSpotify();
        for (let i = 0; i < 16 && alive && !mine; i++) {
          await sleep(1500);
          mine = find(await list());
        }
      }
      if (!alive) return;
      if (!mine) return setTvSound("Spotify on this TV isn't signed in to your account, so the sound plays on the PC.");
      setTvSound(`Sound: Spotify on this TV (${mine.name})`);
      tvPlayer.current = mine.id;
      try {
        localStorage.setItem("vv.tvSpotifyPlayer", mine.id);
      } catch {
        // no storage
      }
      soundHere.current = true;
      if (mine.id !== status.deviceId) await call("/api/spotify/settings", { deviceId: mine.id }).then(reload, () => {});
      void loadDevices();
      // Spotify on the TV can get closed (memory, someone pressing Home and clearing it): while this screen is
      // open, check every 20 s and start it again in the background, so Play never fails for that reason.
      const mineId = mine.id;
      while (alive) {
        await sleep(20_000);
        if (!alive) break;
        const now = await list();
        if (!now.some((d) => d.id === mineId) && tvBridge?.openSpotify) {
          setTvSound("Starting Spotify on this TV again…");
          tvBridge.openSpotify();
          await sleep(9000);
          if (alive) setTvSound(`Sound: Spotify on this TV (${mine.name})`);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // Once per visit to this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) return setResults([]);
    const timer = window.setTimeout(() => call<{ tracks: Track[] }>(`/api/party/search?q=${encodeURIComponent(q)}`).then((r) => setResults(r.tracks), () => {}), 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [shuffle, setShuffle] = useState(true);

  return (
    <aside className="flex w-[26rem] shrink-0 flex-col gap-4 overflow-y-auto border-l border-cream/10 bg-black/20 p-4">
      <div className="flex gap-4 rounded-2xl bg-cream/5 p-3">
        {qr ? (
          <div className="size-36 shrink-0 overflow-hidden rounded-lg bg-white [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qr }} />
        ) : null}
        <div className="min-w-0 text-sm">
          {link ? (
            <>
              <p className="font-semibold">Scan to add songs</p>
              <p className="mt-1 text-cream/60">Guests on your Wi-Fi can search Spotify, add songs and add your playlists.</p>
              <p className="mt-1 text-xs break-all text-cream/40">{link}</p>
              <button type="button" className="mt-2 text-xs text-cream/50 underline hover:text-cream" onClick={() => act("/api/party/code")}>
                New code (old QR stops working)
              </button>
            </>
          ) : phone && !phone.enabled ? (
            <>
              <p className="font-semibold">Let guests add songs</p>
              <p className="mt-1 text-cream/60">Phones on your Wi-Fi reach VayaView through Phone access.</p>
              {phone.available ? (
                <button
                  type="button"
                  className={cn(bold, "mt-2")}
                  onClick={() =>
                    call("/api/phone", { enabled: true })
                      .then(loadPhone)
                      .catch(() => {})
                  }
                >
                  Turn on Phone access
                </button>
              ) : (
                <p className="mt-1 text-xs text-cream/40">Only in the installed app.</p>
              )}
            </>
          ) : (
            <p className="text-cream/60">Finding this PC on the network…</p>
          )}
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 accent-[var(--color-accent)]"
          checked={status.videos}
          onChange={(e) => call("/api/spotify/settings", { videos: e.target.checked }).then(reload)}
        />
        <span>
          Play my music video when I have the song
          <span className="block text-xs text-cream/45">Spotify pauses and the whole video plays here, then the queue carries on.</span>
        </span>
      </label>

      {tvSound ? <p className="-mb-2 text-xs text-cream/60">{tvSound}</p> : null}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-cream/60">Play on</span>
        <select
          className="min-w-0 flex-1 rounded-lg bg-black/40 px-2 py-1.5 text-cream ring-1 ring-cream/15"
          value={status.deviceId}
          onFocus={loadDevices}
          onChange={(e) => call("/api/spotify/settings", { deviceId: e.target.value }).then(reload)}
        >
          <option value="">Whichever Spotify is open</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.type}){d.active ? " · playing" : ""}
            </option>
          ))}
          {status.deviceId && !devices.some((d) => d.id === status.deviceId) ? <option value={status.deviceId}>The one chosen before (not open now)</option> : null}
        </select>
      </div>

      <div>
        <input
          type="search"
          className="w-full rounded-lg bg-black/40 px-3 py-2 text-sm text-cream ring-1 ring-cream/15 outline-none focus:ring-accent"
          placeholder="Search Spotify to add a song"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results.length ? (
          <ul className="mt-2 space-y-1">
            {results.map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded-lg p-1 hover:bg-cream/5">
                <img src={t.art.small} alt="" className="size-10 rounded" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{t.name}</p>
                  <p className="truncate text-xs text-cream/50">{t.artists.join(", ")}</p>
                </div>
                <button type="button" className="text-xs text-cream/60 hover:text-cream" onClick={() => act("/api/party/add", { id: t.id, next: true })}>
                  Next
                </button>
                <button type="button" className="rounded-full bg-accent px-2.5 py-1 text-xs font-bold text-room" onClick={() => act("/api/party/add", { id: t.id })}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div>
        {playlists == null ? (
          <button
            type="button"
            className={cn(button, "w-full")}
            onClick={() => call<{ playlists: Playlist[] }>("/api/party/playlists").then((r) => setPlaylists(r.playlists), () => setPlaylists([]))}
          >
            Choose a playlist…
          </button>
        ) : (
          <div className="rounded-xl bg-cream/5 p-2">
            <div className="flex items-center justify-between px-1 pb-1 text-xs text-cream/60">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-[var(--color-accent)]" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} /> Shuffle
              </label>
              <button type="button" className="hover:text-cream" onClick={() => setPlaylists(null)}>
                Close
              </button>
            </div>
            <ul className="max-h-60 space-y-1 overflow-y-auto">
              {playlists.length === 0 ? <li className="p-2 text-sm text-cream/50">No playlists found.</li> : null}
              {playlists.map((pl) => (
                <li key={pl.id} className="flex items-center gap-2 rounded-lg p-1 hover:bg-cream/5">
                  {pl.art ? <img src={pl.art} alt="" className="size-9 rounded" /> : <span className="size-9 rounded bg-cream/10" />}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {pl.name} <span className="text-xs text-cream/40">{pl.count}</span>
                  </span>
                  <button
                    type="button"
                    title="Play this playlist now (the queue waits until you switch back)"
                    className="rounded-full bg-accent px-2.5 py-1 text-xs font-bold text-room"
                    onClick={() => {
                      void act("/api/party/use-playlist", { id: pl.id, shuffle, play: true });
                      setPlaylists(null);
                    }}
                  >
                    Play
                  </button>
                  <button
                    type="button"
                    title="Use it when the queue runs out, without stopping the song that's on"
                    className="text-xs text-cream/60 hover:text-cream"
                    onClick={() => {
                      void act("/api/party/use-playlist", { id: pl.id, shuffle });
                      setPlaylists(null);
                    }}
                  >
                    Later
                  </button>
                  <button
                    type="button"
                    title="Put every song in the queue"
                    className="text-xs text-cream/60 hover:text-cream"
                    onClick={() => {
                      void act("/api/party/playlist", { id: pl.id, shuffle });
                      setPlaylists(null);
                    }}
                  >
                    + Queue
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {party ? (
        <div className="rounded-2xl bg-cream/5 p-3">
          <p className="text-xs font-semibold tracking-[0.2em] text-cream/50 uppercase">Playing from</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={cn(party.source === "queue" ? bold : button, "flex-1")}
              onClick={() => party.source !== "queue" && act("/api/party/source", { source: "queue", now: party.queue.length > 0 })}
            >
              The queue · {party.queue.length}
            </button>
            <button
              type="button"
              disabled={!party.playlist}
              className={cn(party.source === "playlist" ? bold : button, "min-w-0 flex-1 truncate")}
              onClick={() => party.source !== "playlist" && act("/api/party/source", { source: "playlist", now: true })}
            >
              {party.playlist ? party.playlist.name : "No playlist yet"}
            </button>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-cream/70">
            <input type="checkbox" className="accent-[var(--color-accent)]" checked={party.autoPlaylist} onChange={(e) => act("/api/party/auto-playlist", { on: e.target.checked })} />
            When the queue runs out, play the playlist
          </label>
          {party.playlist ? (
            <button type="button" className="mt-1 text-xs text-cream/40 hover:text-cream" onClick={() => act("/api/party/use-playlist", { id: null })}>
              Stop using {party.playlist.name}
            </button>
          ) : (
            <p className="mt-1 text-xs text-cream/40">Pick one with “Choose a playlist…” above.</p>
          )}
        </div>
      ) : null}

      {party?.source === "playlist" && party.playlistNext.length ? (
        <div>
          <p className="text-xs font-semibold tracking-[0.2em] text-cream/50 uppercase">Next from {party.playlist?.name}</p>
          <ul className="mt-2 space-y-1">
            {party.playlistNext.map((t, i) => (
              <li key={t.id + i} className="flex items-center gap-2 p-1">
                <img src={t.art.small} alt="" className="size-10 rounded" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{t.name}</p>
                  <p className="truncate text-xs text-cream/50">{t.artists.join(", ")}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="min-h-0">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold tracking-[0.2em] text-cream/50 uppercase">
            {party?.source === "playlist" ? "Queue (waits until you switch)" : "Up next"} · {party?.queue.length ?? 0}
          </p>
          {party?.queue.length ? (
            <button type="button" className="text-xs text-cream/50 hover:text-cream" onClick={() => act("/api/party/clear")}>
              Clear
            </button>
          ) : null}
        </div>
        <ul className="mt-2 space-y-1">
          {(party?.queue ?? []).map((item, i) => (
            <li key={item.key} className="group flex items-center gap-2 rounded-lg p-1 hover:bg-cream/5">
              <img src={item.art.small} alt="" className="size-10 rounded" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {item.name}
                  {item.hasVideo && status.videos ? <span className="ml-1.5 rounded border border-accent px-1 text-[10px] font-bold text-accent">VIDEO</span> : null}
                </p>
                <p className="truncate text-xs text-cream/50">
                  {item.artists.join(", ")}
                  {item.by ? ` · ${item.by}` : ""}
                </p>
              </div>
              {i > 0 ? (
                <button type="button" title="Play next" className={cn(isTv ? "block" : "hidden group-hover:block", "text-xs text-cream/50 hover:text-cream")} onClick={() => act("/api/party/move", { key: item.key, to: 0 })}>
                  ↑ Next
                </button>
              ) : null}
              <button type="button" title="Remove" className={cn(isTv ? "block" : "hidden group-hover:block", "px-1 text-cream/50 hover:text-accent")} onClick={() => act("/api/party/remove", { key: item.key })}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>

      <button
        type="button"
        hidden={isRemote}
        className="mt-auto self-start text-xs text-cream/35 hover:text-cream"
        onClick={() => {
          if (window.confirm("Disconnect Spotify from VayaView?")) void call("/api/spotify/logout", {}).then(reload);
        }}
      >
        Disconnect Spotify
      </button>
    </aside>
  );
}
