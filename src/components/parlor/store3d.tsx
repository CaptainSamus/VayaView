import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { cn } from "@/lib/cn";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { backdropUrl, posterUrl } from "@/lib/library/art";
import type { Film } from "@/lib/library/types";
import { resumeMs, watchOf } from "@/lib/watch";
import { durable } from "@/lib/durable";
import type { Pick, Show } from "./streaming";
import { airingOn, loadMusicTv, type MusicTv } from "./store-tv";
import { buildBackRoom } from "./store-keeper";
import { buildFront } from "./store-front";
import { carpetMaterial } from "./store-carpet";
import { buildTheater, theaterTv, type LineupRow } from "./store-theater";
import { caseSeam, caseWear, wearFor } from "./store-case";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

/** The user's own painted model for behind the counter (public/models/keeper.glb). Height in metres, and the turn that makes it face the TV. */
const KEEPER_MODEL = { url: "/models/keeper.glb", height: 1.45, turn: 0 };
/** The rocking chair: runner radius (m), swing (radians) and seconds per rock. Courage stays put on the floor. */
const ROCK = { radius: 1.8, swing: 0.045, period: 3.6 };

/**
 * 3D STORE
 * The library as a walk-around video shop: one double-sided shelf run per genre,
 * cases face-out, a sign over each. Built fresh from the library every time, so
 * new films land on the shelves by themselves.
 *
 * Walking eases in and out with a light head bob. No footstep sounds (the user
 * found them bad; add only if asked).
 * Picking up a case brings it into your hands. Covers use only official artwork:
 * the poster on the front, and on the back the film's stills and title logo from
 * TMDB. Nothing is printed on that pretends to be packaging (no made-up logos or
 * text; the user asked for real scans or nothing).
 * Play: the disc slides out of the case (which stays in your hands), comes
 * toward you, and the film starts.
 *
 * Light by design: case shells are one instanced draw, covers load only near
 * you, and nothing is drawn while a film plays.
 */

type Item = { key: string; title: string; poster: string | null; tmdb: string | null; backdrop: string | null; pick: Pick };
type Section = { name: string; items: Item[] };
type Episode = { id: string; season: number; episode: number; title: string; progress: number; next: boolean };
type Holding = { title: string; play: string; sub: string; facts: string; synopsis: string; episodes: Episode[] };

// A Blu-ray keep case is 135 × 171 × 14 mm; the cover sits under a clear sleeve, a hair inside the edge.
const CASE = { w: 0.135, h: 0.171, d: 0.014 };
const COVER = { w: 0.129, h: 0.165 };
const PITCH = 0.165;
const PER_ROW = 14;
const UNIT = PER_ROW * PITCH;
const SHELF_Y = [0.42, 0.82, 1.22, 1.62];
const PER_SIDE = PER_ROW * SHELF_Y.length;
const ROW_GAP = 3.4;
/** The user's additions from their Blender copy of the store, and the store's corner when they placed them. */
const ADDITIONS = { url: "/models/store-additions.glb", leftX: -7.31, backZ: -24.4, channel: 8 };
const WALL_H = 3.4;
const EYE = 1.62;
const WALK = 3.4; // m/s
const RUN = 6.5;
const STRIDE = 0.85;

function filmOf(item: Item): Film | null {
  return item.pick.kind === "film" ? item.pick.film : null;
}
function showOf(item: Item): Show | null {
  return item.pick.kind === "show" ? item.pick.show : null;
}

/** The episode a show's Play button starts: the one last watched, or the next after it. */
function nextUp(show: Show): Film | undefined {
  const touched = show.episodes.map((item, i) => ({ entry: watchOf(item.id), i })).filter(({ entry }) => entry);
  const last = touched.sort((a, b) => (b.entry?.at ?? 0) - (a.entry?.at ?? 0))[0];
  if (!last) return [...show.episodes].sort((a, b) => (a.season || 1e9) - (b.season || 1e9) || (a.episode ?? 0) - (b.episode ?? 0))[0];
  return last.entry?.done ? (show.episodes[last.i + 1] ?? show.episodes[0]) : show.episodes[last.i];
}

function sections(movies: Film[], shows: Show[]): Section[] {
  const groups = new Map<string, Item[]>();
  for (const film of movies) {
    const genre = film.genres[1] ?? "Other";
    const item: Item = { key: film.id, title: film.title, poster: film.poster ?? null, tmdb: film.metadataId, backdrop: film.backdrop ?? null, pick: { kind: "film", film } };
    groups.set(genre, [...(groups.get(genre) ?? []), item]);
  }
  const big: Section[] = [];
  const more: Item[] = [];
  for (const [name, items] of groups) {
    if (items.length >= 6) big.push({ name, items });
    else more.push(...items);
  }
  big.sort((a, b) => b.items.length - a.items.length);
  if (more.length) big.push({ name: "More Movies", items: more });
  if (shows.length)
    big.push({
      name: "TV Shows",
      items: shows.map((show) => ({
        key: `show:${show.name}`,
        title: show.name,
        poster: show.poster,
        tmdb: show.episodes.find((e) => e.metadataId?.startsWith("tv/"))?.metadataId ?? null,
        backdrop: show.backdrop,
        pick: { kind: "show", show },
      })),
    });
  for (const section of big) section.items.sort((a, b) => a.title.localeCompare(b.title));
  return big;
}

// ---------- Images ----------

function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d") as CanvasRenderingContext2D];
}

