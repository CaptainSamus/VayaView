import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { durable } from "@/lib/durable";
import { formatDuration } from "@/lib/format";
import { backdropUrl, posterUrl } from "@/lib/library/art";
import { CATALOG, diskMissingIds } from "@/lib/library/catalog";
import { LIBRARY_EVENT, refreshLibrary } from "@/lib/library/disk";
import type { Film } from "@/lib/library/types";
import { playRequestFor } from "@/lib/player/seam";
import type { Airing, Channel } from "@/lib/schedule/types";
import { clearPosition, recordPosition, resumeMs, watchAll, watchOf } from "@/lib/watch";
import { ModeSwitch, type AppMode } from "./mode-switch";
import { Picture } from "./picture";
import { PictureMenu, usePictureAdjust } from "./picture-adjust";
import { TrackMenu, useTracks } from "./tracks";
import { isRemote } from "@/lib/remote";
import { useCompleteSync, useShared } from "@/lib/shared";
import { serverNow } from "@/lib/server-clock";
import { PlayIntro, TitlePage, type IntroKind } from "./streaming-page";
import { GapPage, GapTile, UndoHide, WantPage } from "./streaming-missing";
import { missingActions, useMissing, type Gap, type Missing } from "@/lib/missing";

/**
 * STREAMING VIEW
 * The library as a streaming app: pick a film or an episode and it plays from
 * the start, or from where you left off. The TV channels are not touched; this
 * view has its own player session, and leaving it goes back to the clock.
 */

export type Look = "cinema" | "wall" | "retro";
const LOOKS: { id: Look; label: string; hint: string }[] = [
  { id: "cinema", label: "Cinema", hint: "Big feature banner with rows" },
  { id: "wall", label: "Poster wall", hint: "Every title in one grid" },
  { id: "retro", label: "Retro", hint: "Video-shop shelves" },
];

export type Show = { name: string; episodes: Film[]; poster: string | null; backdrop: string | null; year: number; rating: number; synopsis: string; genres: string[]; addedMs: number };
export type Pick = { kind: "film"; film: Film } | { kind: "show"; show: Show } | { kind: "collection"; name: string; films: Film[] } | { kind: "gap"; gap: Gap };
type Playing = { film: Film; fromMs: number; session: number };
/** Complete Sync: the film playing and its timeline. Paused: `at` is the spot; playing: `at` is when it was at 0 (wall clock). */
type Clock = { id: string; paused: boolean; at: number } | null;

const buttonClass = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20";
const primaryClass = "rounded-md bg-accent px-4 py-2 text-sm font-semibold text-room shadow hover:brightness-110";

function byEpisode(a: Film, b: Film) {
  return (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title);
}

/** Changes once a day, so the banner is not the same film every time but does not jump about either. */
function dayHash(text: string) {
  let hash = Math.floor(Date.now() / 86_400_000);
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function useLibrary() {
  // Read again whenever the library or its posters change (see refreshLibrary in disk.ts).
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    window.addEventListener(LIBRARY_EVENT, bump);
    return () => window.removeEventListener(LIBRARY_EVENT, bump);
  }, []);
  return useMemo(() => {
    const movies: Film[] = [];
    const showMap = new Map<string, Film[]>();
    // The same film (or episode) twice on disk shows once: the sharper copy, then the longer cut.
    const best = new Map<string, Film>();
    for (const film of CATALOG) {
      if (diskMissingIds.has(film.id)) continue;
      const name = film.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const key =
        film.genres[0] === "TV"
          ? film.season != null && film.episode != null
            ? `tv|${film.collection}|${film.season}|${film.episode}`
            : `id|${film.id}`
          : `movie|${name}|${film.year}`;
      const held = best.get(key);
      if (!held || (film.height ?? 0) > (held.height ?? 0) || ((film.height ?? 0) === (held.height ?? 0) && film.durationMs > held.durationMs)) best.set(key, film);
    }
    for (const film of best.values()) {
      if (film.genres[0] === "TV") {
        const name = film.collection ?? film.title;
        showMap.set(name, [...(showMap.get(name) ?? []), film]);
      } else movies.push(film);
    }
    const shows: Show[] = [...showMap].map(([name, episodes]) => {
      episodes.sort(byEpisode);
      const first = episodes.find((film) => film.poster) ?? episodes[0];
      return {
        name,
        episodes,
        poster: first.poster ?? null,
        backdrop: first.backdrop ?? null,
        year: first.year,
        rating: first.rating ?? 0,
        synopsis: first.showSynopsis ?? "",
        genres: first.genres.slice(1),
        addedMs: Math.max(...episodes.map((film) => film.addedMs ?? 0)),
      };
    });
    movies.sort((a, b) => a.title.localeCompare(b.title));
    shows.sort((a, b) => a.name.localeCompare(b.name));
    return { movies, shows };
  }, [version]);
}

/**
 * Home videos: the user's own recordings (G:\vids\VayaView Recorded Media by default, Data/parlor-home.json
 * {folder}). Scanned on their own by the server, never on TV stations and never looked up on TMDB.
 * The picture is a still from the video itself.
 */
