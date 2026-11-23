import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { durable } from "@/lib/durable";
import { catalogById, diskMissingIds, isDiskLibrary, libraryInfo } from "@/lib/library/catalog";
import { STORAGE_KEY } from "@/lib/library/state";
import { onNow } from "@/lib/schedule/engine";
import type { Channel } from "@/lib/schedule/types";

type Keep = <T extends { dispose: () => void }>(thing: T) => T;

/*
 * The cinema off the side of the store. Local coordinates: x = 0 is the store's side wall,
 * +x runs down a short hall and into the auditorium, z = 0 is the middle of the door.
 * The seats face +x, towards the screen on the far wall; the floor steps down row by row.
 */
const DOOR = 0.95; // half the door's width
const DOOR_H = 2.5;
const HALL = 4; // where the auditorium starts
const HALL_Z = 1.2;
const HALL_H = 2.8;
// IMAX-sized: a wall-to-wall screen nearly floor to ceiling, and steep rows.
const END = 48; // the screen wall
const SIDE = 22; // half the auditorium's width
const CEIL = 22;
const PLATFORM = 1.6;
const ROWS = 22;
const TIER = 1.15;
const RISE = 0.5;
const LOW = -ROWS * RISE; // the floor in front of the seats
const STAGE = END - 2.4;
const STAGE_TOP = LOW + 0.5;
const SEAT_PITCH = 0.63;
const SEATS = 57;
const SCREEN_W = SIDE * 2 - 1;
const SCREEN_H = SCREEN_W / 1.43; // the IMAX shape
const CURVE = 2.4; // how far the screen's edges come towards you
const SEAT_EYE = 1.15;

const tierX = (i: number) => HALL + PLATFORM + i * TIER;

/** The floor height at a point (local). */
function floorAt(x: number): number {
  if (x < tierX(0)) return 0;
  if (x >= tierX(ROWS)) return LOW;
  return -Math.floor((x - tierX(0)) / TIER) * RISE;
}

/** Can you stand here (local)? Covers the doorway, the hall and the auditorium. */
function walkable(x: number, z: number): boolean {
  if (x > -0.6 && x < HALL + 0.5 && Math.abs(z) < Math.min(DOOR, HALL_Z) - 0.25) return true;
  if (x < HALL + 0.35 || x > STAGE - 0.3 || Math.abs(z) > SIDE - 0.35) return false;
  // The seats themselves (the legroom in front of them is free).
  if (x >= tierX(0) && x < tierX(ROWS) && Math.abs(z) < (SEATS / 2) * SEAT_PITCH + 0.05) {
    const into = (x - tierX(0)) % TIER;
    if (into < 0.62) return false;
  }
  return true;
}

function velvet(keep: Keep, color: string) {
  return keep(new THREE.MeshPhysicalMaterial({ color, roughness: 0.8, sheen: 1, sheenColor: new THREE.Color("#ff6a78"), sheenRoughness: 0.45 }));
}

/** A curtain hanging in soft folds, `w` wide and `h` tall, its face towards +z. */
function curtainGeometry(keep: Keep, w: number, h: number, folds: number, depth: number) {
  const geo = new THREE.PlaneGeometry(w, h, Math.round(folds * 12), 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / w + 0.5;
    pos.setZ(i, Math.sin(u * folds * Math.PI * 2) * depth);
  }
  geo.computeVertexNormals();
  return keep(geo);
}

