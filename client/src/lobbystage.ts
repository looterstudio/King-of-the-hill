// The lobby's stage: the real island, drawn live by the game's own ink renderer, and your party
// standing on the paper plane as it circles over it before the drop. Your character idles, cheers
// when picked, and teammates land on the wing when they join. The camera hangs off the plane, so the
// island drifts by behind the lineup. Everything is the game's real models and renderer; the canvas
// runs at the screen's pixel ratio.
import * as THREE from 'three';
import { SKINS } from '../../shared/src/constants.ts';
import type { Game3D } from './game3d.ts';
import { buildFigure, buildPaperPlane, posedGeometry, poseStand, type Figure } from './models.ts';

export interface StageMember { key: string; skin: number; you: boolean }
interface Slot { key: string; skin: number; you: boolean; fig: Figure; x: number; born: number; cheer: number; seed: number; out: number }

const FIG_H = 1.85;
// where each lineup spot stands on the wing (you in the middle, friends either side)
const SPOTS = [0, 1.35, -1.35, 2.7];
const ORBIT_R = 250, ALT = 74, LAP = 260; // the plane's circle over the island, seconds a lap

export type StageView = 'home' | 'select';

export class LobbyStage {
  readonly ink;
  private plane = new THREE.Group();   // the plane and everyone on it; moved along its path each frame
  private slots: Slot[] = [];
  private ghosts: number[] = [];       // open spots (x on the wing), for the "invite" cards
  private size = 1;
  private t = 0;
  private view: StageView = 'home';
  private viewK = 0;                   // 0 home .. 1 select, eased
  private camPos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private sx = 0.5; private sy = 0.5;  // where the lineup sits on screen (0..1), eased
  caption = '';

  constructor(private game: Game3D) {
    this.ink = game.ink;
    this.plane.add(buildPaperPlane(this.ink)); // nose at -z: forward
    this.ink.scene.add(this.plane);
    this.place(0);
  }

  // the lineup: you first, then whoever is in your party; size = how many spots the mode has
  setLineup(members: StageMember[], size: number) {
    this.size = Math.max(1, Math.min(4, size));
    const keep = new Set(members.map((m) => m.key));
    for (const s of this.slots) if (!keep.has(s.key) && !s.out) s.out = 0.0001; // leaving: fades by sinking
    members.forEach((m, i) => {
      const x = SPOTS[i] ?? 0;
      let s = this.slots.find((q) => q.key === m.key && !q.out);
      if (s && s.skin !== m.skin) { this.drop(s); s = undefined; }
      if (!s) {
        const fig = buildFigure(this.ink, 7 + i, m.skin);
        this.plane.add(fig.root);
        s = { key: m.key, skin: m.skin, you: m.you, fig, x, born: this.t, cheer: 0, seed: Math.random() * 10, out: 0 };
        // you swap in place; a friend lands from above
        if (!m.you) s.born = this.t;
        this.slots.push(s);
      }
      s.x = x; s.you = m.you;
    });
    this.ghosts = [];
    for (let i = members.length; i < Math.max(this.size, members.length); i++) this.ghosts.push(SPOTS[i] ?? 0);
  }

  // you, wearing another character for a moment (hovering the picker), or for good
  setYou(skin: number) {
    const s = this.slots.find((q) => q.you && !q.out);
    if (!s || s.skin === skin) return;
    const key = s.key, x = s.x;
    this.drop(s);
    const fig = buildFigure(this.ink, 7, skin);
    this.plane.add(fig.root);
    this.slots.push({ key, skin, you: true, fig, x, born: this.t - 0.35, cheer: 0, seed: s.seed, out: 0 });
  }
  cheer() { const s = this.slots.find((q) => q.you && !q.out); if (s) s.cheer = 1; }
  setView(v: StageView) { this.view = v; }

  private drop(s: Slot) {
    s.fig.root.parent?.remove(s.fig.root);
    this.slots = this.slots.filter((q) => q !== s);
  }

  // the plane's place on its circle at time t (world), banking gently into the turn
  private place(t: number) {
    const a = (t / LAP) * Math.PI * 2;
    this.plane.position.set(Math.cos(a) * ORBIT_R, ALT + Math.sin(t * 0.21) * 1.6, Math.sin(a) * ORBIT_R);
    // flying counter-clockwise: heading along the tangent
    this.plane.rotation.set(0, Math.PI - a, 0, 'YXZ');
    this.plane.rotateZ(-0.05 + Math.sin(t * 0.33) * 0.012);
    this.plane.updateMatrixWorld(true);
  }

