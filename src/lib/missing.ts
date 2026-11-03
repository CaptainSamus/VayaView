import { useEffect, useMemo, useSyncExternalStore } from "react";
import { durable } from "@/lib/durable";
import type { Film } from "@/lib/library/types";

/**
 * FILMS NOT IN THE LIBRARY
 * Gaps in the franchises the library has a film from, TMDB's top rated films,
 * and anything added by hand. The want list, the hidden list and the hand-added
 * films are kept in the durable store. A wanted film leaves the want list by
 * itself once it turns up in the library.
 */

export type Gap = {
  id: number;
  title: string;
  year: number;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number;
  genres: string[];
  /** The franchise it belongs to, when it came from one. */
  collection?: string;
  collectionId?: number;
};
type Saved = Gap & { at: number };
type Catalog = { building: boolean; error: string | null; collections: Record<string, { name: string; parts: Gap[] }>; top: Gap[] };

const KEYS = { want: "parlor.want", hidden: "parlor.hidden", manual: "parlor.manual", show: "parlor.showMissing" };
const read = (key: string): Record<string, Saved> => {
  try {
    return JSON.parse(durable.getItem(key) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

let state = {
  want: read(KEYS.want),
  hidden: read(KEYS.hidden),
  manual: read(KEYS.manual),
  show: durable.getItem(KEYS.show) === "1",
  catalog: null as Catalog | null,
  /** The last film hidden, for Undo. */
  lastHidden: null as Saved | null,
  lastWant: null as Saved | null,
};
const listeners = new Set<() => void>();
function update(next: Partial<typeof state>) {
  state = { ...state, ...next };
  if (next.want) durable.setItem(KEYS.want, JSON.stringify(next.want));
  if (next.hidden) durable.setItem(KEYS.hidden, JSON.stringify(next.hidden));
  if (next.manual) durable.setItem(KEYS.manual, JSON.stringify(next.manual));
  if (next.show != null) durable.setItem(KEYS.show, next.show ? "1" : "0");
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const without = (record: Record<string, Saved>, id: number) => {
  const next = { ...record };
  delete next[id];
  return next;
};
const stamp = (gap: Gap): Saved => ({ ...gap, at: Date.now() });

export const missingActions = {
  setShow: (show: boolean) => update({ show }),
  toggleWant: (gap: Gap) => update({ want: state.want[gap.id] ? without(state.want, gap.id) : { ...state.want, [gap.id]: stamp(gap) } }),
  /** Added by hand: shows greyed out, and goes on the want list. */
  addManual: (gap: Gap) => update({ manual: { ...state.manual, [gap.id]: stamp(gap) }, want: { ...state.want, [gap.id]: stamp(gap) } }),
  removeManual: (id: number) => update({ manual: without(state.manual, id), want: without(state.want, id) }),
  hide: (gap: Gap) => update({ hidden: { ...state.hidden, [gap.id]: stamp(gap) }, want: without(state.want, gap.id), lastHidden: stamp(gap), lastWant: state.want[gap.id] ?? null }),
  /** Undo puts a wanted film back on the want list too. */
  restore: (id: number) =>
    update({
      hidden: without(state.hidden, id),
      ...(state.lastWant?.id === id ? { want: { ...state.want, [id]: state.lastWant } } : {}),
      lastHidden: state.lastHidden?.id === id ? null : state.lastHidden,
      lastWant: state.lastWant?.id === id ? null : state.lastWant,
    }),
  dismissUndo: () => update({ lastHidden: null }),
};

let loading = false;
async function loadCatalog(refresh = false) {
  if (loading) return;
  loading = true;
  try {
    const catalog = (await (await fetch(`/api/tmdb/catalog${refresh ? "?refresh=1" : ""}`)).json()) as Catalog;
    update({ catalog });
    // Still fetching franchises: look again shortly.
    if (catalog.building) window.setTimeout(() => void loadCatalog(), 4000);
  } catch {
    // No server or no token: nothing missing is shown.
  } finally {
    loading = false;
  }
}
export const refreshCatalog = () => void loadCatalog(true);

const norm = (title: string) => title.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

/** What is missing, worked out against the films on disk. */
export function useMissing(movies: Film[]) {
  const snap = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!state.catalog) void loadCatalog();
  }, []);

  const owned = useMemo(() => {
    const ids = new Set<number>();
    const titles = new Set<string>();
    for (const film of movies) {
      const match = /^movie\/(\d+)$/.exec(film.metadataId ?? "");
      if (match) ids.add(Number(match[1]));
      titles.add(`${norm(film.title)}|${film.year}`);
    }
    return (gap: Gap) => ids.has(gap.id) || titles.has(`${norm(gap.title)}|${gap.year}`);
  }, [movies]);

  // Arrived on disk: off the want list and the hand-added list.
  useEffect(() => {
    const want = Object.values(snap.want).filter(owned);
    const manual = Object.values(snap.manual).filter(owned);
    if (want.length || manual.length)
      update({
        want: want.reduce((record, gap) => without(record, gap.id), snap.want),
        manual: manual.reduce((record, gap) => without(record, gap.id), snap.manual),
      });
  }, [snap.want, snap.manual, owned]);

  return useMemo(() => {
    const keep = (gap: Gap) => !owned(gap) && !snap.hidden[gap.id];
    const byCollection = new Map<number, Gap[]>();
    for (const [id, entry] of Object.entries(snap.catalog?.collections ?? {})) {
      byCollection.set(
        Number(id),
        entry.parts.filter(keep).map((part) => ({ ...part, collection: entry.name, collectionId: Number(id) })).sort((a, b) => a.year - b.year),
      );
    }
    const franchise = [...byCollection.values()].flat();
    const seen = new Set(franchise.map((gap) => gap.id));
    const top = (snap.catalog?.top ?? []).filter((gap) => keep(gap) && !seen.has(gap.id));
    const manual = Object.values(snap.manual).filter(keep).sort((a, b) => b.at - a.at);
    const all = new Map<number, Gap>();
    for (const gap of [...franchise, ...top, ...manual]) if (!all.has(gap.id)) all.set(gap.id, gap);
    return {
      show: snap.show,
      ready: snap.catalog != null,
      building: snap.catalog?.building ?? false,
      error: snap.catalog?.error ?? null,
      franchise,
      top,
      manual,
      all: [...all.values()],
      want: Object.values(snap.want).filter((gap) => !owned(gap)).sort((a, b) => b.at - a.at),
      hidden: Object.values(snap.hidden).sort((a, b) => b.at - a.at),
      lastHidden: snap.lastHidden,
      wanted: (id: number) => Boolean(snap.want[id]),
      isManual: (id: number) => Boolean(snap.manual[id]),
      inCollection: (collectionId: number | null | undefined) => (collectionId ? (byCollection.get(collectionId) ?? []) : []),
      owned,
    };
  }, [snap, owned]);
}
export type Missing = ReturnType<typeof useMissing>;

export async function searchTmdb(query: string): Promise<Gap[]> {
  const response = await fetch(`/api/tmdb/search?q=${encodeURIComponent(query)}`);
  const body = (await response.json()) as { results?: Gap[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? "Search failed");
  return body.results ?? [];
}