function useHomeVideos(): Film[] {
  const [films, setFilms] = useState<Film[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/home")
        .then((response) => response.json())
        .then((data: { films: { id: string; rel: string; durationMs: number; height: number; direct: boolean; vcodec: string; addedMs?: number; missing: boolean; audio: Film["audio"]; subs: Film["subs"] }[] }) => {
          if (!live) return;
          setFilms(
            (data.films ?? [])
              .filter((file) => !file.missing)
              .map((file) => {
                const name = file.rel.split(/[\/]/).pop()!.replace(/.[^.]+$/, "").replace(/[._]+/g, " ").trim();
                return {
                  id: file.id,
                  title: name,
                  year: new Date(file.addedMs || Date.now()).getFullYear(),
                  durationMs: file.durationMs,
                  director: "",
                  genres: ["Home video"],
                  keywords: [],
                  collection: null,
                  synopsis: "",
                  scenes: [],
                  filePath: file.rel,
                  metadataId: null,
                  fileName: file.rel,
                  addedMs: file.addedMs ?? 0,
                  height: file.height,
                  direct: file.direct,
                  vcodec: file.vcodec,
                  audio: file.audio,
                  subs: file.subs,
                  poster: `/api/thumb/${file.id}`,
                  backdrop: `/api/thumb/${file.id}`,
                } as Film;
              })
              .sort((a, b) => (b.addedMs ?? 0) - (a.addedMs ?? 0)),
          );
        })
        .catch(() => {});
    void load();
    window.addEventListener(LIBRARY_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(LIBRARY_EVENT, load);
    };
  }, []);
  return films;
}

/** Looks for new films and fetches any missing posters. */
function RefreshButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title={busy ? "Looking for new films and posters…" : "Refresh: find new films and fetch missing posters"}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void refreshLibrary().finally(() => setBusy(false));
      }}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-cream/60 transition-colors hover:bg-cream/10 hover:text-cream disabled:text-accent"
    >
      <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4", busy && "animate-spin")}>
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M12.6 1.6v3.1H9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

// The 3D store pulls in three.js, so it only loads when the 3D Store mode is opened.
const VideoStore = lazy(() => import("./store3d").then((m) => ({ default: m.VideoStore })));

