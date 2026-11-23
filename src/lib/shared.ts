/**
 * Complete Sync: when on, every screen (the PC, every TV, phones) shows the same thing.
 *
 * Not key presses (the PC and TV layouts differ, so the same press would land on different buttons) but
 * what is on screen: the mode, the channel, pause/skips, the open title page, the film and its spot.
 * Each screen posts what the viewer changed on it; the others poll the PC (/api/shared) and copy it.
 * Whoever touched something last wins. Turning it on makes that screen's state everyone's.
 */
import { useEffect, useRef, useState } from "react";

type Entry = { value: unknown; rev: number; from: string };
type State = { on: boolean; rev: number; epoch: number; keys: Record<string, Entry> };

/** This screen, so it never copies its own posts back. */
export const screenId = Math.random().toString(36).slice(2, 10);

let state: State = { on: false, rev: 0, epoch: 0, keys: {} };
let polling = false;
const watchers = new Set<() => void>();
/** The newest rev of each key this screen has applied or sent. */
const seen = new Map<string, number>();

function notify() {
  for (const watcher of watchers) watcher();
}

async function poll() {
  try {
    const next = (await fetch("/api/shared", { cache: "no-store" }).then((response) => response.json())) as State;
    if (next && typeof next.rev === "number" && (next.rev !== state.rev || next.on !== state.on)) {
      if (next.rev < state.rev) seen.clear(); // the PC restarted
      state = next;
      notify();
    }
  } catch {
    // the PC is away for a moment
  }
}

function start() {
  if (polling) return;
  polling = true;
  void poll();
  window.setInterval(() => void poll(), 500);
}

async function post(body: object) {
  try {
    const next = (await fetch("/api/shared", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json())) as State;
    if (next && typeof next.rev === "number") {
      // What this screen just sent counts as applied here.
      for (const [key, entry] of Object.entries(next.keys)) if (entry.from === screenId) seen.set(key, Math.max(seen.get(key) ?? 0, entry.rev));
      state = next;
      notify();
    }
  } catch {
    // the PC is away; nothing shared
  }
}

/** Complete Sync on or off (shared by every screen). Turning it on makes this screen's state everyone's. */
export function useCompleteSync(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(state.on);
  useEffect(() => {
    start();
    const watcher = () => setOn(state.on);
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
  }, []);
  const set = (next: boolean) => {
    void post({ on: next }).then(() => {
      if (next) window.dispatchEvent(new Event("vv-share-all"));
    });
  };
  return [on, set];
}

/**
 * One piece of what is on screen. `value` is this screen's current value (anything JSON); when the viewer
 * changes it here it is sent to the others, and when another screen changes it `apply` is called with theirs.
 * A screen that opens (or a mode that starts) takes the shared value instead of pushing its own.
 */
export function useShared<T>(key: string, value: T, apply: (value: T) => void, options?: { event?: boolean }) {
  // event: a one-off happening (a skip), not a state. It is never re-sent when Complete Sync turns on and a
  // screen that opens does not replay the last one (that skipped twice and put the screens out of step).
  const event = options?.event === true;
  const json = JSON.stringify(value ?? null);
  const last = useRef<string | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const valueRef = useRef(json);
  valueRef.current = json;

  useEffect(() => {
    start();
    const take = (opening = false) => {
      if (!state.on) return;
      const entry = state.keys[key];
      if (!entry || entry.from === screenId || entry.rev <= (seen.get(key) ?? 0)) return;
      seen.set(key, entry.rev);
      if (opening && event) return;
      const theirs = JSON.stringify(entry.value ?? null);
      last.current = theirs;
      if (theirs !== valueRef.current) applyRef.current(entry.value as T);
    };
    const pushAll = () => {
      if (event) return;
      last.current = valueRef.current;
      void post({ key, value: JSON.parse(valueRef.current), from: screenId });
    };
    // Opening: the shared value wins over this screen's own.
    last.current = valueRef.current;
    take(true);
    const watch = () => take();
    watchers.add(watch);
    window.addEventListener("vv-share-all", pushAll);
    return () => {
      watchers.delete(watch);
      window.removeEventListener("vv-share-all", pushAll);
    };
  }, [key]);

  // Changed here (not copied from another screen): tell the others.
  useEffect(() => {
    if (json === last.current) return;
    last.current = json;
    if (state.on) void post({ key, value: value ?? null, from: screenId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- json stands for value
  }, [json, key]);
}
