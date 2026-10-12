// Doodle models built from primitives. The ink renderer outlines and hatches them, so a handful
// of boxes and cylinders reads as a hand-drawn figure. Nothing here is loaded from files.
import * as THREE from 'three';
import { SKINS, WEAPON_IDS, type WeaponId } from '../../shared/src/constants.ts';
import { INK_IDS, INK_VERTEX, type InkRenderer } from './ink.ts';

type Mat = THREE.Material;

// Models are rebuilt all the time (every player that comes into view, loot, vehicles, forts) and each
// one is a few dozen small primitives. intern() swaps every geometry of a freshly built model for an
// identical shared one, so a figure costs no new GPU buffers after the first and nothing leaks when
// it is thrown away. Shared geometries are flagged so dispose passes leave them alone.
const shared = new Map<string, THREE.BufferGeometry>();
function geoKey(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position'), a = pos.array as ArrayLike<number>;
  let h = 0; for (let i = 0; i < a.length; i += 7) h = (h * 31 + Math.round(a[i] * 1000)) | 0; // baked rotations/offsets too
  return `${g.type}|${JSON.stringify((g as unknown as { parameters?: unknown }).parameters ?? null)}|${a.length}|${h}`;
}
export function intern<T extends THREE.Object3D>(root: T): T {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || m.geometry.userData.shared) return;
    const k = geoKey(m.geometry), hit = shared.get(k);
    if (hit) { m.geometry.dispose(); m.geometry = hit; }
    else { m.geometry.userData.shared = true; shared.set(k, m.geometry); }
  });
  return root;
}
// what to free when a model leaves for good: its own geometries (shared ones stay), instanced buffers
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((m as unknown as THREE.InstancedMesh).isInstancedMesh) (m as unknown as THREE.InstancedMesh).dispose();
    if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
  });
}
const attachIf = (parent: THREE.Object3D, o: THREE.Object3D, on: boolean) => { if (on && o.parent !== parent) parent.add(o); else if (!on && o.parent) o.parent.remove(o); };
const box = (w: number, h: number, d: number, m: Mat, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); return o; };
// cylinder lying along -z (barrels, scopes)
const tube = (r: number, len: number, m: Mat, x = 0, y = 0, z = 0, seg = 10) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2), m); o.position.set(x, y, z); return o; };

export interface GunMats { body: Mat; dark: Mat; accent: Mat; gem?: Mat; wood?: Mat } // gem: glowing parts (the blade, the wand's tip); wood: the wand

// guns are modelled pointing down -z with the grip at the origin, about 1 unit = 1 m
export function buildGun(id: WeaponId, m: GunMats): THREE.Group {
  const g = new THREE.Group();
  const add = (...o: THREE.Object3D[]) => g.add(...o);
  const grip = (z = 0.04, tilt = 0) => { const o = box(0.05, 0.13, 0.06, m.dark, 0, -0.08, z); o.rotation.x = tilt; add(o); };
  switch (id) {
    case 'pistol':
      add(box(0.05, 0.06, 0.22, m.body, 0, 0.03, -0.05), box(0.045, 0.04, 0.2, m.dark, 0, -0.015, -0.05), box(0.01, 0.02, 0.01, m.dark, 0, 0.07, -0.14));
      grip(0.04, -0.2); break;
    case 'smg':
      add(box(0.07, 0.09, 0.3, m.body, 0, 0.02, -0.06), tube(0.018, 0.12, m.dark, 0, 0.02, -0.27), box(0.04, 0.18, 0.05, m.accent, 0, -0.12, -0.08));
      add(box(0.03, 0.03, 0.18, m.dark, 0, 0.0, 0.16), box(0.06, 0.08, 0.03, m.dark, 0, -0.01, 0.25)); // wire stock
      grip(0.05); break;
    case 'tac':
      add(box(0.08, 0.1, 0.32, m.body, 0, 0.02, -0.06), tube(0.026, 0.42, m.dark, 0, 0.04, -0.42), box(0.07, 0.06, 0.1, m.accent, 0, -0.02, -0.32));
      add(box(0.04, 0.12, 0.05, m.dark, 0, -0.1, 0.06), box(0.06, 0.09, 0.18, m.body, 0, -0.01, 0.2));
      break;
    case 'pump':
      add(box(0.08, 0.1, 0.3, m.body, 0, 0.02, -0.08), tube(0.024, 0.5, m.dark, 0, 0.04, -0.45), tube(0.02, 0.38, m.dark, 0, -0.01, -0.4), box(0.07, 0.07, 0.16, m.accent, 0, -0.01, -0.36));
      grip(0.06);
      { const stock = box(0.065, 0.11, 0.26, m.body, 0, -0.02, 0.22); stock.rotation.x = -0.12; add(stock); }
      break;
    case 'ar':
    case 'scar': {
      const scar = id === 'scar';
      add(box(0.07, 0.1, 0.42, m.body, 0, 0.02, -0.12), box(0.075, 0.07, 0.24, m.dark, 0, 0, -0.42), tube(0.016, 0.22, m.dark, 0, 0.01, -0.64), box(0.05, 0.05, 0.05, m.dark, 0, 0.01, -0.77));
      const mag = box(0.05, 0.2, 0.08, m.accent, 0, -0.12, -0.16); mag.rotation.x = scar ? 0.05 : 0.25; add(mag);
      grip();
      add(box(0.06, 0.1, 0.22, m.body, 0, 0, 0.2));
      if (scar) add(box(0.075, 0.03, 0.5, m.accent, 0, 0.085, -0.2), box(0.05, 0.06, 0.09, m.dark, 0, 0.13, -0.08), tube(0.03, 0.05, m.accent, 0, 0.14, -0.13)); // rail + holo sight
      else add(box(0.04, 0.05, 0.1, m.dark, 0, 0.1, -0.1), box(0.05, 0.012, 0.012, m.accent, 0, 0.13, -0.1));
      break;
    }
    case 'burst':
      add(box(0.07, 0.11, 0.5, m.body, 0, 0.02, -0.15), tube(0.017, 0.2, m.dark, 0, 0.02, -0.5), box(0.05, 0.16, 0.07, m.accent, 0, -0.1, -0.05));
      add(box(0.065, 0.12, 0.22, m.body, 0, 0, 0.18), tube(0.028, 0.18, m.dark, 0, 0.11, -0.1)); // bullpup with a small scope
      grip(-0.12); break;
    case 'hunting':
      add(box(0.06, 0.08, 0.36, m.body, 0, 0, -0.06), tube(0.016, 0.58, m.dark, 0, 0.015, -0.52), box(0.07, 0.12, 0.34, m.accent, 0, -0.02, 0.24));
      add(box(0.06, 0.015, 0.015, m.dark, 0.05, 0.03, 0.02));
      break;
    case 'minigun': {
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; add(tube(0.015, 0.6, m.dark, Math.cos(a) * 0.045, Math.sin(a) * 0.045, -0.5)); }
      add(tube(0.07, 0.12, m.accent, 0, 0, -0.78), tube(0.07, 0.1, m.accent, 0, 0, -0.3), box(0.16, 0.18, 0.34, m.body, 0, -0.02, -0.02));
      add(box(0.04, 0.16, 0.04, m.dark, 0, 0.14, -0.05), box(0.1, 0.12, 0.12, m.accent, 0.12, -0.08, 0)); // handle and ammo box
      break;
    }
    case 'rocket':
      add(tube(0.09, 1.1, m.body, 0, 0.06, -0.2, 12), tube(0.1, 0.12, m.accent, 0, 0.06, -0.78, 12), tube(0.1, 0.1, m.dark, 0, 0.06, 0.34, 12));
      add(box(0.05, 0.16, 0.06, m.dark, 0, -0.08, -0.05), box(0.05, 0.14, 0.06, m.dark, 0, -0.08, -0.35), box(0.06, 0.08, 0.14, m.accent, 0.1, 0.12, -0.15));
      break;
    case 'guided': // a launcher with a guidance screen and a little antenna
      add(tube(0.095, 1.15, m.dark, 0, 0.06, -0.2, 12), tube(0.105, 0.12, m.accent, 0, 0.06, -0.8, 12), tube(0.105, 0.1, m.body, 0, 0.06, 0.36, 12));
      add(box(0.05, 0.16, 0.06, m.dark, 0, -0.08, -0.05), box(0.16, 0.12, 0.04, m.dark, -0.13, 0.16, -0.1), box(0.13, 0.09, 0.045, m.gem ?? m.accent, -0.13, 0.16, -0.1));
      add(box(0.015, 0.22, 0.015, m.dark, 0.08, 0.26, 0.1));
      break;
    case 'blade': { // a hilt and a long glowing blade, held point forward
      add(tube(0.03, 0.26, m.dark, 0, 0, 0.02, 10), box(0.11, 0.035, 0.035, m.accent, 0, 0, -0.12), tube(0.034, 0.04, m.body, 0, 0, 0.1, 10));
      const blade = box(0.045, 0.045, 1.05, m.gem ?? m.body, 0, 0, -0.66); blade.name = 'blade'; add(blade);
      break;
    }
    case 'wand': // a wooden wand with a handle and a glowing tip
      add(tube(0.022, 0.16, m.dark, 0, 0, 0.05, 8), tube(0.014, 0.42, m.wood ?? m.accent, 0, 0, -0.22, 8));
      add(new THREE.Mesh(new THREE.OctahedronGeometry(0.035), m.gem ?? m.accent).translateZ(-0.45));
      break;
    case 'stinger':
      add(tube(0.075, 1.25, m.dark, 0, 0.06, -0.2, 12), tube(0.08, 0.1, m.accent, 0, 0.06, -0.85, 12), box(0.18, 0.14, 0.12, m.body, 0, 0.2, -0.3));
      add(box(0.05, 0.16, 0.06, m.dark, 0, -0.08, -0.02), box(0.22, 0.03, 0.03, m.accent, 0, 0.29, -0.3), box(0.03, 0.16, 0.03, m.accent, 0.1, 0.22, -0.3));
      break;
    case 'heavy':
      add(box(0.07, 0.1, 0.42, m.body, 0, 0, -0.1), tube(0.022, 0.7, m.dark, 0, 0.01, -0.66), box(0.06, 0.06, 0.12, m.dark, 0, 0.01, -1.04));
      add(tube(0.04, 0.34, m.dark, 0, 0.12, -0.12, 12), tube(0.052, 0.06, m.accent, 0, 0.12, -0.32, 12), tube(0.052, 0.06, m.accent, 0, 0.12, 0.06, 12));
      add(box(0.05, 0.16, 0.07, m.dark, 0, -0.1, 0.08), box(0.07, 0.13, 0.34, m.body, 0, -0.01, 0.28), box(0.08, 0.05, 0.14, m.accent, 0, 0.07, 0.28));
      { const legA = box(0.014, 0.2, 0.014, m.dark, 0.035, -0.1, -0.62); legA.rotation.z = 0.3; const legB = legA.clone(); legB.position.x = -0.035; legB.rotation.z = -0.3; add(legA, legB); }
      add(box(0.09, 0.02, 0.02, m.accent, 0.06, 0.03, 0.04));
      break;
  }
  g.userData.body = m.body;
  const bb = new THREE.Box3().setFromObject(g);
  g.userData.min = bb.min.toArray(); g.userData.max = bb.max.toArray();
  return g;
}

// a gun's upgrade stars, on the gun itself: one gold band per star, a scope with a diamond lens from two
// stars, and at three the whole gun turns gold. Applied (and taken off) in place on the same model
export function upgradeGun(g: THREE.Group, level: number, gold: Mat, gem: Mat) {
  if ((g.userData.level ?? 0) === level) return;
  g.userData.level = level;
  const old = g.getObjectByName('ups');
  if (old) { g.remove(old); disposeTree(old); }
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.userData.mat0 ??= m.material;
    m.material = level >= 3 && m.userData.mat0 === g.userData.body ? gold : m.userData.mat0;
  });
  if (!level || !g.userData.min) return;
  const [x0, y0, z0] = g.userData.min as number[], [x1, y1, z1] = g.userData.max as number[];
  const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ups = new THREE.Group(); ups.name = 'ups';
  for (let k = 0; k < level; k++) ups.add(box(Math.min(0.2, sx * 0.9) + 0.025, Math.min(0.16, sy * 0.45) + 0.02, 0.035, gold, cx, cy + sy * 0.12, z0 + sz * (0.35 + k * 0.12)));
  if (level >= 2) ups.add(box(0.045, 0.045, Math.min(0.3, sz * 0.3), gold, cx, y1 + 0.03, z0 + sz * 0.5), box(0.05, 0.05, 0.02, gem, cx, y1 + 0.03, z0 + sz * 0.5 - Math.min(0.15, sz * 0.15) - 0.01));
  if (level >= 3) { const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.035), gem); star.position.set(cx + sx / 2 + 0.02, cy, z0 + sz * 0.6); ups.add(star); }
  g.add(ups);
}

