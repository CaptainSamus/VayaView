// Spotify party mode. VayaView is the remote, the queue and the screen; the Spotify app (on the PC or the
// TV) plays the sound, because Spotify's audio is protected and only its own apps may play it.
// - The user makes a free developer app on developer.spotify.com and pastes its Client ID; sign-in uses
//   PKCE, so there is no secret. Tokens live in Data/parlor-spotify.json and never leave the PC.
// - The queue lives here (Data/parlor-party.json), so the PC screen and every guest see the same one.
//   Spotify gets one song at a time; a timer starts the next one just before the current one ends.
// - Guests scan a QR code on the PC screen and get /party (party.html) with the party code: they can
//   search, add songs and add the host's playlists. Skipping, removing and settings are the host's.
// - "Play my music video" (on by default): when a song coming up is in the music library, Spotify pauses
//   and the PC screen plays the video, sound and all, start to finish; then the queue carries on.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = "https://api.spotify.com/v1";
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative";
const QUEUE_MAX = 400;

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const newCode = () => String(crypto.randomInt(0, 10_000)).padStart(4, "0");

/** Song names compared loosely: "Pump It - Radio Edit" = "Pump It"; "The Black Eyed Peas" = "Black Eyed Peas". */
const flat = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");
const cleanTitle = (title) =>
  String(title ?? "")
    .replace(/\s*[([][^)\]]*[)\]]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+(?:feat|ft)\.?\s.*$/i, "")
    .trim();

