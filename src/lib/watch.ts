/**
 * Where you left off in each film or episode, and what you have finished.
 * Saved in the durable store (one key, `parlor.watch`), so it is backed up with
 * the stations. Only on-demand play (the Streaming view) writes here; the TV
 * channels run on the clock and never do.
 */
import { durable } from "./durable.ts";

const KEY = "parlor.watch";

/** `ms`: position. `at`: when it was last watched. `done`: watched to the end. */
export type WatchEntry = { ms: number; at: number; done?: boolean };

let cache: Record<string, WatchEntry> | null = null;

function all(): Record<string, WatchEntry> {
  if (cache) return cache;
  try {
    cache = JSON.parse(durable.getItem(KEY) ?? "{}") as Record<string, WatchEntry>;
  } catch {
    cache = {};
  }
  return cache;
}

export function watchOf(id: string): WatchEntry | undefined {
  return all()[id];
}

export function watchAll(): Record<string, WatchEntry> {
  return all();
}

/** Within the last few minutes counts as finished; the credits are not worth resuming. */
export function recordPosition(id: string, ms: number, durationMs: number): void {
  const map = all();
  const done = durationMs > 0 && ms >= durationMs - Math.min(8 * 60_000, durationMs * 0.08);
  if (ms < 60_000 && !map[id]) return;
  map[id] = done ? { ms: 0, at: Date.now(), done: true } : { ms, at: Date.now(), done: map[id]?.done };
  durable.setItem(KEY, JSON.stringify(map));
}

export function clearPosition(id: string): void {
  const map = all();
  if (!map[id]) return;
  map[id] = { ...map[id], ms: 0 };
  durable.setItem(KEY, JSON.stringify(map));
}

/** Where to start: the saved spot, unless the film was finished (which resets it) or barely begun. */
export function resumeMs(id: string): number {
  const entry = all()[id];
  return entry && entry.ms >= 60_000 ? entry.ms : 0;
}
