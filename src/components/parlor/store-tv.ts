import { durable } from "@/lib/durable";
import { onNow } from "@/lib/schedule/engine";
import type { Airing, Channel, Schedulable } from "@/lib/schedule/types";

/** The music stations, read without touching the film library the store is showing. */
export type MusicTv = {
  channels: Channel[];
  library: Map<string, Schedulable & { artist: string; song: string }>;
  missing: Set<string>;
};

type MusicVideo = { id: string; title: string; artist: string; durationMs: number; missing?: boolean };

export async function loadMusicTv(): Promise<MusicTv | null> {
  try {
    const data = (await (await fetch("/api/music")).json()) as { folder: string | null; videos: MusicVideo[] };
    if (!data.folder || !data.videos?.length) return null;
    const library = new Map(
      data.videos.map((video) => [video.id, { id: video.id, title: video.title, durationMs: video.durationMs, artist: video.artist, song: video.title }]),
    );
    const missing = new Set(data.videos.filter((video) => video.missing).map((video) => video.id));
    const raw = durable.getItem(`parlor.v2.music:${data.folder}`);
    const state = raw ? (JSON.parse(raw) as { state?: { channels?: Channel[]; missingIds?: string[] } }).state : null;
    let channels = (state?.channels ?? []).filter((channel) => Array.isArray(channel.mediaIds) && typeof channel.anchorMs === "number");
    for (const id of state?.missingIds ?? []) missing.add(id);
    // No stations saved yet: one that plays everything.
    if (!channels.length)
      channels = [{ id: "all", number: 1, name: "All Music Videos", callSign: "MTV", mode: "shuffle", shuffleSeed: "store", anchorMs: 0, mediaIds: [...library.keys()], query: null } as unknown as Channel];
    channels = channels.slice().sort((a, b) => a.number - b.number);
    return { channels, library, missing };
  } catch {
    return null;
  }
}

export function airingOn(tv: MusicTv, channel: Channel, nowMs = Date.now()): Airing | null {
  return onNow(channel, tv.library, tv.missing, nowMs);
}
