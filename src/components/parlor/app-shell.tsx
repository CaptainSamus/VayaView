import { lazy, Suspense, useEffect, useState } from "react";
import { useShared } from "@/lib/shared";
import { durable } from "@/lib/durable";
import { leaveMusic } from "@/lib/music-volume";
import { isTv } from "@/lib/remote";
import { libraryInfo } from "@/lib/library/catalog";
import { switchLibrary } from "@/lib/library/disk";
import type { AppMode } from "./mode-switch";
import { MusicParty } from "./music";
import { ParlorApp } from "./parlor-app";
import { StreamingView } from "./streaming";

type MusicLook = "guide" | "party";

/** Spotify party mode needs neither library, so it is only loaded when opened. */
const SpotifyMode = lazy(() => import("./spotify"));

/**
 * The whole app: one mode at a time. Each mode has its own player, so leaving
 * the TV stops its picture, and coming back rejoins the clock.
 * Music runs the same guide on the music folder, with its own stations, so the
 * film library is swapped out while Music is open and back in when it closes.
 */
export function AppShell() {
  const [mode, setModeRaw] = useState<AppMode>(() => {
    const saved = durable.getItem("parlor.mode");
    return saved === "streaming" || saved === "music" || saved === "store" || saved === "spotify" ? saved : "tv";
  });
  useEffect(() => durable.setItem("parlor.mode", mode), [mode]);

  // On a Fire TV only one app can make sound. Outside the Spotify screen (Live TV, Music…), a Spotify party
  // playing through THIS TV's Spotify would fight the picture for the sound (black flashes, songs skipped),
  // so pause it. It happened when the TV app reopened on Live TV with the party still going (2026-11-16).
  useEffect(() => {
    if (!isTv || mode === "spotify") return;
    const check = async () => {
      let mine = "";
      try {
        mine = localStorage.getItem("vv.tvSpotifyPlayer") ?? "";
      } catch {
        // no storage: nothing known
      }
      if (!mine) return;
      try {
        const [party, spotify] = await Promise.all([
          fetch("/api/party/state").then((r) => r.json()),
          fetch("/api/spotify/status").then((r) => r.json()),
        ]);
        if (party?.playing && spotify?.deviceId === mine) await fetch("/api/party/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      } catch {
        // the PC is away: nothing to do
      }
    };
    void check();
    const timer = window.setInterval(check, 4000);
    return () => window.clearInterval(timer);
  }, [mode]);
  const setMode = (next: AppMode) => {
    if (mode === "music" && next !== "music") leaveMusic();
    setModeRaw(next);
  };
  const [look, setLook] = useState<MusicLook>(() => (durable.getItem("parlor.musicLook") === "party" ? "party" : "guide"));
  useEffect(() => durable.setItem("parlor.musicLook", look), [look]);
  // Complete Sync: the mode and the music look are the same on every screen. (A TV has no 3D store yet: it stays put.)
  useShared<AppMode>("mode", mode, (next) => {
    if (isTv && next === "store") return;
    setMode(next);
  });
  useShared<MusicLook>("musicLook", look, setLook);

  // Which library is loaded; a mode is shown only once its own library is in.
  const want = mode === "music" ? "music" : "tv";
  const [loaded, setLoaded] = useState(libraryInfo.source);
  useEffect(() => {
    let alive = true;
    void switchLibrary(want).then(() => alive && setLoaded(want));
    return () => {
      alive = false;
    };
  }, [want]);

  if (mode === "spotify")
    return (
      <Suspense fallback={<main className="h-dvh bg-room" />}>
        <SpotifyMode onMode={setMode} />
      </Suspense>
    );
  if (loaded !== want)
    return <main className="flex h-dvh items-center justify-center text-cream/60">{want === "music" ? "Tuning in the music…" : "Loading your library…"}</main>;
  if (mode === "music")
    return look === "party" ? (
      <MusicParty key="party" onMode={setMode} onGuide={() => setLook("guide")} />
    ) : (
      <ParlorApp key="music" music onMode={setMode} onParty={() => setLook("party")} />
    );
  if (mode === "store") return <StreamingView key="store" store onMode={setMode} />;
  return mode === "streaming" ? <StreamingView key="streaming" onMode={setMode} /> : <ParlorApp key="tv" onMode={setMode} />;
}