  // screen positions of the lineup (for the name tags and invite cards), in CSS pixels
  spots(W: number, H: number): { x: number; y: number; foot: number; s: number; you: boolean; key: string | null }[] {
    const cam = this.ink.camera, out: { x: number; y: number; foot: number; s: number; you: boolean; key: string | null }[] = [];
    const proj = (lx: number, ly: number) => { this.tmp.set(lx, ly, 12).applyMatrix4(this.plane.matrixWorld).project(cam); return [(this.tmp.x + 1) / 2 * W, (1 - this.tmp.y) / 2 * H] as const; };
    for (const s of this.slots) {
      if (s.out || (this.viewK > 0.5 && !s.you)) continue;
      const [x, y] = proj(s.x, FIG_H + 0.28), [, foot] = proj(s.x, 0);
      out.push({ x, y, foot, s: (foot - y) / H, you: s.you, key: s.key });
    }
    if (this.viewK < 0.5) for (const gx of this.ghosts) { const [x, y] = proj(gx, FIG_H + 0.28), [, foot] = proj(gx, 0); out.push({ x, y, foot, s: (foot - y) / H, you: false, key: null }); }
    return out;
  }

  frame(dt: number, W: number, H: number) {
    this.t += dt;
    this.place(this.t);
    this.viewK += ((this.view === 'select' ? 1 : 0) - this.viewK) * Math.min(1, dt * 4);
    const k = this.viewK * this.viewK * (3 - 2 * this.viewK);

    // everyone on the wing: idle, cheering, landing, leaving
    for (const s of [...this.slots]) this.pose(s, dt, k);

    // the camera: in front of the lineup, a little above, a long lens so the island looms behind
    const wide = W / Math.max(1, H), narrow = wide < 0.9;
    const span = Math.max(1, this.size) * 1.35; // how wide the lineup is (m)
    const fov = narrow ? 34 : 26;
    const fitH = (FIG_H + 0.9) / (narrow ? 0.42 : 0.62);              // the figure about 60% of the screen's height
    const fitW = (span + 1.4) / (wide * (narrow ? 0.95 : 0.5));        // and the lineup inside the middle of the screen
    let dist = Math.max(fitH, fitW) / (2 * Math.tan((fov * Math.PI) / 360));
    const selDist = (FIG_H + 0.5) / (narrow ? 0.4 : 0.78) / (2 * Math.tan((fov * Math.PI) / 360));
    dist += (selDist - dist) * k;
    const drift = Math.sin(this.t * 0.17) * 0.35, lift = 1.35 + Math.sin(this.t * 0.11) * 0.12;
    // local (plane) space: the lineup stands at z=12 facing +z (toward the tail); the camera behind the tail
    this.camPos.set(drift + (1 - k) * 0, lift + 0.8 * (1 - k), 12 + dist);
    this.look.set(drift * 0.4, 1.05 - 0.15 * k, 12);
    this.camPos.applyMatrix4(this.plane.matrixWorld);
    this.look.applyMatrix4(this.plane.matrixWorld);
    const cam = this.ink.camera;
    cam.position.copy(this.camPos);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    // lens shift: put the lineup where the layout wants it (centre on home, left of the picker on select)
    const tx = narrow ? 0.5 : 0.5 - 0.2 * k, ty = narrow ? 0.4 - 0.05 * k : 0.55;
    this.sx += (tx - this.sx) * Math.min(1, dt * 5); this.sy += (ty - this.sy) * Math.min(1, dt * 5);
    if (cam.fov !== fov) cam.fov = fov;
    cam.setViewOffset(W, H, -(this.sx - 0.5) * W, -(this.sy - 0.5) * H, W, H);
    cam.updateProjectionMatrix();
    this.caption = this.over();
    this.ink.setStorm(0, 0, 9999, 0, 0, 0);
    this.ink.render(this.t);
  }