/** Streaming, or with `store` the 3D video store: the same title pages, player and search. */
export function StreamingView({ onMode, store = false }: { onMode: (mode: AppMode) => void; store?: boolean }) {
  const { movies, shows } = useLibrary();
  const home = useHomeVideos();
  const missing = useMissing(movies);
  const [wantOpen, setWantOpen] = useState(false);
  const [look, setLook] = useState<Look>(() => {
    const saved = durable.getItem("parlor.streamLook") as Look | null;
    return LOOKS.some((item) => item.id === saved) ? (saved as Look) : "cinema";
  });
  useEffect(() => durable.setItem("parlor.streamLook", look), [look]);
  const [lookOpen, setLookOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pick, setPickState] = useState<Pick | null>(null);
  // True when one title page led to another.
  const [pageHop, setPageHop] = useState(false);
  const setPick = (next: Pick | null) => {
    setPageHop(false);
    setPickState(next);
  };
  const [playing, setPlaying] = useState<Playing | null>(null);
  // Bumped when a position is saved, so "Continue watching" and progress bars refresh.
  const [watchTick, setWatchTick] = useState(0);
  const retro = look === "retro";

  // A short opening before the film, in every look (can be turned off under Look).
  const [introOn, setIntroOn] = useState(() => durable.getItem("parlor.playIntro") !== "0");
  useEffect(() => durable.setItem("parlor.playIntro", introOn ? "1" : "0"), [introOn]);
  const [intro, setIntro] = useState<{ kind: IntroKind; src: string | null; title: string; start: () => void } | null>(null);

  /** `quiet` skips the opening animation (the 3D store plays its own). */
  function play(film: Film, fromMs = resumeMs(film.id), quiet = false) {
    const start = () => {
      setPlaying((before) => ({ film, fromMs, session: (before?.session ?? 0) + 1 }));
      setClock({ id: film.id, paused: false, at: serverNow() - fromMs });
    };
    if (quiet || !introOn || intro) return start();
    // From a title page its backdrop is already showing; from the rows the backdrop opens up.
    const show = showOf(film);
    setIntro({
      kind: pick ? "page" : "browse",
      src: backdropUrl(film.backdrop ?? show?.backdrop),
      title: show ? `${show.name} · ${episodeLabel(film).split(" · ")[0]}` : film.title,
      start,
    });
  }

  const showOf = (film: Film) => shows.find((show) => show.episodes.includes(film));

  // Complete Sync: the title page that is open, and the film playing (and where), are the same on every screen.
  const [syncOn] = useCompleteSync();
  const [clock, setClock] = useState<Clock>(null);
  const [remoteClock, setRemoteClock] = useState(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useShared<Clock>("stream.play", clock, (theirs) => {
    setClock(theirs);
    if (!theirs) return setPlaying(null);
    const film = CATALOG.find((item) => item.id === theirs.id) ?? home.find((item) => item.id === theirs.id);
    if (!film) return;
    setIntro(null);
    const pos = theirs.paused ? theirs.at : serverNow() - theirs.at;
    if (playingRef.current?.film.id !== theirs.id) setPlaying((before) => ({ film, fromMs: Math.max(0, pos), session: (before?.session ?? 0) + 1 }));
    setRemoteClock((value) => value + 1);
  });
  type PickKey = { kind: Pick["kind"]; id: string } | null;
  const pickKey: PickKey =
    pick == null
      ? null
      : pick.kind === "film"
        ? { kind: "film", id: pick.film.id }
        : pick.kind === "show"
          ? { kind: "show", id: pick.show.name }
          : pick.kind === "collection"
            ? { kind: "collection", id: pick.name }
            : { kind: "gap", id: pick.gap.id };
  useShared<PickKey>("stream.pick", pickKey, (theirs) => {
    if (!theirs) return setPick(null);
    if (theirs.kind === "film") {
      const film = movies.find((item) => item.id === theirs.id) ?? CATALOG.find((item) => item.id === theirs.id) ?? home.find((item) => item.id === theirs.id);
      if (film) setPick({ kind: "film", film });
    } else if (theirs.kind === "show") {
      const show = shows.find((item) => item.name === theirs.id);
      if (show) setPick({ kind: "show", show });
    } else if (theirs.kind === "collection") {
      const films = movies.filter((item) => item.collection === theirs.id);
      if (films.length) setPick({ kind: "collection", name: theirs.id, films });
    } else {
      const gap = missing.all.find((item) => item.id === theirs.id);
      if (gap) setPick({ kind: "gap", gap });
    }
  });

  const searched = useMemo(() => {
    const words = query.trim().toLowerCase();
    if (!words) return null;
    const hit = (text: string) => text.toLowerCase().includes(words);
    return {
      movies: [...home.filter((film) => hit(film.title)), ...movies.filter((film) => hit(film.title) || hit(film.director) || (film.collection != null && hit(film.collection)))],
      shows: shows.filter((show) => hit(show.name)),
      gaps: missing.all.filter((gap) => hit(gap.title) || (gap.collection != null && hit(gap.collection))),
    };
  }, [query, movies, shows, missing.all, home]);

  const tileFor = (film: Film) => <Tile key={film.id} title={film.title} sub={film.year ? String(film.year) : ""} poster={film.poster} film={film} retro={retro} onOpen={() => setPick({ kind: "film", film })} />;
  const gapTile = (gap: Gap) => <GapTile key={`gap:${gap.id}`} gap={gap} wanted={missing.wanted(gap.id)} retro={retro} onOpen={() => setPick({ kind: "gap", gap })} />;
  const showTile = (show: Show) => (
    <Tile key={`show:${show.name}`} title={show.name} sub={`${show.episodes.length} episodes`} poster={show.poster} retro={retro} onOpen={() => setPick({ kind: "show", show })} />
  );

  return (
    <main className={cn("relative flex h-dvh flex-col overflow-hidden", retro && "font-display")}>
      <header className="z-20 flex shrink-0 flex-wrap items-center gap-3 border-b border-cream/10 bg-room/85 px-5 py-3 backdrop-blur">
        <p className={cn("text-lg font-semibold tracking-tight text-cream", retro && "tracking-widest uppercase")}>VayaView</p>
        <ModeSwitch mode={store ? "store" : "streaming"} onMode={onMode} />
        {isRemote ? null : <RefreshButton />}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search films, shows, directors…"
          className="ml-auto w-72 max-w-full rounded-full bg-bezel px-4 py-1.5 text-sm text-cream outline-none placeholder:text-cream/35 focus:outline-2 focus:outline-accent"
        />
        <button
          type="button"
          aria-pressed={missing.show}
          title="Show films you don't have, greyed out"
          className={cn(buttonClass, missing.show && "bg-cream/25 font-semibold")}
          onClick={() => missingActions.setShow(!missing.show)}
        >
          {missing.show ? "● " : "○ "}Show missing
        </button>
        <button type="button" className={buttonClass} onClick={() => setWantOpen(true)}>
          ★ Want list{missing.want.length ? ` · ${missing.want.length}` : ""}
        </button>
        <div className={cn("relative", store && "hidden")}>
          <button type="button" className={buttonClass} onClick={() => setLookOpen((open) => !open)}>
            Look · {LOOKS.find((item) => item.id === look)?.label} ▾
          </button>
          {lookOpen ? (
            <div className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg bg-bezel shadow-xl ring-1 ring-cream/15">
              {LOOKS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cn("block w-full px-4 py-2 text-left hover:bg-cream/10", item.id === look && "bg-cream/10")}
                  onClick={() => {
                    setLook(item.id);
                    setLookOpen(false);
                  }}
                >
                  <span className="block text-sm text-cream">{item.id === look ? "● " : ""}{item.label}</span>
                  <span className="block text-xs text-cream/50">{item.hint}</span>
                </button>
              ))}
              <label className="flex cursor-pointer items-center gap-2 border-t border-cream/10 px-4 py-2.5 text-sm text-cream hover:bg-cream/10">
                <input type="checkbox" checked={introOn} onChange={(event) => setIntroOn(event.target.checked)} className="accent-[var(--color-accent)]" />
                Play animation
              </label>
            </div>
          ) : null}
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto" key={watchTick}>
        {retro ? <Scanlines /> : null}
        {movies.length === 0 && shows.length === 0 && home.length === 0 ? (
          <p className="p-10 text-cream/60">No films found yet. Pick your library folder in TV Guide → Settings.</p>
        ) : searched ? (
          <Grid label={`Results for “${query.trim()}”`} retro={retro}>
            {searched.shows.map(showTile)}
            {searched.movies.map(tileFor)}
            {missing.show ? searched.gaps.map(gapTile) : null}
            {searched.shows.length + searched.movies.length === 0 ? <p className="text-cream/50">Nothing matches.</p> : null}
          </Grid>
        ) : store ? (
          <Suspense fallback={<p className="p-10 text-cream/60">Opening the store…</p>}>
            <VideoStore movies={movies} shows={shows} paused={pick != null || playing != null || wantOpen} onPlay={(film) => play(film, resumeMs(film.id), true)} />
          </Suspense>
        ) : look === "wall" ? (
          <Wall home={home} movies={movies} shows={shows} tileFor={tileFor} showTile={showTile} gaps={missing.show ? missing.all : []} gapTile={gapTile} />
        ) : (
          <Rows home={home} missing={missing} gapTile={gapTile} movies={movies} shows={shows} retro={retro} tileFor={tileFor} showTile={showTile} showOf={showOf} onPick={setPick} onPlay={play} />
        )}
      </div>

      {wantOpen ? <WantPage missing={missing} onClose={() => setWantOpen(false)} onPick={setPick} /> : null}
      {pick?.kind === "gap" ? (
        <GapPage key={pick.gap.id} gap={pick.gap} missing={missing} movies={movies} hop={pageHop} onClose={() => setPick(null)} onPick={(next) => { setPickState(next); setPageHop(true); }} />
      ) : pick ? (
        <TitlePage missing={missing} leaving={intro?.kind === "page"} hop={pageHop} key={pick.kind === "film" ? pick.film.id : pick.kind === "show" ? pick.show.name : pick.name} pick={pick} movies={movies} onClose={() => setPick(null)} onPick={(next) => { setPickState(next); setPageHop(true); }} onPlay={play} />
      ) : null}

      {playing ? (
        <Player
          playing={playing}
          setPlaying={setPlaying}
          shared={syncOn ? clock : null}
          remoteClock={remoteClock}
          onClock={setClock}
          nextOf={(film) => {
            const show = showOf(film);
            if (!show) return null;
            return show.episodes[show.episodes.indexOf(film) + 1] ?? null;
          }}
          onClose={() => {
            setPlaying(null);
            setClock(null);
            setWatchTick((value) => value + 1);
          }}
        />
      ) : null}

      <UndoHide missing={missing} />
      {intro ? <PlayIntro kind={intro.kind} src={intro.src} title={intro.title} onCover={intro.start} onDone={() => setIntro(null)} /> : null}
    </main>
  );
}

