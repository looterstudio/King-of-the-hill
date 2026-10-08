// The first-person client: builds the island from the room seed (the same World the server
// simulates), predicts your own movement with the shared physics and reconciles against the
// server, interpolates everyone else 100 ms in the past, and draws it all through InkRenderer.
import * as THREE from 'three';
import { EYE_H, TICK_HZ, WEAPONS, WEAPON_ORDER, type WeaponId } from '../../shared/src/constants.ts';
import { OTHER_ALIVE, OTHER_GLIDE, OTHER_HOOK, OTHER_SLIDE, type RoomSeat, type ServerMsg, type SnapOther, type SnapSelf } from '../../shared/src/protocol.ts';
import { moveStep, spreadFor, type Input } from '../../shared/src/sim.ts';
import { World, type Body } from '../../shared/src/world.ts';
import { INK_IDS, InkRenderer } from './ink.ts';
import { buildFigure, buildGun, poseFigure, type Figure } from './models.ts';
import { sfx } from './audio.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
const DT = 1 / TICK_HZ;
const INTERP = 0.1;
const BODY_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'grounded', 'gliding', 'airJumps', 'wallX', 'wallZ', 'wallT', 'slideT', 'dashT', 'dashX', 'dashZ', 'dashReady', 'hook', 'gx', 'gy', 'gz', 'hookCd'] as const;
const copyBody = (from: Body, to: Body) => { for (const k of BODY_KEYS) (to as unknown as Record<string, unknown>)[k] = from[k]; };

interface Tracer { start: THREE.Vector3; end: THREE.Vector3; life: number; mine: boolean }

