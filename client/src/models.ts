// Doodle models built from primitives. The ink renderer outlines and hatches them, so a handful
// of boxes and cylinders reads as a hand-drawn figure. Nothing here is loaded from files.
import * as THREE from 'three';
import type { WeaponId } from '../../shared/src/constants.ts';
import { INK_IDS, type InkRenderer } from './ink.ts';

type Mat = THREE.Material;
const box = (w: number, h: number, d: number, m: Mat, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); return o; };
// cylinder lying along -z (barrels, scopes)
const tube = (r: number, len: number, m: Mat, x = 0, y = 0, z = 0, seg = 10) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2), m); o.position.set(x, y, z); return o; };

export interface GunMats { body: Mat; dark: Mat; accent: Mat }

// guns are modelled pointing down -z with the grip at the origin, about 1 unit = 1 m
export function buildGun(id: WeaponId, m: GunMats): THREE.Group {
  const g = new THREE.Group();
  const add = (...o: THREE.Object3D[]) => g.add(...o);
  if (id === 'rifle') {
    add(box(0.07, 0.1, 0.42, m.body, 0, 0.02, -0.12));               // receiver
    add(box(0.075, 0.07, 0.24, m.dark, 0, 0.0, -0.42));              // handguard
    add(tube(0.016, 0.22, m.dark, 0, 0.01, -0.64));                  // barrel
    add(box(0.05, 0.05, 0.05, m.dark, 0, 0.01, -0.77));              // muzzle
    const mag = box(0.05, 0.2, 0.08, m.accent, 0, -0.12, -0.16); mag.rotation.x = 0.25; add(mag);
    add(box(0.05, 0.13, 0.06, m.dark, 0, -0.08, 0.04));              // grip
    add(box(0.06, 0.1, 0.22, m.body, 0, 0.0, 0.2));                  // stock
    add(box(0.04, 0.05, 0.1, m.dark, 0, 0.1, -0.1));                 // sight housing
    add(box(0.05, 0.012, 0.012, m.accent, 0, 0.13, -0.1));           // red-dot frame
  } else if (id === 'shotgun') {
    add(box(0.08, 0.1, 0.3, m.body, 0, 0.02, -0.08));
    add(tube(0.024, 0.5, m.dark, 0, 0.04, -0.45));                   // barrel
    add(tube(0.02, 0.38, m.dark, 0, -0.01, -0.4));                   // magazine tube
    add(box(0.07, 0.07, 0.16, m.accent, 0, -0.01, -0.36));           // pump
    add(box(0.05, 0.13, 0.06, m.dark, 0, -0.08, 0.06));
    const stock = box(0.065, 0.11, 0.26, m.body, 0, -0.02, 0.22); stock.rotation.x = -0.12; add(stock);
  } else if (id === 'sniper') {
    add(box(0.06, 0.09, 0.4, m.body, 0, 0.0, -0.1));
    add(tube(0.018, 0.6, m.dark, 0, 0.01, -0.6));                    // long barrel
    add(box(0.045, 0.045, 0.08, m.dark, 0, 0.01, -0.92));            // muzzle brake
    add(tube(0.035, 0.3, m.dark, 0, 0.1, -0.12, 12));                // scope
    add(tube(0.045, 0.05, m.accent, 0, 0.1, -0.3, 12), tube(0.045, 0.05, m.accent, 0, 0.1, 0.04, 12)); // lens bells
    add(box(0.02, 0.05, 0.02, m.dark, 0, 0.055, -0.2), box(0.02, 0.05, 0.02, m.dark, 0, 0.055, -0.04)); // rings
    const bolt = box(0.08, 0.015, 0.015, m.accent, 0.05, 0.03, 0.02); add(bolt);
    add(box(0.05, 0.13, 0.06, m.dark, 0, -0.08, 0.08));
    add(box(0.065, 0.12, 0.3, m.body, 0, -0.01, 0.26));              // stock
    add(box(0.07, 0.04, 0.12, m.accent, 0, 0.06, 0.26));             // cheek rest
    const legA = box(0.012, 0.16, 0.012, m.dark, 0.03, -0.08, -0.5); legA.rotation.z = 0.3; const legB = legA.clone(); legB.position.x = -0.03; legB.rotation.z = -0.3; add(legA, legB);
  } else {
    add(box(0.05, 0.06, 0.22, m.body, 0, 0.03, -0.05));              // slide
    add(box(0.045, 0.04, 0.2, m.dark, 0, -0.015, -0.05));            // frame
    const grip = box(0.045, 0.13, 0.06, m.accent, 0, -0.08, 0.04); grip.rotation.x = -0.2; add(grip);
    add(box(0.01, 0.02, 0.01, m.dark, 0, 0.07, -0.14));
  }
  return g;
}