function signTexture(keep: Keep) {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#3a060c";
  g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = "#d9b56a";
  g.lineWidth = 8;
  g.strokeRect(14, 14, 996, 228);
  // A border of bulbs.
  for (let x = 40; x < 1000; x += 40)
    for (const y of [34, 222]) {
      g.fillStyle = "#fff1c4";
      g.beginPath();
      g.arc(x, y, 8, 0, Math.PI * 2);
      g.fill();
    }
  g.fillStyle = "#ffd98a";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "bold 120px Georgia, serif";
  g.fillText("THEATER", 512, 132);
  const t = keep(new THREE.CanvasTexture(c));
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export type Theater = ReturnType<typeof buildTheater>;

export function buildTheater(keep: Keep, posters: (() => Promise<THREE.Texture | null>)[]) {
  const group = new THREE.Group();
  const box = keep(new THREE.BoxGeometry(1, 1, 1));
  const block = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(box, mat);
    m.scale.set(x1 - x0, y1 - y0, z1 - z0);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    group.add(m);
    return m;
  };
  const fabric = keep(new THREE.MeshLambertMaterial({ color: "#3a0d14" }));
  const darkWood = keep(new THREE.MeshStandardMaterial({ color: "#24130b", roughness: 0.6 }));
  const gold = keep(new THREE.MeshStandardMaterial({ color: "#c9a253", roughness: 0.35, metalness: 0.8 }));
  const carpet = keep(new THREE.MeshLambertMaterial({ color: "#2a0c10" }));
  const black = keep(new THREE.MeshBasicMaterial({ color: "#050304" }));
  const ceilingMat = keep(new THREE.MeshLambertMaterial({ color: "#0d0709" }));
  const red = velvet(keep, "#7a0f1a");

  // ---- The doorway, seen from the store ----
  for (const s of [-1, 1]) block(-0.14, 0.14, 0, DOOR_H + 0.08, s * DOOR - 0.06, s * DOOR + 0.06, darkWood);
  block(-0.14, 0.14, DOOR_H, DOOR_H + 0.1, -DOOR - 0.06, DOOR + 0.06, darkWood);
  const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(2.0, 0.5)), keep(new THREE.MeshBasicMaterial({ map: signTexture(keep) })));
  sign.position.set(-0.12, DOOR_H + 0.42, 0);
  sign.rotation.y = -Math.PI / 2;
  group.add(sign);
  // Curtains tied back either side of the door, on the hall side.
  const doorCurtain = curtainGeometry(keep, 0.5, DOOR_H, 3, 0.04);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(doorCurtain, red);
    m.position.set(0.25, DOOR_H / 2, s * (DOOR - 0.25));
    m.rotation.y = -Math.PI / 2;
    group.add(m);
  }

  // ---- The hall ----
  block(0.1, HALL, -0.02, 0, -HALL_Z, HALL_Z, carpet);
  block(0.1, HALL, HALL_H, HALL_H + 0.1, -HALL_Z, HALL_Z, ceilingMat);
  for (const s of [-1, 1]) {
    block(0.1, HALL, 0, HALL_H, s * HALL_Z, s * (HALL_Z + 0.1), fabric);
    block(0.1, HALL, 0, 0.9, s * (HALL_Z - 0.02), s * (HALL_Z + 0.02), darkWood);
  }
  // Coming attractions: posters from your own shelves, framed on the hall walls.
  const posterGeo = keep(new THREE.PlaneGeometry(0.68, 1.02));
  posters.slice(0, 4).forEach((load, i) => {
    const s = i % 2 === 0 ? -1 : 1;
    const x = 1.2 + Math.floor(i / 2) * 1.7;
    block(x - 0.42, x + 0.42, 0.95, 2.25, s * (HALL_Z - 0.04), s * (HALL_Z - 0.0), gold);
    const mat = keep(new THREE.MeshBasicMaterial({ color: "#222" }));
    const m = new THREE.Mesh(posterGeo, mat);
    m.position.set(x, 1.6, s * (HALL_Z - 0.05));
    m.rotation.y = s === -1 ? 0 : Math.PI;
    group.add(m);
    void load().then((tex) => {
      if (!tex) return;
      keep(tex);
      mat.map = tex;
      mat.color.set("#d8d0c4");
      mat.needsUpdate = true;
    });
  });
  const hallLight = new THREE.PointLight("#ffb46a", 2.2, 6, 1.6);
  hallLight.position.set(2, HALL_H - 0.3, 0);
  group.add(hallLight);

  // ---- The auditorium ----
  // Floor: a platform at the top, then a step down for each row, then the front.
  block(HALL, tierX(1), LOW - 0.1, 0, -SIDE, SIDE, carpet);
  for (let i = 1; i < ROWS; i++) block(tierX(i), tierX(i + 1), LOW - 0.1, -i * RISE, -SIDE, SIDE, carpet);
  block(tierX(ROWS), END, LOW - 0.1, LOW, -SIDE, SIDE, carpet);
  // Little amber lights on the step edges in the side aisles.
  const stepLight = keep(new THREE.MeshBasicMaterial({ color: "#ffb347" }));
  const aisle = (SEATS / 2) * SEAT_PITCH + 0.15;
  for (let i = 1; i <= ROWS; i++)
    for (const s of [-1, 1]) {
      const top = -(i - 1) * RISE;
      block(tierX(i) - 0.012, tierX(i) + 0.008, top - 0.035, top - 0.015, s * (aisle + 0.1), s * (SIDE - 0.15), stepLight);
    }
  // Walls and ceiling.
  for (const s of [-1, 1]) block(HALL, END, LOW, CEIL, s * SIDE, s * (SIDE + 0.2), fabric);
  block(END, END + 0.2, LOW, CEIL, -SIDE, SIDE, black);
  for (const s of [-1, 1]) block(HALL - 0.2, HALL, 0, CEIL, s * HALL_Z, s * SIDE, fabric);
  block(HALL - 0.2, HALL, HALL_H, CEIL, -HALL_Z, HALL_Z, fabric);
  block(HALL, END, CEIL, CEIL + 0.1, -SIDE, SIDE, ceilingMat);
  // Wood pilasters with gold caps down the side walls, and sconces on some of them.
  // Sconces: a brass plate on the pilaster and a half-round glass shade flat against it.
  const sconceMat = keep(new THREE.MeshBasicMaterial({ color: "#ffe3b3", side: THREE.DoubleSide, toneMapped: false }));
  const shadeGeo = keep(new THREE.CylinderGeometry(0.2, 0.11, 0.42, 20, 1, false, Math.PI / 2, Math.PI));
  const capGeo = keep(new THREE.CylinderGeometry(0.21, 0.21, 0.03, 20, 1, false, Math.PI / 2, Math.PI));
  let lights = 0;
  for (let x = HALL + 2.4; x < STAGE - 1; x += 3.2) {
    for (const s of [-1, 1]) {
      const y0 = floorAt(x);
      const inner = s * (SIDE - 0.12);
      block(x - 0.18, x + 0.18, y0, CEIL, inner - 0.06, inner + 0.06, darkWood);
      block(x - 0.22, x + 0.22, CEIL - 0.3, CEIL - 0.18, inner - 0.08, inner + 0.08, gold);
      const face = s * (SIDE - 0.18); // the pilaster's front
      const y = y0 + 2.9;
      block(x - 0.1, x + 0.1, y - 0.36, y + 0.3, face - 0.015, face + 0.015, gold);
      const shade = new THREE.Mesh(shadeGeo, sconceMat);
      const cap = new THREE.Mesh(capGeo, gold);
      shade.position.set(x, y, face);
      cap.position.set(x, y + 0.22, face);
      if (s === -1) shade.rotation.y = cap.rotation.y = Math.PI;
      group.add(shade, cap);
      if (lights < 8 && Math.round((x - HALL - 2.4) / 3.2) % 3 === 0) {
        const glow = new THREE.PointLight("#ffa860", 5, 12, 1.6);
        glow.position.set(x, y + 0.2, s * (SIDE - 0.7));
        group.add(glow);
        lights++;
      }
    }
  }
  // A starry ceiling.
  const starPos = new Float32Array(4000 * 3);
  for (let i = 0; i < 4000; i++) {
    starPos[i * 3] = HALL + 0.3 + Math.random() * (END - HALL - 0.6);
    starPos[i * 3 + 1] = CEIL - 0.01;
    starPos[i * 3 + 2] = (Math.random() * 2 - 1) * (SIDE - 0.2);
  }
  const starGeo = keep(new THREE.BufferGeometry());
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  group.add(new THREE.Points(starGeo, keep(new THREE.PointsMaterial({ color: "#ffe6bd", size: 0.1, fog: false }))));

  // ---- Stage, screen, curtains ----
  block(STAGE, END, LOW, STAGE_TOP, -SIDE, SIDE, darkWood);
  block(STAGE - 0.02, STAGE, STAGE_TOP - 0.06, STAGE_TOP, -SIDE, SIDE, gold);
  const screenY = STAGE_TOP + 0.35 + SCREEN_H / 2;
  const masking = new THREE.Mesh(keep(new THREE.PlaneGeometry(SCREEN_W + 0.5, SCREEN_H + 0.5)), black);
  masking.position.set(END - 0.02, screenY, 0);
  masking.rotation.y = -Math.PI / 2;
  group.add(masking);
  const screenOff = keep(new THREE.MeshBasicMaterial({ color: "#0c0c0e", fog: false }));
  // Gently curved: the sides come towards you.
  const screenGeo = keep(new THREE.PlaneGeometry(1, 1, 48, 1));
  const sp = screenGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) sp.setZ(i, CURVE * (2 * sp.getX(i)) ** 2);
  screenGeo.computeVertexNormals();
  const screen = new THREE.Mesh(screenGeo, screenOff);
  screen.position.set(END - 0.04, screenY, 0);
  screen.rotation.y = -Math.PI / 2;
  screen.scale.set(SCREEN_W, SCREEN_H, 1);
  group.add(screen);
  const valance = new THREE.Mesh(curtainGeometry(keep, SIDE * 2, 0.6, 40, 0.06), red);
  valance.position.set(END - 0.45, CEIL - 0.3, 0);
  valance.rotation.y = -Math.PI / 2;
  group.add(valance);
  block(END - 0.55, END - 0.5, CEIL - 0.62, CEIL - 0.58, -SIDE, SIDE, gold);

  // The projector: a little lit window above the hall door and a faint beam to the screen.
  const booth = new THREE.Vector3(HALL + 0.01, 15, 0);
  const port = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.6, 0.36)), keep(new THREE.MeshBasicMaterial({ color: "#fff4d8" })));
  port.position.copy(booth);
  port.rotation.y = Math.PI / 2;
  group.add(port);
  const toScreen = new THREE.Vector3(END - 0.05, screenY, 0).sub(booth);
  const beamGeo = new THREE.CylinderGeometry(SCREEN_W * 0.42, 0.14, toScreen.length(), 32, 1, true);
  beamGeo.translate(0, toScreen.length() / 2, 0);
  beamGeo.rotateX(Math.PI / 2);
  const beamMat = keep(new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.025, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  const beam = new THREE.Mesh(keep(beamGeo), beamMat);
  beam.position.copy(booth);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), toScreen.clone().normalize());
  beam.visible = false;
  group.add(beam);
  // The picture lights the room.
  const screenLight = new THREE.PointLight("#ffffff", 0, 110, 0.9);
  screenLight.position.set(STAGE - 2, screenY - 0.5, 0);
  group.add(screenLight);

  // ---- Seats: velvet with dark arms, facing the screen ----
  const part = (g: THREE.BufferGeometry, x: number, y: number, z: number, tilt = 0) => {
    if (tilt) g.rotateX(tilt);
    g.translate(x, y, z);
    const flat = g.index ? g.toNonIndexed() : g;
    if (flat !== g) g.dispose();
    flat.deleteAttribute("uv");
    return flat;
  };
  const softParts = [part(new RoundedBoxGeometry(0.5, 0.13, 0.5, 2, 0.05), 0, 0.46, 0.04), part(new RoundedBoxGeometry(0.52, 0.66, 0.13, 2, 0.05), 0, 0.84, -0.22, -0.14)];
  const armParts = [
    ...[-1, 1].flatMap((s) => [part(new THREE.BoxGeometry(0.07, 0.06, 0.48), s * 0.3, 0.66, 0.0), part(new THREE.BoxGeometry(0.06, 0.62, 0.1), s * 0.3, 0.31, -0.08)]),
  ];
  const softGeo = keep(mergeGeometries(softParts) as THREE.BufferGeometry);
  const armGeo = keep(mergeGeometries(armParts) as THREE.BufferGeometry);
  for (const g of [...softParts, ...armParts]) g.dispose();
  softGeo.rotateY(Math.PI / 2);
  armGeo.rotateY(Math.PI / 2);
  type Seat = { x: number; z: number; floor: number };
  const seats: Seat[] = [];
  for (let i = 0; i < ROWS; i++)
    for (let k = 0; k < SEATS; k++) seats.push({ x: tierX(i) + 0.34, z: (k - (SEATS - 1) / 2) * SEAT_PITCH, floor: -i * RISE });
  const seatMesh = new THREE.InstancedMesh(softGeo, red, seats.length);
  const armMesh = new THREE.InstancedMesh(armGeo, darkWood, seats.length);
  const m4 = new THREE.Matrix4();
  seats.forEach((seat, i) => {
    m4.makeTranslation(seat.x, seat.floor, seat.z);
    seatMesh.setMatrixAt(i, m4);
    armMesh.setMatrixAt(i, m4);
  });
  group.add(seatMesh, armMesh);

  /** 0 in the store, rising through the hall, 1 in the auditorium. */
  const inside = (x: number) => Math.min(1, Math.max(0, (x - 0.5) / (HALL - 0.5)));

  // ---- The light from the picture ----
  const sample = document.createElement("canvas");
  sample.width = sample.height = 4;
  const sg = sample.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const glow = new THREE.Color();
  let lastSample = 0;
  const tick = (nowMs: number, video: HTMLVideoElement | null, near: number) => {
    const live = !!video && video.readyState >= 2 && !video.paused;
    beam.visible = live && near > 0.2;
    if (!live) {
      screenLight.intensity = 0;
      return;
    }
    if (nowMs - lastSample > 180) {
      lastSample = nowMs;
      try {
        sg.drawImage(video as HTMLVideoElement, 0, 0, 4, 4);
        const d = sg.getImageData(0, 0, 4, 4).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i] as number;
          g += d[i + 1] as number;
          b += d[i + 2] as number;
        }
        glow.setRGB(r / 16 / 255, g / 16 / 255, b / 16 / 255, THREE.SRGBColorSpace);
      } catch {
        glow.set("#8090a0");
      }
    }
    const level = (glow.r + glow.g + glow.b) / 3;
    screenLight.color.copy(glow).multiplyScalar(1 / Math.max(0.05, level));
    screenLight.intensity += (near * (6 + level * 110) - screenLight.intensity) * 0.15;
    beamMat.color.copy(screenLight.color);
    beamMat.opacity = 0.012 + level * 0.05;
  };

  /** Fits the picture inside the screen at its own shape. */
  const fit = (w: number, h: number) => {
    const aspect = w && h ? w / h : 16 / 9;
    if (aspect > SCREEN_W / SCREEN_H) screen.scale.set(SCREEN_W, SCREEN_W / aspect, 1);
    else screen.scale.set(SCREEN_H * aspect, SCREEN_H, 1);
  };

  return {
    group,
    screen,
    screenOff,
    seatMesh,
    seats,
    floorAt,
    walkable,
    inside,
    tick,
    fit,
    /** Where your eyes are in a seat, and where you stand up to (local). */
    sitAt: (seat: Seat) => ({ x: seat.x - 0.04, z: seat.z, y: seat.floor + SEAT_EYE }),
    standFrom: (seat: Seat) => ({ x: seat.x - 0.34 + 0.85, z: seat.z }),
    screenCentre: new THREE.Vector3(END, screenY, 0),
    perRow: SEATS,
  };
}