function Scanlines() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-10 opacity-40 mix-blend-overlay"
      style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,.35) 0 1px, transparent 1px 3px)" }}
    />
  );
}

export function Tile({ title, sub, poster, film, retro, onOpen }: { title: string; sub: string; poster: string | null | undefined; film?: Film; retro: boolean; onOpen: () => void }) {
  const url = posterUrl(poster);
  const entry = film ? watchOf(film.id) : undefined;
  const progress = film && entry && entry.ms > 0 && film.durationMs > 0 ? entry.ms / film.durationMs : 0;
  const uhd = (film?.height ?? 0) >= 1800;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={cn(
        "group relative w-36 shrink-0 text-left transition-transform duration-200 hover:z-10 hover:scale-105 focus-visible:scale-105 xl:w-40",
        retro && "rotate-0 hover:-rotate-1",
      )}
    >
      <div
        className={cn(
          "relative aspect-[2/3] overflow-hidden bg-bezel shadow-lg",
          retro ? "rounded-sm ring-2 ring-cream/25 group-hover:ring-accent" : "rounded-lg ring-1 ring-cream/10 group-hover:ring-2 group-hover:ring-accent",
        )}
      >
        {url ? (
          <img src={url} alt="" loading="lazy" data-poster-for={film?.id} className="size-full object-cover" style={retro ? { filter: "sepia(.35) saturate(1.2) contrast(1.05)" } : undefined} />
        ) : (
          <div className="flex size-full items-end bg-gradient-to-br from-cream/15 to-bezel p-3">
            <span className="font-title text-base leading-tight font-semibold text-cream">{title}</span>
          </div>
        )}
        {retro ? (
          <span className="absolute inset-x-2 bottom-2 truncate rounded-sm bg-cream px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-room uppercase">{title}</span>
        ) : null}
        {uhd ? <span className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 text-[10px] font-bold text-cream">4K</span> : null}
        {entry?.done ? <span className="absolute top-1.5 right-1.5 rounded-full bg-black/70 px-1.5 text-[10px] text-cream">✓</span> : null}
        {progress > 0 ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
        ) : null}
      </div>
      {retro ? null : (
        <>
          <p className="mt-1.5 truncate text-sm text-cream/90">{title}</p>
          <p className="truncate text-xs text-cream/45">{sub}</p>
        </>
      )}
    </button>
  );
}

/**
 * A sideways row. Ways to move it, besides the bar:
 * - arrows at each end (shown on hover) jump a screenful;
 * - the scroll wheel over an arrow, or Shift + wheel anywhere on the row, slides it;
 * - press and drag anywhere on the posters; it glides on a little when let go.
 * The plain wheel still scrolls the page up and down.
 */