function toTexture(source: HTMLCanvasElement | HTMLImageElement, anisotropy = 4): THREE.Texture {
  const texture = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** Draws `img` to fill the box, cropping what spills over. */
function fill(g: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** The front: the poster itself. A title card only when there is no poster at all. */
async function frontCover(item: Item, size: 185 | 500): Promise<THREE.Texture> {
  const img = await loadImage(posterUrl(item.poster, size));
  if (img) return toTexture(img, 8);
  const [c, g] = canvas(256, 328);
  g.fillStyle = "#16131f";
  g.fillRect(0, 0, 256, 328);
  g.fillStyle = "#f5ecd8";
  g.font = "bold 26px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const lines = wrap(g, item.title, 210);
  lines.forEach((line, i) => g.fillText(line, 128, 164 + (i - (lines.length - 1) / 2) * 30));
  return toTexture(c);
}

/** The back: official stills and the studio's title logo, nothing else. */
async function backCover(item: Item): Promise<THREE.Texture | null> {
  let art: { logo: string | null; stills: string[] } = { logo: null, stills: [] };
  if (item.tmdb) {
    try {
      art = await (await fetch(`/api/tmdb/art?id=${encodeURIComponent(item.tmdb)}`)).json();
    } catch {
      // Offline: fall back to the backdrop we already know.
    }
  }
  const stills = art.stills?.length ? art.stills : item.backdrop ? [item.backdrop] : [];
  const [main, ...rest] = await Promise.all(stills.slice(0, 3).map((path) => loadImage(backdropUrl(path, 1280))));
  const logo = await loadImage(art.logo ? posterUrl(art.logo, 500) : null);
  if (!main && !logo) return null;
  const W = 800;
  const H = Math.round((W * COVER.h) / COVER.w);
  const [c, g] = canvas(W, H);
  g.fillStyle = "#08090d";
  g.fillRect(0, 0, W, H);
  if (main) fill(g, main, 0, 0, W, Math.round(H * 0.5));
  const small = rest.filter((img): img is HTMLImageElement => img != null);
  small.forEach((img, i) => fill(g, img, i * (W / small.length) + (i ? 3 : 0), Math.round(H * 0.5) + 6, W / small.length - 3, Math.round(H * 0.24)));
  if (logo) {
    const top = Math.round(H * (small.length ? 0.77 : 0.56));
    const boxW = W * 0.7;
    const boxH = H - top - 40;
    const scale = Math.min(boxW / logo.width, boxH / logo.height);
    g.drawImage(logo, (W - logo.width * scale) / 2, top + (boxH - logo.height * scale) / 2, logo.width * scale, logo.height * scale);
  }
  return toTexture(c, 8);
}

function textTexture(text: string, w: number, h: number, bg: string, fg: string, size: number): THREE.Texture {
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `bold ${size}px system-ui, sans-serif`;
  const lines = wrap(g, text, w * 0.86);
  lines.forEach((line, i) => g.fillText(line, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.15));
  return toTexture(c);
}

/** A plain disc: silver with the rainbow sheen of the data side. */
function discTexture(): THREE.Texture {
  const S = 512;
  const r = S / 2;
  const [c, g] = canvas(S, S);
  const silver = g.createRadialGradient(r, r, 20, r, r, r);
  silver.addColorStop(0, "#b9bfc9");
  silver.addColorStop(1, "#6f7682");
  g.fillStyle = silver;
  g.beginPath();
  g.arc(r, r, r - 1, 0, Math.PI * 2);
  g.fill();
  const sheen = g.createConicGradient(0, r, r);
  ["#ff6b8b", "#ffd66b", "#6bffb0", "#6bc8ff", "#b36bff", "#ff6b8b"].forEach((color, i, all) => sheen.addColorStop(i / (all.length - 1), color));
  g.globalAlpha = 0.3;
  g.fillStyle = sheen;
  g.beginPath();
  g.arc(r, r, r - 1, 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;
  g.strokeStyle = "rgba(255,255,255,0.6)";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(r, r, r * 0.3, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "#c9ced8";
  g.beginPath();
  g.arc(r, r, r * 0.22, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#0b0e16";
  g.beginPath();
  g.arc(r, r, r * 0.08, 0, Math.PI * 2);
  g.fill();
  return toTexture(c);
}

function runtime(ms: number): string {
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

// ---------- The store ----------

/** "Adventure Time Fionna and Cake S02E03 The Hare and the Sprout" → "The Hare and the Sprout". */
function episodeName(title: string, show: string): string {
  let rest = title.trim();
  if (rest.toLowerCase().startsWith(show.toLowerCase())) rest = rest.slice(show.length);
  rest = rest.replace(/^[\s._:-]*(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|(?:season\s*\d+\s*)?episode\s*\d+)?[\s._:-]*/i, "").trim();
  return rest;
}

/** Every episode of the show in your hands, a season at a time. Click one to play it. */
function EpisodeList({ episodes, onPick }: { episodes: Episode[]; onPick: (id: string) => void }) {
  const seasons = [...new Set(episodes.map((ep) => ep.season))].sort((a, b) => a - b);
  const [season, setSeason] = useState(() => episodes.find((ep) => ep.next)?.season ?? seasons[0] ?? 0);
  const shown = episodes.filter((ep) => ep.season === season);
  return (
    <div className="pointer-events-auto mt-4 flex min-h-0 flex-col rounded-xl bg-black/55 p-2 drop-shadow-none backdrop-blur">
      {seasons.length > 1 ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {seasons.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setSeason(n)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-semibold", n === season ? "bg-accent text-room" : "bg-cream/10 text-cream/80 hover:bg-cream/20")}
            >
              {n === 0 ? "Specials" : `Season ${n}`}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {shown.map((ep) => (
          <button
            key={ep.id}
            type="button"
            onClick={() => onPick(ep.id)}
            className={cn("group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-cream/15", ep.next && "bg-cream/10")}
          >
            <span className="w-7 shrink-0 text-xs text-cream/50 tabular-nums">{ep.episode}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{ep.title}</span>
              {ep.progress > 0.02 ? (
                <span className="mt-1 block h-0.5 rounded bg-cream/15">
                  <span className="block h-full rounded bg-accent" style={{ width: `${Math.round(ep.progress * 100)}%` }} />
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-accent opacity-0 group-hover:opacity-100">▶</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function VideoStore({ movies, shows, paused, onPlay }: { movies: Film[]; shows: Show[]; paused: boolean; onPlay: (film: Film) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [locked, setLocked] = useState(false);
  const [tvNote, setTvNote] = useState<{ text: string; at: number } | null>(null);
  const [atTv, setAtTv] = useState(false);
  const [atCrt, setAtCrt] = useState(false);
  const [lineup, setLineup] = useState<{ rows: LineupRow[]; at: number } | null>(null);
  const [theaterHint, setTheaterHint] = useState<string | null>(null);
  const [entered, setEntered] = useState(false); // after the first time in, no big "walk in" screen
  const [hover, setHover] = useState<string | null>(null);
  const [holding, setHolding] = useState<Holding | null>(null);
  const [dark, setDark] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const playRef = useRef(onPlay);
  playRef.current = onPlay;
  const actions = useRef({ play: () => {}, flip: () => {}, putBack: () => {}, playEpisode: (_id: string) => {} });

  useEffect(() => {
    const box = holder.current;
    if (!box) return;
    const list = sections(movies, shows);
    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(thing: T) => (disposables.push(thing), thing);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    box.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#140d09");
    const fog = new THREE.Fog("#140d09", 12, 36);
    scene.fog = fog;
    const storeShade = new THREE.Color("#140d09");
    const nightShade = new THREE.Color("#020102");
    // A soft studio room for reflections, so the plastic and cover sleeves catch the light.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = keep(pmrem.fromScene(room, 0.04).texture);
    room.dispose();
    pmrem.dispose();
    scene.environmentIntensity = 0.45;
    const camera = new THREE.PerspectiveCamera(70, 1, 0.02, 160);
    scene.add(camera); // so a case held in front of you is drawn
    const hemi = new THREE.HemisphereLight("#ffdcae", "#3a2216", 1.0);
    scene.add(hemi);
    const key = new THREE.DirectionalLight("#ffe6c4", 1.1);
    key.position.set(0.4, 1, 0.6);
    camera.add(key, key.target); // a light from over your shoulder

    // Two columns of gondolas either side of a centre walkway.
    const rows = Math.ceil(list.length / 2);
    const units = list.map((section) => Math.max(1, Math.ceil(section.items.length / (PER_SIDE * 2))));
    const maxLen = Math.max(...units, 1) * UNIT;
    const walkway = 4;
    const width = maxLen * 2 + walkway + 6;
    const depth = rows * ROW_GAP + 8;
    const front = 4;

    // Room.
    const carpet = carpetMaterial(keep, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    carpet.cover(width, depth);
    const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(width, depth)), carpet.material);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -depth / 2 + front);
    scene.add(floor);
    // Every piece is labelled with the part it belongs to, so the Blender copy of the store
    // (blender/store-to-blender.py) can group them and moved parts can be read back.
    const tag = <T extends THREE.Object3D>(thing: T, label: string) => {
      thing.userData.part = label;
      if (!thing.name) thing.name = label;
      return thing;
    };
    let part = "Floor";
    tag(floor, part);
    const ceiling = new THREE.Mesh(keep(new THREE.PlaneGeometry(width, depth)), keep(new THREE.MeshLambertMaterial({ color: "#3a281d" })));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, WALL_H, -depth / 2 + front);
    tag(ceiling, "Ceiling");
    scene.add(ceiling);
    const wallMat = keep(new THREE.MeshLambertMaterial({ color: "#6a3f2a" }));
    const box1 = keep(new THREE.BoxGeometry(1, 1, 1));
    const block = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(box1, mat);
      mesh.scale.set(w, h, d);
      mesh.position.set(x, y, z);
      tag(mesh, part);
      scene.add(mesh);
    };
    const backZ = front - depth;
    part = "Wall back";
    block(width, WALL_H, 0.2, 0, WALL_H / 2, backZ, wallMat);
    part = "Wall left";
    block(0.2, WALL_H, depth, -width / 2, WALL_H / 2, front - depth / 2, wallMat);
    // The right wall has the theater door in it, halfway down the store.
    const doorZ = Math.round((front + backZ + 3) / 2);
    const rightWall = (h: number, d: number, y: number, mat: THREE.Material) => {
      const lo = doorZ - 0.95;
      const hi = doorZ + 0.95;
      block(d, h, lo - backZ, width / 2, y, (backZ + lo) / 2, mat);
      block(d, h, front - hi, width / 2, y, (hi + front) / 2, mat);
    };
    part = "Wall right (theater door)";
    rightWall(WALL_H, 0.2, WALL_H / 2, wallMat);
    block(0.2, WALL_H - 2.5, 1.9, width / 2, 2.5 + (WALL_H - 2.5) / 2, doorZ, wallMat);
    // Low wood wainscot round the walls.
    const woodDark = keep(new THREE.MeshLambertMaterial({ color: "#3d2416" }));
    part = "Wall back";
    block(width, 1.0, 0.24, 0, 0.5, backZ, woodDark);
    // The front: a locked door, windows, and the code raining outside.
    const shopFront = buildFront(keep, width, WALL_H, front, wallMat);
    scene.add(tag(shopFront.group, "Shop front"));
    part = "Wall left";
    block(0.24, 1.0, depth, -width / 2, 0.5, front - depth / 2, woodDark);
    part = "Wall right (theater door)";
    rightWall(1.0, 0.24, 0.5, woodDark);
    // Warm pendant lamps over the walkway: a shade, a glowing bulb, and a soft light.
    const shadeMat = keep(new THREE.MeshLambertMaterial({ color: "#2a1a10", side: THREE.DoubleSide }));
    const bulbMat = keep(new THREE.MeshBasicMaterial({ color: "#ffd59a" }));
    const shadeGeo = keep(new THREE.ConeGeometry(0.32, 0.26, 24, 1, true));
    const bulbGeo = keep(new THREE.SphereGeometry(0.07, 16, 12));
    const cordGeo = keep(new THREE.CylinderGeometry(0.006, 0.006, 0.7, 6));
    let lamps = 0;
    for (let z = front - 2.5; z > backZ + 1; z -= 4.5) {
      if (Math.abs(z - (backZ + 3.0)) < 1.4) continue; // keep clear of the CHECK OUT sign
      const shade = new THREE.Mesh(shadeGeo, shadeMat);
      shade.position.set(0, WALL_H - 0.85, z);
      const bulb = new THREE.Mesh(bulbGeo, bulbMat);
      bulb.position.set(0, WALL_H - 0.95, z);
      const cord = new THREE.Mesh(cordGeo, shadeMat);
      cord.position.set(0, WALL_H - 0.35, z);
      const lampName = `Lamp ${lamps + 1}`;
      scene.add(tag(shade, lampName), tag(bulb, lampName), tag(cord, lampName));
      if (lamps++ < 8) {
        const glow = new THREE.PointLight("#ffbe73", 9, 9, 1.6);
        glow.position.set(0, WALL_H - 1.05, z);
        scene.add(tag(glow, lampName));
      }
    }
    const name = new THREE.Mesh(keep(new THREE.PlaneGeometry(6, 0.94)), keep(new THREE.MeshBasicMaterial({ map: keep(textTexture("VAYAVIEW VIDEO", 1024, 160, "#ffb45e", "#2a140c", 96)) })));
    // Raised and made smaller by the user in Blender (2026-11-15).
    name.position.set(0, 2.944, backZ + 0.11);
    name.scale.setScalar(0.733);
    scene.add(tag(name, "Sign VAYAVIEW VIDEO"));

    // ---- A TV on the wall, showing the music stations live ----
    const tvVideo = document.createElement("video");
    tvVideo.crossOrigin = "anonymous";
    tvVideo.playsInline = true;
    tvVideo.volume = 0;
    const tvTex = keep(new THREE.VideoTexture(tvVideo));
    tvTex.colorSpace = THREE.SRGBColorSpace;
    const tvOff = keep(new THREE.MeshBasicMaterial({ color: "#060606" }));
    const tvLive = keep(new THREE.MeshBasicMaterial({ map: tvTex }));
    const tvSet = new THREE.Group();
    const tvBody = new THREE.Mesh(keep(new RoundedBoxGeometry(1.72, 1.0, 0.07, 3, 0.02)), keep(new THREE.MeshStandardMaterial({ color: "#141210", roughness: 0.55 })));
    const tvScreen = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.6, 0.9)), tvOff);
    tvScreen.position.z = 0.0365;
    const tvGlow = new THREE.PointLight("#b8c8ff", 0, 4.5, 2);
    tvGlow.position.z = 0.7;
    tvSet.add(tvBody, tvScreen, tvGlow);
    // On the side wall above the end of the counter, where the shopkeeper watches it.
    const counterZ = backZ + 3.0;
    const tvX = -width / 2 + 0.17;
    // Where the user put it in the Blender copy (2026-11-15): high in the back-left corner, turned to
    // the room. Kept relative to the back-left corner so it stays there if the store grows.
    tvSet.position.set(-width / 2 + 0.7283, 2.7198, backZ + 0.7824);
    tvSet.quaternion.set(0.0745, 0.4117, -0.0338, 0.9076).normalize();
    scene.add(tag(tvSet, "Music TV"));
    const tvPos = tvSet.position.clone();
    let tv: MusicTv | null = null;
    let tvIndex = 0;
    let tvMedia: string | null = null;
    let tvLevel = 0;
    // The TV's own volume knob, 0 to 1 (saved). Even at full it stays background-quiet.
    let tvKnob = Math.min(1, Math.max(0, Number(durable.getItem("parlor.storeTvVolume") ?? "0.3") || 0));
    const tvTurn = (by: number) => {
      tvKnob = Math.round(Math.min(1, Math.max(0, tvKnob + by)) * 50) / 50; // 2% steps
      durable.setItem("parlor.storeTvVolume", String(tvKnob));
      setTvNote({ text: tvKnob === 0 ? "TV muted" : `TV volume ${Math.round(tvKnob * 100)}%`, at: Date.now() });
    };
    const tvChannel = () => (tv ? (tv.channels[tvIndex] ?? null) : null);
    const tvTune = (announce: boolean) => {
      const channel = tvChannel();
      if (!tv || !channel) return;
      const on = airingOn(tv, channel);
      const song = on ? tv.library.get(on.slot.mediaId) : null;
      if (announce) setTvNote({ text: `CH ${channel.number} · ${channel.name}${song ? ` — ${song.artist ? `${song.artist} – ` : ""}${song.song}` : ""}`, at: Date.now() });
      if (!on) {
        tvMedia = null;
        tvVideo.removeAttribute("src");
        tvVideo.load();
        tvScreen.material = tvOff;
        return;
      }
      const id = on.slot.mediaId;
      tvMedia = id;
      tvLevel = 0;
      const start = on.offsetMs / 1000;
      tvVideo.src = `/media/${id}`;
      tvVideo.addEventListener("loadedmetadata", () => tvMedia === id && tvLevel === 0 && (tvVideo.currentTime = start), { once: true });
      tvVideo.play().catch(() => {});
    };
    const tvStep = (by: number) => {
      if (!tv || !tv.channels.length) return;
      tvIndex = (tvIndex + by + tv.channels.length) % tv.channels.length;
      tvTune(true);
    };
    // A file the browser can't play as it is gets converted on the fly.
    const tvFailed = () => {
      const channel = tvChannel();
      if (!tv || !channel || !tvMedia || tvLevel) return;
      tvLevel = 2;
      const on = airingOn(tv, channel);
      tvVideo.src = `/media/${tvMedia}?v=enc&a=0&t=${((on?.offsetMs ?? 0) / 1000).toFixed(2)}`;
      tvVideo.play().catch(() => {});
    };
    const tvPlaying = () => {
      tvScreen.material = tvLive;
      tvGlow.intensity = 1.2;
    };
    const tvEnded = () => tvTune(false);
    tvVideo.addEventListener("error", tvFailed);
    tvVideo.addEventListener("playing", tvPlaying);
    tvVideo.addEventListener("ended", tvEnded);
    void loadMusicTv().then((loaded) => {
      if (!alive || !loaded) return;
      tv = loaded;
      tvTune(false);
    });

    // ---- The theater, through the door in the right wall, showing your TV stations ----
    const posterPool = list.flatMap((section) => section.items).filter((item) => item.poster);
    // Loaded like the shelf covers. If the browser's cached copy can't be used in 3D
    // (it was fetched by a plain <img> elsewhere), a fresh copy is asked for.
    const hallPosters = Array.from({ length: Math.min(4, posterPool.length) }, () => {
      const url = posterUrl(posterPool[Math.floor(Math.random() * posterPool.length)]?.poster, 500);
      return async () => {
        const img = (await loadImage(url)) ?? (url ? await loadImage(`${url}?vv=hall`) : null);
        return img ? toTexture(img, 8) : null;
      };
    });
    const theater = buildTheater(keep, hallPosters);
    const theaterX = width / 2;
    theater.group.position.set(theaterX, 0, doorZ);
    scene.add(tag(theater.group, "Theater"));
    const show = theaterTv({
      note: (text) => setTvNote({ text, at: Date.now() }),
      picture: (video) => {
        if (video) theater.fit(video.videoWidth, video.videoHeight);
        theater.screen.material = video ? theaterLive : theater.screenOff;
      },
    });
    const theaterLive = keep(new THREE.MeshBasicMaterial({ map: show.texture, toneMapped: false, fog: false }));
    disposables.push({ dispose: () => show.dispose() });
    const showLineup = () => setLineup({ rows: show.lineup(), at: Date.now() });
    let seated: (typeof theater.seats)[number] | null = null;
    let lookSeat: number | null = null;
    let lookingAtScreen = false;
    let eyeY = EYE;
    let typed = "";
    let typedTimer = 0;

    // Shelves.
    const black = keep(new THREE.MeshLambertMaterial({ color: "#2a170d" }));
    const boardMat = keep(new THREE.MeshLambertMaterial({ color: "#9a6a42" }));
    const panelBack = keep(new THREE.MeshLambertMaterial({ color: "#5c3824" }));
    const blocks: THREE.Box2[] = [];
    type Slot = { item: Item; pos: THREE.Vector3; side: number; section: string };
    const slots: Slot[] = [];
    list.forEach((section, index) => {
      const column = index % 2 === 0 ? -1 : 1;
      const row = Math.floor(index / 2);
      const length = (units[index] as number) * UNIT;
      const cx = column * (walkway / 2 + 1 + length / 2);
      const cz = front - 4 - row * ROW_GAP;
      part = `Shelf ${section.name}`;
      block(length, 1.9, 0.06, cx, 0.95, cz, panelBack);
      block(length + 0.04, 0.12, 0.62, cx, 0.06, cz, black);
      for (const y of SHELF_Y) for (const side of [-1, 1]) block(length, 0.02, 0.24, cx, y - 0.01, cz + side * 0.15, boardMat);
      blocks.push(new THREE.Box2(new THREE.Vector2(cx - length / 2 - 0.35, cz - 0.65), new THREE.Vector2(cx + length / 2 + 0.35, cz + 0.65)));
      const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(2.2, 0.55)), keep(new THREE.MeshBasicMaterial({ map: keep(textTexture(section.name.toUpperCase(), 512, 128, "#f5e2bf", "#4a2216", 64)), side: THREE.DoubleSide })));
      sign.position.set(cx, 2.55, cz);
      scene.add(tag(sign, part));
      // Fill the front side top to bottom, then the back.
      const perRow = Math.round(length / PITCH);
      const perSide = perRow * SHELF_Y.length;
      section.items.forEach((item, i) => {
        const side = i < perSide ? 1 : -1;
        const k = side === 1 ? i : i - perSide;
        const shelf = Math.floor(k / perRow);
        if (shelf >= SHELF_Y.length) return;
        const x = cx - length / 2 + PITCH / 2 + (k % perRow) * PITCH;
        slots.push({ item, side, section: section.name, pos: new THREE.Vector3(x, (SHELF_Y[SHELF_Y.length - 1 - shelf] as number) + CASE.h / 2, cz + side * 0.2) });
      });
    });

    // The back of the store: two long counters wall to wall with a gap between, and behind
    // the left one the old shopkeeper in his armchair, watching the TV.
    const back = buildBackRoom(keep);
    const gap = 1.2;
    const len = width / 2 - 0.12 - gap;
    for (const side of [-1, 1]) {
      const counter = back.counterOf(len);
      counter.position.set(side * (gap + len / 2), 0, counterZ);
      scene.add(tag(counter, side === -1 ? "Counter left" : "Counter right"));
      blocks.push(new THREE.Box2(new THREE.Vector2(side === -1 ? -width / 2 : gap - 0.3, counterZ - 0.6), new THREE.Vector2(side === -1 ? -gap + 0.3 : width / 2, counterZ + 0.6)));
    }
    back.register.position.set(gap + 0.55, 1.05, counterZ - 0.05);
    back.register.rotation.y = 0.15;
    back.bell.position.set(-gap - 0.45, 1.05, counterZ + 0.15);
    back.returns.position.set(-gap - 1.0, 1.05, counterZ + 0.05);
    tag(back.register, "Register");
    tag(back.bell, "Bell");
    tag(back.returns, "Returns pile");
    scene.add(back.extras);
    const keeperX = Math.max(-width / 2 + 1.4, -3.2);
    const keeperZ = backZ + 1.45;
    back.corner.position.set(keeperX, 0, keeperZ);
    back.chair.rotation.y = Math.atan2(tvX - keeperX, counterZ + 0.9 - keeperZ);
    scene.add(tag(back.corner, "Shopkeeper corner"));
    let keeperRock: ((nowMs: number) => void) | null = null;
    let rockHold: number | null = null; // tests freeze the swing here
    const keeperRunners: THREE.Object3D[] = [];
    // The user's model replaces the built one once it has loaded; if it can't load, the built one stays.
    {
      const draco = new DRACOLoader().setDecoderPath("/draco/");
      const loader = new GLTFLoader().setDRACOLoader(draco);
      loader.load(
        KEEPER_MODEL.url,
        (gltf) => {
          draco.dispose();
          if (!alive) return;
          const model = gltf.scene;
          // The round display base is for a shelf, not a shop floor.
          model.traverse((node) => {
            if (/^Base_Individula/i.test(node.name)) node.visible = false;
          });
          model.getObjectByName("Base_Individula.001")?.removeFromParent();
          model.traverse((node) => {
            const m = node as THREE.Mesh;
            if (!m.isMesh) return;
            keep(m.geometry);
            const material = m.material as THREE.MeshStandardMaterial;
            keep(material);
            material.envMapIntensity = 0.35;
          });
          const holder = new THREE.Group();
          // holder > pivot (rolls on the runners) > offset > model
          const pivot = new THREE.Group();
          const offset = new THREE.Group();
          holder.add(pivot);
          pivot.add(offset);
          offset.add(model);
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const scale = KEEPER_MODEL.height / (size.y || 1);
          model.scale.multiplyScalar(scale);
          box.setFromObject(model);
          const centre = box.getCenter(new THREE.Vector3());
          model.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
          // Rocking: roll on curved runners without sliding. The runners' circle centre sits `radius`
          // above the floor over their middle; turning by θ about it moves it forward by radius × θ.
          holder.updateMatrixWorld(true);
          const runners = new THREE.Box3();
          model.traverse((node) => {
            if ((node as THREE.Mesh).isMesh && /^Silla_2/i.test(node.name)) {
              runners.expandByObject(node);
              keeperRunners.push(node);
            }
          });
          // Where the runners touch the floor: the average of their lowest points.
          const mid = runners.isEmpty() ? new THREE.Vector3() : runners.getCenter(new THREE.Vector3());
          {
            const p = new THREE.Vector3();
            let sum = 0;
            let n = 0;
            for (const node of keeperRunners) {
              const position = (node as THREE.Mesh).geometry.getAttribute("position");
              for (let i = 0; i < position.count; i++) {
                p.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld);
                if (p.y < runners.min.y + 0.01) {
                  sum += p.z;
                  n++;
                }
              }
            }
            if (n) mid.z = sum / n;
          }
          offset.position.set(0, -ROCK.radius, -mid.z);
          const roll = (theta: number) => {
            pivot.position.set(0, ROCK.radius, mid.z + ROCK.radius * theta);
            pivot.rotation.x = theta;
          };
          roll(0);
          holder.updateMatrixWorld(true);
          keeperRock = (nowMs: number) => roll(rockHold ?? ROCK.swing * Math.sin((nowMs / 1000) * ((Math.PI * 2) / ROCK.period)));
          holder.rotation.y = back.chair.rotation.y + KEEPER_MODEL.turn;
          back.chair.visible = false;
          back.corner.add(tag(holder, "Shopkeeper"));
        },
        undefined,
        () => draco.dispose(),
      );
    }
    // ---- What the user added in Blender (blender/store-to-blender.py): an old Panasonic TV on the end of the left
    // counter playing the nostalgia station, wall shelves with Jake and a box set. Exported from their
    // .blend in world positions for a store whose left wall was x -7.31 and back wall z -24.4. ----
    const crtOff = keep(new THREE.MeshBasicMaterial({ color: "#0b0d0c" }));
    let crtScreen: THREE.Mesh | null = null;
    const crt = theaterTv(
      {
        note: (text) => setTvNote({ text, at: Date.now() }),
        picture: (video) => {
          if (crtScreen) crtScreen.material = video ? crtLive : crtOff;
        },
      },
      { save: "parlor.storeCrt", label: "Old TV", channel: ADDITIONS.channel },
    );
    crt.texture.flipY = false; // glTF texture layout
    crt.texture.channel = 1; // the screen's picture uses the model's second UV map
    const crtLive = keep(new THREE.MeshBasicMaterial({ map: crt.texture }));
    disposables.push({ dispose: () => crt.dispose() });
    const crtPos = new THREE.Vector3(1e6, 0, 1e6);
    const crtGlow = new THREE.PointLight("#cfe0ff", 0, 3.5, 2);
    scene.add(crtGlow); // added now so lights don't change (a shader rebuild) when the model arrives
    {
      const draco = new DRACOLoader().setDecoderPath("/draco/");
      new GLTFLoader().setDRACOLoader(draco).load(
        ADDITIONS.url,
        (gltf) => {
          draco.dispose();
          if (!alive) return;
          const group = gltf.scene;
          group.position.set(-width / 2 - ADDITIONS.leftX, 0, backZ - ADDITIONS.backZ);
          group.traverse((node) => {
            const m = node as THREE.Mesh;
            if (!m.isMesh) return;
            keep(m.geometry);
            for (const material of [m.material].flat()) {
              keep(material);
              (material as THREE.MeshStandardMaterial).envMapIntensity = 0.35;
            }
          });
          scene.add(tag(group, "Added in Blender"));
          group.updateMatrixWorld(true);
          crtScreen = ((group.getObjectByName("tv_screen") ?? group.getObjectByName("tv screen")) as THREE.Mesh | undefined) ?? null;
          if (!crtScreen) return;
          crtScreen.material = crtOff;
          crtScreen.getWorldPosition(crtPos);
          crtGlow.position.copy(crtPos).add(new THREE.Vector3(0.6, 0, 0)); // the screen faces +x
        },
        undefined,
        () => draco.dispose(),
      );
    }
    blocks.push(new THREE.Box2(new THREE.Vector2(keeperX - 0.75, keeperZ - 0.7), new THREE.Vector2(keeperX + 0.75, keeperZ + 0.7)));
    const checkout = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.8, 0.45)), keep(new THREE.MeshBasicMaterial({ map: keep(textTexture("CHECK OUT", 512, 128, "#f5e2bf", "#4a2216", 64)), side: THREE.DoubleSide })));
    checkout.position.set(0, 3.233, counterZ); // raised and made smaller in Blender (2026-11-15)
    checkout.scale.setScalar(0.735);
    scene.add(tag(checkout, "Sign CHECK OUT"));

    // Cases: every plastic shell in one instanced draw; covers are their own planes.
    const shellGeo = keep(new RoundedBoxGeometry(CASE.w, CASE.h, CASE.d, 3, 0.0025));
    // Worn plastic: smudges and scratches in the roughness (grey 64 = clean, see store-case.ts).
    const wear = caseWear(keep, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    const shellMat = keep(new THREE.MeshPhysicalMaterial({ color: "#1d4fae", roughness: 1.1, roughnessMap: wear.rough, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.6, clearcoatRoughnessMap: wear.rough }));
    const shells = new THREE.InstancedMesh(shellGeo, shellMat, Math.max(1, slots.length));
    scene.add(tag(shells, "Cases (stay on their shelves)"));
    // The line where the two halves meet (top, bottom, opening edge; not the spine).
    const seam = caseSeam(keep, CASE);
    const seams = new THREE.InstancedMesh(seam.geometry, seam.material, Math.max(1, slots.length));
    scene.add(tag(seams, "Cases (stay on their shelves)"));
    const coverGeo = keep(new THREE.PlaneGeometry(COVER.w, COVER.h));
    const blank = keep(new THREE.MeshStandardMaterial({ color: "#14161c", roughness: 0.4 }));
    const covers: THREE.Mesh[] = [];
    const slotOf = new Map<THREE.Object3D, number>();
    const tmpM = new THREE.Matrix4();
    const tmpQ = new THREE.Quaternion();
    const tmpE = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    const zero = new THREE.Vector3(0, 0, 0);
    /** Puts case `i` on its shelf, pulled forward by `out` metres, or hides it. */
    const place = (i: number, out = 0, shown = true) => {
      const slot = slots[i] as Slot;
      tmpE.set(-0.1 * slot.side, slot.side === 1 ? 0 : Math.PI, 0);
      tmpQ.setFromEuler(tmpE);
      const pos = slot.pos.clone();
      pos.z += out * slot.side;
      tmpM.compose(pos, tmpQ, shown ? one : zero);
      shells.setMatrixAt(i, tmpM);
      shells.instanceMatrix.needsUpdate = true;
      seams.setMatrixAt(i, tmpM);
      seams.instanceMatrix.needsUpdate = true;
      const cover = covers[i] as THREE.Mesh;
      cover.visible = shown;
      cover.quaternion.copy(tmpQ);
      cover.position.copy(pos).add(new THREE.Vector3(0, 0, CASE.d / 2 + 0.0004).applyQuaternion(tmpQ));
    };
    slots.forEach((_, i) => {
      const cover = new THREE.Mesh(coverGeo, blank);
      tag(cover, `Shelf ${(slots[i] as Slot).section}`);
      scene.add(cover);
      covers.push(cover);
      slotOf.set(cover, i);
      place(i);
    });

    // Covers load only for nearby shelves, a few at a time.
    let alive = true;
    const pending = new Set<number>();
    const dressed = new Set<number>();
    const dress = (i: number) => {
      pending.add(i);
      void frontCover((slots[i] as Slot).item, 185).then((texture) => {
        if (!alive) return texture.dispose();
        (covers[i] as THREE.Mesh).material = keep(new THREE.MeshStandardMaterial({ map: keep(texture), roughness: 1.3, roughnessMap: wear.rough }));
        pending.delete(i);
        dressed.add(i);
      });
    };
    const nearby = () => {
      if (pending.size > 6) return;
      let started = 0;
      for (let i = 0; i < slots.length; i++) {
        if (dressed.has(i) || pending.has(i)) continue;
        if ((slots[i] as Slot).pos.distanceToSquared(body) > 14 * 14) continue;
        dress(i);
        if (++started >= 8) return;
      }
    };

    // ---- Walking ----
    const body = new THREE.Vector3(0, EYE, front - 1.5); // where you stand; the camera adds the head's movement
    camera.position.copy(body);
    const controls = new PointerLockControls(camera, renderer.domElement);
    controls.pointerSpeed = 0.8;
    controls.addEventListener("lock", () => ((relock = false), setLocked(true), setEntered(true)));
    // Putting a case back with Esc: the app lets the store take the mouse back (see electron/main.mjs).
    let relock = false;
    (window as unknown as { __vvRelock?: () => void }).__vvRelock = () => {
      if (relock && !controls.isLocked) controls.lock();
      relock = false;
    };
    controls.addEventListener("unlock", () => setLocked(false));
    // Windows sometimes reports one wild jump of the mouse while it's captured, which snapped the
    // view round. A real flick never moves this far in one event, so those are dropped.
    const spike = (event: MouseEvent) => {
      if (controls.isLocked && (Math.abs(event.movementX) > 180 || Math.abs(event.movementY) > 180)) event.stopImmediatePropagation();
    };
    window.addEventListener("mousemove", spike, { capture: true });
    const keys = new Set<string>();
    const velocity = new THREE.Vector3();
    let stride = 0;
    let bob = 0;

    // ---- Holding a case ----
    type Held = {
      slot: number;
      mesh: THREE.Group;
      t: number;
      from: THREE.Vector3;
      fromQ: THREE.Quaternion;
      yaw: number;
      pitch: number;
      yawTo: number;
      pitchTo: number;
      dist: number;
      leaving: number;
      playing: number;
      disc: THREE.Mesh | null;
      film: Film | null;
    };
    let held: Held | null = null;
    let heldEpisodes: Film[] = [];
    const heldDisposables: { dispose: () => void }[] = [];
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    // A dark veil just behind the case, so the shop fades back while you look at it.
    const veilMat = keep(new THREE.MeshBasicMaterial({ color: "#000", transparent: true, opacity: 0, depthWrite: false }));
    const veil = new THREE.Mesh(keep(new THREE.PlaneGeometry(4, 4)), veilMat);
    veil.position.set(0, 0, -0.9);
    veil.visible = false;
    camera.add(veil);

    const pickUp = (i: number) => {
      const slot = slots[i] as Slot;
      if (held) return;
      const item = slot.item;
      const film = filmOf(item);
      const show = showOf(item);
      const playable = film ?? (show ? (nextUp(show) ?? null) : null);
      const cover = covers[i] as THREE.Mesh;
      const shelfMat = cover.material as THREE.MeshStandardMaterial;
      // The case in your hands: the same shell, glossier, with the cover under a sleeve.
      // Its own placement of the wear, so the sleeve's scratches differ from the shelf's.
      const ownWear = wearFor(wear);
      // Scratch grooves only up close, in your hands (on the shelf they would just shimmer).
      const grooves = { normalMap: ownWear.normal, normalScale: new THREE.Vector2(0.6, 0.6), clearcoatNormalMap: ownWear.normal, clearcoatNormalScale: new THREE.Vector2(0.6, 0.6) };
      const shellOwn = new THREE.MeshPhysicalMaterial({ color: "#1d4fae", roughness: 1.1, roughnessMap: ownWear.rough, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.6, clearcoatRoughnessMap: ownWear.rough, ...grooves });
      const shell = new THREE.Mesh(shellGeo, shellOwn);
      const seamLine = new THREE.Mesh(seam.geometry, seam.material);
      shell.add(seamLine);
      const sleeve = { roughness: 1.8, roughnessMap: ownWear.rough, clearcoat: 0.5, clearcoatRoughness: 1.2, clearcoatRoughnessMap: ownWear.rough, envMapIntensity: 0.3, ...grooves };
      const frontMat = new THREE.MeshPhysicalMaterial({ map: shelfMat.map ?? null, color: shelfMat.map ? "#fff" : "#14161c", ...sleeve });
      const backMat = new THREE.MeshPhysicalMaterial({ color: "#0c0e14", ...sleeve });
      heldDisposables.push(frontMat, backMat, shellOwn, ownWear.rough, ownWear.normal);
      const frontPlane = new THREE.Mesh(coverGeo, frontMat);
      frontPlane.position.z = CASE.d / 2 + 0.0004;
      const backPlane = new THREE.Mesh(coverGeo, backMat);
      backPlane.position.z = -CASE.d / 2 - 0.0004;
      backPlane.rotation.y = Math.PI;
      const group = new THREE.Group();
      group.add(shell, frontPlane, backPlane);
      camera.add(group);
      const from = camera.worldToLocal(cover.getWorldPosition(new THREE.Vector3()).sub(new THREE.Vector3(0, 0, CASE.d / 2).applyQuaternion(cover.quaternion)));
      const fromQ = camera.quaternion.clone().invert().multiply(cover.quaternion);
      group.position.copy(from);
      group.quaternion.copy(fromQ);
      place(i, 0, false);
      held = { slot: i, mesh: group, t: 0, from, fromQ, yaw: 0, pitch: 0, yawTo: 0, pitchTo: 0, dist: 0.23, leaving: 0, playing: 0, disc: null, film: playable };
      veil.visible = true;
      // The poster never goes away: keep the shelf's picture until a sharper one is fully ready.
      const mine = held;
      const still = () => held === mine;
      const usePoster = (texture: THREE.Texture, sharp: boolean) => {
        if (!still() || (!sharp && frontMat.map)) return texture.dispose();
        heldDisposables.push(texture);
        renderer.initTexture(texture);
        frontMat.map = texture;
        frontMat.color.set("#fff");
        frontMat.needsUpdate = true;
      };
      if (!shelfMat.map) void frontCover(item, 185).then((texture) => usePoster(texture, false));
      void loadImage(posterUrl(item.poster, 500)).then((img) => img && usePoster(toTexture(img, 8), true));
      if (!dressed.has(i) && !pending.has(i)) dress(i);
      void backCover(item).then((texture) => {
        if (!texture) return;
        if (!still()) return texture.dispose();
        heldDisposables.push(texture);
        backMat.map = texture;
        backMat.color.set("#fff");
        backMat.needsUpdate = true;
      });
      keys.clear();
      velocity.set(0, 0, 0);
      controls.enabled = false; // the view stays still while you hold a case
      controls.unlock();
      const source = film ?? playable;
      const facts = show
        ? [show.year || null, `${show.episodes.length} episodes`].filter(Boolean).join(" · ")
        : [film?.year || null, film?.durationMs ? runtime(film.durationMs) : null, film?.rating ? `★ ${film.rating.toFixed(1)}` : null, film?.director || null].filter(Boolean).join(" · ");
      setHolding({
        title: item.title,
        play: source && resumeMs(source.id) ? "▶ Resume" : "▶ Play",
        sub: show && playable ? `Season ${playable.season ?? 0} · Episode ${playable.episode ?? 0}` : "",
        facts,
        synopsis: (film?.synopsis || show?.synopsis || "").trim(),
        episodes: show
          ? show.episodes.map((ep) => ({
              id: ep.id,
              season: ep.season ?? 0,
              episode: ep.episode ?? 0,
              title: episodeName(ep.title, show.name) || `Episode ${ep.episode ?? 0}`,
              progress: ep.durationMs ? Math.min(1, resumeMs(ep.id) / ep.durationMs) : 0,
              next: ep.id === playable?.id,
            }))
          : [],
      });
      heldEpisodes = show ? show.episodes : [];
      setHover(null);
    };

    const dropHeld = () => {
      if (!held) return;
      camera.remove(held.mesh);
      if (held.disc) camera.remove(held.disc);
      place(held.slot, 0, true);
      held = null;
      controls.enabled = true;
      veil.visible = false;
      for (const thing of heldDisposables.splice(0)) thing.dispose();
      setHolding(null);
    };

    actions.current = {
      flip() {
        if (held && !held.leaving && !held.playing) held.yawTo += Math.PI;
      },
      putBack() {
        if (!held || held.playing || held.leaving) return;
        held.leaving = 0.0001;
        // Back to walking straight away (this runs inside the click or key press, which the browser needs).
        relock = true;
        try {
          controls.lock();
        } catch {
          // Not allowed right now: a click on the store takes you back in.
        }
      },
      playEpisode(id: string) {
        const episode = heldEpisodes.find((ep) => ep.id === id);
        if (!held || held.playing || held.leaving || !episode) return;
        held.film = episode;
        actions.current.play();
      },
      play() {
        if (!held || held.playing || held.leaving || !held.film) return;
        // Face up, then the disc slides out of the case.
        held.yawTo = Math.round(held.yawTo / (Math.PI * 2)) * Math.PI * 2;
        held.pitchTo = 0;
        const discTex = discTexture();
        const discMat = new THREE.MeshStandardMaterial({ map: discTex, metalness: 0.35, roughness: 0.35, envMapIntensity: 0.25 });
        const discEdge = new THREE.MeshStandardMaterial({ color: "#c9ced8", metalness: 0.6, roughness: 0.35, envMapIntensity: 0.35 });
        const discGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.0012, 64);
        heldDisposables.push(discTex, discMat, discEdge, discGeo);
        const disc = new THREE.Mesh(discGeo, [discEdge, discMat, discEdge]);
        disc.rotation.x = Math.PI / 2;
        disc.position.set(0, 0.012, -held.dist - 0.002);
        camera.add(disc);
        held.disc = disc;
        held.playing = 0.0001;
        setHolding((value) => value && { ...value, play: "" });
      },
    };

    // Dev only: lets the test scripts pick up a case without taking over the mouse.
    if (import.meta.env.DEV)
      (window as unknown as { __vvStore?: unknown }).__vvStore = {
        crt: () => crt.current(),
        /** The whole store as a .glb (base64), for blender/store-to-blender.py. Covers are all loaded first. */
        async exportGlb() {
          slots.forEach((_, i) => !dressed.has(i) && !pending.has(i) && dress(i));
          for (let t = 0; t < 60 && pending.size; t++) await new Promise((r) => setTimeout(r, 500));
          const parts = scene.children.filter((child) => child !== camera);
          // The exporter can only save pictures it can draw: raw pixel textures become canvases,
          // anything else (video) is left off for the export and put back after.
          const undo: (() => void)[] = [];
          const drawable = (image: unknown) =>
            image instanceof HTMLImageElement || image instanceof HTMLCanvasElement || image instanceof ImageBitmap || (typeof OffscreenCanvas !== "undefined" && image instanceof OffscreenCanvas);
          const asCanvas = (image: { data?: ArrayLike<number>; width?: number; height?: number }) => {
            const { data, width = 0, height = 0 } = image;
            if (!data || !width || !height || data.length < width * height * 4 || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(data.slice(0, width * height * 4)), width, height), 0, 0);
            return canvas;
          };
          const seen = new Set<THREE.Material>();
          scene.traverse((node) => {
            const mesh = node as THREE.Mesh;
            if (!mesh.material) return;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              if (seen.has(material)) continue;
              seen.add(material);
              const record = material as unknown as Record<string, unknown>;
              for (const key of Object.keys(record)) {
                const texture = record[key] as THREE.Texture | null;
                if (!texture || !(texture as THREE.Texture).isTexture) continue;
                // Surface wear maps are left out: shared by hundreds of covers, they made the file huge.
                const surface = /roughnessMap|metalnessMap|normalMap|bumpMap|aoMap/i.test(key);
                if (!surface && drawable(texture.image)) continue;
                const canvas = surface ? null : asCanvas(texture.image as { data?: ArrayLike<number>; width?: number; height?: number });
                if (canvas) {
                  const image = texture.image;
                  texture.image = canvas;
                  undo.push(() => (texture.image = image));
                } else {
                  record[key] = null;
                  undo.push(() => (record[key] = texture));
                }
              }
            }
          });
          let glb: ArrayBuffer;
          try {
            glb = (await new GLTFExporter().parseAsync(parts, { binary: true, onlyVisible: true, maxTextureSize: 2048 })) as ArrayBuffer;
          } finally {
            for (const step of undo) step();
          }
          let text = "";
          const bytes = new Uint8Array(glb);
          for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        },
        rock(theta: number | null) {
          rockHold = theta;
          keeperRock?.(0);
          const box = new THREE.Box3();
          for (const node of keeperRunners) {
            node.updateWorldMatrix(true, false);
            box.expandByObject(node, true);
          }
          return box.isEmpty() ? null : { low: +box.min.y.toFixed(4), front: +box.max.z.toFixed(3) };
        },
        visitBack(x = 0, dz = 6.5, lookX = keeperX, lookY = 1.2, lookZ = keeperZ) {
          body.set(x, EYE, backZ + dz);
          camera.position.copy(body);
          camera.lookAt(lookX, lookY, lookZ);
        },
        visitTheater(x = 3, z = 0, look: [number, number, number] | null = null) {
          seated = null;
          body.set(theaterX + x, EYE, doorZ + z);
          eyeY = EYE + theater.floorAt(x);
          camera.position.set(body.x, eyeY, body.z);
          const at = look ? new THREE.Vector3(theaterX + look[0], look[1], doorZ + look[2]) : theater.screenCentre.clone().add(theater.group.position);
          camera.lookAt(at);
          return show.current();
        },
        sitTheater(row = 4, seat = 10) {
          sit(row * theater.perRow + seat);
          eyeY = theater.sitAt(theater.seats[row * theater.perRow + seat] as (typeof theater.seats)[number]).y;
          camera.position.y = eyeY;
          return show.current();
        },
        theaterChannel(by = 1) {
          show.step(by);
          showLineup();
          return show.current();
        },
        lookDoor() {
          body.set(theaterX - 4, EYE, doorZ - 1);
          eyeY = EYE;
          camera.position.set(body.x, EYE, body.z);
          camera.lookAt(theaterX, 1.6, doorZ);
        },
        lookFront() {
          body.set(0.6, EYE, front - 2.2);
          camera.position.copy(body);
          camera.lookAt(-0.2, 1.5, front);
        },
        face() {
          const yaw = back.chair.rotation.y;
          camera.position.set(keeperX + Math.sin(yaw) * 0.95, 1.4, keeperZ + Math.cos(yaw) * 0.95);
          camera.lookAt(keeperX + Math.sin(yaw) * 0.1, 1.3, keeperZ + Math.cos(yaw) * 0.1);
          body.set(camera.position.x, EYE, camera.position.z);
        },
        lookTv() {
          camera.lookAt(tvPos);
          return { media: tvMedia, level: tvLevel, time: tvVideo.currentTime, paused: tvVideo.paused, volume: tvVideo.volume, channels: tv?.channels.length ?? 0 };
        },
        pickShow() {
          const i = slots.findIndex((slot) => showOf(slot.item) && (showOf(slot.item)?.episodes.length ?? 0) > 3);
          if (i >= 0) pickUp(i);
          return i;
        },
        pickNearest() {
          let best = 0;
          slots.forEach((slot, i) => {
            if (slot.pos.distanceToSquared(body) < (slots[best] as Slot).pos.distanceToSquared(body)) best = i;
          });
          if (slots.length) pickUp(best);
        },
      };

    // ---- Input ----
    const down = (event: KeyboardEvent) => {
      if (held) {
        // Esc puts it back when the key comes UP. Acting on the press would take the mouse back for
        // walking, and then the release would make the app let go of it again.
        if (event.code === "KeyQ" || event.code === "Backspace") actions.current.putBack();
        else if (event.code === "KeyF") actions.current.flip();
        else if (event.code === "Enter" || event.code === "Space") {
          event.preventDefault();
          actions.current.play();
        }
        return;
      }
      // In the theater the keys work its screen; looking at the old TV on the counter, that one.
      const screenTv = body.x - theaterX > -0.5 ? show : lookingAtCrt ? crt : null;
      if (screenTv) {
        const list = screenTv === show ? showLineup : () => {};
        if (event.code === "Equal" || event.code === "NumpadAdd") return screenTv.turn(0.02);
        if (event.code === "Minus" || event.code === "NumpadSubtract") return screenTv.turn(-0.02);
        if (event.code === "BracketRight" || event.code === "PageUp") return (screenTv.step(1), list());
        if (event.code === "BracketLeft" || event.code === "PageDown") return (screenTv.step(-1), list());
        if (screenTv === show && (event.code === "KeyG" || event.code === "Tab")) {
          event.preventDefault();
          return showLineup();
        }
        const digit = /^(Digit|Numpad)([0-9])$/.exec(event.code)?.[2];
        if (digit) {
          typed = (typed + digit).slice(-3);
          setTvNote({ text: `CH ${typed}_`, at: Date.now() });
          window.clearTimeout(typedTimer);
          typedTimer = window.setTimeout(() => {
            screenTv.go(Number(typed));
            list();
            typed = "";
          }, 1100);
          return;
        }
        if (event.code === "KeyE" && lookSeat != null && hovered == null) return sit(lookSeat);
      }
      if (event.code === "Equal" || event.code === "NumpadAdd") return tvTurn(0.02);
      if (event.code === "Minus" || event.code === "NumpadSubtract") return tvTurn(-0.02);
      if (event.code === "BracketRight" || event.code === "PageUp") return tvStep(1);
      if (event.code === "BracketLeft" || event.code === "PageDown") return tvStep(-1);
      if (!controls.isLocked) return;
      keys.add(event.code);
      if (event.code === "KeyE" && hovered != null) pickUp(hovered);
    };
    const up = (event: KeyboardEvent) => {
      keys.delete(event.code);
      if (event.code === "Escape" && held) actions.current.putBack();
    };
    const clearKeys = () => keys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clearKeys);

    const ray = new THREE.Raycaster();
    ray.far = 2.6;
    const centre = new THREE.Vector2(0, 0);
    let hovered: number | null = null;
    let lookingAtTv = false;
    let lookingAtCrt = false;
    const tvRay = new THREE.Raycaster();
    tvRay.far = 9;
    const seatRay = new THREE.Raycaster();
    seatRay.far = 3;
    const screenRay = new THREE.Raycaster();
    screenRay.far = 40;
    const hint = (text: string | null) => setTheaterHint((was) => (was === text ? was : text));
    const sit = (i: number) => {
      const seat = theater.seats[i];
      if (!seat) return;
      seated = seat;
      const at = theater.sitAt(seat);
      body.set(theaterX + at.x, EYE, doorZ + at.z);
      velocity.set(0, 0, 0);
      camera.position.set(body.x, eyeY, body.z);
      camera.lookAt(theater.screenCentre.clone().add(theater.group.position));
      hint("W A S D to stand up · [ ] or click the screen to change channel · type a number · G channel list");
    };
    const click = () => {
      if (held) return;
      if (!controls.isLocked) controls.lock();
      else if (hovered != null) pickUp(hovered);
      else if (lookSeat != null) sit(lookSeat);
      else if (lookingAtScreen) {
        show.step(1);
        showLineup();
      } else if (lookingAtCrt) crt.step(1);
      else if (lookingAtTv) tvStep(1);
    };
    // Turning a held case: drag with the mouse, wheel to bring it closer.
    let drag: { x: number; y: number } | null = null;
    const press = (event: PointerEvent) => {
      if (held) drag = { x: event.clientX, y: event.clientY };
    };
    const move = (event: PointerEvent) => {
      if (!held || !drag) return;
      held.yawTo += (event.clientX - drag.x) * 0.01;
      held.pitchTo = Math.max(-1.2, Math.min(1.2, held.pitchTo + (event.clientY - drag.y) * 0.01));
      drag = { x: event.clientX, y: event.clientY };
    };
    const release = () => (drag = null);
    const wheel = (event: WheelEvent) => {
      if (held) held.dist = Math.max(0.15, Math.min(0.45, held.dist + event.deltaY * 0.0004));
      else if (body.x - theaterX > 0.5) show.turn(event.deltaY < 0 ? 0.02 : -0.02);
      else if (lookingAtCrt) crt.turn(event.deltaY < 0 ? 0.02 : -0.02);
      else if (lookingAtTv) tvTurn(event.deltaY < 0 ? 0.02 : -0.02);
    };
    const canvasEl = renderer.domElement;
    canvasEl.addEventListener("click", click);
    canvasEl.addEventListener("pointerdown", press);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    canvasEl.addEventListener("wheel", wheel, { passive: true });

    const blocked = (x: number, z: number) =>
      !theater.walkable(x - theaterX, z - doorZ) &&
      (x < -width / 2 + 0.4 || x > width / 2 - 0.4 || z > front - 0.4 || z < backZ + 0.4 || blocks.some((b) => x > b.min.x && x < b.max.x && z > b.min.y && z < b.max.y));
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const wish = new THREE.Vector3();
    const target = new THREE.Vector3();
    let dark = false;
    const setDarkNow = (value: boolean) => {
      dark = value;
      setDark(value);
    };
    let last = performance.now();
    let tick = 0;
    let tvCheck = 0;

    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (pausedRef.current || document.hidden) {
        if (!tvVideo.paused) tvVideo.pause();
        show.pause();
        crt.pause();
        return;
      }
      back.animate(now);
      keeperRock?.(now);
      shopFront.tick(now);
      // The TV: back to live after a pause, follows the station, and is only loud up close.
      if (tvMedia && tvVideo.paused && tvVideo.readyState >= 2) tvTune(false);
      if (tv && ++tvCheck % 120 === 0) {
        const channel = tvChannel();
        const on = channel ? airingOn(tv, channel) : null;
        if ((on?.slot.mediaId ?? null) !== tvMedia) tvTune(false);
      }
      const tvDist = Math.hypot(body.x - tvPos.x, body.z - tvPos.z);
      tvVideo.volume = Math.min(1, 0.3 * tvKnob * Math.max(0, 1 - tvDist / 16) ** 1.5);
      // The theater: darker the further in you go, its sound with it, the projector on when you are near.
      const lx = body.x - theaterX;
      const deep = theater.inside(lx);
      hemi.intensity = 1 - 0.88 * deep;
      key.intensity = 1.1 * (1 - 0.85 * deep);
      scene.environmentIntensity = 0.45 * (1 - 0.6 * deep);
      fog.near = 12 + 90 * deep;
      fog.far = 36 + 160 * deep;
      fog.color.copy(storeShade).lerp(nightShade, deep);
      (scene.background as THREE.Color).copy(fog.color);
      const toDoor = lx >= 0 ? 0 : Math.hypot(lx, body.z - doorZ);
      show.power(toDoor < 10);
      show.update(now, lx >= 4 ? 1 : lx > 0 ? 0.3 + 0.7 * (lx / 4) : 0.3 * Math.max(0, 1 - toDoor / 8));
      theater.tick(now, show.video, deep);
      tvVideo.volume *= 1 - deep;
      tvGlow.intensity = tvMedia ? 1 + Math.sin(now / 170) * 0.15 + Math.sin(now / 53) * 0.1 : 0;
      // The old TV on the counter: on while you are in the store, quiet unless you are near it.
      const crtDist = Math.hypot(body.x - crtPos.x, body.z - crtPos.z);
      crt.power(!!crtScreen && crtDist < 16 && deep < 0.5);
      crt.update(now, 0.35 * Math.max(0, 1 - crtDist / 14) ** 1.5 * (1 - deep));
      crtGlow.intensity = crt.current().media && !crt.current().paused ? 0.7 + Math.sin(now / 170) * 0.1 + Math.sin(now / 61) * 0.08 : 0;

      // Walking: quick to get going and to stop, but not a snap.
      const running = keys.has("ShiftLeft") || keys.has("ShiftRight");
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      right.crossVectors(forward, camera.up).normalize();
      wish.set(0, 0, 0);
      if (controls.isLocked) {
        if (keys.has("KeyW") || keys.has("ArrowUp")) wish.add(forward);
        if (keys.has("KeyS") || keys.has("ArrowDown")) wish.sub(forward);
        if (keys.has("KeyD") || keys.has("ArrowRight")) wish.add(right);
        if (keys.has("KeyA") || keys.has("ArrowLeft")) wish.sub(right);
      }
      if (seated && wish.lengthSq() > 0) {
        const to = theater.standFrom(seated);
        body.set(theaterX + to.x, EYE, doorZ + to.z);
        seated = null;
        hint(null);
      }
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(running ? RUN : WALK);
      velocity.lerp(wish, 1 - Math.exp(-(wish.lengthSq() > 0 ? 10 : 12) * dt));
      const dx = velocity.x * dt;
      const dz = velocity.z * dt;
      if (!blocked(body.x + dx, body.z)) body.x += dx;
      else velocity.x = 0;
      if (!blocked(body.x, body.z + dz)) body.z += dz;
      else velocity.z = 0;

      // A light head bob and sway.
      const speed = Math.hypot(velocity.x, velocity.z);
      stride += ((speed * dt) / STRIDE) * Math.PI;
      bob += (Math.min(1.2, speed / WALK) - bob) * (1 - Math.exp(-6 * dt));
      const dip = Math.abs(Math.sin(stride));
      const eyeWant = seated ? theater.sitAt(seated).y : EYE + theater.floorAt(body.x - theaterX);
      eyeY += (eyeWant - eyeY) * (1 - Math.exp(-10 * dt));
      camera.position.set(body.x, eyeY - (1 - dip) * 0.03 * bob + 0.015 * bob, body.z);
      camera.position.addScaledVector(right, Math.sin(stride) * 0.012 * bob);
      const fov = 70 + Math.max(0, speed - WALK) * 1.2;
      if (Math.abs(camera.fov - fov) > 0.05) {
        camera.fov += (fov - camera.fov) * (1 - Math.exp(-5 * dt));
        camera.updateProjectionMatrix();
      }

      // What you look at slides forward a little.
      if (controls.isLocked && !held) {
        ray.setFromCamera(centre, camera);
        const hit = ray.intersectObjects(covers, false)[0]?.object;
        const index = hit ? (slotOf.get(hit) ?? null) : null;
        if (index !== hovered) {
          if (hovered != null) place(hovered);
          hovered = index;
          if (hovered != null) place(hovered, 0.05);
          setHover(hovered != null ? (slots[hovered] as Slot).item.title : null);
        }
        const seesTv = hovered == null && tvMedia != null && (tvRay.setFromCamera(centre, camera), tvRay.intersectObject(tvScreen, false).length > 0);
        if (seesTv !== lookingAtTv) setAtTv((lookingAtTv = seesTv));
        const seesCrt = hovered == null && crtScreen != null && (tvRay.setFromCamera(centre, camera), tvRay.intersectObject(crtScreen, false).length > 0);
        if (seesCrt !== lookingAtCrt) setAtCrt((lookingAtCrt = seesCrt));
        const inHall = body.x - theaterX > 3;
        lookSeat = null;
        lookingAtScreen = false;
        // Seated or standing, looking at the screen lets a click change channel (the seat hint says so).
        if (inHall && hovered == null) {
          seatRay.setFromCamera(centre, camera);
          lookSeat = seated ? null : (seatRay.intersectObject(theater.seatMesh, false)[0]?.instanceId ?? null);
          if (lookSeat == null) {
            screenRay.setFromCamera(centre, camera);
            lookingAtScreen = screenRay.intersectObject(theater.screen, false).length > 0;
          }
        }
        if (!seated) hint(lookSeat != null ? "Click to sit down" : lookingAtScreen ? "Click the screen for the next channel · [ ] · type a number · G channel list" : null);
      } else if (hovered != null && !held) {
        place(hovered);
        hovered = null;
        setHover(null);
      }

      // The case in your hands.
      if (held) {
        const h = held;
        h.t = Math.min(1, h.t + dt / 0.5);
        h.yaw += (h.yawTo - h.yaw) * (1 - Math.exp(-10 * dt));
        h.pitch += (h.pitchTo - h.pitch) * (1 - Math.exp(-10 * dt));
        target.set(0, 0.012 + Math.sin(now / 900) * 0.004, -h.dist);
        tmpE.set(h.pitch + Math.sin(now / 1300) * 0.015, h.yaw + 0.06, 0, "YXZ");
        tmpQ.setFromEuler(tmpE);
        let k = ease(h.t);
        if (h.leaving) {
          h.leaving = Math.min(1, h.leaving + dt / 0.45);
          k = 1 - ease(h.leaving);
        }
        h.mesh.position.lerpVectors(h.from, target, k);
        h.mesh.quaternion.slerpQuaternions(h.fromQ, tmpQ, k);
        veilMat.opacity = 0.6 * k;
        if (h.leaving >= 1) dropHeld();
        else if (h.playing) {
          // The disc rises out of the case (which stays put), spins up and comes to you.
          h.playing += dt / 1.6;
          const p = h.playing;
          const disc = h.disc as THREE.Mesh;
          // It slides up out of the top, behind the cover, so the poster stays in view the whole time.
          const rise = ease(Math.min(1, p / 0.45));
          disc.position.set(0, 0.012 + rise * 0.15, -h.dist - 0.002);
          disc.rotation.y += dt * (4 + p * 40);
          if (p > 0.45) {
            const fly = ease(Math.min(1, (p - 0.45) / 0.55));
            disc.position.y = 0.162 + fly * 0.02;
            disc.position.z = -h.dist - 0.002 + fly * (h.dist - 0.1);
          }
          if (p > 0.6 && !dark) setDarkNow(true);
          if (p >= 1) {
            const film = h.film as Film;
            dropHeld();
            playRef.current(film);
            setTimeout(() => setDarkNow(false), 900);
          }
        }
      }

      if (++tick % 15 === 0) nearby();
      renderer.render(scene, camera);
    });

    const fit = () => {
      const { clientWidth: w, clientHeight: h } = box;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    fit();
    nearby();

    return () => {
      alive = false;
      window.clearTimeout(typedTimer);
      renderer.setAnimationLoop(null);
      tvVideo.removeEventListener("error", tvFailed);
      tvVideo.removeEventListener("playing", tvPlaying);
      tvVideo.removeEventListener("ended", tvEnded);
      tvVideo.pause();
      tvVideo.removeAttribute("src");
      tvVideo.load();
      delete (window as unknown as { __vvRelock?: unknown }).__vvRelock;
      observer.disconnect();
      window.removeEventListener("mousemove", spike, { capture: true });
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clearKeys);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      canvasEl.removeEventListener("click", click);
      canvasEl.removeEventListener("pointerdown", press);
      canvasEl.removeEventListener("wheel", wheel);
      controls.dispose();
      shells.dispose();
      for (const thing of [...heldDisposables, ...disposables]) thing.dispose();
      renderer.dispose();
      canvasEl.remove();
    };
  }, [movies, shows]);

  useEffect(() => {
    if (!lineup) return;
    const timer = window.setTimeout(() => setLineup(null), 6000);
    return () => window.clearTimeout(timer);
  }, [lineup]);

  // The channel banner fades after a few seconds.
  useEffect(() => {
    if (!tvNote) return;
    const timer = window.setTimeout(() => setTvNote(null), 4000);
    return () => window.clearTimeout(timer);
  }, [tvNote]);

  const button = "rounded-lg px-4 py-2 text-sm font-semibold transition-colors";
  return (
    <div className="absolute inset-0 overflow-hidden bg-black select-none">
      <div ref={holder} className={holding ? "absolute inset-0 cursor-grab active:cursor-grabbing" : "absolute inset-0"} />
      {locked && !holding ? (
        <>
          <div className="pointer-events-none absolute top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full bg-white/80 ring-2 ring-black/40" />
          {hover ? (
            <div className="pointer-events-none absolute top-[56%] left-1/2 -translate-x-1/2 rounded-lg bg-black/70 px-4 py-2 text-center text-cream">
              <p className="font-semibold">{hover}</p>
              <p className="text-xs text-cream/60">Click or E to pick it up</p>
            </div>
          ) : atCrt ? (
            <div className="pointer-events-none absolute top-[56%] left-1/2 -translate-x-1/2 rounded-lg bg-black/70 px-4 py-2 text-center text-cream">
              <p className="font-semibold">Old TV</p>
              <p className="text-xs text-cream/60">Click for the next channel · [ ] channels · type a number · wheel or − = for volume</p>
            </div>
          ) : atTv ? (
            <div className="pointer-events-none absolute top-[56%] left-1/2 -translate-x-1/2 rounded-lg bg-black/70 px-4 py-2 text-center text-cream">
              <p className="font-semibold">Music TV</p>
              <p className="text-xs text-cream/60">Click for the next channel · [ ] channels · wheel or − = for volume</p>
            </div>
          ) : null}
        </>
      ) : null}
      {holding ? (
        <>
          {holding.play ? (
            <div className={cn("pointer-events-none absolute right-8 flex w-80 flex-col text-cream drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)] max-lg:hidden", holding.episodes.length ? "top-16 bottom-32" : "top-1/2 -translate-y-1/2")}>
              <p className="font-title text-2xl leading-tight font-bold">{holding.title}</p>
              {holding.sub ? <p className="mt-1 text-sm text-cream/70">{holding.sub}</p> : null}
              {holding.facts ? <p className="mt-2 text-sm text-cream/70">{holding.facts}</p> : null}
              {holding.synopsis ? <p className={cn("mt-3 text-sm leading-relaxed text-cream/85", holding.episodes.length ? "line-clamp-4" : "line-clamp-[10]")}>{holding.synopsis}</p> : null}
              {holding.episodes.length ? <EpisodeList episodes={holding.episodes} onPick={(id) => actions.current.playEpisode(id)} /> : null}
            </div>
          ) : null}
          <div className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-3">
            {holding.play ? (
              <>
                <div className="flex gap-2 rounded-xl bg-black/60 p-2 backdrop-blur">
                  <button type="button" className={`${button} bg-accent text-room hover:brightness-110`} onClick={() => actions.current.play()}>
                    {holding.play}
                  </button>
                  <button type="button" className={`${button} bg-cream/15 text-cream hover:bg-cream/25`} onClick={() => actions.current.flip()}>
                    ↻ Flip it over
                  </button>
                  <button type="button" className={`${button} bg-cream/15 text-cream hover:bg-cream/25`} onClick={() => actions.current.putBack()}>
                    Put it back
                  </button>
                </div>
                <p className="text-xs text-cream/50">Drag to turn it · wheel to bring it closer · F flip · Enter play · Esc put back</p>
              </>
            ) : null}
          </div>
        </>
      ) : null}
      {!locked && !holding && !dark && entered ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-cream backdrop-blur-[2px]">
          <p className="font-title text-5xl font-bold tracking-wide">Paused</p>
          <p className="mt-3 text-base text-cream/80">Click anywhere to keep walking</p>
          <p className="mt-6 text-xs text-cream/50">W A S D walk · Shift run · click a case to pick it up · [ ] TV channel · − = TV volume</p>
        </div>
      ) : null}
      {!locked && !holding && !dark && !entered ? (
        <button
          type="button"
          onClick={() => (holder.current?.querySelector("canvas") as HTMLCanvasElement | null)?.click()}
          className="absolute inset-0 flex items-center justify-center bg-black/35"
        >
          <span className="rounded-xl bg-room/90 px-8 py-6 text-center text-cream shadow-2xl ring-1 ring-cream/15">
            <span className="block text-2xl font-bold">Click to walk in</span>
            <span className="mt-2 block text-sm text-cream/65">W A S D to walk · Shift to run · mouse to look · click a case to pick it up · [ ] TV channel · − = TV volume · the door on the right goes to the theater · Esc for the pointer</span>
          </span>
        </button>
      ) : null}
      {tvNote && !holding ? (
        <div key={tvNote.at} className="pointer-events-none absolute top-6 left-1/2 max-w-[70%] -translate-x-1/2 truncate rounded-lg bg-black/70 px-4 py-2 text-sm text-cream">
          {tvNote.text}
        </div>
      ) : null}
      {lineup && lineup.rows.length && !holding ? (
        <div key={lineup.at} className="pointer-events-none absolute top-6 left-6 max-h-[70%] w-80 overflow-hidden rounded-xl bg-black/70 p-2 text-sm text-cream backdrop-blur">
          {lineup.rows.map((row) => (
            <div key={row.number} className={cn("flex gap-2 rounded-md px-2 py-1", row.current ? "bg-accent/80 text-room" : "")}>
              <span className="w-7 shrink-0 text-right font-bold tabular-nums">{row.number}</span>
              <span className="min-w-0 truncate">
                <span className="font-semibold">{row.name}</span>
                {row.title ? <span className={row.current ? "" : "text-cream/60"}> — {row.title}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {theaterHint && locked && !holding ? (
        <div className="pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 rounded-lg bg-black/60 px-4 py-2 text-sm text-cream/90">{theaterHint}</div>
      ) : null}
      <div className="pointer-events-none absolute inset-0 bg-black transition-opacity duration-500" style={{ opacity: dark ? 1 : 0 }} />
    </div>
  );
}
