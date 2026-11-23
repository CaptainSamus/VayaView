import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Keep = <T extends { dispose: () => void }>(thing: T) => T;

/**
 * Wear for the plastic, drawn so it tiles with no edges (anything near a border is drawn
 * again on the other side):
 * - `rough`: roughness (green channel). Grey 64 is clean gloss; lighter is duller. Materials set
 *   roughness so 64 lands where they want clean plastic (roughness = factor × value / 255).
 * - `normal`: the scratches as fine grooves, so they catch the light instead of only dulling it.
 */
export function caseWear(keep: Keep, anisotropy: number) {
  const size = 2048;
  const make = (fill: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, size, size);
    return { canvas, ctx };
  };
  const rough = make("rgb(64,64,64)");
  const height = make("rgb(128,128,128)");
  const g = rough.ctx;
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  /** Draws at (x, y), and again wherever reach `r` crosses an edge, so the map wraps cleanly. */
  const tiled = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, draw: (c: CanvasRenderingContext2D) => void) => {
    for (const dx of [-size, 0, size])
      for (const dy of [-size, 0, size]) {
        if (x + dx < -r || x + dx > size + r || y + dy < -r || y + dy > size + r) continue;
        ctx.save();
        ctx.translate(x + dx, y + dy);
        draw(ctx);
        ctx.restore();
      }
  };

  // Smudges: soft greasy patches.
  for (let i = 0; i < 34; i++) {
    const r = rnd(60, 280);
    const a = rnd(0.06, 0.24);
    const squash = rnd(0.5, 1);
    const turn = rnd(0, Math.PI);
    tiled(g, rnd(0, size), rnd(0, size), r, (c) => {
      c.rotate(turn);
      c.scale(1, squash);
      const grad = c.createRadialGradient(0, 0, 0, 0, 0, r);
      grad.addColorStop(0, `rgba(170,170,170,${a})`);
      grad.addColorStop(0.6, `rgba(170,170,170,${a * 0.45})`);
      grad.addColorStop(1, "rgba(170,170,170,0)");
      c.fillStyle = grad;
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.fill();
    });
  }
  // A few fingerprints: whorls of ridges fading out at the rim.
  for (let i = 0; i < 8; i++) {
    const turn = rnd(0, Math.PI);
    const rings = Array.from({ length: 16 }, (_, k) => ({ k, a: rnd(0.05, 0.13) * (1 - k / 18), s: rnd(0, 1), e: rnd(0, 1) }));
    tiled(g, rnd(0, size), rnd(0, size), 80, (c) => {
      c.rotate(turn);
      c.lineWidth = 2.4;
      for (const ring of rings) {
        c.strokeStyle = `rgba(190,190,190,${ring.a})`;
        c.beginPath();
        c.ellipse(0, 0, (ring.k + 1) * 3.6, (ring.k + 1) * 4.6, 0, ring.s, Math.PI * 2 - ring.e);
        c.stroke();
      }
    });
  }
  // Wipe swirls: faint fine arcs from cloths and sleeves rubbing.
  for (let i = 0; i < 260; i++) {
    const r = rnd(160, 900);
    const start = rnd(0, Math.PI * 2);
    const sweep = rnd(0.08, 0.4);
    const a = rnd(0.03, 0.09);
    const w = rnd(0.6, 1.4);
    // Placed by the arc's middle, so the reach test covers it.
    const mid = start + sweep / 2;
    const mx = Math.cos(mid) * r;
    const my = Math.sin(mid) * r;
    tiled(g, rnd(0, size), rnd(0, size), r * sweep, (c) => {
      c.strokeStyle = `rgba(150,150,150,${a})`;
      c.lineWidth = w;
      c.beginPath();
      c.arc(-mx, -my, r, start, start + sweep);
      c.stroke();
    });
  }

  // Scratches: hairlines that taper in and out, mostly in clusters running the same way
  // (cases slid on and off shelves), plus strays and a few deeper ones.
  const scratch = (x: number, y: number, angle: number, len: number, width: number, alpha: number) => {
    const bend = rnd(-0.12, 0.12);
    const steps = Math.max(4, Math.round(len / 10));
    const points = Array.from({ length: steps + 1 }, (_, k) => {
      const t = k / steps;
      const a = angle + bend * (t - 0.5) * 2;
      return [Math.cos(a) * len * (t - 0.5), Math.sin(a) * len * (t - 0.5)] as const;
    });
    const draw = (c: CanvasRenderingContext2D, colour: string, scale: number) => {
      c.lineCap = "round";
      for (let k = 0; k < steps; k++) {
        const fade = Math.sin(Math.PI * ((k + 0.5) / steps)) ** 0.7;
        const [x0, y0] = points[k] as readonly [number, number];
        const [x1, y1] = points[k + 1] as readonly [number, number];
        c.strokeStyle = `rgba(${colour},${Math.min(1, alpha * fade * scale)})`;
        c.lineWidth = width * (0.4 + 0.6 * fade);
        c.beginPath();
        c.moveTo(x0, y0);
        c.lineTo(x1, y1);
        c.stroke();
      }
    };
    tiled(g, x, y, len, (c) => draw(c, "225,225,225", 1));
    tiled(height.ctx, x, y, len, (c) => draw(c, "0,0,0", 1.6));
  };
  for (let i = 0; i < 26; i++) {
    const cx = rnd(0, size);
    const cy = rnd(0, size);
    const dir = Math.random() < 0.6 ? rnd(-0.25, 0.25) : rnd(0, Math.PI);
    const spread = rnd(60, 260);
    const count = Math.round(rnd(8, 26));
    for (let k = 0; k < count; k++)
      scratch(cx + rnd(-spread, spread), cy + rnd(-spread, spread), dir + rnd(-0.08, 0.08), rnd(30, 260), rnd(0.6, 1.3), rnd(0.1, 0.3));
  }
  for (let i = 0; i < 700; i++) scratch(rnd(0, size), rnd(0, size), rnd(0, Math.PI), rnd(6, 50), rnd(0.6, 1.2), rnd(0.1, 0.32));
  for (let i = 0; i < 10; i++) scratch(rnd(0, size), rnd(0, size), rnd(0, Math.PI), rnd(120, 420), rnd(1.4, 2.2), rnd(0.22, 0.36));

  // A little grain so the gloss isn't perfectly flat (per pixel, so it tiles too).
  const image = g.getImageData(0, 0, size, size);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, (px[i] as number) + (Math.random() - 0.5) * 8));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  g.putImageData(image, 0, 0);

  // Grooves to normals, sampling across the wrap.
  const hd = height.ctx.getImageData(0, 0, size, size).data;
  const normal = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => (hd[(((y + size) % size) * size + ((x + size) % size)) * 4] as number) / 255;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * 3;
      const ny = (at(x, y + 1) - at(x, y - 1)) * 3; // canvas y runs down, texture v runs up
      const len = Math.hypot(nx, ny, 1);
      const o = (y * size + x) * 4;
      normal[o] = ((nx / len) * 0.5 + 0.5) * 255;
      normal[o + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      normal[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }

  const roughTex = keep(new THREE.CanvasTexture(rough.canvas));
  const normalTex = keep(new THREE.DataTexture(normal, size, size));
  normalTex.flipY = true; // match the canvas texture's orientation
  normalTex.generateMipmaps = true;
  normalTex.minFilter = THREE.LinearMipmapLinearFilter;
  normalTex.magFilter = THREE.LinearFilter;
  for (const t of [roughTex, normalTex]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
  }
  return { rough: roughTex, normal: normalTex };
}

