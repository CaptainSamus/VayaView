import { useEffect, useMemo, useRef, useState } from "react";
import { musicStartVolume, musicVolumeChanged } from "@/lib/music-volume";
import { cn } from "@/lib/cn";
import { isRemote } from "@/lib/remote";
import { catalogById } from "@/lib/library/catalog";
import { onNow } from "@/lib/schedule/engine";
import { ModeSwitch, type AppMode } from "./mode-switch";
import { Lineup } from "./lineup";
import { Picture } from "./picture";
import { useTracks } from "./tracks";
import { scheduleLibrary, useParlor } from "./use-parlor";

/**
 * MUSIC MODE · PARTY LOOK
 * The music stations (the same ones the Music guide edits) as a full-screen
 * music-TV channel: the picture, a list of stations down the side, and a card
 * with the artist, song and year when each song starts.
 * Keys are the guide's: ↑ ↓ change station, G or Esc shows and hides the list.
 */
export function MusicParty({ onMode, onGuide }: { onMode: (mode: AppMode) => void; onGuide: () => void }) {
  const parlor = useParlor();
  const { state, channel, airing, film, request, now, missing } = parlor;
  const tracks = useTracks(film);
  const panelOpen = parlor.overlay !== "none";
  const channels = useMemo(() => [...state.channels].sort((a, b) => a.number - b.number), [state.channels]);

  // Up/Down follow the station list on screen (1 at the top): Up moves up the list, to the station before.
  // The guide's "channel up = next number" made the remote feel upside down here (user, 2026-11-16).
  const dispatch = parlor.dispatch;
  // Edit stations right here (the station list stays on the left), no trip to the guide (user, 2026-11-18).
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const panel = panelOpen || editing;
  const skipRef = useRef(parlor.skip);
  skipRef.current = parlor.skip;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The remote's fast-forward skips the song (a TV has no Skip button here).
      if (editingRef.current && event.key === "Escape") {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        setEditing(false);
        return;
      }
      if (editingRef.current) return; // the editor has the keys
      if (event.key === "MediaFastForward") {
        event.preventDefault();
        skipRef.current();
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const active = document.activeElement;
      if (active && active !== document.body) return; // a button is highlighted: the remote moves between buttons
      event.preventDefault();
      event.stopImmediatePropagation();
      dispatch({ type: "step", dir: event.key === "ArrowUp" ? -1 : 1 });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dispatch]);

  // The song card shows for a few seconds when a song starts or the station changes, then gets out of the way.
  const cardKey = `${channel?.id}|${film?.id}`;
  const [cardAt, setCardAt] = useState({ key: "", at: 0 });
  useEffect(() => setCardAt({ key: cardKey, at: Date.now() }), [cardKey]);
  const cardOn = cardAt.key === cardKey && (now ?? 0) - cardAt.at < 9000;
  const next = airing?.next ? catalogById.get(airing.next.mediaId) : undefined;
  const song = (item: typeof film) => (item ? { artist: item.director, title: item.synopsis || item.title } : null);
  const playing = song(film);

  const buttonClass = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20";

  return (
    <main className="relative h-dvh overflow-hidden bg-black">
      {/* With the station list open the picture sits beside it, so nothing is covered. */}
      <div className="absolute inset-y-0 right-0 transition-[left] duration-300" style={{ left: panel ? "22rem" : 0 }}>
        <Picture
          className="size-full"
          ownVolume={{ start: musicStartVolume(), onChange: musicVolumeChanged }}
          powered={state.powered}
          channel={channel}
          airing={airing}
          film={film}
          request={request}
          digits={parlor.digits}
          notice={parlor.notice}
          audio={tracks.audio}
          sub={tracks.sub}
          compact={false}
          seekToken={0}
          onToggleView={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen();
          }}
          toolbar={
            <>
            <button type="button" className={buttonClass} onClick={parlor.skip} title="Skip to the next song (N)">
              Skip song ⏭
            </button>
            <button type="button" className={buttonClass} onClick={() => parlor.setOverlay(panel ? "none" : "guide")}>
              {panel ? "Hide stations" : "Stations"}
            </button>
            </>
          }
        />
      </div>

      {playing ? (
        <div
          key={film?.id}
          className="parlor-in pointer-events-none absolute bottom-36 left-10 z-20 max-w-[60%] drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] transition-opacity duration-1000"
          style={{ marginLeft: panel ? "22rem" : 0, opacity: cardOn ? 1 : 0 }}
        >
          {playing.artist ? <p className="text-sm font-semibold tracking-[0.25em] text-accent uppercase">{playing.artist}</p> : null}
          <p className="font-title text-3xl leading-tight font-bold text-cream xl:text-4xl">{playing.title}</p>
          <p className="mt-1 text-sm text-cream/70">
            {[film?.year || null, film?.genres[1] ?? null].filter(Boolean).join(" · ")}
            {next ? <span className="text-cream/45"> · Next: {next.title}</span> : null}
          </p>
        </div>
      ) : null}

      {editing ? (
        <div data-station-editor className="absolute inset-y-0 right-0 z-40 flex flex-col bg-room" style={{ left: "22rem" }}>
          <Lineup
            className="min-h-0 flex-1"
            state={state}
            dispatch={parlor.dispatch}
            onClose={() => setEditing(false)}
            history={parlor.history}
            onUndo={parlor.undo}
            onRestore={parlor.restore}
          />
        </div>
      ) : null}

      <aside
        className={cn(
          "absolute inset-y-0 left-0 z-30 flex w-[22rem] flex-col bg-room/90 backdrop-blur-md transition-transform duration-300",
          panel ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-cream/10 p-4">
          <ModeSwitch mode="music" onMode={onMode} />
          <div className="ml-auto flex gap-2">
            {isRemote ? null : (
              <button
                type="button"
                className={cn(buttonClass, "bg-accent font-semibold text-black hover:bg-accent/85")}
                onClick={() => setEditing((on) => !on)}
                title="Make, change and reorder stations, right here"
              >
                {editing ? "Done editing" : "Edit stations"}
              </button>
            )}
            <button type="button" className={buttonClass} onClick={onGuide} title="The TV-guide layout (its ← Party view button comes back here)">
              Guide view
            </button>
          </div>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {channels.map((item, index) => {
            // Each station gets its own quiet, dark tint (golden-angle hues so neighbours differ).
            const hue = Math.round((index * 137.5 + 20) % 360);
            const on = now != null ? onNow(item, scheduleLibrary, missing, now) : null;
            const current = on ? catalogById.get(on.slot.mediaId) : undefined;
            const active = item.id === channel?.id;
            return (
              <li key={item.id} className="mb-1">
                <button
                  type="button"
                  onClick={() => parlor.dispatch({ type: "tune", id: item.id })}
                  className={cn("w-full rounded-lg border-l-[3px] px-3 py-2.5 text-left transition-[filter] hover:brightness-125", active ? "ring-1 ring-accent" : "")}
                  style={{
                    background: `hsl(${hue} ${active ? 30 : 24}% ${active ? 20 : 14}%)`,
                    borderLeftColor: `hsl(${hue} 32% 34%)`,
                  }}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="w-7 shrink-0 text-sm font-semibold text-cream/50 tabular-nums">{item.number}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold text-cream" style={item.color ? { color: item.color } : undefined}>
                      {item.favorite ? "★ " : ""}
                      {item.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-cream/40">{item.mediaIds.length} videos</span>
                  </div>
                  {current ? <p className="mt-0.5 truncate pl-9 text-xs text-cream/60">{current.title}</p> : null}
                  {on ? (
                    <div className="mt-1.5 ml-9 h-0.5 overflow-hidden rounded bg-cream/10">
                      <div className="h-full bg-accent/70" style={{ width: `${(on.offsetMs / on.slot.durationMs) * 100}%` }} />
                    </div>
                  ) : null}
                </button>
              </li>
            );
          })}
          {channels.length === 0 ? <p className="p-3 text-sm text-cream/50">No music stations yet. Open Guide & edit to make one.</p> : null}
        </ul>
        <p className="border-t border-cream/10 px-4 py-3 text-[11px] text-cream/35">↑ ↓ change station · N skips a song · G hides this list · click the picture for sound</p>
      </aside>
    </main>
  );
}