// ---------------- loot, cases, gadgets ----------------
// ammo boxes: the colour band and how many rounds stand on the lid
const AMMO_LOOK: Record<string, [number, number]> = { light: [INK_IDS.BLUE, 4], medium: [INK_IDS.GREEN, 3], heavy: [INK_IDS.RED, 2], shells: [INK_IDS.ORANGE, 3], rockets: [INK_IDS.PURPLE, 1] };
export function buildItem(what: string, ink: InkRenderer): THREE.Group {
  const g = new THREE.Group();
  const blue = ink.material(INK_IDS.BLUE), dark = ink.material(INK_IDS.GRAPHITE), red = ink.material(INK_IDS.RED), paper = ink.material(INK_IDS.PAPER), orange = ink.material(INK_IDS.ORANGE), green = ink.material(INK_IDS.GREEN);
  if (what in AMMO_LOOK) { // an ammo box: a paper crate with its colour band, rounds standing on the lid
    const [band, n] = AMMO_LOOK[what], c = ink.material(band);
    g.add(box(0.46, 0.22, 0.3, paper, 0, 0.11, 0), box(0.47, 0.07, 0.31, c, 0, 0.12, 0), box(0.47, 0.02, 0.31, dark, 0, 0.225, 0));
    for (let k = 0; k < n; k++) g.add(tube(0.035, 0.14, c, -0.12 + (k * 0.24) / Math.max(1, n - 1), 0.31, 0).rotateX(Math.PI / 2));
  } else if (what === 'mini' || what === 'big') {
    const s = what === 'big' ? 1.3 : 0.9;
    const bottle = new THREE.Mesh(new THREE.SphereGeometry(0.16 * s, 10, 8), blue); bottle.position.y = 0.16 * s;
    g.add(bottle, tube(0.05 * s, 0.14 * s, paper, 0, 0.33 * s, 0).rotateX(Math.PI / 2), box(0.08 * s, 0.05 * s, 0.08 * s, dark, 0, 0.42 * s, 0));
  } else if (what === 'med') {
    g.add(box(0.42, 0.26, 0.3, paper, 0, 0.13, 0), box(0.06, 0.18, 0.31, red, 0, 0.13, 0), box(0.18, 0.06, 0.31, red, 0, 0.13, 0));
  } else if (what === 'grenade') {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), green); b.position.y = 0.14; g.add(b, box(0.05, 0.08, 0.05, dark, 0, 0.29, 0));
  } else if (what === 'smoke') {
    g.add(tube(0.09, 0.32, paper, 0, 0.16, 0).rotateX(Math.PI / 2), box(0.2, 0.04, 0.2, dark, 0, 0.33, 0));
  } else if (what === 'launch') {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.12, 12), orange).translateY(0.06), box(0.1, 0.02, 0.4, blue, 0, 0.13, 0));
  } else if (what === 'fort') {
    g.add(box(0.36, 0.22, 0.18, ink.material(INK_IDS.BROWN), 0, 0.11, 0), box(0.36, 0.22, 0.18, ink.material(INK_IDS.BROWN), 0.04, 0.33, 0.02));
  } else if (what === 'molotov') {
    g.add(tube(0.07, 0.24, ink.material(INK_IDS.GREEN), 0, 0.12, 0).rotateX(Math.PI / 2), tube(0.03, 0.1, paper, 0, 0.29, 0).rotateX(Math.PI / 2), box(0.05, 0.08, 0.05, orange, 0, 0.37, 0));
  } else if (what === 'shock') {
    const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), blue); s2.position.y = 0.15; g.add(s2, new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 6, 14).rotateX(Math.PI / 2), orange).translateY(0.15));
  } else if (what === 'kit') {
    g.add(box(0.44, 0.24, 0.3, red, 0, 0.12, 0), box(0.2, 0.06, 0.06, dark, 0, 0.28, 0), box(0.06, 0.2, 0.06, orange, 0.12, 0.34, 0));
  } else if (what === 'rocket') {
    g.add(tube(0.08, 0.6, dark, 0, 0, 0), new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 8), red).rotateX(-Math.PI / 2).translateY(0.4));
  } else if (what === 'spell') { // the wand's bolt: a bright core in a purple shell
    g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), ink.material(INK_IDS.PURPLE)), new THREE.Mesh(new THREE.OctahedronGeometry(0.11), ink.material(INK_IDS.DIAMOND)));
  } else if (what === 'c4') {
    g.add(box(0.34, 0.12, 0.22, ink.material(INK_IDS.BROWN), 0, 0.06, 0), box(0.12, 0.05, 0.14, dark, 0.06, 0.14, 0), box(0.02, 0.1, 0.02, red, -0.1, 0.17, 0.05));
  } else if (what === 'nuke') {
    g.add(tube(0.11, 0.6, dark, 0, 0.3, 0).rotateX(Math.PI / 2), new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.22, 10), red).translateY(0.71), box(0.32, 0.02, 0.12, orange, 0, 0.06, 0), box(0.12, 0.02, 0.32, orange, 0, 0.06, 0));
  }
  return g;
}

// a pencil case: a long rounded box with a zipper; golden ones are orange and twice as tempting
export function buildCase(ink: InkRenderer, golden: boolean): { root: THREE.Group; lid: THREE.Group } {
  const root = new THREE.Group();
  const body = ink.material(golden ? INK_IDS.ORANGE : INK_IDS.PINK), dark = ink.material(INK_IDS.GRAPHITE), paper = ink.material(INK_IDS.PAPER);
  root.add(box(1.1, 0.32, 0.44, body, 0, 0.16, 0));
  for (let i = 0; i < 3; i++) root.add(tube(0.012, 0.05, paper, -0.35 + i * 0.35, 0.33, 0.2, 6).rotateY(Math.PI / 2)); // pencils peeking out
  const lid = pivot(0, 0.32, -0.22, box(1.1, 0.12, 0.44, body, 0, 0.06, 0.22), box(1.12, 0.03, 0.03, dark, 0, 0.0, 0.44));
  root.add(lid);
  if (golden) { const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), ink.material(INK_IDS.ORANGE)); star.position.y = 0.95; star.name = 'star'; root.add(star); }
  return { root, lid };
}

export function buildPad(ink: InkRenderer): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.3, 0.18, 16), ink.material(INK_IDS.ORANGE)).translateY(0.09));
  const arrow = box(0.25, 0.05, 1.1, ink.material(INK_IDS.BLUE), 0, 0.2, 0); g.add(arrow);
  return g;
}

export function buildSmoke(ink: InkRenderer): THREE.Group {
  const g = new THREE.Group(), m = ink.material(INK_IDS.GRAPHITE);
  for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2, r = i === 0 ? 0 : 3.4; const s = new THREE.Mesh(new THREE.IcosahedronGeometry(2.8 + (i % 3) * 0.6, 1), m); s.position.set(Math.cos(a) * r, 2.2 + (i % 2) * 1.4, Math.sin(a) * r); g.add(s); }
  return g;
}

export function buildNukeMarker(ink: InkRenderer): THREE.Group {
  const g = new THREE.Group();
  const missile = new THREE.Group();
  missile.add(tube(0.8, 5, ink.material(INK_IDS.GRAPHITE), 0, 0, 0).rotateX(Math.PI / 2), new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.8, 12), ink.material(INK_IDS.RED)).translateY(-3.4).rotateX(Math.PI));
  for (const r of [0, Math.PI / 2]) { const fin = box(2.6, 1.2, 0.1, ink.material(INK_IDS.ORANGE), 0, 2.4, 0); fin.rotation.y = r; missile.add(fin); }
  missile.name = 'missile';
  g.add(missile);
  return g;
}

// ---------------- vehicles (modelled facing -z, origin on the ground) ----------------
export interface VehicleModel { root: THREE.Group; spin: THREE.Object3D[]; kind: number }
const wheel = (m: Mat, x: number, z: number) => { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12).rotateZ(Math.PI / 2), m); w.position.set(x, 0.42, z); w.name = 'wheel'; return w; };
export function buildVehicle(ink: InkRenderer, kind: number, seed: number): VehicleModel {
  const root = new THREE.Group(), spin: THREE.Object3D[] = [];
  const dark = ink.material(INK_IDS.GRAPHITE), paper = ink.material(INK_IDS.PAPER), blue = ink.material(INK_IDS.BLUE), orange = ink.material(INK_IDS.ORANGE);
  const paint = ink.material([INK_IDS.RED, INK_IDS.BLUE, INK_IDS.GREEN, INK_IDS.ORANGE, INK_IDS.PINK][seed % 5]);
  if (kind === 0) { // car: an open-top buggy with a roll hoop (drive-by friendly: you see who's in it) and big wheels
    root.add(box(2.1, 0.6, 4.2, paint, 0, 0.75, 0), box(1.9, 0.12, 1.2, dark, 0, 1.12, -1.4)); // body, bonnet stripe
    root.add(box(1.8, 0.42, 0.06, paper, 0, 1.32, -0.24), box(1.9, 0.06, 0.1, dark, 0, 1.55, -0.24)); // windscreen and its frame
    for (const x of [-0.45, 0.5]) root.add(box(0.62, 0.6, 0.12, dark, x, 1.35, 0.72)); // front seat backs
    root.add(box(1.8, 0.55, 0.12, dark, 0, 1.35, 1.95), new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 5, 12), dark).translateX(-0.45).translateY(1.38).translateZ(-0.02)); // back bench, wheel
    root.add(box(0.08, 0.62, 0.08, dark, -0.9, 1.36, 1.2), box(0.08, 0.62, 0.08, dark, 0.9, 1.36, 1.2), box(1.88, 0.08, 0.08, dark, 0, 1.68, 1.2)); // roll hoop
    root.add(box(0.3, 0.2, 0.1, ink.material(INK_IDS.RED), 0.75, 0.9, 2.12), box(0.3, 0.2, 0.1, ink.material(INK_IDS.RED), -0.75, 0.9, 2.12));
    root.add(box(0.36, 0.18, 0.08, orange, 0.7, 0.85, -2.12), box(0.36, 0.18, 0.08, orange, -0.7, 0.85, -2.12)); // headlights
    for (const [x, z] of [[-1.05, -1.35], [1.05, -1.35], [-1.05, 1.35], [1.05, 1.35]]) root.add(wheel(dark, x, z));
  } else if (kind === 1) { // helicopter: bubble cabin, tail boom, skids, main and tail rotors
    const cabin = new THREE.Mesh(new THREE.SphereGeometry(1.35, 14, 10), paint); cabin.scale.set(1, 0.85, 1.35); cabin.position.y = 1.5; root.add(cabin);
    root.add(box(1.6, 0.5, 0.06, paper, 0, 1.75, -1.55)); // windscreen
    root.add(box(0.4, 0.4, 3.6, paint, 0, 1.75, 2.8), box(0.08, 1.0, 0.6, paint, 0, 2.2, 4.5)); // tail boom, fin
    for (const x of [-0.9, 0.9]) { root.add(box(0.1, 0.1, 3, dark, x, 0.08, 0)); root.add(box(0.08, 0.6, 0.08, dark, x, 0.4, -0.7), box(0.08, 0.6, 0.08, dark, x, 0.4, 0.7)); }
    root.add(box(0.2, 0.4, 0.2, dark, 0, 2.7, 0), box(0.12, 0.12, 0.7, dark, 0, 1.2, -1.9)); // mast, nose gun
    const rotor = new THREE.Group(); rotor.position.y = 2.95; rotor.add(box(8.5, 0.05, 0.35, dark), box(0.35, 0.05, 8.5, dark)); rotor.name = 'rotor'; root.add(rotor); spin.push(rotor);
    const tail = new THREE.Group(); tail.position.set(0.3, 2.2, 4.6); tail.add(box(0.05, 1.6, 0.18, dark)); tail.name = 'tail'; root.add(tail); spin.push(tail);
  } else if (kind === 3) { // motorbike: two wheels, a tank, handlebars, a seat for two
    root.add(box(0.36, 0.42, 1.5, paint, 0, 0.78, 0), box(0.4, 0.14, 0.9, dark, 0, 1.06, 0.35)); // frame + tank, seat
    root.add(box(0.9, 0.06, 0.06, dark, 0, 1.25, -0.62), box(0.06, 0.45, 0.06, dark, 0, 1.0, -0.62)); // handlebars, fork
    root.add(box(0.3, 0.16, 0.08, orange, 0, 1.0, -0.78), box(0.3, 0.12, 0.06, ink.material(INK_IDS.RED), 0, 0.9, 0.8)); // lights
    for (const z of [-0.72, 0.72]) { const w = wheel(dark, 0, z); w.scale.set(0.6, 1, 1); root.add(w); }
  } else if (kind === 4) { // tank: hull, tracks, a turret that turns to where the driver looks
    root.add(box(3.6, 1.0, 5.2, ink.material(INK_IDS.GREEN), 0, 0.95, 0), box(3.8, 0.7, 5.6, dark, 0, 0.45, 0)); // hull, tracks
    for (let z = -2.4; z <= 2.4; z += 0.8) for (const x of [-1.95, 1.95]) root.add(box(0.12, 0.5, 0.3, paper, x, 0.45, z)); // track links
    const turret = new THREE.Group(); turret.position.y = 1.45; turret.name = 'turret';
    turret.add(box(2.2, 0.8, 2.4, ink.material(INK_IDS.GREEN), 0, 0.4, 0.2), box(0.3, 0.3, 3.2, dark, 0, 0.45, -2.4), box(0.5, 0.3, 0.5, dark, 0.5, 0.95, 0.6));
    root.add(turret); spin.push(turret);
  } else { // plane: a paper-plane-ish prop fighter
    root.add(box(1.1, 1.0, 5.6, paint, 0, 1.3, 0), box(9.5, 0.12, 1.6, paper, 0, 1.25, -0.3)); // fuselage, wings
    root.add(box(3.4, 0.1, 0.9, paper, 0, 1.6, 2.5), box(0.1, 1.1, 0.9, paint, 0, 2.2, 2.5)); // tail plane, fin
    root.add(box(0.8, 0.45, 1.2, blue, 0, 1.95, -0.4)); // canopy
    for (const x of [-1.6, 1.6]) root.add(box(0.1, 0.8, 0.1, dark, x, 0.45, -0.6), wheel(dark, x, -0.6));
    root.add(wheel(dark, 0, 2.4)); root.getObjectByName('wheel')!.scale.setScalar(0.7);
    for (const x of [-3.2, 3.2]) root.add(box(0.1, 0.12, 0.6, ink.material(INK_IDS.RED), x, 1.3, -0.9)); // wing guns
    const prop = new THREE.Group(); prop.position.set(0, 1.3, -2.95); prop.add(box(2.6, 0.22, 0.06, dark), box(0.22, 2.6, 0.06, dark)); prop.name = 'prop'; root.add(prop); spin.push(prop);
  }
  return { root, spin, kind };
}