// ---------------- players ----------------
export interface Figure {
  root: THREE.Group; torso: THREE.Group; head: THREE.Group;
  legL: THREE.Group; legR: THREE.Group; armL: THREE.Group; armR: THREE.Group;
  guns: Map<WeaponId, THREE.Group>; chute: THREE.Group; crown: THREE.Group;
  phase: number; lastX: number; lastZ: number; speed: number;
}

const SUIT_INKS = [INK_IDS.RED, INK_IDS.PINK, INK_IDS.ORANGE, INK_IDS.GREEN, INK_IDS.BROWN];
const pivot = (x: number, y: number, z: number, ...kids: THREE.Object3D[]) => { const g = new THREE.Group(); g.position.set(x, y, z); g.add(...kids); return g; };

export function buildFigure(ink: InkRenderer, id: number): Figure {
  const suit = ink.material(SUIT_INKS[id % SUIT_INKS.length]);
  const hatInk = ink.material(SUIT_INKS[(id * 7 + 2) % SUIT_INKS.length]);
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
  const guns = new Map<WeaponId, THREE.Group>();
  const gunMats = { body: ink.material(INK_IDS.BLUE), dark, accent: ink.material(INK_IDS.ORANGE) };
  for (const w of ['rifle', 'shotgun', 'sniper', 'pistol'] as WeaponId[]) {
    const g = buildGun(w, gunMats);
    g.scale.setScalar(1.15); g.position.set(0.02, -0.06, -0.48); g.visible = false;
    armR.add(g); guns.set(w, g);
  }
  torso.add(armL, armR);

  // head: round, two dot eyes, a beanie with a pom-pom
  const head = pivot(0, 0.66, 0,
    new THREE.Mesh(new THREE.SphereGeometry(0.25, 14, 10), paper),
    box(0.05, 0.07, 0.03, dark, -0.09, 0.03, -0.235), box(0.05, 0.07, 0.03, dark, 0.09, 0.03, -0.235),
    box(0.1, 0.02, 0.03, dark, 0, -0.08, -0.23));
  const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.265, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), hatInk);
  beanie.position.y = 0.04;
  const pom = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), hatInk); pom.position.y = 0.32;
  head.add(beanie, pom);
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
  chute.visible = false;
  root.add(chute);

  // kill leader's crown
  const crown = new THREE.Group();
  const gold = ink.material(INK_IDS.ORANGE);
  crown.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.12, 10, 1, true), gold));
  for (let i = 0; i < 5; i++) { const sp = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 4), gold); const a = (i / 5) * Math.PI * 2; sp.position.set(Math.cos(a) * 0.2, 0.12, Math.sin(a) * 0.2); crown.add(sp); }
  crown.position.y = 2.08; crown.visible = false;
  root.add(crown);

  return { root, torso, head, legL, legR, armL, armR, guns, chute, crown, phase: 0, lastX: 0, lastZ: 0, speed: 0 };
}

// pose a figure for this frame from its interpolated state
export function poseFigure(f: Figure, x: number, y: number, z: number, yaw: number, pitch: number, weapon: WeaponId, sliding: boolean, gliding: boolean, leader: boolean, dt: number) {
  const moved = Math.hypot(x - f.lastX, z - f.lastZ);
  f.speed += ((dt > 0 ? moved / dt : 0) - f.speed) * Math.min(1, dt * 10);
  f.lastX = x; f.lastZ = z;
  f.root.position.set(x, y, z);
  f.root.rotation.y = yaw;
  for (const [w, g] of f.guns) g.visible = w === weapon && !gliding;
  f.chute.visible = gliding;
  f.crown.visible = leader;
  f.crown.rotation.y += dt * 1.5;

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
}
