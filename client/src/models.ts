// Doodle models built from primitives. The ink renderer outlines and hatches them, so a handful
// of boxes and cylinders reads as a hand-drawn figure. Nothing here is loaded from files.
import * as THREE from 'three';
import { WEAPON_IDS, type WeaponId } from '../../shared/src/constants.ts';
import { INK_IDS, type InkRenderer } from './ink.ts';

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

export interface GunMats { body: Mat; dark: Mat; accent: Mat }

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
  return g;
}

// ---------------- loot, cases, gadgets ----------------
export function buildItem(what: string, ink: InkRenderer): THREE.Group {
  const g = new THREE.Group();
  const blue = ink.material(INK_IDS.BLUE), dark = ink.material(INK_IDS.GRAPHITE), red = ink.material(INK_IDS.RED), paper = ink.material(INK_IDS.PAPER), orange = ink.material(INK_IDS.ORANGE), green = ink.material(INK_IDS.GREEN);
  if (what === 'mini' || what === 'big') {
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
  if (kind === 0) { // car: a boxy hatchback with a roll bar (drive-by friendly) and big wheels
    root.add(box(2.1, 0.6, 4.2, paint, 0, 0.75, 0), box(1.9, 0.12, 1.2, dark, 0, 1.12, -1.4)); // body, bonnet stripe
    root.add(box(1.9, 0.5, 1.5, paint, 0, 1.3, 0.55), box(1.8, 0.42, 0.06, paper, 0, 1.32, -0.24)); // cabin, windscreen
    root.add(box(1.7, 0.08, 0.08, dark, 0, 1.6, 1.25), box(0.3, 0.2, 0.1, ink.material(INK_IDS.RED), 0.75, 0.9, 2.12), box(0.3, 0.2, 0.1, ink.material(INK_IDS.RED), -0.75, 0.9, 2.12));
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
export interface Figure {
  root: THREE.Group; torso: THREE.Group; head: THREE.Group;
  legL: THREE.Group; legR: THREE.Group; armL: THREE.Group; armR: THREE.Group;
  guns: Map<WeaponId, THREE.Group>; axe: THREE.Group; chute: THREE.Group; crown: THREE.Group; // axe: the diamond pickaxe
  phase: number; lastX: number; lastZ: number; speed: number;
  gunMats: GunMats; held: THREE.Group | null; // only what is in hand is in the scene (13 hidden guns cost every frame)
}

const SUIT_INKS = [INK_IDS.RED, INK_IDS.PINK, INK_IDS.ORANGE, INK_IDS.GREEN, INK_IDS.BROWN];
const pivot = (x: number, y: number, z: number, ...kids: THREE.Object3D[]) => { const g = new THREE.Group(); g.position.set(x, y, z); if (kids.length) g.add(...kids); return g; };

// skin: 0 Scribble (beanie), 1 Crayon Knight (helmet and plume), 2 Ink Ninja (mask, headband),
// 3 Robo Pen (box head, antenna), 4 Captain Blot (tricorn, eyepatch, red coat)
export function buildFigure(ink: InkRenderer, id: number, skin = id % 5): Figure {
  const suit = ink.material(skin === 1 ? INK_IDS.GRAPHITE : skin === 2 ? INK_IDS.GRAPHITE : skin === 3 ? INK_IDS.BLUE : skin === 4 ? INK_IDS.RED : SUIT_INKS[id % SUIT_INKS.length]);
  const hatInk = ink.material(skin === 1 ? INK_IDS.BLUE : skin === 2 ? INK_IDS.RED : skin === 3 ? INK_IDS.ORANGE : skin === 4 ? INK_IDS.GRAPHITE : SUIT_INKS[(id * 7 + 2) % SUIT_INKS.length]);
  const dark = ink.material(INK_IDS.GRAPHITE), paper = ink.material(INK_IDS.PAPER);
  const root = new THREE.Group();

  // legs hang from the hips; the pivot swings them
  const leg = () => pivot(0, 0.78, 0, box(0.17, 0.62, 0.2, suit, 0, -0.33, 0), box(0.19, 0.1, 0.28, dark, 0, -0.72, -0.04));
  const legL = leg(), legR = leg();
  legL.position.x = -0.13; legR.position.x = 0.13;

  const torso = pivot(0, 0.78, 0,
    box(0.5, 0.6, 0.3, suit, 0, 0.3, 0),                  // body
    box(0.36, 0.42, 0.16, hatInk, 0, 0.32, 0.22),         // backpack
    box(0.52, 0.08, 0.32, dark, 0, 0.02, 0));             // belt
  // arms reach forward to hold the gun; they pitch with the aim
  const arm = (side: number) => pivot(side * 0.3, 0.55, 0, box(0.13, 0.13, 0.5, suit, 0, -0.03, -0.22), box(0.12, 0.12, 0.12, paper, side * -0.02, -0.03, -0.5));
  const armL = arm(-1), armR = arm(1);
  armL.rotation.y = -0.35; // left hand comes across to the handguard
  const guns = new Map<WeaponId, THREE.Group>(); // built the first time this player holds each one
  const gunMats = { body: ink.material(INK_IDS.BLUE), dark, accent: ink.material(INK_IDS.ORANGE) };
  const axe = intern(buildPickaxe(ink.material(INK_IDS.BROWN), ink.material(INK_IDS.DIAMOND)));
  axe.scale.setScalar(1.3); axe.position.set(0.02, -0.04, -0.4);
  torso.add(armL, armR);

  // head: each character has its own
  const head = pivot(0, 0.66, 0);
  if (skin === 3) { // Robo Pen: a box head, a visor of orange eyes, an antenna
    head.add(box(0.46, 0.4, 0.42, paper, 0, 0.02, 0), box(0.34, 0.1, 0.03, dark, 0, 0.05, -0.215), box(0.08, 0.05, 0.03, hatInk, -0.08, 0.05, -0.235), box(0.08, 0.05, 0.03, hatInk, 0.08, 0.05, -0.235));
    head.add(box(0.03, 0.3, 0.03, dark, 0.12, 0.36, 0), new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), hatInk).translateY(0.52).translateX(0.12));
  } else {
    head.add(new THREE.Mesh(new THREE.SphereGeometry(0.25, 14, 10), skin === 2 ? dark : paper));
    if (skin === 2) head.add(box(0.44, 0.09, 0.05, paper, 0, 0.03, -0.215)); // the ninja's eye slit
    head.add(box(0.05, 0.07, 0.03, dark, -0.09, 0.03, -0.235), box(0.05, 0.07, 0.03, dark, 0.09, 0.03, -0.235));
    if (skin !== 2) head.add(box(0.1, 0.02, 0.03, dark, 0, -0.08, -0.23));
  }
  if (skin === 0) { // Scribble: a beanie with a pom-pom
    const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.265, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), hatInk);
    beanie.position.y = 0.04;
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), hatInk); pom.position.y = 0.32;
    head.add(beanie, pom);
  } else if (skin === 1) { // Crayon Knight: a steel helmet with a visor bar and a plume
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8, 0, Math.PI * 2, 0, Math.PI / 1.7), dark); helm.position.y = 0.02;
    head.add(helm, box(0.36, 0.05, 0.05, dark, 0, -0.02, -0.25), box(0.06, 0.26, 0.3, ink.material(INK_IDS.RED), 0, 0.36, 0.04));
  } else if (skin === 2) { // Ink Ninja: a red headband with tails
    head.add(box(0.53, 0.07, 0.53, hatInk, 0, 0.13, 0), box(0.05, 0.05, 0.3, hatInk, 0.06, 0.1, 0.38), box(0.05, 0.05, 0.26, hatInk, -0.06, 0.06, 0.36));
  } else if (skin === 4) { // Captain Blot: a tricorn hat and an eyepatch
    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.2, 3), hatInk); hat.position.y = 0.22; hat.rotation.y = Math.PI / 6;
    head.add(hat, box(0.16, 0.12, 0.2, hatInk, 0, 0.33, 0), box(0.09, 0.09, 0.03, dark, 0.09, 0.03, -0.245), box(0.3, 0.02, 0.02, dark, 0, 0.1, -0.23));
  }
  torso.add(head);
  root.add(legL, legR, torso);

  // parachute for the drop: a dome and four strings
  const chute = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.6), hatInk);
  dome.position.y = 4.1;
  chute.add(dome);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const s = box(0.03, 2.6, 0.03, dark, sx * 0.8, 2.75, sz * 0.8);
    s.rotation.z = sx * 0.25; s.rotation.x = -sz * 0.25;
    chute.add(s);
  }
  // attached while gliding only

  // kill leader's crown
  const crown = new THREE.Group();
  const gold = ink.material(INK_IDS.ORANGE);
  crown.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.12, 10, 1, true), gold));
  for (let i = 0; i < 5; i++) { const sp = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 4), gold); const a = (i / 5) * Math.PI * 2; sp.position.set(Math.cos(a) * 0.2, 0.12, Math.sin(a) * 0.2); crown.add(sp); }
  crown.position.y = 2.08; // attached for the kill leader only

  intern(root); intern(chute); intern(crown);
  return { root, torso, head, legL, legR, armL, armR, guns, axe, chute, crown, phase: 0, lastX: 0, lastZ: 0, speed: 0, gunMats, held: null };
}