/** Copies of the wear with their own random placement, so a held case isn't a twin of its neighbours. */
export function wearFor(base: { rough: THREE.Texture; normal: THREE.Texture }) {
  const x = Math.random();
  const y = Math.random();
  const copy = (t: THREE.Texture) => {
    const c = t.clone();
    c.offset.set(x, y);
    c.needsUpdate = true;
    return c;
  };
  return { rough: copy(base.rough), normal: copy(base.normal) };
}

/**
 * The seam where the two halves of the shell meet: a thin dark line round the top, the bottom
 * and the opening edge (+x), at mid-depth. None on the spine (-x), where the halves are hinged.
 */
export function caseSeam(keep: Keep, c: { w: number; h: number; d: number }) {
  const t = 0.0011; // how far the strip stands proud of the surface, both ways
  const z = 0.0009; // line thickness
  const corner = 0.0028; // stops short of the rounded corners
  const top = new THREE.BoxGeometry(c.w - corner * 2, t, z);
  const bottom = top.clone();
  top.translate(0, c.h / 2, 0);
  bottom.translate(0, -c.h / 2, 0);
  const edge = new THREE.BoxGeometry(t, c.h - corner * 2, z);
  edge.translate(c.w / 2, 0, 0);
  const geometry = keep(mergeGeometries([top, bottom, edge]) as THREE.BufferGeometry);
  top.dispose();
  bottom.dispose();
  edge.dispose();
  const material = keep(new THREE.MeshStandardMaterial({ color: "#070b16", roughness: 0.9 }));
  return { geometry, material };
}