export function Row({ label, children, retro }: { label: string; children: ReactNode; retro: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const measure = () => {
    const el = track.current;
    if (el) setEnds({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Wheel handling needs a non-passive listener so the page does not scroll as well.
    const onWheel = (event: WheelEvent) => {
      const overArrow = (event.target as HTMLElement).closest("[data-row-arrow]");
      if (!event.shiftKey && !overArrow) return;
      event.preventDefault();
      el.scrollBy({ left: event.deltaY || event.deltaX, behavior: "smooth" });
    };
    const section = el.parentElement!;
    section.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      section.removeEventListener("wheel", onWheel);
    };
  }, []);

  const page = (direction: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: "smooth" });
  };

  // Press and drag, with a short glide after letting go. A drag never counts as a click.
  const drag = useRef<{ x: number; left: number; moved: boolean; v: number; t: number; lastX: number } | null>(null);
  const glide = useRef(0);
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    cancelAnimationFrame(glide.current);
    const el = track.current!;
    drag.current = { x: event.clientX, left: el.scrollLeft, moved: false, v: 0, t: performance.now(), lastX: event.clientX };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const d = drag.current;
    const el = track.current;
    if (!d || !el) return;
    const dx = event.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 6) return;
    if (!d.moved) {
      d.moved = true;
      el.setPointerCapture(event.pointerId);
    }
    const now = performance.now();
    d.v = (event.clientX - d.lastX) / Math.max(1, now - d.t);
    d.t = now;
    d.lastX = event.clientX;
    el.scrollLeft = d.left - dx;
  };
  const onPointerUp = () => {
    const d = drag.current;
    const el = track.current;
    if (!d || !el) return;
    if (d.moved) {
      // Swallow the click that follows a drag.
      const swallow = (event: MouseEvent) => event.stopPropagation();
      el.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 0);
      let v = -d.v * 16;
      const step = () => {
        if (Math.abs(v) < 0.5) return;
        el.scrollLeft += v;
        v *= 0.92;
        glide.current = requestAnimationFrame(step);
      };
      glide.current = requestAnimationFrame(step);
    }
    drag.current = null;
  };

  const arrow = (direction: 1 | -1, hidden: boolean) => (
    <button
      type="button"
      data-row-arrow
      aria-label={direction === 1 ? `More ${label}` : `Back in ${label}`}
      onClick={() => page(direction)}
      className={cn(
        "absolute top-1 bottom-3 z-20 flex w-14 items-center justify-center text-3xl text-cream opacity-0 transition-opacity duration-200 group-hover/row:opacity-100 focus-visible:opacity-100",
        direction === 1 ? "right-0 bg-gradient-to-l from-room via-room/70 to-transparent" : "left-0 bg-gradient-to-r from-room via-room/70 to-transparent",
        hidden && "pointer-events-none !opacity-0",
      )}
    >
      <span className="grid size-10 place-items-center rounded-full bg-black/60 ring-1 ring-cream/20 transition-transform hover:scale-110">{direction === 1 ? "›" : "‹"}</span>
    </button>
  );

  return (
    <section className="group/row relative z-0 mt-6 px-5">
      <h2 className={cn("mb-2 text-lg font-semibold text-cream", retro && "border-b-2 border-accent/60 pb-1 tracking-widest text-accent uppercase")}>{label}</h2>
      <div className="relative -mx-5">
        {arrow(-1, ends.start)}
        <div
          ref={track}
          onScroll={measure}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDragStart={(event) => event.preventDefault()}
          className="parlor-row flex gap-3 overflow-x-auto px-5 pt-1 pb-3 select-none"
        >
          {children}
        </div>
        {arrow(1, ends.end)}
      </div>
    </section>
  );
}

function Grid({ label, children, retro }: { label: string; children: ReactNode; retro: boolean }) {
  return (
    <section className="p-5">
      <h2 className={cn("mb-3 text-lg font-semibold text-cream", retro && "tracking-widest uppercase")}>{label}</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4">{children}</div>
    </section>
  );
}

function Rows(props: {
  home: Film[];
  missing: Missing;
  gapTile: (gap: Gap) => ReactNode;
  movies: Film[];
  shows: Show[];
  retro: boolean;
  tileFor: (film: Film) => ReactNode;
  showTile: (show: Show) => ReactNode;
  showOf: (film: Film) => Show | undefined;
  onPick: (pick: Pick) => void;
  onPlay: (film: Film) => void;
}) {
  const { home, missing, gapTile, movies, shows, retro, tileFor, showTile, showOf, onPick, onPlay } = props;
  const rows = useMemo(() => {
    const byId = new Map([...movies, ...home, ...shows.flatMap((show) => show.episodes)].map((film) => [film.id, film]));
    const watching = Object.entries(watchAll())
      .filter(([, entry]) => entry.ms > 0)
      .sort((a, b) => b[1].at - a[1].at)
      .map(([id]) => byId.get(id))
      .filter((film): film is Film => film != null)
      .slice(0, 20);
    const recent = [...movies].sort((a, b) => (b.addedMs ?? 0) - (a.addedMs ?? 0)).slice(0, 24);
    const recentShows = [...shows].sort((a, b) => b.addedMs - a.addedMs);
    const topRated = movies.filter((film) => (film.rating ?? 0) >= 7.5).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 30);
    const collections = new Map<string, Film[]>();
    for (const film of movies) if (film.collection) collections.set(film.collection, [...(collections.get(film.collection) ?? []), film]);
    const franchises = [...collections].filter(([, films]) => films.length >= 2).sort((a, b) => b[1].length - a[1].length);
    const genreCount = new Map<string, Film[]>();
    for (const film of movies) for (const genre of film.genres.slice(1)) genreCount.set(genre, [...(genreCount.get(genre) ?? []), film]);
    const genres = [...genreCount].filter(([, films]) => films.length >= 6).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
    const featured = movies.filter((film) => film.backdrop && (film.rating ?? 0) >= 6.5);
    const hero = featured.length ? featured.sort((a, b) => dayHash(a.id) - dayHash(b.id)).slice(0, 6) : [];
    return { watching, recent, recentShows, topRated, franchises, genres, hero };
  }, [movies, shows, home]);

  return (
    <div className="pb-10">
      {rows.hero.length ? <Hero films={rows.hero} retro={retro} onPick={onPick} onPlay={onPlay} /> : null}
      {rows.watching.length ? (
        <Row label="Continue watching" retro={retro}>
          {rows.watching.map((film) => {
            const show = showOf(film);
            return show ? (
              <Tile key={film.id} title={show.name} sub={episodeLabel(film)} poster={show.poster} film={film} retro={retro} onOpen={() => onPlay(film)} />
            ) : (
              <Tile key={film.id} title={film.title} sub={`${formatDuration(film.durationMs - resumeMs(film.id))} left`} poster={film.poster} film={film} retro={retro} onOpen={() => onPlay(film)} />
            );
          })}
        </Row>
      ) : null}
      {home.length ? <Row label="Home videos" retro={retro}>{home.map(tileFor)}</Row> : null}
      {rows.recent.length ? <Row label="Recently added" retro={retro}>{rows.recent.map(tileFor)}</Row> : null}
      {missing.show && missing.want.length ? <Row label="Your want list" retro={retro}>{missing.want.map(gapTile)}</Row> : null}
      {missing.show && missing.franchise.length ? <Row label="Missing from your franchises" retro={retro}>{missing.franchise.map(gapTile)}</Row> : null}
      {missing.show && missing.manual.length ? <Row label="Added by you" retro={retro}>{missing.manual.map(gapTile)}</Row> : null}
      {missing.show && missing.top.length ? <Row label="Top rated you don't have" retro={retro}>{missing.top.map(gapTile)}</Row> : null}
      {rows.recentShows.length ? <Row label="TV shows" retro={retro}>{rows.recentShows.map(showTile)}</Row> : null}
      {rows.topRated.length ? <Row label="Highly rated" retro={retro}>{rows.topRated.map(tileFor)}</Row> : null}
      {rows.franchises.length ? (
        <Row label="Franchises" retro={retro}>
          {rows.franchises.map(([name, films]) => {
            const lead = [...films].sort((a, b) => a.year - b.year)[0];
            const gaps = missing.show ? missing.inCollection(lead.collectionId).length : 0;
            return (
              <Tile key={`col:${name}`} title={name.replace(/ Collection$/, "")} sub={gaps ? `${films.length} of ${films.length + gaps} films` : `${films.length} films`} poster={lead.poster} retro={retro} onOpen={() => onPick({ kind: "collection", name, films })} />
            );
          })}
        </Row>
      ) : null}
      {rows.genres.map(([genre, films]) => (
        <Row key={genre} label={genre} retro={retro}>
          {[...films].sort((a, b) => dayHash(a.id + genre) - dayHash(b.id + genre)).slice(0, 30).map(tileFor)}
        </Row>
      ))}
      <Row label="All films A–Z" retro={retro}>{movies.slice(0, 60).map(tileFor)}</Row>
    </div>
  );
}