/* ---------------- Live TV on the big screen ---------------- */

type Stations = { channels: Channel[]; missing: Set<string> };

/** Your TV Guide stations, read straight from the saved store. */
function loadStations(): Stations | null {
  try {
    const key = isDiskLibrary() ? `${STORAGE_KEY}.disk:${libraryInfo.folders.join("|")}` : STORAGE_KEY;
    const raw = durable.getItem(key);
    const state = raw ? (JSON.parse(raw) as { state?: { channels?: Channel[]; missingIds?: string[] } }).state : null;
    const channels = (state?.channels ?? [])
      .filter((channel) => Array.isArray(channel.mediaIds) && channel.mediaIds.length && typeof channel.anchorMs === "number")
      .sort((a, b) => a.number - b.number);
    if (!channels.length) return null;
    const missing = new Set(diskMissingIds);
    for (const id of state?.missingIds ?? []) missing.add(id);
    return { channels, missing };
  } catch {
    return null;
  }
}

export type LineupRow = { number: number; name: string; title: string; current: boolean };

/**
 * Plays whatever is on the chosen station, live, like the TV Guide: straight from the file
 * when the browser can, else the picture copied with the sound converted, else re-encoded.
 */
export function theaterTv(
  events: { note: (text: string) => void; picture: (video: HTMLVideoElement | null) => void },
  /** `save`: where its channel and volume are kept; `channel`: the station number it starts on. */
  opts: { save?: string; label?: string; channel?: number } = {},
) {
  const save = opts.save ?? "parlor.theater";
  const label = opts.label ?? "Theater";
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.playsInline = true;
  video.volume = 0;
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  const stations = loadStations();
  const saved = durable.getItem(`${save}Channel`);
  let index =
    saved != null || opts.channel == null
      ? Math.max(0, Math.min((stations?.channels.length ?? 1) - 1, Number(saved ?? "0") || 0))
      : Math.max(0, stations?.channels.findIndex((ch) => ch.number === opts.channel) ?? 0);
  let media: string | null = null;
  let level = 0;
  let base = 0; // the film's time at the stream's start
  let token = 0;
  let on = false;
  let knob = Math.min(1, Math.max(0, Number(durable.getItem(`${save}Volume`) ?? "0.8") || 0));

  const channel = () => stations?.channels[index] ?? null;
  const airing = () => {
    const ch = channel();
    return ch && stations ? onNow(ch, catalogById, stations.missing, Date.now()) : null;
  };
  const titleOf = (id: string | undefined) => (id ? (catalogById.get(id)?.title ?? "") : "");
  const banner = () => {
    const ch = channel();
    const now = airing();
    if (ch) events.note(`CH ${ch.number} · ${ch.name}${now ? ` — ${titleOf(now.slot.mediaId)}` : ""}`);
  };
  const off = () => {
    token++;
    media = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    events.picture(null);
  };
  const start = async (my: number) => {
    const now = airing();
    if (!now || !media) return;
    const t = now.offsetMs / 1000;
    if (level === 0) {
      base = 0;
      video.src = `/media/${media}`;
      video.addEventListener("loadedmetadata", () => my === token && (video.currentTime = (airing()?.offsetMs ?? now.offsetMs) / 1000), { once: true });
    } else if (level === 1) {
      const body = (await fetch(`/api/keyframe/${media}?t=${t.toFixed(2)}`)
        .then((r) => r.json())
        .catch(() => null)) as { found: boolean; t: number; base: number } | null;
      if (my !== token) return;
      if (!body?.found) {
        level = 2;
        return start(my);
      }
      base = body.base;
      video.src = `/media/${media}?v=copy&a=0&t=${body.t.toFixed(3)}`;
    } else {
      base = t;
      video.src = `/media/${media}?v=enc&a=0&t=${t.toFixed(2)}`;
    }
    video.play().catch(() => {});
  };
  const tune = () => {
    if (!on) return;
    const now = airing();
    const film = now ? catalogById.get(now.slot.mediaId) : null;
    if (!now || !film) return off();
    const my = ++token;
    media = film.id;
    level = film.direct ? 0 : 1;
    void start(my);
  };
  video.addEventListener("error", () => {
    if (!media || level >= 2) return;
    level++;
    void start(++token);
  });
  video.addEventListener("playing", () => events.picture(video));
  video.addEventListener("ended", () => tune());

  let lastCheck = 0;
  return {
    video,
    texture,
    has: () => !!stations,
    /** Turns the projector on when you come near, and off when you leave. */
    power(want: boolean) {
      if (want === on) return;
      on = want;
      if (on) tune();
      else off();
    },
    step(by: number) {
      if (!stations) return events.note("No TV stations yet — make some in the TV Guide");
      index = (index + by + stations.channels.length) % stations.channels.length;
      durable.setItem(`${save}Channel`, String(index));
      banner();
      tune();
    },
    go(number: number) {
      const i = stations?.channels.findIndex((ch) => ch.number === number) ?? -1;
      if (i < 0) return events.note(`No channel ${number}`);
      index = i;
      durable.setItem(`${save}Channel`, String(index));
      banner();
      tune();
    },
    turn(by: number) {
      knob = Math.round(Math.min(1, Math.max(0, knob + by)) * 50) / 50; // 2% steps
      durable.setItem(`${save}Volume`, String(knob));
      events.note(knob === 0 ? `${label} muted` : `${label} volume ${Math.round(knob * 100)}%`);
    },
    lineup(): LineupRow[] {
      if (!stations) return [];
      const at = Date.now();
      return stations.channels.map((ch, i) => {
        const now = onNow(ch, catalogById, stations.missing, at);
        return { number: ch.number, name: ch.name, title: titleOf(now?.slot.mediaId), current: i === index };
      });
    },
    /** Each frame: loudness by where you are, back to live after a pause, follow the schedule. */
    update(nowMs: number, hear: number) {
      video.volume = Math.min(1, knob * hear);
      if (!on) return;
      if (media && video.paused && video.readyState >= 2) tune();
      if (nowMs - lastCheck < 2000) return;
      lastCheck = nowMs;
      const now = airing();
      if ((now?.slot.mediaId ?? null) !== media) return tune();
      if (now && media && video.readyState >= 2) {
        const drift = base + video.currentTime - now.offsetMs / 1000;
        if (level === 0 && Math.abs(drift) > 3) video.currentTime = now.offsetMs / 1000;
        else if (level > 0 && Math.abs(drift) > 12) tune();
      }
    },
    current: () => ({ media, level, time: video.currentTime, paused: video.paused, volume: video.volume, channel: channel()?.name ?? null }),
    pause: () => video.pause(),
    dispose() {
      off();
      texture.dispose();
    },
  };
}