// where riders sit, in the vehicle model's space (facing -z; x right, z back): the driver's hips (null:
// hidden inside the cockpit or the hull), then each passenger seat in the sim's seat order, and how far
// forward their legs reach (0 hanging, ~1.5 straight out)
export const SEATS: { driver: [number, number, number] | null; seats: [number, number, number][]; legs: number }[] = [
  { driver: [-0.45, 1.14, 0.35], seats: [[0.5, 1.14, 0.35], [-0.5, 1.14, 1.45], [0.5, 1.14, 1.45]], legs: 1.45 },           // car
  { driver: null, seats: [[1.45, 0.98, 0.8], [-1.45, 0.98, 1.2], [1.45, 0.98, 1.6], [-1.45, 0.98, 2.0]], legs: 1.1 },        // helicopter: on the skids
  { driver: null, seats: [[0, 1.86, 0.8], [0, 1.86, 1.25], [0, 1.86, 1.7]], legs: 1.3 },                                     // plane: astride the fuselage
  { driver: [0, 1.2, 0.18], seats: [[0, 1.24, 0.66]], legs: 1.0 },                                                           // motorbike
  { driver: null, seats: [[0, 2.3, 0.6], [0.6, 2.3, 1.1], [-0.6, 2.3, 1.1]], legs: 1.2 },                                    // tank: up on the turret
];

// a patch of fire from a molotov: a ring of flame tongues
export function buildFire(ink: InkRenderer): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2, d = i % 2 ? 1.6 : 3.4, h = 0.9 + (i % 3) * 0.5;
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.45, h, 6), ink.material(i % 3 ? INK_IDS.ORANGE : INK_IDS.RED));
    f.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d); f.name = 'flame'; g.add(f);
  }
  return g;
}

// a supply crate hanging under a striped balloon
export function buildSupply(ink: InkRenderer): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.6, 1.2, 1.6, ink.material(INK_IDS.ORANGE), 0, 0.6, 0), box(1.65, 0.15, 1.65, ink.material(INK_IDS.BLUE), 0, 0.95, 0), box(0.15, 1.25, 1.65, ink.material(INK_IDS.BLUE), 0, 0.6, 0));
  for (const [x, z] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) g.add(box(0.04, 3.2, 0.04, ink.material(INK_IDS.GRAPHITE), x * 0.8, 2.8, z * 0.8));
  const balloon = new THREE.Mesh(new THREE.SphereGeometry(2.2, 14, 10), ink.material(INK_IDS.RED)); balloon.position.y = 6.2; balloon.scale.y = 1.15; g.add(balloon);
  const band = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.18, 6, 24).rotateX(Math.PI / 2), ink.material(INK_IDS.PAPER)); band.position.y = 6.2; g.add(band);
  return g;
}

// the diamond pickaxe: a wooden handle and a two-pointed diamond head, held points forward.
// (In code it is still the "axe": the protocol bit and the sim constant kept their names.)
export function buildPickaxe(wood: Mat, gem: Mat): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.05, 0.05, 0.8, wood, 0, 0, -0.32));                       // handle
  g.add(box(0.07, 0.09, 0.09, gem, 0, 0, -0.7));                        // socket
  // the head: two arms sweeping back from the socket, each ending in a point
  for (const s of [1, -1]) {
    const arm = box(0.055, 0.26, 0.07, gem, 0, s * 0.15, -0.67);
    arm.rotation.x = s * 0.35;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.14, 4), gem);
    tip.position.set(0, s * 0.33, -0.6); tip.rotation.x = s > 0 ? 0.42 : Math.PI - 0.42; // up (down) and curving back
    g.add(arm, tip);
  }
  g.add(box(0.06, 0.05, 0.05, wood, 0, 0, -0.76));                      // the handle's end through the head
  return g;
}

// ---------------- players ----------------
// A character is ONE skinned mesh. Every part (limbs, face, hair, hat, buttons) is baked into a single
// geometry with its ink per vertex and one bone per vertex, so a player costs one draw call however much
// detail it carries (two with something in hand). The geometry is built once per look and shared by
// everyone wearing it; each figure only owns its bones.
const pivot = (x: number, y: number, z: number, ...kids: THREE.Object3D[]) => { const g = new THREE.Group(); g.position.set(x, y, z); if (kids.length) g.add(...kids); return g; };
const BONES = ['pelvis', 'torso', 'head', 'armL', 'foreL', 'armR', 'foreR', 'legL', 'shinL', 'legR', 'shinR'] as const;
type BoneName = typeof BONES[number];
const PARENT = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9]; // pelvis holds the legs and the torso; the torso the head and arms
const BI = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<BoneName, number>;

// a skeleton's measures (m): pelvis height, leg and arm lengths, shoulders and neck from the pelvis, and
// where the gun is held (in the torso's space, before the aim pitches it)
interface Frame { hip: number; legX: number; thigh: number; shin: number; shX: number; shY: number; shZ: number; upper: number; fore: number; neck: number; aim: [number, number, number] }
const HUMAN: Frame = { hip: 0.82, legX: 0.115, thigh: 0.41, shin: 0.41, shX: 0.25, shY: 0.47, shZ: 0, upper: 0.3, fore: 0.29, neck: 0.56, aim: [0.08, 0.36, -0.1] };
function restOf(fr: Frame): [number, number, number][] {
  return [[0, fr.hip, 0], [0, 0, 0], [0, fr.neck, 0], [-fr.shX, fr.shY, fr.shZ], [0, -fr.upper, 0], [fr.shX, fr.shY, fr.shZ], [0, -fr.upper, 0],
    [-fr.legX, 0, 0], [0, -fr.thigh, 0], [fr.legX, 0, 0], [0, -fr.thigh, 0]];
}

const _m4 = new THREE.Matrix4(), _n3 = new THREE.Matrix3(), _q = new THREE.Quaternion(), _eu = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
// collects primitives into one vertex-ink geometry, each vertex tied to one bone
class Rig {
  pos: number[] = []; nor: number[] = []; ink: number[] = []; bone: number[] = []; idx: number[] = [];
  origin: THREE.Vector3[] = [];
  constructor(fr?: Frame) {
    if (!fr) return;
    const rest = restOf(fr);
    rest.forEach((r, i) => { this.origin[i] = new THREE.Vector3(...r); if (PARENT[i] >= 0) this.origin[i].add(this.origin[PARENT[i]]); });
  }
  append(g: THREE.BufferGeometry, m: THREE.Matrix4, ink: number, bone: number) {
    _n3.getNormalMatrix(m);
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), base = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m); this.pos.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(n, i).applyMatrix3(_n3).normalize(); this.nor.push(_v.x, _v.y, _v.z);
      this.ink.push(ink); this.bone.push(bone);
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }
  // a primitive placed in its bone's space: offset from the joint, rotation (radians), scale
  put(b: number, ink: number, g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const o = this.origin[b];
    _m4.compose(_s.set(x + o.x, y + o.y, z + o.z), _q.setFromEuler(_eu.set(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
    this.append(g, _m4, ink, b);
    g.dispose();
  }
  box(b: number, ink: number, w: number, h: number, d: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) { this.put(b, ink, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz); }
  ball(b: number, ink: number, r: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ws = r < 0.07 ? 6 : 8, hs = r < 0.07 ? 4 : 5) { this.put(b, ink, new THREE.SphereGeometry(r, ws, hs), x, y, z, 0, 0, 0, sx, sy, sz); }
  // a cylinder standing on y; sz squashes it front to back (an oval section)
  cyl(b: number, ink: number, rt: number, rb: number, h: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seg = 8, sz = 1) { this.put(b, ink, new THREE.CylinderGeometry(rt, rb, h, seg, 1, false), x, y, z, rx, ry, rz, 1, 1, sz); }
  // a limb hanging from its joint: a tapered cylinder from y0 down
  // (open ended: the joints, the hips and the shoes cover its ends)
  limb(b: number, ink: number, r0: number, r1: number, len: number, y0 = 0, seg = 7) { this.put(b, ink, new THREE.CylinderGeometry(r0, r1, len, seg, 1, true), 0, y0 - len / 2, 0); }
  geometry(skinned: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aInk', new THREE.Float32BufferAttribute(this.ink, 1));
    if (skinned) {
      const si = new Uint16Array(this.bone.length * 4), sw = new Float32Array(this.bone.length * 4);
      this.bone.forEach((b, i) => { si[i * 4] = b; sw[i * 4] = 1; });
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    }
    g.setIndex(this.idx);
    g.computeBoundingBox(); g.computeBoundingSphere();
    g.userData.shared = true; // lives as long as the page, whoever wears it
    return g;
  }
}

// a model built for the old one-material-per-mesh path (a gun, the pickaxe), flattened into one
// vertex-ink geometry. Its materials only need to say which ink they are
const TAG = new Map<number, Mat>();
const tag = (ink: number) => { let m = TAG.get(ink); if (!m) { m = new THREE.MeshBasicMaterial(); m.userData.ink = ink; TAG.set(ink, m); } return m; };
function flatten(root: THREE.Object3D): THREE.BufferGeometry {
  const rig = new Rig();
  root.updateMatrixWorld(true);
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) rig.append(m.geometry, m.matrixWorld, (m.material as Mat).userData.ink ?? INK_IDS.GRAPHITE, 0); });
  return rig.geometry(false);
}
const TAG_GUN: GunMats = { body: tag(INK_IDS.BLUE), dark: tag(INK_IDS.GRAPHITE), accent: tag(INK_IDS.ORANGE), gem: tag(INK_IDS.DIAMOND), wood: tag(INK_IDS.BROWN) };
const heldGeo = new Map<string, THREE.BufferGeometry>();
function heldGeometry(what: WeaponId | 'axe', level: number) {
  const k = `${what}|${level}`;
  let g = heldGeo.get(k);
  if (!g) {
    const model = what === 'axe' ? buildPickaxe(TAG_GUN.wood!, TAG_GUN.gem!) : buildGun(what, TAG_GUN);
    if (what !== 'axe') upgradeGun(model, level, TAG_GUN.accent, TAG_GUN.gem!);
    g = flatten(model); heldGeo.set(k, g);
  }
  return g;
}

// ---- the looks ----
export interface Look { geo: THREE.BufferGeometry; fr: Frame; crownY: number; nod: number; hat: number }
const SUIT_INKS = [INK_IDS.RED, INK_IDS.PINK, INK_IDS.ORANGE, INK_IDS.GREEN, INK_IDS.BROWN];
const looks = new Map<string, Look>();
const I = INK_IDS;
const HR = 0.235, HY = 0.22; // a head's radius, and its centre above the neck
// where the face's surface is, x across and dy up from the head's centre (features sit on it)
const zf = (x: number, dy: number, r = HR) => -Math.sqrt(Math.max(0, r * r - x * x - dy * dy));
// 3 × 5 pixel letters for the slogan on Alon's tank top
const GLYPHS: Record<string, string> = {
  S: '111100111001111', T: '111010010010010', O: '111101101101111', P: '111101111100100', B: '110101110101110',
  E: '111100110100111', I: '111010010010111', N: '101111111101101', G: '111100101101111', R: '110101110101101',
};