// a body left where a player fell: flat on its back, arms out, nothing in hand. Feet stay on the
// spot, the body lies back from where they faced
export function poseCorpse(f: Figure, yaw: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  g.rotation.y = yaw;
  if (f.held) { f.armR.remove(f.held); f.held = null; }
  f.root.position.set(0, 0.17, 0); f.root.rotation.set(Math.PI / 2, 0, 0);
  f.torso.position.y = 0.78; f.torso.rotation.set(0, 0, 0);
  const k = (seed % 7) / 7;
  f.armL.rotation.set(-1.35, 0, -0.5 - k * 0.6); f.armR.rotation.set(-1.35, 0, 0.5 + (1 - k) * 0.6);
  f.legL.rotation.set(0, 0, 0.12 + k * 0.15); f.legR.rotation.set(0, 0, -0.12 - (1 - k) * 0.15);
  f.head.rotation.set(0, (k - 0.5) * 1.4, 0);
  g.add(f.root);
  return g;
}

// pose a figure for this frame from its interpolated state
export function poseFigure(f: Figure, x: number, y: number, z: number, yaw: number, pitch: number, weapon: WeaponId | null, sliding: boolean, gliding: boolean, leader: boolean, dt: number, down = false, axe = false) {
  const moved = Math.hypot(x - f.lastX, z - f.lastZ);
  f.speed += ((dt > 0 ? moved / dt : 0) - f.speed) * Math.min(1, dt * 10);
  f.lastX = x; f.lastZ = z;
  f.root.position.set(x, y, z);
  f.root.rotation.y = yaw;
  // what is in hand: the pickaxe, the gun, or nothing (gliding, knocked)
  let want: THREE.Group | null = null;
  if (!gliding && !down) {
    if (axe) want = f.axe;
    else if (weapon) {
      let g = f.guns.get(weapon);
      if (!g) { g = intern(buildGun(weapon, f.gunMats)); g.scale.setScalar(1.15); g.position.set(0.02, -0.06, -0.48); f.guns.set(weapon, g); }
      want = g;
    }
  }
  if (want !== f.held) { if (f.held) f.armR.remove(f.held); if (want) f.armR.add(want); f.held = want; }
  attachIf(f.root, f.chute, gliding);
  attachIf(f.root, f.crown, leader);
  if (leader) f.crown.rotation.y += dt * 1.5;

  const run = Math.min(1, f.speed / 7);
  f.phase += dt * (4 + f.speed * 1.4);
  const swing = gliding ? 0.25 : sliding ? 0 : Math.sin(f.phase) * 0.75 * run;
  f.legL.rotation.x = sliding ? 1.3 : swing; // feet first in a slide
  f.legR.rotation.x = sliding ? 1.3 : -swing;
  f.torso.rotation.x = sliding ? 0.55 : run * -0.08;
  f.torso.position.y = sliding ? 0.42 : 0.78 + Math.abs(Math.cos(f.phase)) * 0.04 * run;
  // arms: up holding the chute lines while gliding, otherwise aiming
  const aim = gliding ? 2.6 : pitch;
  f.armL.rotation.x = aim; f.armR.rotation.x = aim;
  f.head.rotation.x = gliding ? 0 : pitch * 0.6;
  if (down) { // knocked: flat on the belly, crawling on the elbows, no gun
    f.torso.rotation.x = 1.35; f.torso.position.y = 0.3;
    f.legL.rotation.x = 1.45 + swing * 0.3; f.legR.rotation.x = 1.45 - swing * 0.3;
    f.armL.rotation.x = 2.4 + swing * 0.5; f.armR.rotation.x = 2.4 - swing * 0.5; f.head.rotation.x = -0.9;
  }
}
