import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

type Keep = <T extends { dispose: () => void }>(thing: T) => T;

/**
 * The back of the store: two long checkout counters with a gap between them, and the
 * shopkeeper, an old man of our own design dozing in his armchair behind the counter,
 * remote in hand, with a rug, a lamp and a side table. Everything made here goes
 * through `keep` so it is freed with the store.
 */
export function buildBackRoom(keep: Keep) {
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const mat = (color: string, roughness = 0.85, extra: THREE.MeshStandardMaterialParameters = {}) => {
    const key = `${color}|${roughness}|${JSON.stringify(extra)}`;
    let m = mats.get(key);
    if (!m) mats.set(key, (m = keep(new THREE.MeshStandardMaterial({ color, roughness, ...extra }))));
    return m;
  };
  const soft = (w: number, h: number, d: number, r = 0.04) => keep(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2)));
  const ball = (r: number, ws = 18, hs = 14) => keep(new THREE.SphereGeometry(r, ws, hs));
  const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number) => (o.position.set(x, y, z), o);
  const mesh = (geo: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => at(new THREE.Mesh(geo, material), x, y, z);
  const up = new THREE.Vector3(0, 1, 0);
  /** A rounded limb from joint a to joint b. */
  const bone = (a: [number, number, number], b: [number, number, number], r: number, material: THREE.Material, r2 = r) => {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    const geo = keep(new THREE.CylinderGeometry(r2, r, len, 14, 1));
    const m = new THREE.Mesh(geo, material);
    m.position.copy(va).add(vb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(up, vb.clone().sub(va).normalize());
    const g = new THREE.Group();
    g.add(m, mesh(ball(r, 14, 10), material, ...a), mesh(ball(r2, 14, 10), material, ...b));
    return g;
  };

  const wood = mat("#5a3520", 0.7);
  const woodTop = mat("#8a5a36", 0.55);
  const panelMat = mat("#4a2a18", 0.75);
  const metal = mat("#2c2a28", 0.5);

  // ---- A counter of any length, customer side facing +z ----
  const counterOf = (len: number) => {
    const g = new THREE.Group();
    g.add(mesh(soft(len, 1.0, 0.65, 0.02), wood, 0, 0.5, 0));
    g.add(mesh(soft(len + 0.08, 0.05, 0.8, 0.015), woodTop, 0, 1.025, 0.02));
    g.add(mesh(soft(len, 0.08, 0.6, 0.01), mat("#2a170d"), 0, 0.04, 0.03)); // kick plate
    const panels = Math.max(1, Math.round(len / 1.05));
    const step = len / panels;
    for (let i = 0; i < panels; i++) g.add(mesh(soft(step - 0.14, 0.66, 0.03, 0.01), panelMat, -len / 2 + step * (i + 0.5), 0.52, 0.33));
    return g;
  };

  const extras = new THREE.Group();
  // Register, bell, a stack of returns: placed by the caller near the gap.
  const register = new THREE.Group();
  register.add(mesh(soft(0.42, 0.18, 0.36, 0.02), metal, 0, 0.09, 0));
  const display = mesh(soft(0.3, 0.12, 0.05, 0.01), metal, 0, 0.25, -0.12);
  display.rotation.x = -0.4;
  const readout = mesh(keep(new THREE.PlaneGeometry(0.24, 0.07)), keep(new THREE.MeshBasicMaterial({ color: "#ffb45e" })), 0, 0.255, -0.092);
  readout.rotation.x = -0.4;
  register.add(display, readout);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) register.add(mesh(soft(0.05, 0.02, 0.04, 0.006), mat("#d8cfb8", 0.6), -0.09 + c * 0.06, 0.19, 0.04 + r * 0.05));
  const bell = new THREE.Group();
  bell.add(mesh(keep(new THREE.SphereGeometry(0.06, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)), mat("#d9c9a0", 0.3, { metalness: 0.8 }), 0, 0.012, 0));
  bell.add(mesh(keep(new THREE.CylinderGeometry(0.07, 0.07, 0.012, 20)), mat("#3a2a1a", 0.6), 0, 0.006, 0));
  const returns = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const c = mesh(soft(0.135, 0.014, 0.171, 0.002), mat("#1d4fae", 0.4), 0, 0.007 + i * 0.0145, 0);
    c.rotation.y = Math.sin(i * 2.3) * 0.12;
    returns.add(c);
  }
  extras.add(register, bell, returns);

  // ---- The armchair (faces +z in its own space) ----
  const chair = new THREE.Group();
  const fabric = mat("#5f6b3a", 0.95);
  const fabricDark = mat("#4c5630", 0.95);
  chair.add(mesh(soft(0.92, 0.42, 0.82, 0.07), fabric, 0, 0.24, 0));
  chair.add(mesh(soft(0.62, 0.14, 0.64, 0.06), fabricDark, 0, 0.5, 0.05));
  const back = mesh(soft(0.92, 0.85, 0.22, 0.08), fabric, 0, 0.88, -0.33);
  back.rotation.x = -0.12;
  chair.add(back);
  chair.add(mesh(soft(0.6, 0.5, 0.12, 0.05), fabricDark, 0, 0.88, -0.2)); // back cushion
  for (const side of [-1, 1]) {
    chair.add(mesh(soft(0.17, 0.3, 0.8, 0.07), fabric, side * 0.38, 0.6, 0));
    chair.add(mesh(keep(new THREE.CylinderGeometry(0.09, 0.09, 0.17, 16)), fabric, side * 0.38, 0.66, 0.4).rotateZ(Math.PI / 2)); // rolled arm front
  }
  for (const x of [-0.38, 0.38]) for (const z of [-0.33, 0.33]) chair.add(mesh(keep(new THREE.CylinderGeometry(0.03, 0.022, 0.06, 10)), wood, x, 0.03, z));
  // A knitted blanket over the chair back.
  const blanket = mesh(soft(0.7, 0.04, 0.4, 0.02), mat("#b0543a", 1), 0, 1.25, -0.4);
  blanket.rotation.x = -0.5;
  chair.add(blanket);

  // ---- The old man, posed in the chair ----
  const man = new THREE.Group();
  const skin = mat("#e6b593", 0.65);
  const skinShade = mat("#d99c80", 0.7);
  const cardigan = mat("#8a5a3c", 0.95);
  const cardiganDark = mat("#6e4630", 0.95);
  const shirt = mat("#e6dfcc", 0.85);
  const trousers = mat("#55565e", 0.9);
  const sock = mat("#3a3a40", 0.95);
  const slipper = mat("#6b2a22", 0.95);
  const white = mat("#f3f0e8", 1);
  const dark = mat("#161616", 0.35);
  const eyeWhite = mat("#f4f1ea", 0.4);
  const button = mat("#3a2616", 0.4);

  // Legs: hip → knee → ankle, socks, slippers.
  for (const s of [-1, 1]) {
    man.add(bone([s * 0.11, 0.63, -0.02], [s * 0.13, 0.64, 0.4], 0.088, trousers, 0.075));
    man.add(bone([s * 0.13, 0.62, 0.42], [s * 0.14, 0.17, 0.48], 0.068, trousers, 0.055));
    man.add(bone([s * 0.14, 0.15, 0.48], [s * 0.14, 0.09, 0.49], 0.05, sock));
    const foot = mesh(soft(0.12, 0.08, 0.27, 0.035), slipper, s * 0.14, 0.045, 0.56);
    man.add(foot, mesh(soft(0.125, 0.025, 0.1, 0.01), mat("#e8dcc0", 1), s * 0.14, 0.09, 0.5)); // fleece trim
  }

  // Body: a pear-shaped trunk turned on a lathe, leaning back into the cushion.
  const trunk = new THREE.Group();
  trunk.position.set(0, 0.6, -0.1);
  trunk.rotation.x = -0.16;
  const profile = [
    [0.0, 0.0], [0.17, 0.0], [0.23, 0.08], [0.25, 0.2], [0.24, 0.32], [0.22, 0.44], [0.2, 0.52], [0.13, 0.57], [0.06, 0.6], [0.0, 0.6],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const body = mesh(keep(new THREE.LatheGeometry(profile, 28)), cardigan);
  body.scale.set(1.12, 1, 0.9);
  trunk.add(body);
  // The shirt showing down the open front, the collar, buttons, pockets.
  const front = mesh(soft(0.07, 0.3, 0.05, 0.022), shirt, 0, 0.42, 0.2);
  front.rotation.x = 0.12;
  trunk.add(front);
  for (const s of [-1, 1]) {
    const collar = mesh(soft(0.08, 0.02, 0.06, 0.008), shirt, s * 0.045, 0.57, 0.12);
    collar.rotation.set(0.6, 0, s * 0.5);
    const band = mesh(soft(0.035, 0.44, 0.04, 0.015), cardiganDark, s * 0.075, 0.34, 0.21);
    band.rotation.set(0.12, 0, s * -0.08);
    const pocket = mesh(soft(0.11, 0.1, 0.03, 0.01), cardiganDark, s * 0.15, 0.13, 0.225);
    trunk.add(collar, band, pocket);
  }
  for (let i = 0; i < 4; i++) trunk.add(mesh(ball(0.011, 8, 6), button, 0.075, 0.12 + i * 0.1, 0.235 - i * 0.008));
  // Neck.
  trunk.add(bone([0, 0.56, 0.0], [0, 0.66, 0.02], 0.055, skin));

  // Arms: shoulder → elbow → wrist, resting on the chair arms; a remote in the right hand.
  for (const s of [-1, 1]) {
    const shoulder: [number, number, number] = [s * 0.24, 0.5, -0.02];
    const elbow: [number, number, number] = [s * 0.33, 0.2, 0.0];
    const wrist: [number, number, number] = [s * 0.36, 0.18, 0.3];
    trunk.add(mesh(ball(0.085, 16, 12), cardigan, ...shoulder));
    trunk.add(bone(shoulder, elbow, 0.068, cardigan, 0.06));
    trunk.add(bone(elbow, wrist, 0.058, cardigan, 0.05));
    trunk.add(mesh(keep(new THREE.TorusGeometry(0.05, 0.012, 8, 16)), cardiganDark, ...wrist).rotateX(0.15)); // cuff
    // Hand: a palm and fingers curled over the end of the chair arm.
    const hand = new THREE.Group();
    hand.position.set(s * 0.36, 0.17, 0.36);
    hand.add(mesh(soft(0.075, 0.03, 0.085, 0.014), skin, 0, 0, 0));
    for (let f = 0; f < 4; f++) {
      const x = -0.027 + f * 0.018;
      hand.add(bone([x, 0, 0.04], [x, -0.03, 0.065], 0.009, skin, 0.008));
    }
    hand.add(bone([s * -0.04, 0, 0.0], [s * -0.045, 0.0, 0.04], 0.011, skin));
    if (s === 1) {
      const remote = mesh(soft(0.04, 0.02, 0.16, 0.008), mat("#202020", 0.5), 0, 0.022, 0.03);
      remote.add(mesh(ball(0.006, 8, 6), mat("#c0392b", 0.4), 0, 0.011, 0.055));
      hand.add(remote);
    }
    trunk.add(hand);
  }

  // Head.
  const head = new THREE.Group();
  head.position.set(0, 0.78, 0.03);
  const skull = mesh(ball(0.125, 28, 22), skin);
  skull.scale.set(0.95, 1.05, 1.0);
  const jaw = mesh(ball(0.105, 22, 16), skin, 0, -0.06, 0.025);
  jaw.scale.set(0.95, 0.75, 0.95);
  const chin = mesh(ball(0.04, 14, 10), skin, 0, -0.115, 0.075);
  head.add(skull, jaw, chin);
  // Nose: a soft bulb, a little rosy. Cheeks rosy too.
  const nose = mesh(ball(0.028, 16, 12), skinShade, 0, -0.012, 0.128);
  nose.scale.set(1, 1.15, 1.1);
  head.add(nose, mesh(ball(0.014, 10, 8), skinShade, 0, 0.018, 0.118));
  for (const s of [-1, 1]) {
    const cheek = mesh(ball(0.034, 14, 10), mat("#e7a38a", 0.7), s * 0.062, -0.035, 0.088);
    cheek.scale.set(1, 0.8, 0.7);
    head.add(cheek);
    // Eyes, with heavy lids half shut: he's comfortable.
    head.add(mesh(ball(0.017, 12, 10), eyeWhite, s * 0.044, 0.018, 0.104));
    head.add(mesh(ball(0.008, 10, 8), dark, s * 0.044, 0.016, 0.119));
    const lid = mesh(keep(new THREE.SphereGeometry(0.0195, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55)), skin, s * 0.044, 0.018, 0.104);
    lid.rotation.x = 0.55;
    head.add(lid);
    const bag = mesh(ball(0.016, 10, 8), skinShade, s * 0.046, 0.0, 0.106);
    bag.scale.set(1.2, 0.45, 0.6);
    head.add(bag);
    // Bushy white brows, a few tufts each.
    for (let t = 0; t < 3; t++) {
      const tuft = mesh(ball(0.013, 8, 6), white, s * (0.027 + t * 0.017), 0.046 + (t === 1 ? 0.004 : 0), 0.108 - t * 0.006);
      tuft.scale.set(1.3, 0.8, 0.9);
      head.add(tuft);
    }
    // Ears, big as old men's are.
    const ear = mesh(ball(0.032, 14, 10), skinShade, s * 0.122, -0.005, -0.005);
    ear.scale.set(0.45, 1.25, 0.85);
    head.add(ear);
    // Glasses: round lenses, arms back to the ears.
    head.add(mesh(keep(new THREE.TorusGeometry(0.031, 0.0045, 8, 28)), dark, s * 0.046, 0.016, 0.128));
    const lensGlass = mesh(keep(new THREE.CircleGeometry(0.03, 24)), keep(new THREE.MeshStandardMaterial({ color: "#cfe3ff", transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.2 })), s * 0.046, 0.016, 0.129);
    head.add(lensGlass);
    const arm = mesh(soft(0.004, 0.004, 0.12, 0.0015), dark, s * 0.08, 0.02, 0.07);
    arm.rotation.y = s * -0.35;
    head.add(arm);
    // Moustache: two soft drooping sweeps.
    const stache = bone([s * 0.008, -0.04, 0.122], [s * 0.05, -0.058, 0.1], 0.013, white, 0.008);
    head.add(stache);
  }
  head.add(mesh(soft(0.022, 0.005, 0.005, 0.002), dark, 0, 0.022, 0.131)); // glasses bridge
  // Mouth: a thin line under the moustache.
  const mouth = mesh(soft(0.04, 0.006, 0.01, 0.003), mat("#a8705c", 0.7), 0, -0.068, 0.112);
  head.add(mouth);
  // Hair: a white horseshoe round the back and sides; a few wisps on top of the bald crown.
  const fringe = mesh(keep(new THREE.TorusGeometry(0.112, 0.032, 10, 30, Math.PI * 1.25)), white, 0, 0.0, -0.01);
  fringe.rotation.set(Math.PI / 2 + 0.25, 0, Math.PI * 0.375 + Math.PI);
  fringe.scale.set(1, 1.05, 0.7);
  head.add(fringe);
  for (const s of [-1, 1]) {
    const puff = mesh(ball(0.045, 14, 10), white, s * 0.105, 0.025, -0.045);
    puff.scale.set(0.6, 0.9, 1.1);
    head.add(puff);
  }
  for (let w = 0; w < 3; w++) {
    const wisp = bone([-0.02 + w * 0.02, 0.128, -0.01 + w * 0.01], [-0.03 + w * 0.03, 0.145, 0.03], 0.005, white, 0.003);
    head.add(wisp);
  }
  trunk.add(head);
  man.add(trunk);
  chair.add(man);

  // ---- His corner: rug, side table with a mug, floor lamp ----
  const corner = new THREE.Group();
  const rug = mesh(keep(new THREE.CircleGeometry(1.3, 40)), mat("#6b2a22", 1), 0, 0.006, 0);
  rug.rotation.x = -Math.PI / 2;
  const rugEdge = mesh(keep(new THREE.RingGeometry(1.14, 1.23, 40)), mat("#c08a4a", 1), 0, 0.008, 0);
  rugEdge.rotation.x = -Math.PI / 2;
  const table = new THREE.Group();
  table.add(mesh(keep(new THREE.CylinderGeometry(0.24, 0.24, 0.04, 24)), woodTop, 0, 0.6, 0));
  table.add(mesh(keep(new THREE.CylinderGeometry(0.03, 0.05, 0.58, 10)), wood, 0, 0.3, 0));
  const mug = mesh(keep(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 18)), mat("#e8dcc0", 0.5), 0.06, 0.67, 0.04);
  mug.add(mesh(keep(new THREE.TorusGeometry(0.028, 0.008, 6, 14)), mat("#e8dcc0", 0.5), 0.05, 0, 0).rotateY(Math.PI / 2));
  table.add(mug);
  const lamp = new THREE.Group();
  lamp.add(mesh(keep(new THREE.CylinderGeometry(0.15, 0.17, 0.03, 20)), metal, 0, 0.015, 0));
  lamp.add(mesh(keep(new THREE.CylinderGeometry(0.015, 0.015, 1.5, 8)), metal, 0, 0.77, 0));
  lamp.add(mesh(keep(new THREE.CylinderGeometry(0.16, 0.25, 0.28, 24, 1, true)), mat("#f0d29a", 0.8, { emissive: "#ffb45e", emissiveIntensity: 0.6, side: THREE.DoubleSide }), 0, 1.55, 0));
  const glow = new THREE.PointLight("#ffb866", 3, 5, 1.6);
  glow.position.set(0, 1.45, 0);
  lamp.add(glow);
  corner.add(rug, rugEdge, chair, table, lamp);
  table.position.set(0.75, 0, 0.1);
  lamp.position.set(-0.75, 0, -0.3);

  /** Slow breathing, and now and then his head nods. */
  const animate = (nowMs: number) => {
    const breath = Math.sin(nowMs / 1100);
    body.scale.set(1.12 * (1 + breath * 0.012), 1 + breath * 0.015, 0.9 * (1 + breath * 0.02));
    const nod = Math.max(0, Math.sin(nowMs / 9000)) ** 8;
    head.rotation.x = 0.08 + nod * 0.22 + breath * 0.01;
  };
  return { counterOf, register, bell, returns, extras, corner, chair, rugs: [rug, rugEdge], animate };
}