function lookOf(skin: number, id: number): Look {
  const key = skin === 0 ? `0|${id % 5}|${(id * 7 + 2) % 5}` : String(skin);
  const hit = looks.get(key);
  if (hit) return hit;
  const suit = SUIT_INKS[id % SUIT_INKS.length], hat = SUIT_INKS[(id * 7 + 2) % SUIT_INKS.length];
  const fr: Frame = skin === 6 ? { hip: 0.34, legX: 0.17, thigh: 0.16, shin: 0.18, shX: 0.4, shY: 0.5, shZ: -0.3, upper: 0.19, fore: 0.18, neck: 0.62, aim: [0.06, 0.4, -0.42] }
    : skin === 9 ? { ...HUMAN, hip: 0.76, thigh: 0.37, shin: 0.39, shX: 0.31, shY: 0.42, upper: 0.27, fore: 0.27, neck: 0.55, aim: [0.08, 0.32, -0.14] }
    : skin === 8 ? { ...HUMAN, shX: 0.265 }
    : HUMAN;
  const r = new Rig(fr);
  const { pelvis, torso, head, armL, foreL, armR, foreR, legL, shinL, legR, shinR } = BI;
  const ARMS: [number, number, number][] = [[armL, foreL, -1], [armR, foreR, 1]], LEGS: [number, number, number][] = [[legL, shinL, -1], [legR, shinR, 1]];
  let crown = fr.hip + fr.neck + HY + HR + 0.08, nod = 0.6;

  // ---- shared pieces ----
  // legs: thigh, knee, shin, a shoe with its sole (cuff: a rolled hem or a sock at the ankle)
  const legs = (pants: number, shin: number, shoe: number, sole: number, o: { cuff?: number; wide?: number; boot?: boolean } = {}) => {
    const w = o.wide ?? 1;
    for (const [l, s] of LEGS) {
      r.limb(l, pants, 0.102 * w, 0.086 * w, fr.thigh + 0.05, 0.03);
      r.ball(s, shin, 0.08 * w, 0, 0, 0);
      r.limb(s, shin, (o.boot ? 0.09 : 0.078) * w, (o.boot ? 0.084 : 0.066) * w, fr.shin - 0.08);
      if (o.boot) r.cyl(s, shin, 0.1, 0.1, 0.06, 0, -0.06, 0, 0, 0, 0, 10);
      if (o.cuff !== undefined) r.cyl(s, o.cuff, 0.088 * w, 0.088 * w, 0.06, 0, -fr.shin + 0.13, 0, 0, 0, 0, 10);
      r.box(s, shoe, 0.15, 0.1, 0.27, 0, -fr.shin + 0.06, -0.045);
      r.ball(s, shoe, 0.075, 0, -fr.shin + 0.07, -0.16, 1, 0.75, 0.9); // a round toe
      r.box(s, sole, 0.16, 0.03, 0.3, 0, -fr.shin + 0.015, -0.055);
    }
    r.cyl(pelvis, pants, 0.215 * Math.min(1.08, w), 0.205 * Math.min(1.08, w), 0.17, 0, -0.01, 0, 0, 0, 0, 10, 0.72);
  };
  // a torso tapering to the waist, round shoulders on top; front(y) is the chest's surface, for prints
  const TOP = 0.25, WAIST = 0.205, SZ = 0.62;
  const front = (y: number, x = 0, t = TOP, w = WAIST) => { const rr = w + (t - w) * Math.max(0, Math.min(1, (y - 0.05) / 0.5)); return -SZ * Math.sqrt(Math.max(0, rr * rr - x * x)); };
  const chest = (shirt: number, o: { top?: number; waist?: number; low?: number; dome?: number } = {}) => {
    const t = o.top ?? TOP, w = o.waist ?? WAIST, low = o.low ?? 0.05;
    r.cyl(torso, shirt, t, w, 0.55 - low, 0, (0.55 + low) / 2, 0, 0, 0, 0, 10, SZ);
    r.ball(torso, o.dome ?? shirt, t, 0, 0.53, 0, 1, 0.32, SZ, 10, 4);
  };
  // arms: a shoulder ball, upper arm, elbow, forearm, fist. sleeve: 1 long, 0 bare, in between a short sleeve
  const arms = (cloth: number, sleeve: number, skinInk: number, hand: number, o: { wide?: number; cuff?: number } = {}) => {
    for (const [a, f] of ARMS) {
      r.ball(a, sleeve > 0 ? cloth : skinInk, 0.088, 0, -0.01, 0, 1, 1, 1, 8, 6);
      if (sleeve >= 1) r.limb(a, cloth, 0.074, 0.066, fr.upper, -0.02);
      else {
        r.limb(a, skinInk, 0.064, 0.058, fr.upper, -0.02);
        if (sleeve > 0) r.limb(a, cloth, 0.09 * (o.wide ?? 1), 0.085 * (o.wide ?? 1), fr.upper * sleeve, -0.01, 10);
      }
      const fi = sleeve >= 1 ? cloth : skinInk;
      r.ball(f, fi, sleeve >= 1 ? 0.066 : 0.058, 0, 0, 0);
      r.limb(f, fi, sleeve >= 1 ? 0.064 : 0.056, sleeve >= 1 ? 0.058 : 0.05, fr.fore - 0.06);
      if (o.cuff !== undefined) r.cyl(f, o.cuff, 0.072, 0.072, 0.06, 0, -fr.fore + 0.1, 0, 0, 0, 0, 10);
      r.ball(f, hand, 0.066, 0, -fr.fore + 0.005, -0.005, 1, 1.15, 0.95);
    }
  };
  // a head: skull and neck, ears
  const skull = (ink: number, neck = ink, ears = true) => {
    r.ball(head, ink, HR, 0, HY, 0, 1, 1.02, 0.98, 12, 8);
    r.limb(head, neck, 0.07, 0.074, 0.14, 0.1);
    if (ears) for (const s of [-1, 1]) r.ball(head, ink, 0.055, s * (HR - 0.012), HY - 0.015, 0.015, 0.45, 1, 0.75);
  };
  const eyes = (o: { y?: number; x?: number; r?: number; sy?: number; ink?: number; sides?: number[] } = {}) => {
    const y = o.y ?? -0.005, x = o.x ?? 0.085, rr = o.r ?? 0.034;
    for (const s of o.sides ?? [-1, 1]) r.ball(head, o.ink ?? I.BLACK, rr, s * x, HY + y, zf(x, y) + 0.012, 0.85, o.sy ?? 1.25, 0.5);
  };
  const brows = (y = 0.075, tilt = 0.1, thick = 0.022, x = 0.088) => { for (const s of [-1, 1]) r.box(head, I.BLACK, 0.085, thick, 0.03, s * x, HY + y, zf(x, y) + 0.012, 0, 0, -s * tilt); };
  const nose = (ink: number, y = -0.045, rr = 0.032) => r.ball(head, ink, rr, 0, HY + y, zf(0, y) + 0.006, 1, 1, 1.2);
  // a smile: half a ring, open side up
  const smile = (w: number, ink: number = I.BLACK, y = -0.105, thick = 0.012) => r.put(head, ink, new THREE.TorusGeometry(w, thick, 4, 10, Math.PI), 0, HY + y + w * 0.35, zf(0, y) + 0.008, 0, 0, Math.PI, 1, 0.75, 1);
  // a dome over the head (hair, beanie, helmet): r, how far down it reaches (theta), centre offset, tilt back
  const dome = (ink: number, rr: number, theta: number, y = 0, tilt = 0, sx = 1, sy = 1, sz = 1) => r.put(head, ink, new THREE.SphereGeometry(rr, 12, 5, 0, Math.PI * 2, 0, theta), 0, HY + y, 0, tilt, 0, 0, sx, sy, sz);
  // hair or cloth hanging around the sides and back, open at the face (gap: half the opening, radians)
  const curtain = (ink: number, rt: number, rb: number, h: number, y: number, gap: number, z = 0) => r.put(head, ink, new THREE.CylinderGeometry(rt, rb, h, 10, 1, true, Math.PI + gap, Math.PI * 2 - gap * 2), 0, HY + y, z);
  // a peak: a half disc sticking out of the front of a cap
  const peak = (ink: number, rr: number, y: number, z: number, tilt = 0) => r.put(head, ink, new THREE.CylinderGeometry(rr, rr, 0.022, 10, 1, false, Math.PI / 2, Math.PI), 0, HY + y, z, tilt);

  switch (skin) {
    case 1: { // Crayon Knight: steel plate, a blue tabard with a gold cross, a great helm with a T visor and a red plume
      legs(I.GRAPHITE, I.GRAPHITE, I.BROWN, I.BLACK, { boot: true });
      chest(I.GRAPHITE);
      r.cyl(torso, I.BROWN, 0.218, 0.214, 0.06, 0, 0.08, 0, 0, 0, 0, 12, SZ);
      for (const s of [-1, 1]) r.box(torso, I.BLUE, 0.3, 0.6, 0.02, 0, 0.21, s * (-front(0.25) + 0.008)); // tabard, front and back
      r.box(torso, I.ORANGE, 0.06, 0.26, 0.026, 0, 0.3, front(0.3) - 0.012); r.box(torso, I.ORANGE, 0.19, 0.06, 0.026, 0, 0.35, front(0.35) - 0.012);
      arms(I.GRAPHITE, 1, I.GRAPHITE, I.GRAPHITE, { cuff: I.GRAPHITE });
      for (const [a] of ARMS) r.ball(a, I.BLUE, 0.125, 0, 0.01, 0, 1.1, 0.7, 1.1, 10, 5); // pauldrons
      r.ball(head, I.GRAPHITE, 0.25, 0, HY, 0, 1, 1.06, 1, 12, 8);
      r.limb(head, I.GRAPHITE, 0.08, 0.09, 0.14, 0.1);
      r.box(head, I.BLACK, 0.3, 0.038, 0.05, 0, HY + 0.02, zf(0, 0.02, 0.25) + 0.012); r.box(head, I.BLACK, 0.038, 0.13, 0.05, 0, HY - 0.06, zf(0, -0.06, 0.25) + 0.012);
      r.cyl(head, I.GRAPHITE, 0.258, 0.258, 0.03, 0, HY + 0.1, 0, 0, 0, 0, 14); // brow ridge
      r.box(head, I.ORANGE, 0.04, 0.06, 0.12, 0, HY + 0.25, 0.0);
      r.ball(head, I.RED, 0.1, 0, HY + 0.33, 0.06, 0.45, 1.15, 2.3, 8, 6);
      crown += 0.18;
      break;
    }
    case 2: { // Ink Ninja: black from head to toe, a skin slit with angry eyes, a red headband with long tails, a sword on the back
      legs(I.BLACK, I.BLACK, I.BLACK, I.GRAPHITE);
      for (const [, s] of LEGS) for (const y of [-0.1, -0.2]) r.cyl(s, I.WHITE, 0.08, 0.077, 0.045, 0, y, 0, 0, 0, 0, 10);
      chest(I.BLACK);
      r.cyl(torso, I.RED, 0.22, 0.216, 0.07, 0, 0.09, 0, 0, 0, 0, 12, SZ);
      r.box(torso, I.RED, 0.06, 0.2, 0.03, 0.1, -0.02, front(0.05, 0.1) - 0.01, 0, 0, 0.15);
      for (const s of [-1, 1]) r.box(torso, I.GRAPHITE, 0.04, 0.3, 0.02, s * 0.06, 0.4, front(0.4, 0.06) - 0.004, 0, 0, s * 0.45); // the gi's crossed collar
      r.box(torso, I.GRAPHITE, 0.055, 0.9, 0.055, 0.02, 0.3, 0.18, 0, 0, 0.62);  // scabbard across the back
      r.box(torso, I.ORANGE, 0.13, 0.025, 0.07, -0.235, 0.665, 0.18, 0, 0, 0.62);   // guard
      r.box(torso, I.RED, 0.045, 0.22, 0.045, -0.315, 0.776, 0.18, 0, 0, 0.62);    // hilt over the shoulder
      arms(I.BLACK, 1, I.BLACK, I.BLACK);
      skull(I.BLACK);
      r.put(head, I.SKIN, new THREE.CylinderGeometry(HR + 0.004, HR + 0.004, 0.09, 12, 1, true, Math.PI - 0.95, 1.9), 0, HY + 0.005, 0);
      for (const s of [-1, 1]) r.box(head, I.BLACK, 0.075, 0.028, 0.03, s * 0.085, HY + 0.0, zf(0.085, 0) + 0.01, 0, 0, -s * 0.28);
      r.cyl(head, I.RED, HR + 0.014, HR + 0.014, 0.055, 0, HY + 0.1, 0, 0, 0, 0, 14);
      r.ball(head, I.RED, 0.045, 0, HY + 0.1, HR + 0.02);
      for (const s of [-1, 1]) r.box(head, I.RED, 0.055, 0.018, 0.4, s * 0.05, HY + 0.0, HR + 0.18, 0.55, s * 0.3, 0);
      break;
    }
    case 3: { // Robo Pen: a blue tin body, a white box head with a black visor and orange eyes, an antenna, a pen clip
      legs(I.BLUE, I.BLUE, I.GRAPHITE, I.BLACK);
      for (const [, s] of LEGS) r.ball(s, I.GRAPHITE, 0.097, 0, 0, 0);
      r.box(torso, I.BLUE, 0.5, 0.44, 0.3, 0, 0.33, 0);
      r.cyl(torso, I.GRAPHITE, 0.17, 0.17, 0.12, 0, 0.07, 0, 0, 0, 0, 10);
      r.box(torso, I.WHITE, 0.28, 0.16, 0.02, 0, 0.37, -0.155);
      [I.ORANGE, I.RED, I.GREEN].forEach((c, k) => r.box(torso, c, 0.045, 0.045, 0.02, -0.08 + k * 0.08, 0.37, -0.168));
      r.box(torso, I.GRAPHITE, 0.3, 0.1, 0.06, 0, 0.36, 0.17); // battery pack
      arms(I.BLUE, 1, I.BLUE, I.GRAPHITE);
      for (const [a, f] of ARMS) { r.ball(a, I.GRAPHITE, 0.1, 0, -0.01, 0); r.ball(f, I.GRAPHITE, 0.082, 0, 0, 0); }
      r.limb(head, I.GRAPHITE, 0.07, 0.08, 0.12, 0.1);
      r.box(head, I.WHITE, 0.44, 0.38, 0.4, 0, HY + 0.02, 0);
      r.box(head, I.BLACK, 0.36, 0.13, 0.03, 0, HY + 0.05, -0.205);
      for (const s of [-1, 1]) r.box(head, I.ORANGE, 0.08, 0.055, 0.02, s * 0.085, HY + 0.05, -0.222);
      for (const y of [-0.08, -0.11]) r.box(head, I.GRAPHITE, 0.16, 0.014, 0.02, 0, HY + y, -0.205);
      for (const s of [-1, 1]) r.cyl(head, I.GRAPHITE, 0.07, 0.07, 0.05, s * 0.23, HY + 0.02, 0, 0, 0, Math.PI / 2, 10);
      r.box(head, I.GRAPHITE, 0.05, 0.32, 0.035, 0.1, HY + 0.08, 0.215); // the pen's clip
      r.cyl(head, I.GRAPHITE, 0.012, 0.012, 0.26, 0.12, HY + 0.33, 0, 0, 0, 0, 5);
      r.ball(head, I.ORANGE, 0.05, 0.12, HY + 0.47, 0);
      crown += 0.16;
      break;
    }
    case 4: { // Captain Blot: a red frock coat with gold trim, white breeches, tall boots, an eyepatch, a beard, a tricorn
      legs(I.WHITE, I.BLACK, I.BLACK, I.BROWN, { boot: true });
      chest(I.RED);
      r.put(pelvis, I.RED, new THREE.CylinderGeometry(0.225, 0.3, 0.4, 12, 1, true, Math.PI + 0.4, Math.PI * 2 - 0.8), 0, -0.14, 0, 0, 0, 0, 1, 1, 0.75); // coat tails
      r.box(torso, I.WHITE, 0.13, 0.4, 0.02, 0, 0.33, front(0.33) - 0.002);
      for (const s of [-1, 1]) {
        r.box(torso, I.ORANGE, 0.035, 0.46, 0.024, s * 0.085, 0.3, front(0.3, 0.085) - 0.004);
        for (const y of [0.4, 0.29, 0.18]) r.ball(torso, I.ORANGE, 0.02, s * 0.13, y, front(y, 0.13) - 0.008);
      }
      r.cyl(torso, I.BROWN, 0.218, 0.214, 0.06, 0, 0.08, 0, 0, 0, 0, 12, SZ); r.box(torso, I.ORANGE, 0.07, 0.06, 0.02, 0, 0.08, front(0.08) - 0.008);
      arms(I.RED, 1, I.SKIN, I.SKIN, { cuff: I.ORANGE });
      for (const [a] of ARMS) r.ball(a, I.ORANGE, 0.1, 0, 0.035, 0, 1.15, 0.4, 1.15, 8, 4); // epaulettes
      skull(I.SKIN);
      r.box(head, I.BLACK, 0.085, 0.075, 0.03, 0.085, HY - 0.005, zf(0.085, 0) + 0.01);
      r.put(head, I.BLACK, new THREE.CylinderGeometry(HR + 0.006, HR + 0.006, 0.016, 14, 1, true), 0, HY + 0.03, 0, 0, 0, 0.42);
      eyes({ sides: [-1] }); brows(0.075, 0.12);
      nose(I.SKIN, -0.04, 0.036);
      r.ball(head, I.BROWN, 0.14, 0, HY - 0.16, -0.1, 1.25, 0.85, 0.85); // beard
      for (const s of [-1, 1]) r.ball(head, I.BROWN, 0.045, s * 0.045, HY - 0.085, zf(0.045, -0.085) + 0.006, 1.5, 0.55, 0.6);
      r.ball(head, I.BLACK, 0.2, 0, HY + 0.15, 0, 1.15, 0.7, 1.1, 10, 6);
      r.put(head, I.BLACK, new THREE.ConeGeometry(0.42, 0.18, 3), 0, HY + 0.2, 0, 0, Math.PI, 0);
      r.ball(head, I.WHITE, 0.035, 0, HY + 0.22, -0.2, 1, 1, 0.6); // the skull on the hat
      crown += 0.1;
      break;
    }
    case 5: { // Chill House: a house for a head (window eyes, a round nose, a gable roof, a chimney), grey sweater, rolled jeans
      legs(I.BLUE, I.BLUE, I.BROWN, I.WHITE, { cuff: I.WHITE });
      chest(I.GRAPHITE);
      r.cyl(torso, I.GRAPHITE, 0.212, 0.212, 0.07, 0, 0.08, 0, 0, 0, 0, 12, SZ);     // ribbed hem
      r.put(torso, I.GRAPHITE, new THREE.TorusGeometry(0.1, 0.025, 5, 12), 0, 0.58, -0.02, Math.PI / 2); // collar
      arms(I.GRAPHITE, 1, I.SKIN, I.SKIN, { cuff: I.GRAPHITE });
      r.limb(head, I.SKIN, 0.07, 0.074, 0.12, 0.08);
      r.box(head, I.WHITE, 0.48, 0.38, 0.44, 0, HY, 0);
      r.cyl(head, I.RED, 0.33, 0.33, 0.56, 0, HY + 0.305, 0, -Math.PI / 2, 0, 0, 3, 0.7); // a gable roof, its triangle to the front
      r.box(head, I.BROWN, 0.09, 0.22, 0.09, 0.15, HY + 0.43, 0.1);
      for (const s of [-1, 1]) {
        r.box(head, I.BLACK, 0.15, 0.15, 0.02, s * 0.11, HY + 0.05, -0.222); r.box(head, I.BLUE, 0.12, 0.12, 0.022, s * 0.11, HY + 0.05, -0.225);
        r.box(head, I.BLACK, 0.12, 0.014, 0.026, s * 0.11, HY + 0.05, -0.228); r.box(head, I.BLACK, 0.014, 0.12, 0.026, s * 0.11, HY + 0.05, -0.228);
      }
      r.ball(head, I.BROWN, 0.055, 0, HY - 0.05, -0.24, 1, 1, 0.9);
      r.put(head, I.BLACK, new THREE.TorusGeometry(0.06, 0.012, 4, 10, Math.PI), 0, HY - 0.105, -0.222, 0, 0, Math.PI, 1, 0.7, 1);
      crown = fr.hip + fr.neck + HY + 0.62;
      break;
    }
    case 6: { // Cupsey: a tall plush gumdrop, cream white over green with a drip line, rosy cheeks, a sprout, stubby green arms and feet
      for (const [l, s] of LEGS) { r.limb(l, I.GREEN, 0.085, 0.08, fr.thigh + 0.04, 0.02); r.ball(s, I.GREEN, 0.082, 0, 0, 0); r.ball(s, I.GREEN, 0.11, 0, -fr.shin + 0.07, -0.05, 1, 0.62, 1.4); }
      const P: [number, number][] = [[0, -0.04], [0.4, -0.02], [0.5, 0.1], [0.53, 0.3], [0.51, 0.55], [0.46, 0.8], [0.37, 1.02], [0.23, 1.2], [0.08, 1.28], [0, 1.29]];
      const rad = (y: number) => { for (let k = 1; k < P.length; k++) if (y <= P[k][1]) { const t = (y - P[k - 1][1]) / (P[k][1] - P[k - 1][1]); return P[k - 1][0] + (P[k][0] - P[k - 1][0]) * t; } return 0; };
      const split = 0.52, lathe = (from: number, to: number) => { const pts = [new THREE.Vector2(from > 0 ? rad(from) : 0, from)]; for (const [x, y] of P) if (y > from && y < to) pts.push(new THREE.Vector2(x, y)); pts.push(new THREE.Vector2(to < 1.29 ? rad(to) : 0, to)); return new THREE.LatheGeometry(pts, 16); };
      r.put(torso, I.GREEN, lathe(-0.04, split));
      r.put(torso, I.WHITE, lathe(split, 1.29));
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + 0.2, rr = rad(split) - 0.01; r.ball(torso, I.WHITE, 0.07, Math.sin(a) * rr, split - 0.02, Math.cos(a) * rr, 1, 1.3, 0.6, 6, 5); } // drips
      r.limb(torso, I.GREEN, 0.014, 0.018, 0.12, 1.38, 5);
      for (const s of [-1, 1]) r.put(torso, I.GREEN, new THREE.SphereGeometry(0.07, 8, 5), s * 0.06, 1.38, 0, 0, 0, s * -0.5, 1, 0.3, 0.55);
      for (const [a, f] of ARMS) { r.ball(a, I.GREEN, 0.075, 0, 0, 0); r.limb(a, I.GREEN, 0.07, 0.066, fr.upper); r.ball(f, I.GREEN, 0.066, 0, 0, 0); r.limb(f, I.GREEN, 0.066, 0.062, fr.fore - 0.04); r.ball(f, I.GREEN, 0.078, 0, -fr.fore + 0.01, 0); }
      const fz = (x: number, y: number) => -Math.sqrt(Math.max(0, rad(fr.neck + y) ** 2 - x * x)); // the face sits on the body
      for (const s of [-1, 1]) {
        r.ball(head, I.BLACK, 0.05, s * 0.13, 0.13, fz(0.13, 0.13) + 0.018, 0.85, 1.1, 0.5);
        r.ball(head, I.WHITE, 0.015, s * 0.13 + 0.015, 0.155, fz(0.13, 0.13) - 0.006);
        r.ball(head, I.PINK, 0.06, s * 0.23, 0.04, fz(0.23, 0.04) + 0.014, 1, 0.62, 0.3);
      }
      r.put(head, I.BLACK, new THREE.TorusGeometry(0.045, 0.011, 4, 10, Math.PI), 0, 0.055, fz(0, 0.05) + 0.008, 0, 0, Math.PI, 1, 0.75, 1);
      crown = fr.hip + 1.45; nod = 0;
      break;
    }
    case 7: { // Retardio: clown paint, a red nose, an orange bob under a black cap with a patch, a black long-sleeve with a print, orange plaid trousers, purple shoes
      legs(I.ORANGE, I.ORANGE, I.PURPLE, I.WHITE);
      for (const [l, s] of LEGS) {
        for (const y of [-0.13, -0.29]) r.cyl(l, I.BLACK, 0.098, 0.096, 0.02, 0, y, 0, 0, 0, 0, 10);
        r.cyl(s, I.BLACK, 0.077, 0.075, 0.02, 0, -0.14, 0, 0, 0, 0, 10);
        r.box(l, I.BLACK, 0.02, fr.thigh, 0.01, 0.03, -fr.thigh / 2, -0.098); r.box(s, I.BLACK, 0.02, fr.shin - 0.12, 0.01, 0.025, -0.16, -0.076);
      }
      chest(I.BLACK);
      r.box(torso, I.ORANGE, 0.28, 0.2, 0.02, 0, 0.35, front(0.35) - 0.004);
      r.box(torso, I.RED, 0.17, 0.07, 0.02, 0, 0.38, front(0.35) - 0.012); r.box(torso, I.WHITE, 0.2, 0.03, 0.02, 0, 0.3, front(0.35) - 0.012);
      arms(I.BLACK, 1, I.SKIN, I.SKIN);
      skull(I.WHITE, I.WHITE);
      for (const s of [-1, 1]) for (const y of [0.075, -0.075]) r.box(head, I.BLUE, 0.04, 0.04, 0.02, s * 0.088, HY + y, zf(0.088, y) + 0.006, 0, 0, Math.PI / 4);
      eyes();
      r.ball(head, I.RED, 0.055, 0, HY - 0.035, zf(0, -0.035) - 0.01);
      smile(0.08, I.RED, -0.115, 0.016);
      dome(I.ORANGE, 0.256, Math.PI * 0.5, 0.005, 0.5);
      curtain(I.ORANGE, 0.257, 0.275, 0.26, -0.11, 0.78, 0.005);
      r.box(head, I.ORANGE, 0.3, 0.05, 0.05, 0, HY + 0.135, zf(0, 0.135) - 0.0);
      dome(I.BLACK, 0.264, Math.PI * 0.42, 0.04);
      peak(I.BLACK, 0.16, 0.115, -0.2, 0.12);
      r.box(head, I.WHITE, 0.15, 0.075, 0.02, 0, HY + 0.22, zf(0, 0.18, 0.264) - 0.005, 0.75);
      for (const x of [-0.05, -0.017, 0.017, 0.05]) r.box(head, I.BLACK, 0.018, 0.04, 0.022, x, HY + 0.22, zf(0, 0.18, 0.264) - 0.012, 0.75);
      break;
    }
    case 8: { // Kimchi: a black bowl cut with a fringe, a friendly grin, an oversized cream tee, a thin silver chain with a cross
      legs(I.GRAPHITE, I.GRAPHITE, I.WHITE, I.GRAPHITE, { wide: 1.12 });
      chest(I.WHITE, { top: 0.265, waist: 0.245, low: -0.03 });
      r.cyl(torso, I.WHITE, 0.25, 0.25, 0.05, 0, -0.02, 0, 0, 0, 0, 12, SZ);
      r.put(torso, I.WHITE, new THREE.TorusGeometry(0.095, 0.022, 5, 12), 0, 0.585, -0.015, Math.PI / 2);
      r.put(torso, I.GRAPHITE, new THREE.TorusGeometry(0.15, 0.006, 3, 14), 0, 0.56, -0.06, Math.PI / 2 - 0.82);
      r.box(torso, I.GRAPHITE, 0.016, 0.058, 0.012, 0, 0.43, front(0.43, 0, 0.265, 0.245) - 0.008); r.box(torso, I.GRAPHITE, 0.042, 0.014, 0.012, 0, 0.44, front(0.43, 0, 0.265, 0.245) - 0.01);
      arms(I.WHITE, 0.7, I.SKIN, I.SKIN, { wide: 1.15 });
      skull(I.SKIN);
      r.ball(head, I.GRAPHITE, 0.014, -(HR - 0.005), HY - 0.065, -0.005);
      eyes({ y: -0.01, sy: 0.85, r: 0.033 }); brows(0.06, 0.05, 0.03, 0.09);
      nose(I.SKIN, -0.05, 0.03);
      r.put(head, I.WHITE, new THREE.CircleGeometry(0.066, 10, Math.PI, Math.PI), 0, HY - 0.098, zf(0, -0.11) - 0.005, 0, Math.PI, 0.06);
      r.box(head, I.BLACK, 0.135, 0.012, 0.016, 0, HY - 0.098, zf(0, -0.1) - 0.002, 0, 0, 0.06);
      dome(I.BLACK, 0.262, Math.PI * 0.56, 0.025, 0.36, 1.08, 1.04, 1.08);
      for (let k = -2; k <= 2; k++) { const a = k * 0.32, x = Math.sin(a) * 0.235; r.ball(head, I.BLACK, 0.052, x, HY + 0.085 + Math.abs(k) * -0.012, -Math.cos(a) * 0.23, 1, 0.75, 0.8, 6, 4); } // fringe
      for (const [x, z] of [[-0.1, -0.05], [0.08, 0.02], [0, 0.12]]) r.ball(head, I.BLACK, 0.08, x, HY + 0.22, z, 1, 0.6, 1, 6, 4); // a messy top
      crown += 0.04;
      break;
    }
    case 9: { // Unipcs: a round glossy yellow robot, two antennas, chrome headphones, a dark visor stripe, big eyes, a speaker on the chest, spring knees
      for (const [l, s] of LEGS) {
        r.limb(l, I.BLACK, 0.045, 0.045, fr.thigh, 0, 6);
        for (let k = 0; k < 3; k++) r.cyl(l, I.GRAPHITE, 0.074, 0.074, 0.035, 0, -0.07 - k * 0.12, 0, 0, 0, 0, 8);
        r.ball(s, I.GRAPHITE, 0.07, 0, 0, 0);
        r.limb(s, I.YELLOW, 0.095, 0.115, fr.shin - 0.08, -0.03, 10);
        r.ball(s, I.YELLOW, 0.13, 0, -fr.shin + 0.08, -0.04, 1, 0.62, 1.3, 10, 6);
        r.cyl(s, I.BLACK, 0.122, 0.122, 0.025, 0, -fr.shin + 0.035, -0.04, 0, 0, 0, 10, 1.3);
      }
      r.cyl(pelvis, I.GRAPHITE, 0.16, 0.16, 0.12, 0, 0.02, 0, 0, 0, 0, 10);
      r.cyl(torso, I.YELLOW, 0.27, 0.25, 0.34, 0, 0.27, 0, 0, 0, 0, 12, 0.82);
      r.ball(torso, I.YELLOW, 0.27, 0, 0.44, 0, 1, 0.36, 0.82, 12, 5);
      r.ball(torso, I.YELLOW, 0.25, 0, 0.1, 0, 1, 0.32, 0.82, 12, 5);
      r.put(torso, I.GRAPHITE, new THREE.TorusGeometry(0.1, 0.024, 4, 14), 0, 0.28, -0.205);
      r.cyl(torso, I.BLACK, 0.09, 0.09, 0.03, 0, 0.28, -0.2, Math.PI / 2, 0, 0, 14);
      r.cyl(torso, I.YELLOW, 0.035, 0.035, 0.03, 0, 0.28, -0.215, Math.PI / 2, 0, 0, 10);
      for (const [a, f] of ARMS) {
        r.ball(a, I.YELLOW, 0.1, 0, -0.01, 0, 1, 1, 1, 10, 7);
        for (const y of [-0.08, -0.11]) r.cyl(a, I.GRAPHITE, 0.058, 0.058, 0.022, 0, y, 0, 0, 0, 0, 8);
        r.limb(a, I.YELLOW, 0.072, 0.068, fr.upper - 0.12, -0.12, 8);
        r.ball(f, I.GRAPHITE, 0.06, 0, 0, 0);
        r.limb(f, I.YELLOW, 0.078, 0.07, fr.fore - 0.1, -0.02, 8);
        r.cyl(f, I.GRAPHITE, 0.055, 0.055, 0.03, 0, -fr.fore + 0.07, 0, 0, 0, 0, 8);
        r.ball(f, I.GRAPHITE, 0.06, 0, -fr.fore + 0.01, 0, 1, 1.2, 0.9);
      }
      for (const y of [0.0, 0.05]) r.cyl(head, I.GRAPHITE, 0.085, 0.085, 0.03, 0, y, 0, 0, 0, 0, 10);
      const RX = 1.13, RY = 0.92, RH = 0.27, CY = 0.29; // a wide round head
      r.ball(head, I.YELLOW, RH, 0, CY, 0, RX, RY, 1, 14, 9);
      const hz = (x: number, dy: number) => -Math.sqrt(Math.max(0, RH * RH - (x / RX) ** 2 - (dy / RY) ** 2));
      r.put(head, I.BLACK, new THREE.CylinderGeometry(RH * 0.93, RH * 0.95, 0.045, 14, 1, true, Math.PI - 0.95, 1.9), 0, CY + 0.11, 0, 0, 0, 0, RX, 1, 1.02);
      for (const s of [-1, 1]) {
        r.ball(head, I.BLACK, 0.064, s * 0.11, CY - 0.02, hz(0.11, -0.02) + 0.02, 0.85, 1.05, 0.45);
        r.ball(head, I.WHITE, 0.018, s * 0.11 + 0.022, CY + 0.012, hz(0.11, -0.02) - 0.008);
        r.cyl(head, I.GRAPHITE, 0.115, 0.115, 0.08, s * 0.3, CY, 0.01, 0, 0, Math.PI / 2, 14);
        r.cyl(head, I.BLACK, 0.065, 0.065, 0.085, s * 0.3, CY, 0.01, 0, 0, Math.PI / 2, 10);
        r.cyl(head, I.GRAPHITE, 0.009, 0.009, 0.22, s * 0.06, CY + RH * RY + 0.07, 0.02, 0, 0, 0, 4);
        r.ball(head, I.GRAPHITE, 0.022, s * 0.06, CY + RH * RY + 0.19, 0.02);
      }
      r.ball(head, I.BLACK, 0.012, 0, CY - 0.07, hz(0, -0.07) - 0.002);
      r.put(head, I.BLACK, new THREE.TorusGeometry(0.04, 0.009, 4, 10, Math.PI), 0, CY - 0.1, hz(0, -0.11) + 0.002, 0, 0, Math.PI, 1, 0.7, 1);
      crown = fr.hip + fr.neck + CY + RH * RY + 0.3;
      break;
    }
    case 10: { // Alon: straight grey hair to the shoulders, a yellow and black cycling cap with a coiled snake, big white round shades, a flat mouth, a white STOP BEING POOR tank top
      legs(I.BLACK, I.SKIN, I.WHITE, I.BLACK, { cuff: I.WHITE });
      for (const [l] of LEGS) r.cyl(l, I.BLACK, 0.112, 0.112, 0.06, 0, -fr.thigh + 0.06, 0, 0, 0, 0, 10); // shorts' hems
      chest(I.WHITE, { dome: I.SKIN });
      for (const s of [-1, 1]) r.box(torso, I.WHITE, 0.07, 0.035, 0.3, s * 0.12, 0.575, 0);
      // STOP / BEING / POOR, printed in black pixels
      ['STOP', 'BEING', 'POOR'].forEach((word, row) => {
        const px = 0.0105, gap = 0.012, w = word.length * 3 * px + (word.length - 1) * gap, y0 = 0.46 - row * 0.078;
        [...word].forEach((ch, k) => {
          const gl = GLYPHS[ch];
          for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) {
            if (gl[j * 3 + i] !== '1' || (i > 0 && gl[j * 3 + i - 1] === '1')) continue;
            let n = 1; while (i + n < 3 && gl[j * 3 + i + n] === '1') n++; // a run of pixels is one quad
            const x = -w / 2 + k * (3 * px + gap) + (i + n / 2) * px, y = y0 - j * px * 1.3;
            r.put(torso, I.BLACK, new THREE.PlaneGeometry(px * n + 0.001, px * 1.32), x, y, front(y, x) - 0.004);
          }
        });
      });
      arms(I.WHITE, 0, I.SKIN, I.SKIN);
      skull(I.SKIN);
      for (const s of [-1, 1]) {
        r.put(head, I.WHITE, new THREE.TorusGeometry(0.068, 0.02, 4, 12), s * 0.1, HY - 0.005, zf(0.1, 0) - 0.016);
        r.cyl(head, I.BLACK, 0.064, 0.064, 0.012, s * 0.1, HY - 0.005, zf(0.1, 0) - 0.008, Math.PI / 2, 0, 0, 12);
        r.box(head, I.BLACK, 0.08, 0.018, 0.02, s * 0.1, HY + 0.1, zf(0.1, 0.1) + 0.006);
      }
      r.box(head, I.WHITE, 0.06, 0.022, 0.025, 0, HY + 0.015, zf(0, 0.015) - 0.018);
      r.box(head, I.BLACK, 0.07, 0.02, 0.02, 0, HY - 0.12, zf(0, -0.12) + 0.004);
      nose(I.SKIN, -0.06, 0.026);
      curtain(I.GRAPHITE, 0.252, 0.3, 0.42, -0.09, 0.62, 0.012);
      for (const s of [-1, 1]) r.box(head, I.GRAPHITE, 0.05, 0.3, 0.035, s * 0.175, HY - 0.06, -0.16, 0, s * 0.5, -s * 0.06); // strands framing the face
      for (const [phi, ink] of [[Math.PI / 2, I.YELLOW], [Math.PI * 1.5, I.BLACK]] as const) r.put(head, ink, new THREE.SphereGeometry(0.266, 12, 5, phi, Math.PI, 0, Math.PI * 0.45), 0, HY + 0.08, 0);
      r.cyl(head, I.YELLOW, 0.27, 0.27, 0.085, 0, HY + 0.155, 0, 0, 0, 0, 16);
      peak(I.YELLOW, 0.13, 0.125, -0.25, 0.55);
      r.put(head, I.BLACK, new THREE.TorusGeometry(0.035, 0.011, 4, 12), 0.1, HY + 0.25, zf(0.1, 0.17, 0.266) - 0.005, 0.7); // the coiled snake
      r.ball(head, I.BLACK, 0.017, 0.13, HY + 0.28, zf(0.13, 0.2, 0.266) - 0.004);
      crown += 0.1;
      break;
    }
    case 0:
    default: { // Scribble: a hoodie (its colour changes player to player), jeans, a beanie with a pom-pom, a backpack
      legs(I.BLUE, I.BLUE, I.GRAPHITE, I.WHITE);
      chest(suit);
      r.box(torso, suit, 0.26, 0.11, 0.03, 0, 0.17, front(0.17) - 0.004);
      r.put(torso, suit, new THREE.TorusGeometry(0.13, 0.055, 6, 10, Math.PI), 0, 0.565, 0.0, Math.PI / 2 - 0.3); // the hood, bunched behind the neck
      for (const s of [-1, 1]) r.box(torso, I.WHITE, 0.014, 0.13, 0.014, s * 0.045, 0.45, front(0.45, 0.045) - 0.008);
      r.box(torso, hat, 0.34, 0.38, 0.15, 0, 0.32, 0.215); r.box(torso, hat, 0.35, 0.09, 0.17, 0, 0.5, 0.215); r.box(torso, I.GRAPHITE, 0.2, 0.06, 0.02, 0, 0.24, 0.297);
      arms(suit, 1, I.SKIN, I.SKIN, { cuff: suit });
      skull(I.SKIN);
      eyes(); brows(0.065, -0.06);
      nose(I.SKIN);
      smile(0.06);
      dome(hat, 0.256, Math.PI * 0.5, 0.08, 0, 1, 1.05, 1);
      r.cyl(head, hat, 0.264, 0.262, 0.08, 0, HY + 0.11, 0, 0, 0, 0, 16);
      r.ball(head, hat, 0.08, 0, HY + 0.37, 0, 1, 1, 1, 8, 6);
      crown += 0.18;
      break;
    }
  }
  const L: Look = { geo: r.geometry(true), fr, crownY: crown, nod, hat: skin === 0 ? hat : [I.RED, I.BLUE, I.RED, I.ORANGE, I.BLACK, I.BROWN, I.GREEN, I.ORANGE, I.BLACK, I.YELLOW, I.YELLOW][skin] ?? hat };
  looks.set(key, L);
  return L;
}

