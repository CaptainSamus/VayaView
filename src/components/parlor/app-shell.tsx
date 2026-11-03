import { useEffect, useState } from "react";
import { durable } from "@/lib/durable";
import type { AppMode } from "./mode-switch";
import { ParlorApp } from "./parlor-app";
import { StreamingView } from "./streaming";

/**
 * The whole app: one mode at a time. Each mode has its own player, so leaving
 * the TV stops its picture, and coming back rejoins the clock.
 */
export function AppShell() {
  const [mode, setMode] = useState<AppMode>(() => (durable.getItem("parlor.mode") === "streaming" ? "streaming" : "tv"));
  useEffect(() => durable.setItem("parlor.mode", mode), [mode]);
  return mode === "streaming" ? <StreamingView onMode={setMode} /> : <ParlorApp onMode={setMode} />;
}
