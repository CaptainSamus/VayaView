import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { backdropUrl, posterUrl } from "@/lib/library/art";
import type { Film } from "@/lib/library/types";
import { resumeMs, watchOf } from "@/lib/watch";
import { episodeLabel, Row, Tile, type Pick, type Show } from "./streaming";
import { GapTile } from "./streaming-missing";
import type { Missing } from "@/lib/missing";

/**
 * CINEMA LOOK: the title page. A whole screen, like the big streaming apps: the
 * backdrop fills the top, the poster and the facts sit over its lower edge, and
 * the rest of the franchise or the episodes follow underneath.
 */
export function TitlePage({
  pick,
  movies,
  onClose,
  onPick,
  onPlay,
  leaving = false,
  hop = false,
  missing,
}: {
  missing: Missing;
  pick: Pick;
  movies: Film[];
  /** Play was pressed: the words fade away and the backdrop is left on its own. */
  leaving?: boolean;
  /** Opened from another title page: no slide-in, which would show the screen behind for a moment. */
  hop?: boolean;
  onClose: () => void;
  onPick: (pick: Pick) => void;
  onPlay: (film: Film, fromMs?: number) => void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  // The backdrop fades in once it has loaded, never showing half an image.
  const [shown, setShown] = useState(false);
  // Leaving for the film: back to the top, where the backdrop is.
  useEffect(() => {
    if (leaving) pageRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [leaving]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const film = pick.kind === "film" ? pick.film : null;
  const show = pick.kind === "show" ? pick.show : null;
  const films = pick.kind === "collection" ? pick.films : [];
  // Films of the same franchise that are not on disk, when "Show missing" is on.
  const gaps = missing.show ? missing.inCollection(film?.collectionId ?? films[0]?.collectionId) : [];
  const gapTiles = gaps.map((gap) => <GapTile key={gap.id} gap={gap} wanted={missing.wanted(gap.id)} retro={false} onOpen={() => onPick({ kind: "gap", gap })} />);
  const backdrop = backdropUrl(film?.backdrop ?? show?.backdrop ?? films.find((item) => item.backdrop)?.backdrop);
  const poster = posterUrl(film?.poster ?? show?.poster ?? [...films].sort((a, b) => a.year - b.year)[0]?.poster, 500);
  const title = (film?.title ?? show?.name ?? (pick.kind === "collection" ? pick.name : "")).replace(/ Collection$/, "");

  // Specials (season 0) go last when there are real seasons.
  const seasons = useMemo(() => (show ? [...new Set(show.episodes.map((item) => item.season ?? 0))].sort((a, b) => (a === 0 ? 1e9 : a) - (b === 0 ? 1e9 : b)) : []), [show]);
  const [season, setSeason] = useState<number | null>(null);
  const activeSeason = season ?? seasons[0] ?? 0;
  const nextUp = useMemo(() => {
    if (!show) return null;
    const touched = show.episodes.map((item, i) => ({ entry: watchOf(item.id), i })).filter(({ entry }) => entry);
    const last = touched.sort((a, b) => (b.entry?.at ?? 0) - (a.entry?.at ?? 0))[0];
    if (!last) return show.episodes.find((item) => (item.season ?? 0) === seasons[0]) ?? show.episodes[0];
    return last.entry?.done ? (show.episodes[last.i + 1] ?? show.episodes[0]) : show.episodes[last.i];
  }, [show, seasons]);

  const related = useMemo(() => {
    if (!film) return { franchise: [] as Film[], similar: [] as Film[] };
    const franchise = film.collection ? movies.filter((item) => item.collection === film.collection && item.id !== film.id).sort((a, b) => a.year - b.year) : [];
    const genre = film.genres[1];
    const similar = genre
      ? movies
          .filter((item) => item.id !== film.id && item.collection !== film.collection && item.genres.includes(genre))
          .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
          .slice(0, 20)
      : [];
    return { franchise, similar };
  }, [film, movies]);

  const resume = film ? resumeMs(film.id) : 0;
  const quality = film ? ((film.height ?? 0) >= 1800 ? "4K" : (film.height ?? 0) >= 700 ? "HD" : null) : null;
  const facts = film
    ? [film.year || null, formatDuration(film.durationMs), film.rating ? `★ ${film.rating}` : null]
    : show
      ? [show.year || null, `${seasons.filter((n) => n > 0).length || 1} season${seasons.length > 1 ? "s" : ""}`, `${show.episodes.length} episodes`, show.rating ? `★ ${show.rating}` : null]
      : [gaps.length ? `${films.length} of ${films.length + gaps.length} films` : `${films.length} films`];
  const genres = film ? film.genres.slice(1) : show ? show.genres : [];
  const synopsis = film?.synopsis ?? show?.synopsis ?? "";
  const ghost = "rounded-lg bg-cream/15 px-5 py-3 text-sm font-semibold text-cream backdrop-blur hover:bg-cream/25";
  const big = "flex items-center gap-2 rounded-lg bg-cream px-7 py-3 text-base font-bold text-room shadow-lg hover:bg-white";

  return (
    <div ref={pageRef} className={cn("fixed inset-0 z-40 bg-room", !hop && "parlor-page", leaving ? "overflow-hidden" : "overflow-y-auto")}>
      {/* The backdrop, fading into the page. */}
      <div className="absolute inset-x-0 top-0 overflow-hidden transition-[height] duration-700" style={{ height: leaving ? "100vh" : "88vh" }}>
        {backdrop ? (
          <img
            src={backdrop}
            alt=""
            onLoad={() => setShown(true)}
            className="size-full object-cover object-top transition-opacity duration-500"
            style={{ opacity: shown ? 1 : 0 }}
          />
        ) : null}
        {/* The tint stays on when Play is pressed, so the picture does not brighten before the black. */}
        <div className="absolute inset-0 bg-black/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-room via-room/55 to-room/10" />
        <div className="absolute inset-0 bg-gradient-to-r from-room/95 via-room/45 to-transparent" />
      </div>

      <button
        type="button"
        onClick={onClose}
        style={{ opacity: leaving ? 0 : 1 }}
        className="fixed top-4 transition-opacity duration-500 left-4 z-50 flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 text-sm font-semibold text-cream backdrop-blur hover:bg-black/75"
      >
        ← Back
      </button>

      <section style={{ opacity: leaving ? 0 : 1 }} className="relative flex min-h-[80vh] transition-opacity duration-500 items-end px-8 pt-24 pb-8 xl:px-14">
        <div className="flex w-full items-end gap-8">
          {poster ? (
            <img
              src={poster}
              alt=""
              data-play-origin
              className="hidden w-52 shrink-0 rounded-xl shadow-2xl ring-1 ring-cream/15 md:block xl:w-64"
            />
          ) : null}
          <div className="min-w-0 max-w-3xl">
            <p className="text-xs font-semibold tracking-[0.3em] text-accent uppercase">{film ? "Film" : show ? "TV series" : "Collection"}</p>
            <h1 className="font-title mt-2 text-4xl leading-[1.05] font-bold text-cream drop-shadow-lg xl:text-6xl">{title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-cream/75">
              {facts.filter(Boolean).map((fact) => (
                <span key={String(fact)}>{fact}</span>
              ))}
              {quality ? <span className="rounded border border-cream/40 px-1.5 text-[11px] font-bold">{quality}</span> : null}
            </div>
            {genres.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {genres.map((genre) => (
                  <span key={genre} className="rounded-full bg-cream/10 px-3 py-0.5 text-xs text-cream/80">
                    {genre}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {film ? (
                <>
                  <button type="button" className={big} onClick={() => onPlay(film)}>
                    ▶ {resume ? "Resume" : "Play"}
                  </button>
                  {resume ? (
                    <button type="button" className={ghost} onClick={() => onPlay(film, 0)}>
                      ↺ Start over
                    </button>
                  ) : null}
                </>
              ) : nextUp ? (
                <button type="button" className={big} onClick={() => onPlay(nextUp)}>
                  ▶ {resumeMs(nextUp.id) ? "Resume" : "Play"} {episodeLabel(nextUp).split(" · ")[0]}
                </button>
              ) : null}
            </div>
            {film && resume ? (
              <div className="mt-3 flex max-w-xs items-center gap-3 text-xs text-cream/60">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-cream/20">
                  <div className="h-full bg-accent" style={{ width: `${(resume / film.durationMs) * 100}%` }} />
                </div>
                {formatDuration(film.durationMs - resume)} left
              </div>
            ) : null}

            {synopsis ? <p className="mt-6 max-w-2xl text-base leading-relaxed text-cream/85">{synopsis}</p> : null}
            {film?.director ? (
              <p className="mt-3 text-sm text-cream/55">
                Directed by <span className="text-cream/85">{film.director}</span>
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <div style={{ opacity: leaving ? 0 : 1 }} className="relative pb-16 transition-opacity duration-500 xl:px-9">
        {film && (related.franchise.length || gapTiles.length) ? (
          <Row label={`More in ${film.collection?.replace(/ Collection$/, "")}`} retro={false}>
            {related.franchise.map((item) => (
              <Tile key={item.id} title={item.title} sub={item.year ? String(item.year) : ""} poster={item.poster} film={item} retro={false} onOpen={() => onPick({ kind: "film", film: item })} />
            ))}
            {gapTiles}
          </Row>
        ) : null}
        {film && related.similar.length ? (
          <Row label="More like this" retro={false}>
            {related.similar.map((item) => (
              <Tile key={item.id} title={item.title} sub={item.year ? String(item.year) : ""} poster={item.poster} film={item} retro={false} onOpen={() => onPick({ kind: "film", film: item })} />
            ))}
          </Row>
        ) : null}
        {film?.fileName ? <p className="mt-8 truncate px-5 text-xs text-cream/25">{film.fileName}</p> : null}

        {show ? <Episodes show={show} seasons={seasons} active={activeSeason} onSeason={setSeason} onPlay={onPlay} /> : null}

        {pick.kind === "collection" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-5 px-5">
            {[...films].sort((a, b) => a.year - b.year).map((item) => (
              <Tile key={item.id} title={item.title} sub={item.year ? String(item.year) : ""} poster={item.poster} film={item} retro={false} onOpen={() => onPick({ kind: "film", film: item })} />
            ))}
            {gapTiles}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Episodes({ show, seasons, active, onSeason, onPlay }: { show: Show; seasons: number[]; active: number; onSeason: (n: number) => void; onPlay: (film: Film) => void }) {
  return (
    <section className="px-5">
      {seasons.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {seasons.map((number) => (
            <button
              key={number}
              type="button"
              className={cn("rounded-full px-4 py-1.5 text-sm", number === active ? "bg-cream font-semibold text-room" : "bg-cream/10 text-cream hover:bg-cream/20")}
              onClick={() => onSeason(number)}
            >
              {number === 0 ? (seasons.length > 1 ? "Specials" : "Episodes") : `Season ${number}`}
            </button>
          ))}
        </div>
      ) : (
        <h2 className="mb-3 text-lg font-semibold text-cream">Episodes</h2>
      )}
      <ul className="grid gap-2">
        {show.episodes
          .filter((item) => (item.season ?? 0) === active)
          .map((item) => {
            const entry = watchOf(item.id);
            const progress = entry && entry.ms > 0 ? entry.ms / item.durationMs : 0;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onPlay(item)}
                  className="group flex w-full items-center gap-4 rounded-xl bg-cream/[0.04] px-4 py-3 text-left ring-1 ring-transparent hover:bg-cream/10 hover:ring-cream/15"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-cream/10 text-sm text-cream group-hover:bg-accent group-hover:text-room">▶</span>
                  <span className="w-12 shrink-0 text-sm text-cream/50 tabular-nums">{item.episode != null ? `E${item.episode}` : ""}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-cream">{item.title}</span>
                    {progress > 0 ? (
                      <span className="mt-1.5 block h-1 max-w-48 overflow-hidden rounded-full bg-cream/15">
                        <span className="block h-full bg-accent" style={{ width: `${Math.min(100, progress * 100)}%` }} />
                      </span>
                    ) : null}
                  </span>
                  {entry?.done ? <span className="text-xs text-cream/45">✓ Watched</span> : null}
                  <span className="w-16 shrink-0 text-right text-xs text-cream/45 tabular-nums">{formatDuration(item.durationMs)}</span>
                </button>
              </li>
            );
          })}
      </ul>
    </section>
  );
}

/**
 * The moments between pressing Play and the film. Nothing is scaled up, so
 * the artwork stays sharp.
 * - "page": the title page has already faded its words away, leaving the
 *   backdrop; this lets it rest a moment, then fades to black.
 * - "browse": the screen dims, the film's backdrop opens from a line across
 *   the middle like a widescreen curtain, with its title, then fades to black.
 * The player starts underneath while it is dark, so it is ready to fade in.
 */
export type IntroKind = "page" | "browse";
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const TIMES: Record<IntroKind, { dark: number; cover: number; reveal: number; done: number }> = {
  page: { dark: 400, cover: 780, reveal: 1350, done: 2050 },
  browse: { dark: 850, cover: 450, reveal: 1250, done: 1850 },
};

export function PlayIntro({ kind, src, title, onCover, onDone }: { kind: IntroKind; src: string | null; title: string; onCover: () => void; onDone: () => void }) {
  const [stage, setStage] = useState<"start" | "open" | "dark" | "reveal">("start");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const t = TIMES[kind];
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setStage("open")));
    const timers = [
      window.setTimeout(() => setStage("dark"), t.dark),
      window.setTimeout(onCover, t.cover),
      window.setTimeout(() => setStage("reveal"), t.reveal),
      window.setTimeout(onDone, t.done),
    ];
    return () => {
      cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per press
  }, []);

  // The black that ends every opening, then lifts off the player.
  const black = (
    <div
      className="absolute inset-0 bg-black"
      style={{
        opacity: stage === "dark" ? 1 : 0,
        transition: stage === "reveal" ? `opacity 650ms ${EASE}` : kind === "page" ? "opacity 350ms ease-in" : "opacity 600ms ease-in-out",
      }}
    />
  );

  if (kind === "page") return <div className="pointer-events-none fixed inset-0 z-[60]">{black}</div>;

  // The room behind softens and darkens; the film's backdrop opens from the centre through a
  // feathered oval (no hard edge), the title rises, then it all sinks into black.
  const open = stage !== "start";
  const showing = open && loaded && stage === "open";
  const mask = "radial-gradient(ellipse closest-side, #000 55%, transparent 100%)";
  // Once open it stays open; the fade to black is a plain fade, never a shrink.
  const size = open && loaded ? "320% 320%" : "55% 55%";
  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-xl"
        style={{ opacity: stage === "reveal" ? 0 : open ? 1 : 0, transition: "opacity 300ms ease-out" }}
      />
      <div
        className="absolute inset-0 bg-black"
        style={{ opacity: stage === "reveal" ? 0 : open ? 1 : 0, transition: stage === "reveal" ? `opacity 550ms ${EASE}` : "opacity 300ms ease-in 120ms" }}
      />
      {src ? (
        <div
          className="absolute inset-0"
          style={{
            maskImage: mask,
            WebkitMaskImage: mask,
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
            maskSize: size,
            WebkitMaskSize: size,
            opacity: showing ? 1 : 0,
            transition: showing
              ? `opacity 450ms ease-out, mask-size 900ms ${EASE}, -webkit-mask-size 900ms ${EASE}`
              : "opacity 380ms ease-in",
          }}
        >
          <img src={src} alt="" onLoad={() => setLoaded(true)} className="size-full object-cover" />
          {/* The same dark tint the banner and title pages wear, so nothing brightens on the way to black. */}
          <div className="absolute inset-0 bg-black/30" />
          <div className="absolute inset-0 bg-gradient-to-t from-room via-room/40 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-room/80 via-room/25 to-transparent" />
          <p
            className="font-title absolute bottom-[12%] left-[6%] max-w-[60%] text-4xl leading-tight font-bold text-cream drop-shadow-2xl xl:text-6xl"
            style={{ opacity: showing ? 1 : 0, transform: showing ? "none" : "translateY(10px)", transition: `opacity 500ms ease-out 200ms, transform 700ms ${EASE} 200ms` }}
          >
            {title}
          </p>
        </div>
      ) : null}
    </div>
  );
}