// the kill leader's crown, one mesh
let crownGeo: THREE.BufferGeometry | null = null;
function crownGeometry() {
  if (crownGeo) return crownGeo;
  const r = new Rig(), gold = I.ORANGE;
  r.append(new THREE.CylinderGeometry(0.22, 0.2, 0.12, 10, 1, true), new THREE.Matrix4(), gold, 0);
  for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; r.append(new THREE.ConeGeometry(0.05, 0.16, 4), new THREE.Matrix4().setPosition(Math.cos(a) * 0.2, 0.12, Math.sin(a) * 0.2), gold, 0); r.append(new THREE.SphereGeometry(0.03, 6, 4), new THREE.Matrix4().setPosition(Math.cos(a) * 0.21, 0.0, Math.sin(a) * 0.21), I.RED, 0); }
  return (crownGeo = r.geometry(false));
}

export interface Figure {
  root: THREE.Group; body: THREE.SkinnedMesh;
  pelvis: THREE.Bone; torso: THREE.Bone; head: THREE.Bone;
  armL: THREE.Bone; foreL: THREE.Bone; armR: THREE.Bone; foreR: THREE.Bone;
  legL: THREE.Bone; shinL: THREE.Bone; legR: THREE.Bone; shinR: THREE.Bone;
  aim: THREE.Object3D;          // the gun's mount on the torso, pitched with the aim
  hand: THREE.Mesh;             // what is in hand (a gun or the pickaxe), one mesh whose geometry is swapped
  held: string | null;          // which: 'ar|2', 'axe|0', or nothing
  chute: THREE.Group; crown: THREE.Mesh;
  phase: number; lastX: number; lastY: number; lastZ: number; speed: number; vy: number; air: number; hips: number;
  hip: number; look: Look;
}