  private pose(s: Slot, dt: number, k: number) {
    const f = s.fig, age = this.t - s.born;
    poseStand(f);
    const ph = this.t * 1.6 + s.seed;
    let y = 0, yaw = 0, scale = 1;
    // breathing and a weight shift
    f.pelvis.position.y += Math.sin(ph) * 0.012;
    f.torso.rotation.x = -0.03 + Math.sin(ph) * 0.02;
    f.pelvis.rotation.z = Math.sin(ph * 0.5) * 0.03;
    f.head.rotation.y = Math.sin(ph * 0.37) * 0.25;
    f.armL.rotation.z -= 0.04 + Math.sin(ph) * 0.03; f.armR.rotation.z += 0.04 + Math.sin(ph) * 0.03;
    // landing on the wing: from high above, a squash on touchdown
    if (!s.you && age < 1.1) {
      const u = age / 0.6;
      if (u < 1) { y = (1 - u * u) * 7; f.armL.rotation.z = -2.6; f.armR.rotation.z = 2.6; }
      else { const b = (age - 0.6) / 0.5; scale = 1 - Math.sin(b * Math.PI) * 0.12; }
    }
    // you, swapped in: a quick pop
    if (s.you && age < 0.35) scale = 0.75 + 0.25 * Math.sin((age / 0.35) * Math.PI / 2) + Math.sin((age / 0.35) * Math.PI) * 0.1;
    // a cheer: hop, spin, both arms up
    if (s.cheer > 0) {
      s.cheer = Math.max(0, s.cheer - dt / 1.4);
      const u = 1 - s.cheer;
      if (u < 0.55) { const j = u / 0.55; y = Math.sin(j * Math.PI) * 0.9; yaw = j * Math.PI * 2; }
      const arms = Math.min(1, u * 5) * Math.min(1, s.cheer * 4);
      f.armL.rotation.z += -2.7 * arms; f.armR.rotation.z += 2.7 * arms;
      f.foreL.rotation.x += 0.4 * arms; f.foreR.rotation.x += 0.4 * arms;
      f.head.rotation.x = -0.25 * arms;
    }
    if (s.out) { s.out += dt; y = -s.out * s.out * 30; if (s.out > 0.7) { this.drop(s); return; } }
    // friends step back out of the way while you pick
    const hide = s.you ? 0 : k;
    f.root.visible = hide < 0.6;
    f.root.position.set(s.x, y + Math.abs(s.x) / 12, 12 - hide * 2);
    f.root.rotation.set(0, Math.PI + yaw - s.x * 0.06, 0);
    f.root.scale.set(1 / Math.sqrt(scale), scale, 1 / Math.sqrt(scale));
  }

  // the place the plane is over right now
  private over(): string {
    const w = this.game.world;
    if (!w) return '';
    const p = this.plane.position;
    let best = '', bd = 1e9;
    for (const poi of w.pois) { const d = Math.hypot(poi.x - p.x, poi.z - p.z); if (d < bd) { bd = d; best = poi.name; } }
    return bd < 140 ? best : 'the island';
  }

  // pictures of every character drawn by this same renderer: a full figure and a head-and-shoulders
  // portrait each, at the screen's pixel ratio. Drawn in one go off to the side of the scene
  portraits(cssW: number, cssH: number, bust: boolean): string[] {
    const r = this.ink.renderer, canvas = this.ink.canvas, cam = this.ink.camera;
    const prevW = canvas.style.width, prevH = canvas.style.height, prevView = cam.view ? { ...cam.view } : null, prevFov = cam.fov;
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    cam.clearViewOffset();
    this.ink.resize();
    const out = document.createElement('canvas');
    out.width = r.domElement.width; out.height = r.domElement.height;
    const ctx = out.getContext('2d')!;
    const booth = new THREE.Group(); booth.position.set(0, 900, 0); this.ink.scene.add(booth); // high above everything: just paper behind
    booth.updateMatrixWorld(true);
    const hidden = this.plane.visible; this.plane.visible = false;
    const pics: string[] = [];
    for (let i = 0; i < SKINS.length; i++) {
      const f = buildFigure(this.ink, 7, i);
      poseStand(f);
      f.head.rotation.y = 0.12;
      f.root.rotation.y = Math.PI + 0.35;
      booth.add(f.root);
      const box = new THREE.Box3().setFromBufferAttribute(posedGeometry(f).getAttribute('position') as THREE.BufferAttribute);
      const top = box.max.y, fov = bust ? 24 : 26;
      cam.fov = fov; cam.aspect = cssW / cssH; cam.updateProjectionMatrix();
      const h = bust ? (top - 1.05) * 1.25 : top * 1.12, cy = bust ? top - h * 0.46 : top * 0.5;
      const d = (h / 2) / Math.tan((fov * Math.PI) / 360);
      cam.position.set(Math.sin(0.0) * d, 900 + cy + (bust ? 0.05 : 0.15), d);
      cam.lookAt(0, 900 + cy, 0);
      this.ink.render(this.t);
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.drawImage(r.domElement, 0, 0);
      pics.push(out.toDataURL('image/png'));
      booth.remove(f.root);
    }
    this.ink.scene.remove(booth);
    this.plane.visible = hidden;
    canvas.style.width = prevW; canvas.style.height = prevH;
    cam.fov = prevFov;
    if (prevView) cam.setViewOffset(prevView.fullWidth, prevView.fullHeight, prevView.offsetX, prevView.offsetY, prevView.width, prevView.height);
    this.ink.resize();
    return pics;
  }
}