export function createSpotify({ dataDir, sendJson, readBody, musicVideos }) {
  const file = path.join(dataDir, "parlor-spotify.json");
  const partyFile = path.join(dataDir, "parlor-party.json");
  const pageFile = path.join(import.meta.dirname, "party.html");
  /** Changes when VayaView is updated, so phones with the page open reload the new one. */
  const pageStamp = (() => {
    try {
      return String(fs.statSync(pageFile).mtimeMs);
    } catch {
      return "";
    }
  })();
  const read = (where, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(where, "utf8"));
    } catch {
      return fallback;
    }
  };

  /** clientId, refresh, access, expires, name, deviceId, videos */
  const config = read(file, {});
  const save = () => fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const party = { code: newCode(), queue: [], now: null, history: [], ...read(partyFile, {}), playing: false };
  // The song that was on when VayaView last closed is over: Play must start the queue, not bring it back.
  if (party.now) party.history = [{ ...party.now, startedAt: undefined }, ...party.history].slice(0, 30);
  party.now = null;
  // Where songs come from: the queue people build, or the host's chosen playlist (party.playlist:
  // { id, name, art, tracks, pos, shuffle }). With autoPlaylist on, an empty queue hands over to the playlist.
  if (party.source !== "playlist") party.source = "queue";
  party.playlist ??= null;
  if (typeof party.autoPlaylist !== "boolean") party.autoPlaylist = true;
  let partyTimer = null;
  const saveParty = () => {
    clearTimeout(partyTimer);
    partyTimer = setTimeout(() => fs.writeFile(partyFile, JSON.stringify({ ...party, playing: undefined }), () => {}), 400);
  };

  let pending = null; // sign-in in progress: { verifier, state, redirect }
  let error = "";
  let backoffUntil = 0;
  let uiSeen = 0; // the Spotify screen asks for the queue every second while it is open
  const uiAlive = () => Date.now() - uiSeen < 5000;

  // ------------------------------------------------------------ Spotify Web API
  async function token() {
    if (!config.refresh || !config.clientId) throw Object.assign(new Error("Spotify is not connected."), { status: 401 });
    if (config.access && Date.now() < config.expires - 60_000) return config.access;
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: config.refresh, client_id: config.clientId }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.error === "invalid_grant") {
        config.refresh = null;
        save();
      }
      throw new Error(body.error_description || body.error || `Spotify sign-in answered ${response.status}`);
    }
    config.access = body.access_token;
    config.expires = Date.now() + body.expires_in * 1000;
    if (body.refresh_token) config.refresh = body.refresh_token;
    save();
    return config.access;
  }

  async function api(method, where, body) {
    if (Date.now() < backoffUntil) throw new Error("Spotify asked VayaView to slow down for a moment.");
    const response = await fetch(API + where, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : method === "PUT" || method === "POST" ? "" : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429) {
      backoffUntil = Date.now() + Number(response.headers.get("retry-after") || 5) * 1000;
      throw new Error("Spotify asked VayaView to slow down for a moment.");
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Some player calls answer with an empty or plain body.
    }
    if (!response.ok) throw Object.assign(new Error(json?.error?.message || `Spotify answered ${response.status}`), { status: response.status, reason: json?.error?.reason });
    return json;
  }

  const art = (images) => {
    const list = (images ?? []).slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    return { big: list[0]?.url ?? "", small: (list.find((img) => (img.width ?? 0) <= 320) ?? list[list.length - 1])?.url ?? "" };
  };
  const trackOf = (t) =>
    t && typeof t.uri === "string" && t.uri.startsWith("spotify:track:")
      ? { id: t.id, uri: t.uri, name: t.name, artists: (t.artists ?? []).map((a) => a.name), album: t.album?.name ?? "", albumUri: t.album?.uri ?? "", art: art(t.album?.images), durationMs: t.duration_ms }
      : null;
  /** Songs guests saw in a search, so adding one needs no second request (and they can't send made-up ones). */
  const seen = new Map();
  const remember = (track) => {
    seen.set(track.id, track);
    if (seen.size > 2000) seen.delete(seen.keys().next().value);
    return track;
  };

  // ------------------------------------------------------------ Music videos
  let videoCache = { at: 0, list: [] };
  async function videos() {
    if (Date.now() - videoCache.at > 60_000) {
      try {
        videoCache = { at: Date.now(), list: (await musicVideos()).filter((v) => !v.missing) };
      } catch {
        videoCache.at = Date.now();
      }
    }
    return videoCache.list;
  }
  async function findVideo(track) {
    const title = flat(cleanTitle(track.name));
    if (!title) return null;
    const artists = track.artists.map(flat).filter(Boolean);
    const hit = (await videos()).find((v) => flat(cleanTitle(v.title)) === title && artists.some((a) => flat(v.artist).includes(a)));
    return hit ? { id: hit.id, direct: Boolean(hit.direct), durationMs: hit.durationMs, rel: hit.rel } : null;
  }

  // ------------------------------------------------------------ Playing
  async function devices() {
    return (await api("GET", "/me/player/devices"))?.devices ?? [];
  }
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  /** Is Spotify's current song this one? (Spotify sometimes swaps in another copy of the same song.) */
  // Spotify often plays a re-released copy of the song asked for (another id, "butter" for "Butter", the artist
  // renamed), and no longer says so (linked_from was removed in 2026): same title loosely + same length counts.
  const isSong = (item, track) =>
    Boolean(
      item &&
        track &&
        (item.id === track.id || item.uri === track.uri || (track.name && flat(cleanTitle(item.name)) === flat(cleanTitle(track.name)) && Math.abs(item.duration_ms - track.durationMs) < 3000)),
    );
  /** Wait up to ~2 s for Spotify to be on this song; make sure it is playing. */
  async function landed(track, device) {
    for (let i = 0; i < 5; i++) {
      await sleep(400);
      const state = await api("GET", "/me/player").catch(() => null);
      if (isSong(state?.item, track)) {
        if (party.now && isSong(state.item, party.now)) party.now.confirmed = true;
        if (!state.is_playing) await api("PUT", `/me/player/play?device_id=${device}`).catch(() => {});
        return true;
      }
    }
    return false;
  }
  /**
   * Start a song on Spotify. The user's Spotify for Windows ignored "play this song" (the API answered OK and
   * it restarted the song from the last session), so the song is put in Spotify's own queue and skipped to,
   * which it does obey; it is then checked, skipping again past anything queued in front of it.
   */
  /** The album a song is on (songs from older queues or public playlists don't carry it yet). */
  async function albumOf(track) {
    if (track.albumUri == null || (track.albumUri === "" && !track.albumChecked)) {
      const full = track.id ? await api("GET", `/tracks/${track.id}`).catch(() => null) : null;
      track.albumUri = full?.album?.uri ?? "";
      track.albumChecked = true;
    }
    return track.albumUri;
  }
  async function pickDevice() {
    const list = await devices();
    const pick = list.find((d) => d.id === config.deviceId) ?? list.find((d) => d.is_active) ?? list.find((d) => d.type === "Computer") ?? list[0];
    if (!pick) throw new Error("Open Spotify on this PC (or on the TV) so VayaView has something to play through.");
    if (!pick.is_active) {
      await api("PUT", "/me/player", { device_ids: [pick.id], play: false }).catch(() => {});
      await sleep(800);
    }
    return pick.id;
  }
  /**
   * Start a song (at track.resumeMs when it was switched away from), and make sure Spotify is really on it.
   * Tested on the user's Spotify for Windows (2026-11-16):
   * 1. The song inside its album (context + offset), the way Spotify's own apps start a song: always obeyed,
   *    and it never touches Spotify's queue. The main way.
   * 2. "Play this song" (uris): flaky there (it sometimes just restarts the song that was on).
   * 3. Spotify's queue + skip: obeyed, but anything abandoned stays in Spotify's queue, so only as a last resort.
   */
  async function playUri(uri) {
    const track = party.now?.uri === uri ? party.now : { uri, id: uri.split(":")[2] };
    const device = await pickDevice();
    const at = Math.max(0, Math.round(track.resumeMs ?? 0));
    const done = () => {
      delete track.resumeMs;
      track.progressMs = at;
      track.progressAt = Date.now();
      error = "";
    };
    const album = await albumOf(track);
    if (album && (await api("PUT", `/me/player/play?device_id=${device}`, { context_uri: album, offset: { uri }, position_ms: at }).then(() => true, () => false)) && (await landed(track, device))) return done();
    if ((await api("PUT", `/me/player/play?device_id=${device}`, { uris: [uri], position_ms: at }).then(() => true, () => false)) && (await landed(track, device))) return done();
    const waiting = await api("GET", "/me/player/queue").catch(() => null);
    if (!waiting?.queue?.some((item) => isSong(item, track))) await api("POST", `/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${device}`);
    for (let i = 0; i < 4; i++) {
      try {
        await api("POST", `/me/player/next?device_id=${device}`);
      } catch {
        // "Restriction violated": Spotify won't skip from where it stopped. Start it, then skip.
        await api("PUT", `/me/player/play?device_id=${device}`).catch(() => {});
        await sleep(600);
        await api("POST", `/me/player/next?device_id=${device}`).catch(() => {});
      }
      if (await landed(track, device)) {
        if (at > 1500) await api("PUT", `/me/player/seek?position_ms=${at}&device_id=${device}`).catch(() => {});
        return done();
      }
    }
    throw new Error("Spotify wouldn't switch songs. VayaView keeps trying; Skip moves on.");
  }

  const pauseQuietly = () => api("PUT", "/me/player/pause").catch(() => {});

  let endTimer = null;
  let nextPoll = 0;
  let advancing = null;
  /** The next song in the queue starts (or the party goes quiet when it is empty). */
  const shuffled = (list) =>
    list
      .map((t) => [Math.random(), t])
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => t);
  /** The next song from the chosen playlist, starting over (reshuffled) at its end. */
  function fromPlaylist() {
    const pl = party.playlist;
    if (!pl?.tracks?.length) return null;
    if (pl.pos >= pl.tracks.length) {
      pl.pos = 0;
      if (pl.shuffle) pl.tracks = shuffled(pl.tracks);
    }
    if (pl.resume) {
      const back = pl.resume;
      pl.resume = null;
      return back;
    }
    const track = pl.tracks[pl.pos++];
    return { ...track, key: crypto.randomBytes(6).toString("hex"), by: "", fromPlaylist: pl.name, hasVideo: false };
  }
  /** Is there something to play next (from the current source, or the playlist taking over)? */
  const hasNext = () =>
    (party.source === "queue" && party.queue.length > 0) || (Boolean(party.playlist?.tracks?.length) && (party.source === "playlist" || party.autoPlaylist));
  function nextItem() {
    if (party.source === "queue") {
      const item = party.queue.shift();
      if (item) return item;
      if (!party.autoPlaylist || !party.playlist?.tracks?.length) return null;
      party.source = "playlist"; // the queue ran out: the playlist takes over
    }
    return fromPlaylist();
  }
  /**
   * Switching to the other source mid-song: the song goes back where it came from (front of the queue, or
   * first in the playlist) with where it got to, instead of into history, so it carries on when switched back.
   */
  function putBack() {
    const cur = party.now;
    if (!cur || party.source === (cur.fromPlaylist ? "playlist" : "queue")) return;
    // A couple of seconds back, so nothing is missed when it comes back.
    const at = cur.mode === "spotify" ? Math.max(0, (publicNow()?.progressMs ?? 0) - 2000) : 0;
    const back = { ...cur, resumeMs: at, startedAt: undefined, confirmed: undefined, tries: undefined, mode: undefined, video: undefined, paused: undefined };
    if (!cur.fromPlaylist) party.queue.unshift(back);
    else if (party.playlist) party.playlist.resume = back;
    party.now = null; // not into history: it isn't finished
  }
  function advance() {
    advancing ??= (async () => {
      clearTimeout(endTimer);
      endTimer = null;
      nextPoll = 0;
      if (party.now) party.history = [{ ...party.now, startedAt: undefined }, ...party.history].slice(0, 30);
      party.now = nextItem();
      saveParty();
      const now = party.now;
      if (!now) {
        await pauseQuietly();
        return;
      }
      now.startedAt = Date.now();
      now.progressMs = now.resumeMs ?? 0;
      now.progressAt = Date.now();
      const video = config.videos !== false && uiAlive() ? await findVideo(now) : null;
      try {
        if (video) {
          now.mode = "video";
          now.video = video;
          await pauseQuietly();
        } else {
          now.mode = "spotify";
          await playUri(now.uri);
        }
      } catch (problem) {
        error = problem.message; // the loop below tries again
        now.tries = 1;
      }
      saveParty();
    })().finally(() => (advancing = null));
    return advancing;
  }

  let ticking = false;
  let quickEnds = 0;
  async function tick() {
    if (!party.playing || !config.refresh || ticking || advancing || Date.now() < backoffUntil) return;
    ticking = true;
    try {
      const now = party.now;
      if (!now) {
        if (hasNext()) await advance();
        return;
      }
      if (now.mode === "video") {
        // The screen that plays videos was closed: the song plays on Spotify instead.
        if (!uiAlive()) {
          now.mode = "spotify";
          now.startedAt = Date.now();
          await playUri(now.uri);
        }
        return;
      }
      if (Date.now() < nextPoll) return;
      const state = await api("GET", "/me/player");
      if (party.now !== now || advancing) return; // the song changed while Spotify was answering
      const age = Date.now() - now.startedAt;
      const ours = isSong(state?.item, now);
      if (!ours) {
        if (now.confirmed && state && !state.is_playing) {
          // Something else stopped Spotify (another app took the sound, e.g. a video on the same TV, or
          // someone pressed pause in Spotify). Don't fight it or run through the queue: pause the party.
          party.playing = false;
          error = "Spotify was stopped from somewhere else. Press Play to carry on.";
          now.paused = true;
          return;
        }
        if (now.confirmed) {
          // Songs ending within seconds of starting, again and again, means something keeps interrupting
          // Spotify (another app on the same TV taking the sound): stop instead of running through the list.
          const played = (now.progressMs ?? 0) + (now.progressAt ? Date.now() - now.progressAt : 0);
          quickEnds = played < 8000 && (now.durationMs ?? 0) > 30000 ? quickEnds + 1 : 0;
          if (quickEnds >= 3) {
            quickEnds = 0;
            party.playing = false;
            error = "Spotify kept getting interrupted (is something else playing on that TV?). Press Play to carry on.";
            return;
          }
          // It played and Spotify has moved on (the song ended, autoplay): our next song.
          await advance();
          return;
        }
        // Spotify never got onto it: ask again rather than skipping it.
        if (age > 4000) {
          now.startedAt = Date.now();
          now.tries = (now.tries ?? 0) + 1;
          if (now.tries > 3) {
            party.playing = false;
            error = "Spotify wouldn't play this song. Press Skip, or Play to try again.";
            return;
          }
          await playUri(now.uri);
          error = "";
        } else nextPoll = Date.now() + 1000;
        return;
      }
      now.confirmed = true;
      now.progressMs = state.progress_ms;
      now.progressAt = Date.now();
      now.paused = !state.is_playing;
      if (!state.is_playing) {
        if (state.progress_ms === 0 && now.confirmed && age > 6000) await advance();
        nextPoll = Date.now() + 2000;
        return;
      }
      const left = state.item.duration_ms - state.progress_ms;
      if (left < 3500) {
        // Start the next song a moment before this one ends, so Spotify's autoplay never gets in.
        endTimer ??= setTimeout(() => {
          endTimer = null;
          void advance();
        }, Math.max(0, left - 300));
        nextPoll = Date.now() + 5000;
      } else nextPoll = Date.now() + Math.min(3000, left - 3000);
    } catch (problem) {
      error = problem.message;
      nextPoll = Date.now() + 3000;
    } finally {
      ticking = false;
    }
  }
  const loop = setInterval(() => void tick(), 1000);
  loop.unref?.();

  // ------------------------------------------------------------ Queue
  async function addTracks(tracks, by, next = false) {
    const room = QUEUE_MAX - party.queue.length;
    const items = [];
    for (const track of tracks.slice(0, Math.max(0, room))) {
      const video = await findVideo(track).catch(() => null);
      items.push({ ...track, key: crypto.randomBytes(6).toString("hex"), by: String(by ?? "").trim().slice(0, 24), hasVideo: Boolean(video) });
    }
    if (next) party.queue.unshift(...items);
    else party.queue.push(...items);
    // Nothing on: the first song added starts the party (a paused song stays paused).
    if (items.length && !party.now) {
      party.playing = true;
      party.source = "queue";
    }
    saveParty();
    return items.length;
  }
  async function playlistTracks(id) {
    const tracks = [];
    let where = `/playlists/${encodeURIComponent(id)}/items?limit=50`;
    while (where && tracks.length < 300) {
      const page = await api("GET", where);
      for (const row of page?.items ?? []) {
        const track = trackOf(row.item ?? row.track);
        if (track) tracks.push(remember(track));
      }
      where = page?.next ? page.next.replace(API, "") : null;
    }
    return tracks;
  }
  /** The host's playlists, newest first as Spotify lists them; mine = theirs (or shared to edit). */
  let ownCache = { at: 0, list: [] };
  async function ownPlaylists() {
    if (Date.now() - ownCache.at < 60_000) return ownCache.list;
    if (!config.userId) {
      const me = await api("GET", "/me");
      config.userId = me?.id ?? "";
      config.name ||= me?.display_name ?? "";
      save();
    }
    const list = await api("GET", "/me/playlists?limit=50");
    ownCache = {
      at: Date.now(),
      list: (list?.items ?? []).filter(Boolean).map((pl) => ({
        id: pl.id,
        name: pl.name,
        art: art(pl.images).small,
        count: pl.items?.total ?? pl.tracks?.total ?? 0,
        mine: pl.owner?.id === config.userId || Boolean(pl.collaborative),
      })),
    };
    return ownCache.list;
  }
  const GUEST_PLAYLISTS = 3;
  const guestPlaylists = async () => (await ownPlaylists()).filter((pl) => pl.mine).slice(0, GUEST_PLAYLISTS);
  const playlistId = (text) =>
    String(text ?? "")
      .trim()
      .replace(/^.*playlist[/:]/, "")
      .replace(/[?#].*$/, "");
  /**
   * Anyone's public playlist (a guest's own): the Web API only opens the host's, so this reads the songs from
   * Spotify's public embed page (about the first 50 to 100). Unofficial: if Spotify changes that page it stops working.
   */
  async function publicPlaylist(id) {
    const response = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("Spotify couldn't find that playlist. Make sure it's public.");
    const html = await response.text();
    const data = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
    const entity = data ? JSON.parse(data)?.props?.pageProps?.state?.data?.entity : null;
    if (!entity?.trackList) throw new Error("Spotify didn't show the songs of that playlist. Make sure it's public.");
    const cover = entity.coverArt?.sources?.[0]?.url ?? "";
    return {
      name: entity.name ?? "Playlist",
      art: cover,
      tracks: entity.trackList
        .filter((t) => typeof t.uri === "string" && t.uri.startsWith("spotify:track:"))
        .map((t) => ({ id: t.uri.split(":")[2], uri: t.uri, name: t.title, artists: String(t.subtitle ?? "").split(/,\s*/), album: "", art: { big: cover, small: cover }, durationMs: t.duration })),
    };
  }

  const publicNow = () => {
    const now = party.now;
    if (!now) return null;
    const progressMs = now.mode === "spotify" && !now.paused && party.playing ? now.progressMs + (Date.now() - now.progressAt) : now.progressMs;
    return { ...now, progressMs: Math.min(progressMs ?? 0, now.durationMs ?? 0) };
  };
  const state = (host) => ({
    page: pageStamp,
    now: publicNow(),
    queue: party.queue,
    history: party.history.slice(0, host ? 30 : 5),
    playing: party.playing,
    source: party.source,
    playlist: party.playlist ? { id: party.playlist.id, name: party.playlist.name, art: party.playlist.art, count: party.playlist.tracks.length, shuffle: party.playlist.shuffle } : null,
    playlistNext: host && party.playlist ? Array.from({ length: Math.min(5, party.playlist.tracks.length) }, (_, i) => party.playlist.tracks[(party.playlist.pos + i) % party.playlist.tracks.length]) : [],
    autoPlaylist: party.autoPlaylist,
    error,
    ...(host ? { code: party.code } : {}),
  });

  // ------------------------------------------------------------ Routes
  const fail = (res, problem) => sendJson(res, problem.status === 401 ? 401 : 502, { error: problem.message });

  /** Routes both the host and guests use. Returns false when the path isn't one of them. */
  async function shared(req, res, url, by, body = {}) {
    const p = url.pathname;
    try {
      if (p === "/api/party/state") return sendJson(res, 200, state(false));
      if (p === "/api/party/search") {
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
        if (!q) return sendJson(res, 200, { tracks: [] });
        const offset = Math.max(0, Math.min(40, Number(url.searchParams.get("offset")) || 0));
        const found = await api("GET", `/search?type=track&limit=10&offset=${offset}&q=${encodeURIComponent(q)}`);
        const tracks = (found?.tracks?.items ?? []).map(trackOf).filter(Boolean).map(remember);
        return sendJson(res, 200, { tracks });
      }
      if (p === "/api/party/playlists") {
        // Guests see only the host's few newest playlists; the host sees them all.
        const list = by.host ? await ownPlaylists() : await guestPlaylists();
        return sendJson(res, 200, { playlists: list.map(({ id, name, art: cover, count }) => ({ id, name, art: cover, count })) });
      }
      if (p === "/api/party/playlist-songs") {
        // One playlist's songs, to add one by one: the host's (guests: only the newest few) through the Web API,
        // or anyone's public playlist from its link.
        const id = playlistId(url.searchParams.get("id"));
        if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return sendJson(res, 400, { error: "That isn't a playlist link." });
        const own = (by.host ? await ownPlaylists() : await guestPlaylists()).find((pl) => pl.id === id && pl.mine);
        if (own) return sendJson(res, 200, { name: own.name, art: own.art, tracks: await playlistTracks(id) });
        return sendJson(res, 200, await publicPlaylist(id));
      }
      if (p === "/api/party/add" && req.method === "POST") {
        const id = String(body.id ?? "").replace(/^spotify:track:/, "");
        if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return sendJson(res, 400, { error: "That isn't a song." });
        const track = seen.get(id) ?? remember(trackOf(await api("GET", `/tracks/${id}`)));
        if (!track) return sendJson(res, 400, { error: "That isn't a song." });
        await addTracks([track], by(body), Boolean(body.next) && by.host);
        return sendJson(res, 200, state(false));
      }
      if (p === "/api/party/playlist" && req.method === "POST" && by.host) {
        // A whole playlist at once: the host only (guests add songs one by one).
        const id = playlistId(body.id);
        if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return sendJson(res, 400, { error: "That isn't a playlist." });
        let tracks = await playlistTracks(id).catch((problem) => {
          throw problem.status === 403 || problem.status === 404 ? new Error("Spotify only lets VayaView open the host's own playlists.") : problem;
        });
        if (!tracks.length) return sendJson(res, 400, { error: "Spotify only lets VayaView open the host's own playlists, and this one has no songs it can play." });
        if (body.shuffle) tracks = tracks.map((t) => [Math.random(), t]).sort((a, b) => a[0] - b[0]).map(([, t]) => t);
        const added = await addTracks(tracks, by(body));
        return sendJson(res, 200, { ...state(false), added });
      }
    } catch (problem) {
      return fail(res, problem);
    }
    return false;
  }

  /** The PC (and paired phones). */
  async function host(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith("/api/spotify") && !p.startsWith("/api/party")) return false;
    const redirect = `http://${String(req.headers.host ?? "127.0.0.1:47816").replace(/^localhost\b/, "127.0.0.1")}/api/spotify/callback`;
    const body = req.method === "POST" ? ((await readBody(req)) ?? {}) : {};
    try {
      if (p === "/api/spotify/status") {
        return sendJson(res, 200, {
          clientId: config.clientId ?? "",
          connected: Boolean(config.refresh),
          name: config.name ?? "",
          deviceId: config.deviceId ?? "",
          videos: config.videos !== false,
          redirect,
        });
      }
      if (p === "/api/spotify/settings" && req.method === "POST") {
        if (typeof body.clientId === "string" && !req.vvRemote) {
          const id = body.clientId.trim();
          if (id && !/^[A-Za-z0-9]{20,64}$/.test(id)) return sendJson(res, 400, { error: "That doesn't look like a Client ID (it's 32 letters and numbers)." });
          if (id !== config.clientId) Object.assign(config, { clientId: id, refresh: null, access: null, name: "" });
        }
        if (typeof body.videos === "boolean") config.videos = body.videos;
        if (typeof body.deviceId === "string") config.deviceId = body.deviceId;
        save();
        return sendJson(res, 200, { ok: true });
      }
      if (p === "/api/spotify/login") {
        if (!config.clientId) return sendJson(res, 400, { error: "Paste the Client ID first." });
        const verifier = base64url(crypto.randomBytes(48));
        pending = { verifier, state: base64url(crypto.randomBytes(16)), redirect };
        const query = new URLSearchParams({
          client_id: config.clientId,
          response_type: "code",
          redirect_uri: redirect,
          code_challenge_method: "S256",
          code_challenge: base64url(crypto.createHash("sha256").update(verifier).digest()),
          scope: SCOPES,
          state: pending.state,
        });
        res.writeHead(302, { Location: `https://accounts.spotify.com/authorize?${query}` });
        return res.end();
      }
      if (p === "/api/spotify/callback") {
        const page = (text) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><meta charset="utf-8"><title>VayaView</title><body style="font:20px system-ui;background:#12100e;color:#f3e9d8;display:grid;place-items:center;height:90vh;margin:0"><p>${text}</p>`);
        };
        const got = url.searchParams;
        if (!pending || got.get("state") !== pending.state) return page("This sign-in link is old. Press Connect Spotify in VayaView again.");
        if (got.get("error")) return page(`Spotify said: ${got.get("error").replace(/[<>&]/g, "")}. Press Connect Spotify in VayaView to try again.`);
        const response = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code: got.get("code") ?? "", redirect_uri: pending.redirect, client_id: config.clientId, code_verifier: pending.verifier }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await response.json().catch(() => ({}));
        pending = null;
        if (!response.ok) return page(`Spotify didn't accept the sign-in (${String(body.error_description || body.error || response.status).replace(/[<>&]/g, "")}). Check the Redirect URI in your Spotify app, then try again.`);
        Object.assign(config, { access: body.access_token, refresh: body.refresh_token, expires: Date.now() + body.expires_in * 1000 });
        save();
        try {
          const me = await api("GET", "/me");
          config.name = me?.display_name ?? "";
          config.userId = me?.id ?? "";
          ownCache = { at: 0, list: [] };
          save();
        } catch {
          // The name is only for show.
        }
        error = "";
        return page("VayaView is connected to Spotify. You can close this tab.");
      }
      if (p === "/api/spotify/logout" && req.method === "POST") {
        Object.assign(config, { refresh: null, access: null, name: "", userId: "" });
        ownCache = { at: 0, list: [] };
        party.playing = false;
        save();
        return sendJson(res, 200, { ok: true });
      }
      if (p === "/api/spotify/devices") return sendJson(res, 200, { devices: (await devices()).map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active })) });

      // The queue, from the host's side.
      if (p === "/api/party/state") {
        if (url.searchParams.get("ui") === "1") uiSeen = Date.now();
        return sendJson(res, 200, state(true));
      }
      if (req.method === "POST") {
        if (p === "/api/party/play") {
          party.playing = true;
          error = "";
          if (party.now) party.now.tries = 0;
          if (advancing) await advancing.catch(() => {});
          if (party.now?.mode === "spotify") {
            const now = party.now;
            // Hold off the once-a-second check until the song is really back on: while Spotify was being
            // asked, it read "Spotify isn't on it" as "it finished" and skipped songs at 0:00 (2026-11-16).
            advancing = (async () => {
              const on = await api("GET", "/me/player").catch(() => null);
              if (on?.item && isSong(on.item, now)) await api("PUT", `/me/player/play${config.deviceId ? `?device_id=${config.deviceId}` : ""}`).catch(() => playUri(now.uri));
              else {
                // Spotify isn't on it any more (the TV's Spotify let it go, another app took the sound):
                // start it again where it was paused, counted as not yet playing.
                now.confirmed = false;
                now.resumeMs = Math.max(0, (now.progressMs ?? 0) - 1000);
                await playUri(now.uri);
              }
              now.startedAt = Date.now();
              nextPoll = 0;
            })().finally(() => (advancing = null));
            await advancing;
          } else if (!party.now) await advance();
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/pause") {
          party.playing = false;
          clearTimeout(endTimer);
          endTimer = null;
          if (party.now?.mode === "spotify") {
            party.now.progressMs = publicNow().progressMs;
            party.now.progressAt = Date.now();
            await pauseQuietly();
          }
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/next") {
          party.playing = true;
          await advance();
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/video-ended") {
          if (party.now?.key === body.key) await advance();
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/video-failed") {
          // The video wouldn't play: the song plays on Spotify instead.
          if (party.now?.key === body.key && party.now.mode === "video") {
            party.now.mode = "spotify";
            party.now.startedAt = Date.now();
            await playUri(party.now.uri).catch((problem) => (error = problem.message));
          }
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/remove") {
          party.queue = party.queue.filter((item) => item.key !== body.key);
          saveParty();
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/move") {
          const from = party.queue.findIndex((item) => item.key === body.key);
          if (from >= 0) {
            const [item] = party.queue.splice(from, 1);
            const to = Math.max(0, Math.min(party.queue.length, Number(body.to) || 0));
            party.queue.splice(to, 0, item);
            saveParty();
          }
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/source") {
          // Switch between the queue and the playlist; now: start it straight away.
          if (body.source === "queue" || body.source === "playlist") party.source = body.source;
          if (body.now) putBack();
          if (body.now) {
            party.playing = true;
            await advance();
          }
          saveParty();
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/use-playlist") {
          // Choose the playlist (or none). Its songs are fetched once and kept.
          if (!body.id) party.playlist = null;
          else {
            const id = playlistId(body.id);
            const own = (await ownPlaylists()).find((pl) => pl.id === id);
            const got = own?.mine ? { name: own.name, art: own.art, tracks: await playlistTracks(id) } : await publicPlaylist(id);
            if (!got.tracks.length) return sendJson(res, 400, { error: "That playlist has no songs VayaView can play." });
            const shuffle = body.shuffle !== false;
            party.playlist = { id, name: got.name, art: got.art, tracks: shuffle ? shuffled(got.tracks) : got.tracks, pos: 0, shuffle };
            if (body.play) {
              party.source = "playlist";
              putBack();
              party.playing = true;
              await advance();
            }
          }
          if (!party.playlist && party.source === "playlist") party.source = "queue";
          saveParty();
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/auto-playlist") {
          party.autoPlaylist = Boolean(body.on);
          saveParty();
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/clear") {
          party.queue = [];
          saveParty();
          return sendJson(res, 200, state(true));
        }
        if (p === "/api/party/code") {
          party.code = newCode();
          saveParty();
          return sendJson(res, 200, state(true));
        }
      }
    } catch (problem) {
      return fail(res, problem);
    }
    const byHost = (body) => body.by || "Host";
    byHost.host = true;
    const handled = await shared(req, res, url, byHost, body);
    return handled === false ? sendJson(res, 404, { error: "Not found." }) : handled;
  }

  /**
   * Guests on the home network (the phone listener, no PIN): the party page, and with the party code
   * the queue, search and adding. Returns false for anything else, which then needs a paired phone.
   */
  async function guest(req, res, url) {
    const p = url.pathname;
    if (p === "/party") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(pageFile).pipe(res);
    }
    if (!p.startsWith("/api/party/")) return false;
    const code = req.headers["x-party-code"];
    if (code == null) return false; // a paired phone: the usual door
    if (String(code) !== party.code) return sendJson(res, 403, { error: "code" });
    if (!config.refresh) return sendJson(res, 503, { error: "The host hasn't connected Spotify yet." });
    const byGuest = (body) => body.by || "Guest";
    const handled = await shared(req, res, url, byGuest, req.method === "POST" ? ((await readBody(req)) ?? {}) : {});
    if (handled === false) return sendJson(res, 403, { error: "Only the host can do that." });
    return handled;
  }

  return { host, guest, dispose: () => clearInterval(loop) };
}