// skin: 0 Scribble (beanie), 1 Crayon Knight (helmet and plume), 2 Ink Ninja (mask, headband),
// 3 Robo Pen (box head, antenna), 4 Captain Blot (tricorn, eyepatch, red coat), 5 Chill House (a house for
// a head), 6 Cupsey (a plush gumdrop), 7 Retardio (clown face, orange bob, black cap), 8 Kimchi (bowl cut,
// cream tee, silver chain), 9 Unipcs (a round yellow robot with headphones), 10 Alon (grey hair, cycling
// cap, white shades, STOP BEING POOR). Every one has the same bones, so they all run, aim, glide, ride and
// fall the same way.
export function buildFigure(ink: InkRenderer, id: number, skin = id % SKINS.length): Figure {
  const L = lookOf(skin, id), fr = L.fr, rest = restOf(fr);
  const root = new THREE.Group();
  const bones = BONES.map((n, i) => { const b = new THREE.Bone(); b.name = n; b.position.set(...rest[i]); return b; });
  bones.forEach((b, i) => (PARENT[i] < 0 ? root : bones[PARENT[i]]).add(b));
  const mat = ink.material(INK_VERTEX);
  const body = new THREE.SkinnedMesh(L.geo, mat);
  body.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.8); // generous: it covers every pose, lying down included
  root.add(body);
  root.updateMatrixWorld(true);
  body.bind(new THREE.Skeleton(bones));
  const [pelvis, torso, head, armL, foreL, armR, foreR, legL, shinL, legR, shinR] = bones;
  const aim = new THREE.Object3D(); aim.position.set(...fr.aim); torso.add(aim);
  const hand = new THREE.Mesh(heldGeometry('pistol', 0), mat);

  // the glider for the drop: a folded paper wing over your head, in your colours (attached while gliding only)
  const chute = buildGlider(ink.material(INK_IDS.PAPER), ink.material(L.hat), ink.material(INK_IDS.GRAPHITE));
  const crown = new THREE.Mesh(crownGeometry(), mat); crown.position.y = L.crownY; // attached for the kill leader only

  return { root, body, pelvis, torso, head, armL, foreL, armR, foreR, legL, shinL, legR, shinR, aim, hand, held: null, chute, crown,
    phase: 0, lastX: 0, lastY: 0, lastZ: 0, speed: 0, vy: 0, air: 0, hips: 0, hip: fr.hip, look: L };
}

