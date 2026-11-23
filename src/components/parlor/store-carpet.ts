import * as THREE from "three";

type Keep = <T extends { dispose: () => void }>(thing: T) => T;

/**
 * Plush cut-pile carpet, one colour, no pattern. Two layers:
 * - Detail (tiles every DETAIL metres, too fine to see repeat): yarn tufts as rounded
 *   clumps with dark gaps between them (cellular noise), each tuft its own shade, plus
 *   fibre grain. A matching normal map makes the tufts catch the light up close.
 * - Shade (stretched once over the whole floor, so it never repeats): soft pile shading,
 *   lighter where the pile is pressed flat along the walkway, a touch darker at the walls.
 *   It is multiplied in through a small shader hook.
 */
const DETAIL = 0.95; // metres per detail tile (tufts ≈ 7 mm)
const BASE = [76, 20, 27]; // deep wine

function detailTextures(keep: Keep, anisotropy: number) {
  const size = 1024;
  const cell = 8;
  const cells = size / cell;
  // One jittered point per cell: the middle of a tuft, with its own shade and size.
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  const tone = new Float32Array(cells * cells);
  const reach = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    px[i] = 0.15 + Math.random() * 0.7;
    py[i] = 0.15 + Math.random() * 0.7;
    tone[i] = 0.82 + Math.random() * 0.3;
    reach[i] = 0.75 + Math.random() * 0.45;
  }
  const rgba = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const cy = Math.floor(y / cell);
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell);
      // Nearest and second-nearest tuft centres, looking in the 3×3 cells round this one (wrapping).
      let d1 = 9;
      let d2 = 9;
      let near = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const gx = (cx + ox + cells) % cells;
          const gy = (cy + oy + cells) % cells;
          const k = gy * cells + gx;
          const dx = (cx + ox + (px[k] as number)) * cell - x;
          const dy = (cy + oy + (py[k] as number)) * cell - y;
          const d = Math.hypot(dx, dy) / (cell * (reach[k] as number));
          if (d < d1) {
            d2 = d1;
            d1 = d;
            near = k;
          } else if (d < d2) d2 = d;
        }
      // Dome over each tuft; the crease where two tufts meet stays dark.
      const dome = Math.max(0, 1 - d1 * d1);
      const crease = Math.min(1, (d2 - d1) * 2.2);
      const grain = Math.random();
      const h = dome * (0.55 + 0.45 * crease) * (0.85 + 0.15 * grain);
      const shade = (tone[near] as number) * (0.28 + 0.72 * h) * (0.94 + 0.12 * grain);
      const o = (y * size + x) * 4;
      // A faint warm/cool shift from tuft to tuft, as dyed yarn varies.
      const warm = ((tone[near] as number) - 0.97) * 0.25;
      rgba[o] = (BASE[0] as number) * shade * (1 + warm);
      rgba[o + 1] = (BASE[1] as number) * shade;
      rgba[o + 2] = (BASE[2] as number) * shade * (1 - warm);
      rgba[o + 3] = 255;
      height[y * size + x] = h;
    }
  }
  const c = document.createElement("canvas");
  c.width = c.height = size;
  (c.getContext("2d") as CanvasRenderingContext2D).putImageData(new ImageData(rgba, size, size), 0, 0);

  const normal = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)] as number;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * 2.2;
      const ny = (at(x, y + 1) - at(x, y - 1)) * 2.2;
      const len = Math.hypot(nx, ny, 1);
      const o = (y * size + x) * 4;
      normal[o] = ((nx / len) * 0.5 + 0.5) * 255;
      normal[o + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      normal[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  const map = keep(new THREE.CanvasTexture(c));
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = keep(new THREE.DataTexture(normal, size, size));
  normalMap.flipY = true;
  normalMap.generateMipmaps = true;
  normalMap.minFilter = THREE.LinearMipmapLinearFilter;
  normalMap.magFilter = THREE.LinearFilter;
  for (const t of [map, normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
  }
  return { map, normalMap };
}

/** Large, never-repeating shading for a floor `w` × `d` metres. 128 = unchanged. */
function shadeTexture(keep: Keep, w: number, d: number, walkway: number) {
  const nx = Math.min(1024, Math.round(w * 16));
  const ny = Math.min(1024, Math.round(d * 16));
  // Value noise in several octaves, not wrapping (it covers the floor once).
  const octave = (n: number) => {
    const gw = Math.ceil((w / n) * 1) + 2;
    const gh = Math.ceil((d / n) * 1) + 2;
    const grid = new Float32Array(gw * gh).map(() => Math.random() * 2 - 1);
    return (mx: number, mz: number) => {
      const fx = mx / n;
      const fz = mz / n;
      const x0 = Math.floor(fx);
      const z0 = Math.floor(fz);
      let tx = fx - x0;
      let tz = fz - z0;
      tx = tx * tx * (3 - 2 * tx);
      tz = tz * tz * (3 - 2 * tz);
      const g = (x: number, z: number) => grid[Math.min(gh - 1, z) * gw + Math.min(gw - 1, x)] as number;
      return (g(x0, z0) * (1 - tx) + g(x0 + 1, z0) * tx) * (1 - tz) + (g(x0, z0 + 1) * (1 - tx) + g(x0 + 1, z0 + 1) * tx) * tz;
    };
  };
  const big = octave(4.5);
  const mid = octave(1.6);
  const small = octave(0.45);
  const data = new Uint8Array(nx * ny * 4);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const mx = (i / (nx - 1)) * w; // metres from the floor's left edge
      const mz = (j / (ny - 1)) * d;
      // Pile shading: soft patches where the pile lies one way or the other.
      let v = 1 + 0.14 * big(mx, mz) + 0.08 * mid(mx, mz) + 0.025 * small(mx, mz);
      // Pressed flat (a little lighter) down the walkway, with a soft, wandering edge.
      const fromMiddle = Math.abs(mx - w / 2) + 0.35 * mid(mx + 7, mz);
      v += 0.06 * Math.max(0, 1 - Math.max(0, fromMiddle - walkway * 0.3) / (walkway * 0.4));
      // A little darker along the walls.
      const wall = Math.min(mx, w - mx, mz, d - mz);
      v -= 0.07 * Math.max(0, 1 - wall / 0.8);
      const o = (j * nx + i) * 4;
      const g = Math.max(0, Math.min(255, v * 128));
      data[o] = data[o + 1] = data[o + 2] = g;
      data[o + 3] = 255;
    }
  const tex = keep(new THREE.DataTexture(data, nx, ny));
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function carpetMaterial(keep: Keep, anisotropy: number) {
  const { map, normalMap } = detailTextures(keep, anisotropy);
  const shade = { value: null as THREE.Texture | null };
  const material = keep(
    new THREE.MeshPhysicalMaterial({
      map,
      normalMap,
      normalScale: new THREE.Vector2(1, 1),
      roughness: 1,
      metalness: 0,
      sheen: 0.45,
      sheenColor: new THREE.Color("#8a3540"),
      sheenRoughness: 0.6,
      envMapIntensity: 0.1,
    }),
  );
  material.onBeforeCompile = (shader) => {
    shader.uniforms.floorShade = shade;
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec2 vFloorUv;\nvoid main() {")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n  vFloorUv = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform sampler2D floorShade;\nvarying vec2 vFloorUv;\nvoid main() {")
      .replace("#include <map_fragment>", "#include <map_fragment>\n  diffuseColor.rgb *= texture2D( floorShade, vFloorUv ).r * 2.0;");
  };
  /** Fits it to a floor `w` × `d` metres with a walkway `walkway` wide down the middle. */
  const cover = (w: number, d: number, walkway = 4) => {
    map.repeat.set(w / DETAIL, d / DETAIL);
    normalMap.repeat.copy(map.repeat);
    shade.value = shadeTexture(keep, w, d, walkway);
  };
  return { material, cover };
}