export class Game3D {
  ink: InkRenderer;
  world: World | null = null;
  you = -1;
  seats = new Map<number, RoomSeat>();
  self: SnapSelf | null = null;
  watch: number | null = null;     // who we spectate after dying
  ring = { x: 0, y: 0, r: 999, nx: 0, ny: 0, nr: 0, closing: false, nextIn: 0, phase: 0 };
  alive = 0;
  private worldGroup = new THREE.Group();
  private pred: Body | null = null;
  private prevPos = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private lastTickAt = 0;
  private pending: Input[] = [];
  private seq = 0;
  private snaps: { s: Snap; at: number }[] = [];
  private avatars = new Map<number, Figure & { tag: HTMLDivElement }>();
  leader: [number, number] | null = null;
  private viewChute: THREE.Group | null = null;
  private tracers: Tracer[] = [];
  private tracerGeo: THREE.BufferGeometry;
  private ropeGeo: THREE.BufferGeometry;
  private rope: THREE.LineSegments;
  private guns = new Map<WeaponId, THREE.Group>();
  private gunKick = 0;
  private bob = 0;
  private localCd = 0;
  private time = 0;
  private tagLayer: HTMLDivElement;
  onShotFeedback: ((x: number, y: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, tagLayer: HTMLDivElement) {
    this.ink = new InkRenderer(canvas);
    this.tagLayer = tagLayer;
    this.ink.scene.add(this.worldGroup);
    this.tracerGeo = new THREE.BufferGeometry();
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(600 * 6), 3));
    this.tracerGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(600 * 6), 3));
    const tracers = new THREE.LineSegments(this.tracerGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
    tracers.frustumCulled = false;
    this.ink.overlay.add(tracers);
    this.ropeGeo = new THREE.BufferGeometry();
    this.ropeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(200 * 6), 3));
    this.rope = new THREE.LineSegments(this.ropeGeo, new THREE.LineBasicMaterial({ color: 0x2b2f3a, depthTest: false }));
    this.rope.frustumCulled = false;
    this.ink.overlay.add(this.rope);
    this.buildGuns();
  }

  // ---------------- world ----------------
  setRoom(seed: number, seats: RoomSeat[], you: number) {
    this.you = you;
    this.seats = new Map(seats.map((s) => [s.id, s]));
    this.snaps = []; this.pending = []; this.self = null; this.pred = null; this.watch = null; this.tracers = [];
    for (const a of this.avatars.values()) { this.ink.scene.remove(a.root); a.tag.remove(); }
    this.avatars.clear();
    if (this.world?.seed !== seed) this.buildWorld(new World(seed));
  }

  private buildWorld(w: World) {
    this.world = w;
    this.worldGroup.clear();
    const ink = this.ink;
    // every solid box, one instanced draw call
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const instanced = (geo: THREE.BufferGeometry, items: { m: THREE.Matrix4; ink: number }[]) => {
      const g = geo.clone();
      g.setAttribute('aInk', new THREE.InstancedBufferAttribute(new Float32Array(items.map((i) => i.ink)), 1));
      const mesh = new THREE.InstancedMesh(g, ink.material(0), items.length);
      items.forEach((it, i) => mesh.setMatrixAt(i, it.m));
      mesh.frustumCulled = false;
      this.worldGroup.add(mesh);
    };
    const m4 = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
    instanced(boxGeo, w.boxes.map((b) => ({ m: m4((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2, b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0), ink: b.ink })));
    // windows and doors: thin visual-only panels on the building faces, for the doodle detail
    const panels: { m: THREE.Matrix4; ink: number }[] = [];
    for (const r of w.roofs) {
      const floors = Math.round(r.y / 3.5);
      for (let f = 0; f < floors; f++) {
        const y = f * 3.5 + 1.9;
        for (let x = r.x0 + 2; x < r.x1 - 1.5; x += 3) { panels.push({ m: m4(x, y, r.z0 - 0.04, 1.3, 1.5, 0.08), ink: 0 }); panels.push({ m: m4(x, y, r.z1 + 0.04, 1.3, 1.5, 0.08), ink: 0 }); }
      }
      panels.push({ m: m4((r.x0 + r.x1) / 2, 1.1, r.z1 + 0.05, 1.4, 2.2, 0.1), ink: 6 });
    }
    if (panels.length) instanced(boxGeo, panels);
    // tree crowns: scribbly green blobs
    const crown = new THREE.IcosahedronGeometry(1, 1);
    instanced(crown, w.trees.map((t) => ({ m: m4(t.x, t.h * 0.6 + t.r * 0.7, t.z, t.r, t.r * 0.9, t.r), ink: 4 })));
    // doodle clouds drifting over the island
    const puffs: { m: THREE.Matrix4; ink: number }[] = [];
    for (let i = 0; i < 26; i++) {
      const cx = Math.sin(i * 12.9898 + w.seed) * 230, cz = Math.cos(i * 78.233 + w.seed) * 230, cy = 95 + (i % 5) * 9, sz = 6 + (i % 4) * 2;
      for (let k = 0; k < 4; k++) puffs.push({ m: m4(cx + (k - 1.5) * sz * 0.9, cy + (k % 2) * sz * 0.35, cz + (k % 3) * 2, sz, sz * 0.6, sz * 0.8), ink: 0 });
    }
    instanced(new THREE.IcosahedronGeometry(1, 1), puffs);
    // mountains ringing the island (scenery beyond the edge, not walkable)
    const peaks: { m: THREE.Matrix4; ink: number }[] = [];
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + Math.sin(i * 3.7 + w.seed) * 0.05, d = 280 + ((i * 37) % 9) * 14;
      const h = 45 + ((i * 53 + w.seed) % 70), rad = 38 + ((i * 29) % 30);
      peaks.push({ m: m4(Math.cos(a) * d, h / 2 - 1, Math.sin(a) * d, rad, h, rad), ink: i % 3 === 0 ? 6 : 4 });
    }
    instanced(new THREE.ConeGeometry(1, 1, 7, 1), peaks);
    // ground: paper, only contact lines get drawn
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2), ink.material(INK_IDS.PAPER));
    this.worldGroup.add(ground);
    // the island edge
    const edge = new THREE.Mesh(new THREE.BoxGeometry(400.6, 0.3, 400.6), ink.material(INK_IDS.GRAPHITE));
    edge.position.y = -0.16;
    this.worldGroup.add(edge);
  }

  // ---------------- avatars ----------------
  private avatar(id: number) {
    let a = this.avatars.get(id);
    if (a) return a;
    const fig = buildFigure(this.ink, id);
    this.ink.scene.add(fig.root);
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = this.seats.get(id)?.num ?? '';
    this.tagLayer.appendChild(tag);
    a = Object.assign(fig, { tag });
    this.avatars.set(id, a);
    return a;
  }

  // ---------------- first-person guns ----------------
  private buildGuns() {
    const mats = { body: this.ink.material(INK_IDS.BLUE, true), dark: this.ink.material(INK_IDS.GRAPHITE, true), accent: this.ink.material(INK_IDS.ORANGE, true) };
    for (const id of WEAPON_ORDER) {
      const g = buildGun(id, mats);
      g.scale.setScalar(0.62); g.position.set(0.2, -0.2, -0.5); g.visible = false;
      this.ink.viewScene.add(g); this.guns.set(id, g);
    }
    // the canopy edge you see overhead while gliding
    const chute = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2.2, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2.6), this.ink.material(INK_IDS.RED, true));
    dome.position.set(0, 1.6, 0);
    chute.add(dome);
    chute.visible = false;
    this.ink.viewScene.add(chute);
    this.viewChute = chute;
  }

  // ---------------- network ----------------
  onSnap(s: Snap) {
    this.snaps.push({ s, at: performance.now() / 1000 });
    if (this.snaps.length > 30) this.snaps.shift();
    this.ring = s.ring;
    this.alive = s.alive;
    this.leader = s.leader;
    const heard = new Set<number>();
    for (const sh of s.shots) {
      if (sh[6] === this.you) continue; // our own shots were already drawn when we pulled the trigger
      this.tracers.push({ start: new THREE.Vector3(sh[0], sh[1] - 0.15, sh[2]), end: new THREE.Vector3(sh[3], sh[4], sh[5]), life: 0.12, mine: false });
      if (!heard.has(sh[6])) { // one sound per shooter per snapshot (shotgun pellets are one bang)
        heard.add(sh[6]);
        const o = s.others.find((p) => p[0] === sh[6]);
        const cam = this.ink.camera.position;
        sfx.shot(WEAPON_ORDER[o?.[8] ?? 0] ?? 'rifle', Math.max(1, Math.hypot(sh[0] - cam.x, sh[2] - cam.z)));
      }
    }
    if (!s.self) return;
    this.self = s.self;
    if (!this.world) return;
    if (!s.self.alive) { this.pred = null; return; }
    // reconcile: start from the server's state, replay what it hasn't seen yet
    const old = this.pred ? new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z) : null;
    const base = { ...s.self } as Body;
    this.pending = this.pending.filter((i) => i.seq > s.self!.ack);
    for (const i of this.pending) moveStep(this.world, base, i, DT);
    if (!this.pred) { this.pred = base; this.prevPos.set(base.x, base.y, base.z); }
    else copyBody(base, this.pred);
    if (old) {
      const err = old.clone().sub(new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z));
      if (err.length() < 4) this.offset.add(err); else this.offset.set(0, 0, 0); // big jumps snap, small ones melt away
    }
  }

  // which server tick the other players are being drawn at (for lag-compensated shots)
  private viewTick = 0;

  // called at 30 Hz with sampled controls; returns the message to send (or null)
  tick(c: { fwd: number; strafe: number; sprint: boolean; grapple: boolean; jump: boolean; slide: boolean; reload: boolean; slot: number; fire: boolean; aim: boolean; yaw: number; pitch: number }): Input | null {
    if (!this.world || !this.self || !this.self.alive || !this.pred) return null;
    let slot = c.slot;
    if (slot < 0) { // wheel: cycle
      const i = WEAPON_ORDER.indexOf(this.self.weapon), n = WEAPON_ORDER.length;
      slot = ((i + (slot === -1 ? 1 : -1) + n) % n) + 1;
    }
    if (c.jump && this.pred && (this.pred.grounded || this.pred.airJumps > 0)) sfx.jump();
    if (c.reload && this.self.reloadT === 0) sfx.reload();
    const inp: Input = { seq: ++this.seq, fwd: c.fwd, strafe: c.strafe, yaw: c.yaw, pitch: c.pitch, jump: c.jump, sprint: c.sprint, slide: c.slide, grapple: c.grapple, fire: c.fire, aim: c.aim, reload: c.reload, slot, view: this.viewTick };
    this.prevPos.set(this.pred.x, this.pred.y, this.pred.z);
    moveStep(this.world, this.pred, inp, DT);
    this.lastTickAt = performance.now() / 1000;
    this.pending.push(inp);
    if (this.pending.length > 90) this.pending.shift();
    // cosmetic: kick the gun and draw our tracer right away
    this.localCd = Math.max(0, this.localCd - DT);
    const w = this.self.weapon, wi = WEAPON_ORDER.indexOf(w), def = WEAPONS[w];
    if (c.fire && this.localCd === 0 && this.self.mag[wi] > 0 && this.self.reloadT === 0 && !this.pred.gliding) {
      this.localCd = def.cd;
      this.gunKick = 1;
      sfx.shot(w);
      const spread = spreadFor(this.pred, w, c.aim);
      const ox = this.pred.x, oy = this.pred.y + EYE_H, oz = this.pred.z;
      for (let i = 0; i < Math.min(def.pellets, 5); i++) {
        const yaw = c.yaw + (Math.random() - 0.5) * 2 * spread, pitch = c.pitch + (Math.random() - 0.5) * 2 * spread;
        const cp = Math.cos(pitch), dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
        const t = this.world.raycast(ox, oy, oz, dx, dy, dz, def.range);
        const start = new THREE.Vector3(0.22, -0.18, -0.6).applyEuler(new THREE.Euler(c.pitch, c.yaw, 0, 'YXZ')).add(new THREE.Vector3(ox, oy, oz));
        this.tracers.push({ start, end: new THREE.Vector3(ox + dx * t, oy + dy * t, oz + dz * t), life: 0.08, mine: true });
      }
    }
    return inp;
  }

  private interpolated(): { others: Map<number, SnapOther>; tick: number } {
    const out = new Map<number, SnapOther>();
    if (!this.snaps.length) return { others: out, tick: 0 };
    const last = this.snaps[this.snaps.length - 1], now = performance.now() / 1000;
    const rt = last.s.time + (now - last.at) - INTERP;
    let a = this.snaps[0], b = last;
    for (let i = 0; i < this.snaps.length - 1; i++) if (this.snaps[i].s.time <= rt && this.snaps[i + 1].s.time >= rt) { a = this.snaps[i]; b = this.snaps[i + 1]; break; }
    const span = b.s.time - a.s.time, k = span > 0 ? Math.min(1, Math.max(0, (rt - a.s.time) / span)) : 1;
    const prev = new Map(a.s.others.map((o) => [o[0], o]));
    for (const ob of b.s.others) {
      const oa = prev.get(ob[0]) ?? ob, o = ob.slice();
      for (const j of [1, 2, 3, 5]) o[j] = oa[j] + (ob[j] - oa[j]) * k;
      let dy = ob[4] - oa[4]; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      o[4] = oa[4] + dy * k;
      out.set(o[0], o);
    }
    return { others: out, tick: Math.round(a.s.tick + (b.s.tick - a.s.tick) * k) };
  }

  // ---------------- frame ----------------
  frame(dt: number, look: { yaw: number; pitch: number; aim: boolean }) {
    if (!this.world) return;
    this.time += dt;
    const cam = this.ink.camera;
    const { others, tick } = this.interpolated();
    this.viewTick = tick;
    this.offset.multiplyScalar(Math.exp(-dt * 12));

    // camera: our predicted eye, or a chase cam on whoever we're watching
    const me = this.self;
    let eye: THREE.Vector3;
    if (me && me.alive && this.pred) {
      const k = Math.min(1, (performance.now() / 1000 - this.lastTickAt) / DT);
      const pos = this.prevPos.clone().lerp(new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z), k).add(this.offset);
      const crouch = this.pred.slideT > 0 ? -0.6 : 0;
      const speed = Math.hypot(this.pred.vx, this.pred.vz);
      if (this.pred.grounded && speed > 1) this.bob += dt * speed * 1.6;
      eye = pos.add(new THREE.Vector3(0, EYE_H + crouch + Math.sin(this.bob) * 0.04, 0));
      cam.position.copy(eye);
      cam.rotation.set(look.pitch, look.yaw, this.pred.slideT > 0 ? 0.06 : 0, 'YXZ');
      const zoom = look.aim ? WEAPONS[me.weapon].zoom : 1;
      const fov = 78 / zoom + (this.pred.dashT > 0 || this.pred.hook ? 6 : 0);
      if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 14); cam.updateProjectionMatrix(); }
    } else {
      const target = (this.watch !== null && others.get(this.watch)) || [...others.values()][0];
      if (target) {
        const back = new THREE.Vector3(Math.sin(target[4]) * 4.5, 2.4, Math.cos(target[4]) * 4.5);
        eye = new THREE.Vector3(target[1], target[2], target[3]).add(back);
        cam.position.lerp(eye, Math.min(1, dt * 6));
        cam.lookAt(target[1], target[2] + 1.4, target[3]);
      }
      eye = cam.position.clone();
      if (cam.fov !== 78) { cam.fov = 78; cam.updateProjectionMatrix(); }
    }

    // other players
    const seen = new Set<number>();
    const v = new THREE.Vector3();
    for (const o of others.values()) {
      if (!(o[7] & OTHER_ALIVE)) continue;
      seen.add(o[0]);
      const a = this.avatar(o[0]);
      a.root.visible = true;
      poseFigure(a, o[1], o[2], o[3], o[4], o[5], WEAPON_ORDER[o[8]] ?? 'rifle', !!(o[7] & OTHER_SLIDE), !!(o[7] & OTHER_GLIDE), this.leader?.[0] === o[0], dt);
      // number tag over nearby heads
      const d = a.root.position.distanceTo(cam.position);
      v.set(o[1], o[2] + 2.5, o[3]).project(cam);
      if (d < 50 && v.z < 1) {
        a.tag.style.display = 'block';
        a.tag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
      } else a.tag.style.display = 'none';
    }
    for (const [id, a] of this.avatars) if (!seen.has(id)) { a.root.visible = false; a.tag.style.display = 'none'; }

    // grapple ropes: ours from the gun, others' from their hand
    const rp = this.ropeGeo.getAttribute('position') as THREE.BufferAttribute;
    let rn = 0;
    const rope = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => { if (rn < 200) { rp.setXYZ(rn * 2, x0, y0, z0); rp.setXYZ(rn * 2 + 1, x1, y1, z1); rn++; } };
    if (this.pred?.hook && me?.alive) rope(cam.position.x, cam.position.y - 0.3, cam.position.z, this.pred.gx, this.pred.gy, this.pred.gz);
    for (const o of others.values()) if (o[7] & OTHER_HOOK && o.length >= 12) rope(o[1], o[2] + 1.3, o[3], o[9], o[10], o[11]);
    rp.needsUpdate = true;
    this.ropeGeo.setDrawRange(0, rn * 2);

    // tracers
    const tp = this.tracerGeo.getAttribute('position') as THREE.BufferAttribute, tc = this.tracerGeo.getAttribute('color') as THREE.BufferAttribute;
    let tn = 0;
    this.tracers = this.tracers.filter((t) => (t.life -= dt) > 0);
    for (const t of this.tracers) {
      if (tn >= 600) break;
      tp.setXYZ(tn * 2, t.start.x, t.start.y, t.start.z); tp.setXYZ(tn * 2 + 1, t.end.x, t.end.y, t.end.z);
      const c = t.mine ? [0.11, 0.2, 0.72] : [0.93, 0.45, 0.1];
      tc.setXYZ(tn * 2, c[0], c[1], c[2]); tc.setXYZ(tn * 2 + 1, c[0], c[1], c[2]);
      tn++;
    }
    tp.needsUpdate = true; tc.needsUpdate = true;
    this.tracerGeo.setDrawRange(0, tn * 2);

    // first-person gun: sway, bob, recoil, reload dip, hidden while scoped with the sniper
    const gliding = !!this.pred?.gliding && !!me?.alive;
    for (const [id, g] of this.guns) g.visible = !!me?.alive && me.weapon === id && !(look.aim && id === 'sniper') && !gliding;
    if (this.viewChute) { this.viewChute.visible = gliding; this.viewChute.rotation.z = Math.sin(this.time * 1.3) * 0.04; }
    const g = me ? this.guns.get(me.weapon) : null;
    if (g && me) {
      this.gunKick = Math.max(0, this.gunKick - dt * 9);
      const reload = me.reloadT > 0 ? Math.sin(Math.min(1, me.reloadT / WEAPONS[me.weapon].reload) * Math.PI) : 0;
      const ads = look.aim ? 1 : 0;
      g.position.set(0.2 * (1 - ads), -0.2 + ads * 0.1 - reload * 0.22 + Math.sin(this.bob) * 0.012, -0.5 + this.gunKick * 0.06 + ads * 0.08);
      g.rotation.set(this.gunKick * 0.12 - reload * 0.6, 0, 0);
    }

    this.ink.setStorm(this.ring.x, this.ring.y, this.ring.r, this.ring.nx, this.ring.ny, this.ring.nr);
    this.ink.render(this.time);
  }

  // where on screen a world point is (for damage direction indicators)
  bearingTo(x: number, z: number, yaw: number) { if (!this.pred) return 0; return Math.atan2(x - this.pred.x, z - this.pred.z) - yaw + Math.PI; }
  // where a player's head or chest is on screen right now (for damage numbers)
  screenOf(id: number, head: boolean): { x: number; y: number } | null {
    const a = this.avatars.get(id);
    if (!a || !a.root.visible) return null;
    const v = a.root.position.clone().add(new THREE.Vector3(0, head ? 1.8 : 1.2, 0)).project(this.ink.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  }
  positionOf(id: number) { const o = this.snaps.at(-1)?.s.others.find((p) => p[0] === id); return o ? { x: o[1], z: o[3] } : null; }
  get me() { return this.pred; }
}