// every bone back to standing straight
function rest(f: Figure) {
  for (const b of [f.pelvis, f.torso, f.head, f.armL, f.foreL, f.armR, f.foreR, f.legL, f.shinL, f.legR, f.shinR]) b.quaternion.identity();
  f.pelvis.position.y = f.hip;
}

// two-bone IK in the torso's space: the hand (the end of the forearm) on t, the elbow bending toward pole
const DOWN = new THREE.Vector3(0, -1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function reach(up: THREE.Bone, fore: THREE.Bone, a: number, b: number, t: THREE.Vector3, pole: THREE.Vector3) {
  const d = _a.copy(t).sub(up.position);
  const len = Math.min(Math.max(d.length(), Math.abs(a - b) + 0.02), a + b - 0.003);
  d.normalize();
  const cos = (a * a + len * len - b * b) / (2 * a * len), sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  const n = _b.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
  const e = _c.copy(d).multiplyScalar(a * cos).addScaledVector(n, a * sin); // the elbow, from the shoulder
  up.quaternion.setFromUnitVectors(DOWN, _d.copy(e).normalize());
  const h = _d.copy(d).multiplyScalar(len).sub(e).normalize().applyQuaternion(_qa.copy(up.quaternion).invert());
  fore.quaternion.setFromUnitVectors(DOWN, h);
}
const POLE_R = new THREE.Vector3(0.7, -1, 0.3), POLE_L = new THREE.Vector3(-0.5, -1, 0.1), POLE_UP_R = new THREE.Vector3(1, 0.2, 0.4), POLE_UP_L = new THREE.Vector3(-1, 0.2, 0.4);
const _t = new THREE.Vector3(), _x = new THREE.Vector3(1, 0, 0), _y = new THREE.Vector3(0, 1, 0);
// where each hand goes on what it holds, in the held model's space: the grip, and the other hand
// (null: one-handed). Long guns: the left hand on the handguard
const SUPPORT: Partial<Record<WeaponId | 'axe', number | null>> = { pistol: -0.05, wand: null, blade: 0.13, axe: -0.22 };

// the held model on the aim mount, and the arms reaching for it; the head and the gun keep looking where
// the player aims however the body is turned or leaning
// swing: a pickaxe swing in progress (1 just started .. 0 done): up over the shoulder, then chopped down in front
function holdAndAim(f: Figure, what: WeaponId | 'axe' | null, level: number, pitch: number, swing = 0) {
  const fr = f.look.fr;
  // the aim, undoing the torso's own turn and lean so the gun points where the player looks
  _qb.copy(f.pelvis.quaternion).multiply(f.torso.quaternion).invert();
  if (f.look.nod) f.head.quaternion.copy(_qb).multiply(_qa.setFromAxisAngle(_x, pitch * f.look.nod));
  if (!what) { hold(f, null); return; }
  f.aim.quaternion.copy(_qb).multiply(_qa.setFromAxisAngle(_x, pitch));
  if (what === 'axe' && swing > 0) {
    const u = 1 - swing, chop = u < 0.3 ? 1.5 * (u / 0.3) : 1.5 - 2.3 * ((u - 0.3) / 0.7); // the arms follow the pick (they reach for its grip)
    f.aim.quaternion.multiply(_qa.setFromAxisAngle(_x, chop));
  }
  const key = `${what}|${what === 'axe' ? 0 : level}`;
  if (f.held !== key) {
    f.hand.geometry = heldGeometry(what, level);
    f.hand.scale.setScalar(what === 'axe' ? 1.25 : 1.1);
    f.hand.position.set(0, -0.02, what === 'axe' ? -0.16 : -0.2);
    f.hand.rotation.set(what === 'blade' ? 0.95 : what === 'axe' ? 0.75 : 0, 0, 0);
    hold(f, key);
  }
  f.aim.updateMatrix(); f.hand.updateMatrix();
  // right hand on the grip
  reach(f.armR, f.foreR, fr.upper, fr.fore, _t.set(0, -0.075, 0.035).applyMatrix4(f.hand.matrix).applyMatrix4(f.aim.matrix), POLE_R);
  const sup = what in SUPPORT ? SUPPORT[what] : Math.max(-0.36, (f.hand.geometry.boundingBox?.min.z ?? -0.4) * 0.42);
  if (sup === null || sup === undefined) { f.armL.rotation.set(0.25, 0, -0.1); f.foreL.rotation.x = 0.5; return; }
  reach(f.armL, f.foreL, fr.upper, fr.fore, _t.set(-0.02, what === 'pistol' ? -0.1 : -0.04, sup).applyMatrix4(f.hand.matrix).applyMatrix4(f.aim.matrix), POLE_L);
}
function hold(f: Figure, key: string | null) {
  if (key === f.held && (!!key === !!f.hand.parent)) return;
  f.held = key;
  attachIf(f.aim, f.hand, !!key);
}

// a body left where a player fell: flat on its back, arms out, nothing in hand. Feet stay on the
// spot, the body lies back from where they faced
export function poseCorpse(f: Figure, yaw: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  g.rotation.y = yaw;
  hold(f, null);
  rest(f);
  f.root.position.set(0, 0.16, 0); f.root.rotation.set(Math.PI / 2, 0, 0);
  const k = (seed % 7) / 7;
  f.armL.rotation.set(0.2, 0, -1.1 - k * 0.6); f.foreL.rotation.set(0.5 * k, 0, -0.3);
  f.armR.rotation.set(0.2, 0, 1.1 + (1 - k) * 0.6); f.foreR.rotation.set(0.5 * (1 - k), 0, 0.3);
  f.legL.rotation.set(0, 0, -0.12 - k * 0.15); f.legR.rotation.set(0, 0, 0.12 + (1 - k) * 0.15);
  f.shinL.rotation.x = -0.15 * k; f.shinR.rotation.x = -0.3 * (1 - k);
  f.head.rotation.set(0, (k - 0.5) * 1.4, 0);
  g.add(f.root);
  return g;
}

// standing at ease, arms loose at the sides (the lobby's character picker)
export function poseStand(f: Figure) {
  hold(f, null);
  rest(f);
  f.armL.rotation.set(0.05, 0, -0.14); f.foreL.rotation.x = 0.22;
  f.armR.rotation.set(0.05, 0, 0.14); f.foreR.rotation.x = 0.22;
  f.legL.rotation.z = -0.04; f.legR.rotation.z = 0.04;
}

// the posed body as a plain geometry in the figure's space (aInk per vertex), for pictures
export function posedGeometry(f: Figure): THREE.BufferGeometry {
  f.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(f.root.matrixWorld).invert(), sk = f.body.skeleton;
  const mats = sk.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(inv, b.matrixWorld).multiply(sk.boneInverses[i]));
  const nms = mats.map((m) => new THREE.Matrix3().getNormalMatrix(m));
  const src = f.body.geometry, si = src.getAttribute('skinIndex');
  const g = new THREE.BufferGeometry();
  const p = (src.getAttribute('position').array as Float32Array).slice(), n = (src.getAttribute('normal').array as Float32Array).slice();
  for (let i = 0; i < si.count; i++) {
    const b = si.getX(i);
    _v.fromArray(p, i * 3).applyMatrix4(mats[b]).toArray(p, i * 3);
    _v.fromArray(n, i * 3).applyMatrix3(nms[b]).normalize().toArray(n, i * 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setAttribute('aInk', src.getAttribute('aInk'));
  g.setIndex(src.getIndex());
  return g;
}

// pose a figure for this frame from its interpolated state
export function poseFigure(f: Figure, x: number, y: number, z: number, yaw: number, pitch: number, weapon: WeaponId | null, sliding: boolean, gliding: boolean, leader: boolean, dt: number, down = false, axe = false, level = 0, swing = 0) {
  const dx = x - f.lastX, dz = z - f.lastZ, moved = Math.hypot(dx, dz), warp = Math.abs(y - f.lastY) > 4 || moved > 6; // a teleport, a respawn
  const k = Math.min(1, dt * 10);
  f.speed += ((dt > 0 && !warp ? moved / dt : 0) - f.speed) * k;
  f.vy += ((dt > 0 && !warp ? (y - f.lastY) / dt : 0) - f.vy) * Math.min(1, dt * 12);
  f.lastX = x; f.lastY = y; f.lastZ = z;
  f.root.position.set(x, y, z);
  f.root.rotation.set(0, yaw, 0); // (a ride tilts the whole figure with the vehicle)
  attachIf(f.root, f.chute, gliding);
  attachIf(f.root, f.crown, leader);
  if (leader) f.crown.rotation.y += dt * 1.5;
  rest(f);
  const fr = f.look.fr;
  // in the air: rising or falling faster than any stairs or slope
  f.air += ((!gliding && !sliding && !down && (f.vy > 2.2 || f.vy < -4) ? 1 : 0) - f.air) * Math.min(1, dt * 10);
  const run = Math.min(1, f.speed / 7) * (1 - f.air);
  // which way the legs run: the hips turn toward a strafe, a backpedal runs the cycle backwards
  let hipT = 0, dir = 1;
  if (moved > 1e-4 && f.speed > 1) {
    const fwd = -(dx * Math.sin(yaw) + dz * Math.cos(yaw)) / moved, side = (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / moved;
    const m = Math.atan2(side, fwd);
    if (Math.abs(m) <= Math.PI / 2 + 0.2) hipT = -m; else { dir = -1; hipT = -(m - Math.sign(m) * Math.PI); }
  }
  f.hips += (Math.max(-1, Math.min(1, hipT)) - f.hips) * Math.min(1, dt * 8);
  f.phase += dt * (2.2 + f.speed * 1.45) * dir;
  const s = Math.sin(f.phase), c = Math.cos(f.phase);

  if (down) { // knocked: flat on the belly, crawling on the elbows, chin up, no gun
    const cr = Math.min(1, f.speed / 2);
    f.pelvis.position.y = 0.2; f.pelvis.rotation.x = -1.45;
    f.torso.rotation.x = 0.12;
    f.legL.rotation.set(-0.05 + s * 0.25 * cr, 0, -0.12); f.shinL.rotation.x = -0.25 - Math.max(0, s) * 0.7 * cr;
    f.legR.rotation.set(-0.05 - s * 0.25 * cr, 0, 0.12); f.shinR.rotation.x = -0.25 - Math.max(0, -s) * 0.7 * cr;
    f.head.rotation.x = 1.15;
    hold(f, null);
    for (const [up, fo, side, ph] of [[f.armL, f.foreL, -1, s], [f.armR, f.foreR, 1, -s]] as const)
      reach(up, fo, fr.upper, fr.fore, _t.set(side * 0.24, fr.shY + 0.22 + ph * 0.1 * cr, -0.26), side < 0 ? POLE_UP_L : POLE_UP_R);
    return;
  }
  if (gliding) { // hanging under the chute: hands up on the lines, legs dangling
    const sw = Math.sin(f.phase * 0.6);
    f.torso.rotation.x = -0.12;
    f.legL.rotation.set(0.3 + sw * 0.12, 0, -0.14); f.shinL.rotation.x = -0.55 - sw * 0.1;
    f.legR.rotation.set(0.08 - sw * 0.12, 0, 0.14); f.shinR.rotation.x = -0.3 + sw * 0.1;
    holdAndAim(f, null, 0, 0);
    reach(f.armL, f.foreL, fr.upper, fr.fore, _t.set(-0.3, fr.shY + 0.5, 0.0), POLE_UP_L);
    reach(f.armR, f.foreR, fr.upper, fr.fore, _t.set(0.3, fr.shY + 0.5, 0.0), POLE_UP_R);
    return;
  }
  const what = axe ? 'axe' as const : weapon;
  if (sliding) { // a slide (or going over a ledge): low, leaning back, the front leg out straight
    f.pelvis.position.y = f.hip * 0.5;
    f.torso.rotation.x = 0.42;
    f.legL.rotation.x = 1.4; f.shinL.rotation.x = -0.08;
    f.legR.rotation.set(0.45, 0, 0.3); f.shinR.rotation.x = -1.9;
  } else {
    // run cycle: thighs swing, the knee folds as the leg comes through; idle: feet apart, knees soft
    const knee = 0.06 + 0.06 * (1 - run);
    f.legL.rotation.set(s * 0.8 * run, 0, -0.05 * (1 - run)); f.shinL.rotation.x = -(knee + Math.max(0, c * dir) * 1.15 * run);
    f.legR.rotation.set(-s * 0.8 * run, 0, 0.05 * (1 - run)); f.shinR.rotation.x = -(knee + Math.max(0, -c * dir) * 1.15 * run);
    if (f.air > 0.01) { // tucked going up, reaching for the ground coming down
      const up = f.vy > 0, a = f.air;
      f.legL.rotation.x += ((up ? 0.95 : 0.45) - f.legL.rotation.x) * a; f.shinL.rotation.x += ((up ? -1.35 : -0.5) - f.shinL.rotation.x) * a;
      f.legR.rotation.x += ((up ? 0.2 : -0.15) - f.legR.rotation.x) * a; f.shinR.rotation.x += ((up ? -0.6 : -0.25) - f.shinR.rotation.x) * a;
    }
    f.pelvis.position.y = f.hip - 0.015 * (1 - run) + Math.abs(c) * 0.05 * run - f.air * 0.04;
    f.pelvis.rotation.y = f.hips * run;
    f.torso.rotation.set(-0.14 * run, -f.hips * run, 0);
  }
  // shouldering a long gun turns the body a little side-on
  if (what && what !== 'pistol' && what !== 'wand' && !sliding) _qa.setFromAxisAngle(_y, -0.22), f.torso.quaternion.premultiply(_qa);
  holdAndAim(f, what, level, pitch, swing);
  if (!what) { // empty hands: arms swing against the legs
    f.armL.rotation.set(-s * 0.55 * run + 0.05, 0, -0.12); f.foreL.rotation.x = 0.3 + 0.5 * run;
    f.armR.rotation.set(s * 0.55 * run + 0.05, 0, 0.12); f.foreR.rotation.x = 0.3 + 0.5 * run;
  }
}

// someone riding: sat at a seat (hips at `at`, world space), turned and tilted with the vehicle (q) or,
// a passenger, facing where they aim. Drivers keep both hands on the bars or the wheel; passengers hold
// their gun up (they can shoot)
export function poseRider(f: Figure, at: THREE.Vector3, q: THREE.Quaternion | null, yaw: number, pitch: number, legs: number, drive: boolean, weapon: WeaponId | null, leader: boolean, dt: number, level = 0) {
  f.root.position.set(at.x, at.y - f.hip, at.z);
  if (q) f.root.quaternion.copy(q); else f.root.rotation.set(0, yaw, 0);
  attachIf(f.root, f.chute, false);
  attachIf(f.root, f.crown, leader);
  if (leader) f.crown.rotation.y += dt * 1.5;
  f.speed = 0; f.lastX = at.x; f.lastY = at.y - f.hip; f.lastZ = at.z; f.vy = 0; f.air = 0;
  rest(f);
  const fr = f.look.fr, th = Math.min(1.55, legs + 0.1), spread = legs > 1.25 && legs < 1.4 ? 0.4 : 0.12; // astride a plane: knees apart
  f.legL.rotation.set(th, 0, -spread); f.legR.rotation.set(th, 0, spread);
  f.shinL.rotation.x = f.shinR.rotation.x = -Math.max(0.2, th - 0.25) * 0.9;
  f.torso.rotation.x = drive ? -0.2 : 0;
  if (drive) {
    holdAndAim(f, null, 0, pitch * 0.3);
    for (const [up, fo, side] of [[f.armL, f.foreL, -1], [f.armR, f.foreR, 1]] as const)
      reach(up, fo, fr.upper, fr.fore, _t.set(side * 0.19, fr.shY - 0.14, -0.42), side < 0 ? POLE_L : POLE_R);
  } else holdAndAim(f, weapon, level, pitch);
}

// a flat triangle (or a strip of them) from a flat list of corners: paper is folded, not modelled
const sheet = (pts: number[], m: Mat) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); g.computeVertexNormals(); return new THREE.Mesh(g, m); };
type V3 = [number, number, number];
const lerp3 = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
// a ruled ink line across a paper panel (a, b, c): from the a-b edge to the a-c edge at k, lifted off the paper
const ruled = (a: V3, b: V3, c: V3, k: number, w: number, lift: number, m: Mat) => {
  const p0 = lerp3(a, b, k), p1 = lerp3(a, c, k), q0 = lerp3(a, b, k + w), q1 = lerp3(a, c, k + w);
  return sheet([...p0, ...p1, ...q1, ...p0, ...q1, ...q0].map((v, i) => (i % 3 === 1 ? v + lift : v)), m);
};

// the hang glider you drop on: a paper dart wing with a fold down the middle and a band of your ink along
// its leading edges, held up by an A-frame; the bar sits where the hands reach overhead (poseFigure)
export function buildGlider(paper: Mat, ink: Mat, dark: Mat): THREE.Group {
  const g = new THREE.Group();
  const nose: V3 = [0, 2.78, -1.15], tail: V3 = [0, 2.6, 0.75], keel: V3 = [0, 2.4, 0.55], tipL: V3 = [-1.85, 2.95, 0.95], tipR: V3 = [1.85, 2.95, 0.95];
  g.add(sheet([...nose, ...tipL, ...tail, ...nose, ...tail, ...tipR], paper), sheet([...nose, ...tail, ...keel], paper)); // wings, the keel fold
  for (const tip of [tipL, tipR]) { // a band of ink along each leading edge, and a doodled stripe behind it
    const band = lerp3(nose, tail, 0.22);
    g.add(sheet([...nose, ...tip, ...band].map((v, i) => (i % 3 === 1 ? v + 0.02 : v)), ink));
    g.add(ruled(nose, tip, tail, 0.62, 0.07, 0.02, ink));
  }
  for (const x of [-0.42, 0.42]) { const s = box(0.04, 0.95, 0.04, dark, x * 0.55, 2.32, -0.18); s.rotation.z = x > 0 ? -0.22 : 0.22; g.add(s); } // A-frame
  g.add(box(0.9, 0.05, 0.05, dark, 0, 1.86, -0.12)); // the bar in your hands
  return g;
}

// the drop's paper plane: a giant folded dart of notebook paper, nose toward -z, origin on its fold, with the
// notebook's blue rules and red margin drawn across the wings
export function buildPaperPlane(ink: InkRenderer): THREE.Group {
  const g = new THREE.Group(), paper = ink.material(INK_IDS.PAPER), blue = ink.material(INK_IDS.BLUE), red = ink.material(INK_IDS.RED);
  const L = 36, nose: V3 = [0, 0, -L / 2], tail: V3 = [0, 0, L / 2];
  const keelL: V3 = [-0.5, -4.6, L / 2 - 1.5], keelR: V3 = [0.5, -4.6, L / 2 - 1.5];
  for (const s of [-1, 1]) {
    const mid: V3 = [s * 6, 0.5, L / 2], tip: V3 = [s * 14, 2.6, L / 2 - 0.5];
    g.add(sheet([...nose, ...tail, ...mid], paper), sheet([...nose, ...mid, ...tip], paper));        // the wing: two panels, a crease between
    g.add(sheet([...nose, ...tail, ...(s < 0 ? keelL : keelR)], paper));                              // the keel: two layers, folded down
    for (let k = 0.3; k < 0.95; k += 0.11) g.add(ruled(nose, mid, tip, k, 0.012, 0.04, blue));       // notebook rules
    g.add(ruled(nose, tail, mid, 0.82, 0.012, 0.04, red));                                             // the margin
  }
  return g;
}

// free fall out of the plane: flat on your belly, arms and legs spread, a little flutter (after poseFigure)
export function poseFall(f: Figure, yaw: number, t: number) {
  attachIf(f.root, f.chute, false);
  f.root.rotation.set(-1.25, yaw, Math.sin(t * 2.3) * 0.08, 'YXZ');
  f.root.position.y += 1.0;
  const w = Math.sin(t * 9) * 0.08;
  f.armL.rotation.set(0.9 + w, -1.1, 0); f.armR.rotation.set(0.9 - w, 1.1, 0);
  f.legL.rotation.set(-0.35 - w, 0, -0.35); f.legR.rotation.set(-0.35 + w, 0, 0.35);
  f.torso.rotation.x = 0; f.head.rotation.x = -0.6;
}
