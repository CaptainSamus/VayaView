import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { backdropUrl, posterUrl } from "@/lib/library/art";
import type { Film } from "@/lib/library/types";
import { missingActions, refreshCatalog, searchTmdb, type Gap, type Missing } from "@/lib/missing";
import { Row, Tile, type Pick } from "./streaming";

/**
 * Films not in the library: greyed-out tiles, their own page (want list, hide),
 * the want list page, and the Undo note after hiding.
 */

export function GapTile({ gap, wanted, retro, onOpen }: { gap: Gap; wanted: boolean; retro: boolean; onOpen: () => void }) {
  const url = posterUrl(gap.poster);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${gap.title} (not in your library)`}
      data-gap={gap.id}
      className="group relative w-36 shrink-0 text-left transition-transform duration-200 hover:z-10 hover:scale-105 focus-visible:scale-105 xl:w-40"
    >
      <div className={cn("relative aspect-[2/3] overflow-hidden bg-bezel shadow-lg ring-1 ring-cream/10 group-hover:ring-2 group-hover:ring-cream/40", retro ? "rounded-sm" : "rounded-lg")}>
        {url ? (
          <img src={url} alt="" loading="lazy" className="size-full object-cover opacity-45 grayscale transition duration-300 group-hover:opacity-70" />
        ) : (
          <div className="flex size-full items-end bg-gradient-to-br from-cream/10 to-bezel p-3">
            <span className="font-title text-base leading-tight font-semibold text-cream/60">{gap.title}</span>
          </div>
        )}
        <span className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 text-[10px] font-semibold tracking-wide text-cream/70 uppercase">Missing</span>
        {wanted ? <span className="absolute top-1.5 right-1.5 rounded-full bg-accent px-1.5 text-[10px] font-bold text-room">★ Want</span> : null}
      </div>
      <p className="mt-1.5 truncate text-sm text-cream/50">{gap.title}</p>
      <p className="truncate text-xs text-cream/30">{gap.year || ""}</p>
    </button>
  );
}

/** Hiding needs the button held down for a moment, so a stray click can't do it. */
function HoldButton({ label, onDone, ms = 1400 }: { label: string; onDone: () => void; ms?: number }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef(0);
  const start = () => {
    setHolding(true);
    timer.current = window.setTimeout(() => {
      setHolding(false);
      onDone();
    }, ms);
  };
  const stop = () => {
    window.clearTimeout(timer.current);
    setHolding(false);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(event) => (event.key === " " || event.key === "Enter") && !event.repeat && start()}
      onKeyUp={stop}
      onBlur={stop}
      className="relative overflow-hidden rounded-lg bg-cream/10 px-5 py-3 text-sm font-semibold text-cream/80 select-none hover:bg-cream/15"
    >
      <span
        className="absolute inset-y-0 left-0 bg-red-500/45"
        style={{ width: holding ? "100%" : "0%", transition: holding ? `width ${ms}ms linear` : "width 200ms ease-out" }}
      />
      <span className="relative">{holding ? "Keep holding…" : label}</span>
    </button>
  );
}

export function GapPage({ gap, missing, movies, hop, onClose, onPick }: { gap: Gap; missing: Missing; movies: Film[]; hop: boolean; onClose: () => void; onPick: (pick: Pick) => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const wanted = missing.wanted(gap.id);
  const backdrop = backdropUrl(gap.backdrop);
  const poster = posterUrl(gap.poster, 500);
  const source = gap.collection ? gap.collection.replace(/ Collection$/, "") : missing.isManual(gap.id) ? "Added by you" : "Top rated";
  const siblings = gap.collectionId ? movies.filter((film) => film.collectionId === gap.collectionId).sort((a, b) => a.year - b.year) : [];
  const otherGaps = missing.inCollection(gap.collectionId).filter((item) => item.id !== gap.id);

  return (
    <div className={cn("fixed inset-0 z-40 overflow-y-auto bg-room", !hop && "parlor-page")}>
      <div className="absolute inset-x-0 top-0 h-[88vh] overflow-hidden">
        {backdrop ? (
          <img src={backdrop} alt="" onLoad={() => setShown(true)} className="size-full object-cover object-top grayscale-[60%] transition-opacity duration-500" style={{ opacity: shown ? 1 : 0 }} />
        ) : null}
        <div className="absolute inset-0 bg-black/45" />
        <div className="absolute inset-0 bg-gradient-to-t from-room via-room/55 to-room/10" />
        <div className="absolute inset-0 bg-gradient-to-r from-room/95 via-room/45 to-transparent" />
      </div>
      <button type="button" onClick={onClose} className="fixed top-4 left-4 z-50 flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 text-sm font-semibold text-cream backdrop-blur hover:bg-black/75">
        ← Back
      </button>

      <section className="relative flex min-h-[80vh] items-end px-8 pt-24 pb-8 xl:px-14">
        <div className="flex w-full items-end gap-8">
          {poster ? <img src={poster} alt="" className="hidden w-52 shrink-0 rounded-xl opacity-70 shadow-2xl ring-1 ring-cream/15 grayscale md:block xl:w-64" /> : null}
          <div className="min-w-0 max-w-3xl">
            <p className="text-xs font-semibold tracking-[0.3em] text-cream/50 uppercase">Not in your library · {source}</p>
            <h1 className="font-title mt-2 text-4xl leading-[1.05] font-bold text-cream/90 drop-shadow-lg xl:text-6xl">{gap.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-cream/65">
              {gap.year ? <span>{gap.year}</span> : null}
              {gap.rating ? <span>★ {gap.rating}</span> : null}
            </div>
            {gap.genres.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {gap.genres.map((genre) => (
                  <span key={genre} className="rounded-full bg-cream/10 px-3 py-0.5 text-xs text-cream/70">
                    {genre}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => missingActions.toggleWant(gap)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-7 py-3 text-base font-bold shadow-lg",
                  wanted ? "bg-accent text-room hover:brightness-110" : "bg-cream text-room hover:bg-white",
                )}
              >
                {wanted ? "★ On your want list" : "＋ Add to want list"}
              </button>
              {missing.isManual(gap.id) ? (
                <button type="button" onClick={() => { missingActions.removeManual(gap.id); onClose(); }} className="rounded-lg bg-cream/10 px-5 py-3 text-sm font-semibold text-cream/80 hover:bg-cream/15">
                  Remove from VayaView
                </button>
              ) : (
                <HoldButton
                  label="Hold to hide"
                  onDone={() => {
                    missingActions.hide(gap);
                    onClose();
                  }}
                />
              )}
            </div>
            {gap.overview ? <p className="mt-6 max-w-2xl text-base leading-relaxed text-cream/75">{gap.overview}</p> : null}
          </div>
        </div>
      </section>

      {siblings.length || otherGaps.length ? (
        <div className="relative pb-16 xl:px-9">
          <Row label={`Also in ${source}`} retro={false}>
            {siblings.map((film) => (
              <Tile key={film.id} title={film.title} sub={film.year ? String(film.year) : ""} poster={film.poster} film={film} retro={false} onOpen={() => onPick({ kind: "film", film })} />
            ))}
            {otherGaps.map((item) => (
              <GapTile key={item.id} gap={item} wanted={missing.wanted(item.id)} retro={false} onOpen={() => onPick({ kind: "gap", gap: item })} />
            ))}
          </Row>
        </div>
      ) : null}
    </div>
  );
}

/** The want list, adding a film by hand, and the hidden films. */
export function WantPage({ missing, onClose, onPick }: { missing: Missing; onClose: () => void; onPick: (pick: Pick) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Gap[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !(event.target instanceof HTMLInputElement) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function search() {
    if (!query.trim()) return;
    setError(null);
    try {
      setResults(await searchTmdb(query.trim()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Search failed");
    }
  }
  const copy = () => {
    void navigator.clipboard.writeText(missing.want.map((gap) => `${gap.title}${gap.year ? ` (${gap.year})` : ""}`).join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const small = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20";

  return (
    <div className="parlor-page fixed inset-0 z-40 overflow-y-auto bg-room px-8 pt-20 pb-16 xl:px-14">
      <button type="button" onClick={onClose} className="fixed top-4 left-4 z-50 flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 text-sm font-semibold text-cream backdrop-blur hover:bg-black/75">
        ← Back
      </button>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.3em] text-accent uppercase">To download</p>
          <h1 className="font-title mt-1 text-4xl font-bold text-cream">Want list</h1>
        </div>
        <p className="mb-1 text-sm text-cream/50">{missing.want.length} films · each one leaves the list by itself once it's in your library</p>
        {missing.want.length ? (
          <button type="button" className={cn(small, "mb-1 ml-auto")} onClick={copy}>
            {copied ? "Copied ✓" : "Copy list"}
          </button>
        ) : null}
      </div>

      {missing.want.length ? (
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4">
          {missing.want.map((gap) => (
            <GapTile key={gap.id} gap={gap} wanted retro={false} onOpen={() => onPick({ kind: "gap", gap })} />
          ))}
        </div>
      ) : (
        <p className="mt-6 text-cream/50">Nothing yet. Turn on “Show missing” and open a greyed-out film, or add one below.</p>
      )}

      <h2 className="mt-12 text-lg font-semibold text-cream">Add a film by hand</h2>
      <p className="text-sm text-cream/50">It shows greyed out with your films and goes on the want list.</p>
      <form
        className="mt-3 flex max-w-xl gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Film title…"
          className="flex-1 rounded-full bg-bezel px-4 py-2 text-sm text-cream outline-none placeholder:text-cream/35 focus:outline-2 focus:outline-accent"
        />
        <button type="submit" className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-room hover:brightness-110">
          Search
        </button>
      </form>
      {error ? <p className="mt-2 text-sm text-red-300">{error}</p> : null}
      {results ? (
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4">
          {results.length === 0 ? <p className="text-cream/50">No films found.</p> : null}
          {results.map((gap) => {
            const have = missing.owned(gap);
            const added = missing.isManual(gap.id) || missing.wanted(gap.id);
            return (
              <div key={gap.id}>
                <GapTile gap={gap} wanted={missing.wanted(gap.id)} retro={false} onOpen={() => (have ? undefined : onPick({ kind: "gap", gap }))} />
                <button
                  type="button"
                  disabled={have || added}
                  onClick={() => missingActions.addManual(gap)}
                  className={cn("mt-1 w-full rounded-md px-2 py-1 text-xs font-semibold", have || added ? "bg-cream/5 text-cream/40" : "bg-cream/15 text-cream hover:bg-cream/25")}
                >
                  {have ? "In your library" : added ? "Added ✓" : "＋ Add"}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <h2 className="mt-12 text-lg font-semibold text-cream">Hidden films</h2>
      {missing.hidden.length ? (
        <ul className="mt-3 max-w-xl divide-y divide-cream/10">
          {missing.hidden.map((gap) => (
            <li key={gap.id} className="flex items-center gap-3 py-2 text-sm text-cream/70">
              <span className="min-w-0 flex-1 truncate">
                {gap.title} {gap.year ? <span className="text-cream/40">({gap.year})</span> : null}
              </span>
              <button type="button" className={small} onClick={() => missingActions.restore(gap.id)}>
                Show again
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-cream/50">None. Hide a missing film from its page by holding “Hold to hide”.</p>
      )}

      <div className="mt-12 flex items-center gap-3 text-xs text-cream/40">
        <button type="button" className={small} onClick={refreshCatalog}>
          Refresh franchises and top rated
        </button>
        {missing.building ? "Fetching from TMDB…" : missing.error ? `TMDB: ${missing.error}` : "These refresh by themselves once a week."}
      </div>
    </div>
  );
}

export function UndoHide({ missing }: { missing: Missing }) {
  const last = missing.lastHidden;
  useEffect(() => {
    if (!last) return;
    const timer = window.setTimeout(missingActions.dismissUndo, 8000);
    return () => window.clearTimeout(timer);
  }, [last]);
  if (!last) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-[55] flex -translate-x-1/2 items-center gap-4 rounded-full bg-bezel px-5 py-2.5 text-sm text-cream shadow-2xl ring-1 ring-cream/15">
      Hid {last.title}
      <button type="button" className="font-semibold text-accent hover:underline" onClick={() => missingActions.restore(last.id)}>
        Undo
      </button>
    </div>
  );
}