function Hero({ films, retro, onPick, onPlay }: { films: Film[]; retro: boolean; onPick: (pick: Pick) => void; onPlay: (film: Film) => void }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % films.length), 12_000);
    return () => window.clearInterval(timer);
  }, [films.length]);
  const film = films[index % films.length];
  const resume = resumeMs(film.id);
  return (
    <section className="relative h-[52vh] min-h-72 overflow-hidden">
      {films.map((item, i) => (
        <img
          key={item.id}
          src={backdropUrl(item.backdrop) ?? undefined}
          alt=""
          data-hero-for={i === index % films.length ? item.id : undefined}
          className="absolute inset-0 size-full object-cover transition-opacity duration-1000"
          style={{ opacity: i === index % films.length ? 1 : 0, filter: retro ? "sepia(.45) contrast(1.1)" : undefined }}
        />
      ))}
      <div className="absolute inset-0 bg-black/30" />
      <div className="absolute inset-0 bg-gradient-to-t from-room via-room/40 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-room/90 via-room/30 to-transparent" />
      <div className="absolute bottom-8 left-6 max-w-xl">
        <p className="text-xs tracking-[0.3em] text-accent uppercase">{retro ? "Staff pick" : "Featured"}</p>
        <h1 className="font-title mt-1 text-4xl leading-tight font-bold text-cream xl:text-5xl">{film.title}</h1>
        <p className="mt-1 text-sm text-cream/70">
          {[film.year || null, film.rating ? `★ ${film.rating}` : null, formatDuration(film.durationMs), film.genres.slice(1, 3).join(", ") || null].filter(Boolean).join(" · ")}
        </p>
        <p className="mt-2 line-clamp-3 text-sm text-cream/75">{film.synopsis}</p>
        <div className="mt-4 flex gap-2">
          <button type="button" className={primaryClass} onClick={() => onPlay(film)}>
            ▶ {resume ? `Resume · ${formatDuration(resume)}` : "Play"}
          </button>
          <button type="button" className="rounded-md bg-cream/15 px-4 py-2 text-sm font-semibold text-cream hover:bg-cream/25" onClick={() => onPick({ kind: "film", film })}>
            More info
          </button>
        </div>
      </div>
    </section>
  );
}

type Sort = "az" | "added" | "year" | "rating";
type WallItem = { film: Film; gap?: undefined } | { gap: Gap; film?: undefined };
function Wall({ home, movies, shows, tileFor, showTile, gaps, gapTile }: { home: Film[]; movies: Film[]; shows: Show[]; tileFor: (film: Film) => ReactNode; showTile: (show: Show) => ReactNode; gaps: Gap[]; gapTile: (gap: Gap) => ReactNode }) {
  const [genre, setGenre] = useState<string>("All");
  const [sort, setSort] = useState<Sort>(() => (durable.getItem("parlor.wallSort") as Sort | null) ?? "az");
  useEffect(() => durable.setItem("parlor.wallSort", sort), [sort]);
  const genres = useMemo(() => {
    const count = new Map<string, number>();
    for (const film of movies) for (const name of film.genres.slice(1)) count.set(name, (count.get(name) ?? 0) + 1);
    return ["All", "TV shows", ...(home.length ? ["Home videos"] : []), ...[...count].sort((a, b) => b[1] - a[1]).map(([name]) => name)];
  }, [movies, home.length]);
  const list = useMemo(() => {
    // Missing films (when shown) sit among the real ones, greyed out; "Recently added" puts them last.
    const pick = <T extends { genres: string[] }>(list: T[]) => (genre === "All" ? list : genre === "TV shows" ? [] : list.filter((item) => item.genres.includes(genre)));
    const sorted: WallItem[] = [...pick([...home, ...movies]).map((film) => ({ film })), ...pick(gaps).map((gap) => ({ gap }))];
    const of = (item: WallItem) => item.film ?? item.gap;
    if (sort === "az") sorted.sort((a, b) => of(a).title.localeCompare(of(b).title));
    if (sort === "added") sorted.sort((a, b) => (b.film?.addedMs ?? -1) - (a.film?.addedMs ?? -1));
    if (sort === "year") sorted.sort((a, b) => of(b).year - of(a).year);
    if (sort === "rating") sorted.sort((a, b) => (of(b).rating ?? 0) - (of(a).rating ?? 0));
    return sorted;
  }, [movies, home, gaps, genre, sort]);
  const tiles = list.map((item) => (item.film ? tileFor(item.film) : gapTile(item.gap)));
  const showList = genre === "All" || genre === "TV shows" ? shows : [];
  return (
    <section className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {genres.map((name) => (
          <button
            key={name}
            type="button"
            className={cn("rounded-full px-3 py-1 text-xs", name === genre ? "bg-accent font-semibold text-room" : "bg-cream/10 text-cream hover:bg-cream/20")}
            onClick={() => setGenre(name)}
          >
            {name}
          </button>
        ))}
        <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="ml-auto rounded-md bg-bezel px-2 py-1 text-xs text-cream">
          <option value="az">A–Z</option>
          <option value="added">Recently added</option>
          <option value="year">Newest</option>
          <option value="rating">Highest rated</option>
        </select>
      </div>
      <p className="mb-3 text-xs text-cream/45">{list.length + showList.length} titles</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4">
        {genre === "All" ? tiles : null}
        {showList.map(showTile)}
        {genre !== "All" ? tiles : null}
      </div>
    </section>
  );
}

