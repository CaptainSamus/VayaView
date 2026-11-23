import * as THREE from "three";

type Keep = <T extends { dispose: () => void }>(thing: T) => T;

/** Which way the code runs: 1 falls like the film, -1 rises. */
const RAIN_DIRECTION = 1;

/**
 * The front of the store: a wall with a locked double door in the middle and windows along
 * both sides, and through the glass, green code raining forever on black. The store's
 * front wall is at z = `front`; outside is +z.
 */
export function buildFront(keep: Keep, width: number, wallH: number, front: number, wallMat: THREE.Material) {
  const group = new THREE.Group();
  const box = keep(new THREE.BoxGeometry(1, 1, 1));
  const frameMat = keep(new THREE.MeshStandardMaterial({ color: "#3d2416", roughness: 0.7 }));
  const sillMat = keep(new THREE.MeshStandardMaterial({ color: "#8a5a36", roughness: 0.55 }));
  const glassMat = keep(new THREE.MeshStandardMaterial({ color: "#a8ffcc", transparent: true, opacity: 0.08, roughness: 0.04, metalness: 0.3, envMapIntensity: 1.2, depthWrite: false }));
  const block = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
    const m = new THREE.Mesh(box, material);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };
  const glass = (w: number, h: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, h)), glassMat);
    m.position.set(x, y, z);
    group.add(m);
  };

  const T = 0.2; // wall thickness
  const sill = 1.0;
  const head = 2.6;
  const doorW = 1.9;
  const doorH = 2.35;
  const half = width / 2;

  // Over the door, starting on top of the door frame so no faces share a plane.
  const overY = doorH + 0.1;
  block(doorW + 0.08, wallH - overY, T, 0, overY + (wallH - overY) / 2, front, wallMat);
  // Each side: wainscot under the windows, wall above, posts between the panes.
  for (const s of [-1, 1]) {
    const x0 = doorW / 2 + 0.04; // starts inside the door post, so their faces don't overlap
    const span = half - x0;
    const cx = s * (x0 + span / 2);
    block(span, sill, T + 0.04, cx, sill / 2, front, frameMat);
    block(span, wallH - head, T, cx, head + (wallH - head) / 2, front, wallMat);
    block(span - 0.02, 0.05, 0.3, cx, sill + 0.025, front - 0.05, sillMat); // window sill inside
    const lead = 0.5; // solid wall beside the door
    const inner = x0 + lead;
    const outer = half - 0.4;
    const panes = Math.max(1, Math.round((outer - inner) / 2.2));
    const paneW = (outer - inner) / panes;
    block(lead, head - sill, T, s * (x0 + lead / 2), sill + (head - sill) / 2, front, wallMat);
    block(half - outer, head - sill, T, s * (outer + (half - outer) / 2), sill + (head - sill) / 2, front, wallMat);
    for (let i = 0; i < panes; i++) {
      const px = s * (inner + paneW * (i + 0.5));
      glass(paneW, head - sill, px, sill + (head - sill) / 2, front + 0.02);
      // Frame: posts, a crossbar, the top.
      if (i > 0) block(0.1, head - sill, T + 0.04, s * (inner + paneW * i), sill + (head - sill) / 2, front, frameMat);
      block(paneW, 0.05, 0.08, px, sill + (head - sill) * 0.62, front + 0.02, frameMat);
      block(0.04, head - sill, 0.06, px, sill + (head - sill) / 2, front + 0.02, frameMat);
    }
    block(outer - inner, 0.08, T + 0.06, s * (inner + (outer - inner) / 2), head - 0.04, front, frameMat);
  }

  // The double door: wooden frames round glass, push bars, a kick plate. It doesn't open.
  const doorMat = keep(new THREE.MeshStandardMaterial({ color: "#5a3520", roughness: 0.6 }));
  const brass = keep(new THREE.MeshStandardMaterial({ color: "#d9b56a", roughness: 0.3, metalness: 0.8 }));
  block(doorW + 0.16, 0.1, T + 0.08, 0, doorH + 0.05, front, frameMat);
  for (const s of [-1, 1]) {
    block(0.08, doorH, T + 0.08, s * (doorW / 2 + 0.04), doorH / 2, front, frameMat);
    const leafX = s * (doorW / 4);
    const leafW = doorW / 2 - 0.03;
    block(leafW - 0.02, 0.5, 0.054, leafX, 0.27, front, doorMat); // bottom rail and kick panel (thinner than the stiles)
    block(leafW - 0.02, 0.14, 0.054, leafX, doorH - 0.09, front, doorMat); // top rail
    block(0.1, doorH, 0.06, s * (doorW / 2 - 0.06), doorH / 2, front, doorMat); // hinge stile
    block(0.1, doorH, 0.06, s * 0.06, doorH / 2, front, doorMat); // meeting stile
    glass(leafW - 0.2, doorH - 0.66, leafX, 0.52 + (doorH - 0.66) / 2, front);
    block(leafW - 0.24, 0.1, 0.02, leafX, 0.2, front - 0.035, brass); // kick plate
    // Push bar on the inside.
    block(leafW - 0.3, 0.035, 0.035, leafX, 1.05, front - 0.09, brass);
    for (const e of [-1, 1]) block(0.03, 0.03, 0.06, leafX + e * ((leafW - 0.36) / 2), 1.05, front - 0.06, brass);
  }
  // A doormat.
  const mat = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.7, 0.9)), keep(new THREE.MeshStandardMaterial({ color: "#3a2a1c", roughness: 1 })));
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(0, 0.008, front - 0.6);
  group.add(mat);

  // ---- Outside: the code ----
  const fs = 15;
  const canvas = document.createElement("canvas");
  canvas.height = 500;
  canvas.width = Math.min(4096, Math.round((width / wallH) * canvas.height));
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#000";
  g.fillRect(0, 0, canvas.width, canvas.height);
  const glyphs = "ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ012345789Z:・.\"=*+-<>¦|";
  const cols = Math.floor(canvas.width / fs);
  const rows = Math.ceil(canvas.height / fs);
  const drops = Array.from({ length: cols }, () => Math.random() * -rows);
  const speed = Array.from({ length: cols }, () => 0.35 + Math.random() * 0.65);
  const last = new Array<number>(cols).fill(-1);
  const pick = () => glyphs[Math.floor(Math.random() * glyphs.length)] as string;
  g.font = `${fs}px "MS Gothic", "Yu Gothic", monospace`;
  g.textAlign = "center";
  g.textBaseline = "top";
  const texture = keep(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  const rain = new THREE.Mesh(keep(new THREE.PlaneGeometry(width, wallH)), keep(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, fog: false })));
  rain.position.set(0, wallH / 2, front + 0.3);
  rain.rotation.y = Math.PI; // facing into the store
  group.add(rain);

  let lastDraw = 0;
  /** Steps the rain about 24 times a second. */
  const tick = (nowMs: number) => {
    if (nowMs - lastDraw < 42) return;
    lastDraw = nowMs;
    g.fillStyle = "rgba(0, 0, 0, 0.09)";
    g.fillRect(0, 0, canvas.width, canvas.height);
    for (let c = 0; c < cols; c++) {
      drops[c] = (drops[c] as number) + (speed[c] as number);
      const row = Math.floor(drops[c] as number);
      const x = c * fs + fs / 2;
      const yOf = (r: number) => (RAIN_DIRECTION === 1 ? r * fs : canvas.height - (r + 1) * fs);
      if (row !== last[c] && row >= 0) {
        // The trail behind the head turns green; the head itself is nearly white.
        if (last[c] as number >= 0) {
          g.fillStyle = "#000";
          g.fillRect(x - fs / 2, yOf(last[c] as number), fs, fs);
          g.fillStyle = "#22ff66";
          g.fillText(pick(), x, yOf(last[c] as number));
        }
        g.fillStyle = "#d8ffe4";
        g.fillText(pick(), x, yOf(row));
        last[c] = row;
      }
      // Now and then a character in the trail changes, as in the film.
      if (Math.random() < 0.04) {
        const r = Math.floor(Math.random() * rows);
        g.fillStyle = "#000";
        g.fillRect(x - fs / 2, yOf(r), fs, fs);
        g.fillStyle = "#0f8f3a";
        g.fillText(pick(), x, yOf(r));
      }
      if (row > rows && Math.random() > 0.96) {
        drops[c] = Math.random() * -8;
        speed[c] = 0.35 + Math.random() * 0.65;
        last[c] = -1;
      }
    }
    texture.needsUpdate = true;
  };
  return { group, tick };
}