export function episodeLabel(film: Film) {
  if (film.season != null && film.episode != null) return film.season === 0 ? `Ep ${film.episode} · ${film.title}` : `S${film.season} E${film.episode} · ${film.title}`;
  return film.title;
}

const VOD_CHANNEL: Channel = {
  id: "on-demand",
  number: 0,
  name: "",
  callSign: "",
  mode: "loop",
  shuffleSeed: "",
  anchorMs: 0,
  mediaIds: [],
  query: null,
};

/** 1:02:07, or 2:07 under an hour: the seconds always show. */
function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * One film, played on demand by the same player the channels use. Unlike a
 * channel there is no wall clock: the video is the clock. It only starts again
 * from a new spot when you skip somewhere not loaded yet.
 */
function Player({
  playing,
  setPlaying,
  nextOf,
  onClose,
  shared: sharedClock = null,
  remoteClock = 0,
  onClock,
}: {
  playing: Playing;
  setPlaying: (next: Playing | null) => void;
  nextOf: (film: Film) => Film | null;
  onClose: () => void;
  /** Complete Sync on: the shared timeline. */
  shared?: Clock;
  /** Bumped when another screen moved the shared timeline. */
  remoteClock?: number;
  /** The viewer started, skipped or paused here: the new timeline. */
  onClock?: (clock: Clock) => void;
}) {
  const { film } = playing;
  const duration = film.durationMs;
  // Where the stream was asked to start. Changes only on a skip.
  const [startAt, setStartAt] = useState(playing.fromMs);
  // Where the picture actually is, read from the video.
  const [pos, setPos] = useState(playing.fromMs);
  const [paused, setPaused] = useState(false);
  const [seekToken, setSeekToken] = useState(0);
  useEffect(() => {
    setStartAt(playing.fromMs);
    setPos(playing.fromMs);
    setPaused(false);
  }, [playing.session, playing.fromMs]);

  const airing: Airing = {
    channelId: VOD_CHANNEL.id,
    cycleIndex: playing.session,
    slotIndex: 0,
    offsetMs: startAt,
    remainingMs: duration - pos,
    startedAtMs: 0,
    endsAtMs: 0,
    slot: { mediaId: film.id, title: film.title, durationMs: duration, status: diskMissingIds.has(film.id) ? "missing" : "ready" },
    next: null,
  };
  const tracks = useTracks(film);
  const picture = usePictureAdjust(film);

  // Keep the spot every ten seconds, and when leaving.
  const posRef = useRef(pos);
  posRef.current = pos;
  useEffect(() => {
    const save = () => recordPosition(film.id, posRef.current, duration);
    const timer = window.setInterval(save, 10_000);
    return () => {
      window.clearInterval(timer);
      save();
    };
  }, [film.id, duration]);

  function close() {
    recordPosition(film.id, posRef.current, duration);
    onClose();
  }

  // The end: an episode rolls on to the next one; a film goes back to the browser.
  const endedRef = useRef(false);
  useEffect(() => {
    endedRef.current = false;
  }, [playing.session]);
  function finish() {
    if (endedRef.current) return;
    endedRef.current = true;
    recordPosition(film.id, duration, duration);
    const next = nextOf(film);
    if (next) {
      clearPosition(next.id);
      setPlaying({ film: next, fromMs: 0, session: playing.session + 1 });
      onClock?.({ id: next.id, paused: false, at: serverNow() });
    } else onClose();
  }

  // Several skips in a row start one stream, at the last spot, a moment after the presses stop.
  const seekTimer = useRef<number | null>(null);
  const holdPos = useRef<{ streamed: boolean; until: number } | null>(null);
  useEffect(() => () => void (seekTimer.current != null && window.clearTimeout(seekTimer.current)), []);
  function seek(ms: number, share = true) {
    const at = Math.min(Math.max(0, ms), duration - 3000);
    setPos(at);
    setPaused(false);
    if (share) onClock?.({ id: film.id, paused: false, at: serverNow() - at });
    holdPos.current = { streamed: false, until: Date.now() + 8000 };
    if (seekTimer.current != null) window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => {
      seekTimer.current = null;
      setStartAt(at);
      setSeekToken((value) => value + 1);
    }, 250);
  }
  // While a skip is under way, the old stream's time must not move the clock back.
  const onTime = (ms: number) => {
    const hold = holdPos.current;
    // Until the new stream has begun (the old one may still tick for a moment).
    if (hold && !hold.streamed && Date.now() < hold.until) return;
    holdPos.current = null;
    setPos(ms);
  };
  const togglePause = () => {
    const next = !pausedRef.current;
    setPaused(next);
    onClock?.(next ? { id: film.id, paused: true, at: posRef.current } : { id: film.id, paused: false, at: serverNow() - posRef.current });
  };
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Complete Sync: another screen skipped or paused: do the same here.
  const clockRef = useRef(sharedClock);
  clockRef.current = sharedClock;
  useEffect(() => {
    const shared = clockRef.current;
    if (!remoteClock || !shared || shared.id !== film.id) return;
    const target = shared.paused ? shared.at : serverNow() - shared.at;
    if (Math.abs(posRef.current - target) > 1500) seek(target, false);
    setPaused(shared.paused);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when another screen moved it
  }, [remoteClock]);
  // And if this screen falls well behind or ahead (a stall), skip level again; small gaps are evened out by speed.
  useEffect(() => {
    if (!sharedClock || sharedClock.paused || sharedClock.id !== film.id) return;
    const timer = window.setInterval(() => {
      const shared = clockRef.current;
      if (!shared || shared.paused || holdPos.current) return;
      const target = serverNow() - shared.at;
      if (Math.abs(posRef.current - target) > 5000) seek(target, false);
    }, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seek reads refs
  }, [sharedClock?.id, sharedClock?.paused, sharedClock?.at, film.id]);

  const keys = useRef({ seek, togglePause, pos, close });
  keys.current = { seek, togglePause, pos, close };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if ((target instanceof HTMLInputElement && target.type !== "range") || target instanceof HTMLSelectElement) return;
      // The position bar moves itself with the arrow keys.
      if (target instanceof HTMLInputElement && event.key.startsWith("Arrow")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const k = keys.current;
      if (event.key === " " || event.key === "k" || event.key === "MediaPlayPause") {
        event.preventDefault();
        k.togglePause();
      }
      if (event.key === "ArrowLeft" || event.key === "MediaRewind") k.seek(k.pos - 10_000);
      if (event.key === "ArrowRight" || event.key === "MediaFastForward") k.seek(k.pos + 10_000);
      if (event.key === "Escape" && !document.fullscreenElement) {
        event.stopImmediatePropagation();
        k.close();
      }
    };
    // Capture, so Escape closes the player before it reaches the info panel underneath.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const [drag, setDrag] = useState<number | null>(null);
  function commitDrag() {
    if (drag == null) return;
    seek(drag);
    setDrag(null);
  }

  const next = nextOf(film);
  const shown = drag ?? pos;
  const skipClass = "rounded px-2 py-0.5 text-xs font-semibold text-cream hover:bg-cream/15";
  const where = film.genres[0] === "TV" ? [film.collection, film.season != null && film.episode != null ? episodeLabel(film).split(" · ")[0] : null].filter(Boolean).join(" · ") : "";
  return (
    <div className="fixed inset-0 z-50 bg-black">
      <Picture
        className="size-full"
        powered
        channel={{ ...VOD_CHANNEL, name: where }}
        airing={airing}
        film={film}
        request={playRequestFor(airing, film)}
        digits=""
        notice={paused ? "Paused" : null}
        audio={tracks.audio}
        sub={tracks.sub}
        adjust={isRemote ? undefined : picture.value}
        compact={false}
        seekToken={seekToken}
        paused={paused}
        onDemand={{ targetMs: () => (clockRef.current && !clockRef.current.paused && clockRef.current.id === film.id ? serverNow() - clockRef.current.at : null), onTime, onStream: () => void (holdPos.current && (holdPos.current.streamed = true)), onTogglePause: togglePause, onEnded: finish }}
        onToggleView={() => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen();
        }}
        toolbar={
          <div className="flex items-start gap-3">
            <TrackMenu tracks={tracks} className="flex flex-col gap-1.5" />
            {isRemote ? null : <PictureMenu picture={picture} icon />}
            {next ? (
              <button type="button" className={buttonClass} onClick={() => setPlaying({ film: next, fromMs: resumeMs(next.id), session: playing.session + 1 })}>
                Next episode ⏭
              </button>
            ) : null}
            <button type="button" className="rounded-md bg-cream/20 px-3 py-1.5 text-xs font-semibold text-cream ring-1 ring-cream/25 hover:bg-cream/30" onClick={close}>
              ✕ Back
            </button>
          </div>
        }
        footer={
          <div className="flex items-center gap-2 rounded-lg bg-black/55 px-3 py-2">
            <button type="button" className={skipClass} onClick={() => seek(pos - 10_000)} title="Back 10 seconds (←)">
              ↺ 10
            </button>
            <button type="button" className="w-8 text-lg text-cream" onClick={togglePause} title="Play / pause (Space, or click the picture)">
              {paused ? "▶" : "❚❚"}
            </button>
            <button type="button" className={skipClass} onClick={() => seek(pos + 10_000)} title="Forward 10 seconds (→)">
              10 ↻
            </button>
            <span className="ml-1 w-16 text-right text-xs text-cream/80 tabular-nums">{clock(shown)}</span>
            {/* Skips once on release: a skip past what is loaded starts a new stream. */}
            <input
              type="range"
              min={0}
              max={duration}
              step={1000}
              value={shown}
              onChange={(event) => setDrag(Number(event.target.value))}
              onPointerUp={commitDrag}
              onKeyUp={commitDrag}
              onBlur={commitDrag}
              className="flex-1 accent-[var(--color-accent)]"
              aria-label="Position"
            />
            <span className="w-16 text-xs text-cream/80 tabular-nums">-{clock(duration - shown)}</span>
          </div>
        }
      />
    </div>
  );
}
