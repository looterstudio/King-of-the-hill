// The first-person client: builds the island from the room seed (the same World the server
// simulates), predicts your own movement with the shared physics and reconciles against the
// server, interpolates everyone else 100 ms in the past, and draws it all through InkRenderer:
// players, loot, pencil cases, grenades, smoke, pads, forts and incoming nukes.
import * as THREE from 'three';
import { AXE, BUILD, covered, isAir, EYE_H, KNOCK, PLAYER_HP, WRECK_BUDGET, INTERACT_R, ITEMS, MAP_HALF, NUKE, PERKS, TICK_HZ, VEHICLES, VEHICLE_KINDS, WEAPONS, WEAPON_IDS, type Rarity, type WeaponId } from '../../shared/src/constants.ts';
import { OTHER_ALIVE, OTHER_AXE, OTHER_DOWN, OTHER_GLIDE, OTHER_HOOK, OTHER_RIDE, OTHER_SLIDE, type SnapVehicle, type RoomSeat, type ServerMsg, type SnapCase, type SnapLoot, type SnapOther, type SnapSelf } from '../../shared/src/protocol.ts';
import { moveStep, spreadFor, type Input } from '../../shared/src/sim.ts';
import { World, type Body, type Box } from '../../shared/src/world.ts';
import { INK_IDS, InkRenderer } from './ink.ts';
import { buildAxe, buildCase, buildFigure, buildFire, buildGun, buildItem, buildNukeMarker, buildPad, buildSmoke, buildSupply, buildVehicle, poseFigure, type Figure, type VehicleModel } from './models.ts';
import { sfx } from './audio.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
const DT = 1 / TICK_HZ;
const INTERP = 0.1;
const BODY_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'grounded', 'gliding', 'airJumps', 'wallX', 'wallZ', 'wallT', 'slideT', 'dashT', 'dashX', 'dashZ', 'dashReady', 'hook', 'gx', 'gy', 'gz', 'hookCd', 'launchT', 'ride', 'head', 'vpitch', 'spd', 'seat', 'down'] as const;
const copyBody = (from: Body, to: Body) => { for (const k of BODY_KEYS) (to as unknown as Record<string, unknown>)[k] = from[k]; };

export const RARITY_INK: Record<Rarity, number> = { common: INK_IDS.GRAPHITE, uncommon: INK_IDS.GREEN, rare: INK_IDS.BLUE, epic: INK_IDS.PINK, legendary: INK_IDS.ORANGE };
export const RARITY_CSS: Record<Rarity, string> = { common: '#6b7080', uncommon: '#2a8a4a', rare: '#1d33b8', epic: '#c03a8a', legendary: '#e8a317' };
const RARITY_RGB: Record<Rarity, [number, number, number]> = { common: [0.45, 0.47, 0.52], uncommon: [0.16, 0.6, 0.3], rare: [0.11, 0.25, 0.85], epic: [0.78, 0.25, 0.62], legendary: [0.95, 0.65, 0.08] };
export const lootRarity = (kind: number, what: string): Rarity => kind === 0 ? WEAPONS[what as WeaponId].rarity : kind === 1 ? ITEMS[what as keyof typeof ITEMS].rarity : PERKS[what as keyof typeof PERKS].rarity;
export const lootName = (kind: number, what: string): string => kind === 0 ? WEAPONS[what as WeaponId].name : kind === 1 ? ITEMS[what as keyof typeof ITEMS].name : PERKS[what as keyof typeof PERKS].name;

interface Tracer { start: THREE.Vector3; end: THREE.Vector3; life: number; mine: boolean }
interface LootView { g: THREE.Group; d: SnapLoot; phase: number }
interface CaseView { root: THREE.Group; lid: THREE.Group; d: SnapCase; open: number }
interface Boom { m: THREE.Mesh; t: number; r: number; life: number }

export class Game3D {
  ink: InkRenderer;
  world: World | null = null;
  you = -1;
  seats = new Map<number, RoomSeat>();
  self: SnapSelf | null = null;
  watch: number | null = null;     // who we spectate after dying
  mates = new Set<number>();       // teammates (duos / squads)
  free: THREE.Vector3 | null = null; // free spectator camera, once the whole team is out
  ring = { x: 0, y: 0, r: 999, nx: 0, ny: 0, nr: 0, closing: false, nextIn: 0, phase: 0 };
  alive = 0;
  leader: [number, number] | null = null;
  board: number[][] = [];
  prompt = '';                     // "E · open pencil case" etc.
  nukes: { x: number; z: number; t: number }[] = [];
  drops: { x: number; z: number }[] = [];        // supply drops falling or landed (for the minimap)
  vehiclesNow: SnapVehicle[] = [];                 // interpolated, for the HUD and minimap
  private vmodels = new Map<number, VehicleModel>();
  private worldGroup = new THREE.Group();
  private pred: Body | null = null;
  private prevPos = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private lastTickAt = 0;
  private pending: Input[] = [];
  private seq = 0;
  private snaps: { s: Snap; at: number }[] = [];
  private avatars = new Map<number, Figure & { tag: HTMLDivElement; html?: string }>();
  private hitUntil = new Map<number, number>(); // enemies you just hit show their health over their head
  markHit(id: number) { this.hitUntil.set(id, this.time + 2.2); }
  private viewChute: THREE.Group | null = null;
  private tracers: Tracer[] = [];
  private tracerGeo: THREE.BufferGeometry;
  private ropeGeo: THREE.BufferGeometry;
  private beamGeo: THREE.BufferGeometry;
  private guns = new Map<WeaponId, THREE.Group>();
  private loot = new Map<number, LootView>();
  private cases = new Map<number, CaseView>();
  private fx = new Map<number, { g: THREE.Group; kind: string }>();
  private builds = new Map<number, { idx: number[]; meshes: THREE.Mesh[] }>();
  private booms: Boom[] = [];
  private gunKick = 0;
  // the island's boxes as one instanced mesh, one instance per world box (same index), with room for
  // everything a match can break off or build; dead boxes are scaled to nothing
  private boxMesh: THREE.InstancedMesh | null = null;
  private boxInk: THREE.InstancedBufferAttribute | null = null;
  private sepIdx = new Map<number, THREE.Mesh>(); // boxes drawn as their own mesh (forts)
  private falling: { g: THREE.Object3D; t: number; v: number; rx: number; rz: number; land?: number; dust?: boolean }[] = [];
  private debris: { m: THREE.Mesh; vx: number; vy: number; vz: number; t: number }[] = [];
  private axeView: THREE.Group | null = null;
  private axeSwing = 0;
  private axeLocal = 0;
  private ghost: THREE.LineSegments | null = null;
  private target: THREE.LineSegments | null = null; // the block the axe would hit
  private shardCache: { i: number; list: Box[] } | null = null;
  axeAim: { mat: string; hard: boolean } | null = null;
  private lookYaw = 0;
  private gableMesh: THREE.InstancedMesh | null = null;
  caption = ''; // the lobby flyover: the place on screen
  private bob = 0;
  private localCd = 0;
  private time = 0;
  private tagLayer: HTMLDivElement;
  private poiTags: HTMLDivElement[] = [];

  constructor(canvas: HTMLCanvasElement, tagLayer: HTMLDivElement, fit = false) {
    this.ink = new InkRenderer(canvas, fit);
    this.tagLayer = tagLayer;
    this.ink.scene.add(this.worldGroup);
    const lines = (n: number, color?: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial(color === undefined ? { vertexColors: true, transparent: true, opacity: 0.9, depthTest: false } : { color, depthTest: false }));
      l.frustumCulled = false;
      this.ink.overlay.add(l);
      return geo;
    };
    this.tracerGeo = lines(600);
    this.ropeGeo = lines(200, 0x2b2f3a);
    this.beamGeo = lines(400);
    this.buildGuns();
  }

  // ---------------- world ----------------
  setRoom(seed: number, seats: RoomSeat[], you: number) {
    this.you = you;
    this.seats = new Map(seats.map((s) => [s.id, s]));
    const team = this.seats.get(you)?.team ?? 0;
    this.mates = new Set(seats.filter((s) => team > 0 && s.team === team && s.id !== you).map((s) => s.id));
    this.snaps = []; this.pending = []; this.self = null; this.pred = null; this.watch = null; this.free = null; this.tracers = []; this.nukes = [];
    for (const a of this.avatars.values()) { this.ink.scene.remove(a.root); a.tag.remove(); }
    this.avatars.clear();
    for (const l of this.loot.values()) this.ink.scene.remove(l.g);
    for (const c of this.cases.values()) this.ink.scene.remove(c.root);
    for (const f of this.fx.values()) this.ink.scene.remove(f.g);
    for (const b of this.builds.values()) for (const m of b.meshes) this.ink.scene.remove(m);
    for (const b of this.booms) this.ink.scene.remove(b.m);
    this.loot.clear(); this.cases.clear(); this.fx.clear(); this.builds.clear(); this.booms = [];
    for (const f of this.falling) this.ink.scene.remove(f.g);
    for (const d of this.debris) this.ink.scene.remove(d.m);
    this.falling = []; this.debris = []; this.shardCache = null;
    for (const m of this.vmodels.values()) this.ink.scene.remove(m.root);
    this.vmodels.clear(); this.drops = []; this.vehiclesNow = [];
    this.buildWorld(new World(seed)); // always fresh: forts from the last match must not linger
  }

  private buildWorld(w: World) {
    this.world = w;
    this.worldGroup.clear();
    const ink = this.ink;
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const instanced = (geo: THREE.BufferGeometry, items: { m: THREE.Matrix4; ink: number }[]) => {
      if (!items.length) return null;
      const g = geo.clone();
      g.setAttribute('aInk', new THREE.InstancedBufferAttribute(new Float32Array(items.map((i) => i.ink)), 1));
      const mesh = new THREE.InstancedMesh(g, ink.material(0), items.length);
      items.forEach((it, i) => mesh.setMatrixAt(i, it.m));
      mesh.frustumCulled = false;
      this.worldGroup.add(mesh);
      return mesh;
    };
    const m4 = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
    this.sepIdx.clear();
    this.makeBoxMesh();
    instanced(new THREE.IcosahedronGeometry(1, 1), w.trees.map((t) => ({ m: m4(t.x, t.h * 0.6 + t.r * 0.7, t.z, t.r, t.r * 0.9, t.r), ink: t.ink ?? 4 })));
    // clouds and the mountain ring
    const puffs: { m: THREE.Matrix4; ink: number }[] = [];
    for (let i = 0; i < 44; i++) {
      const cx = Math.sin(i * 12.9898 + w.seed) * 440, cz = Math.cos(i * 78.233 + w.seed) * 440, cy = 140 + (i % 5) * 12, sz = 8 + (i % 4) * 3;
      for (let k = 0; k < 4; k++) puffs.push({ m: m4(cx + (k - 1.5) * sz * 0.9, cy + (k % 2) * sz * 0.35, cz + (k % 3) * 2, sz, sz * 0.6, sz * 0.8), ink: 0 });
    }
    instanced(new THREE.IcosahedronGeometry(1, 1), puffs);
    const peaks: { m: THREE.Matrix4; ink: number }[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2, d = MAP_HALF + 90 + ((i * 37) % 9) * 22, h = 70 + ((i * 53 + w.seed) % 110), rad = 55 + ((i * 29) % 40);
      peaks.push({ m: m4(Math.cos(a) * d, h / 2 - 1, Math.sin(a) * d, rad, h, rad), ink: i % 3 === 0 ? 6 : 4 });
    }
    instanced(new THREE.ConeGeometry(1, 1, 7, 1), peaks);
    // gable roofs on houses (scenery: a ridge you can see from far away)
    const prism = new THREE.BufferGeometry();
    {
      const v = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0, -0.5, 0, 0.5, 0.5, 0, 0.5];
      const idx = [0, 1, 2, 0, 2, 3, 4, 3, 2, 4, 2, 5, 0, 3, 4, 1, 5, 2, 0, 4, 5, 0, 5, 1];
      prism.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); prism.setIndex(idx); prism.computeVertexNormals();
      const flat = prism.toNonIndexed(); flat.computeVertexNormals(); prism.copy(flat);
    }
    this.gableMesh = instanced(prism, w.gables.map((g) => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3((g.x0 + g.x1) / 2, g.y, (g.z0 + g.z1) / 2), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), g.alongX ? 0 : Math.PI / 2), new THREE.Vector3(g.alongX ? g.x1 - g.x0 : g.z1 - g.z0, g.h, g.alongX ? g.z1 - g.z0 : g.x1 - g.x0));
      return { m, ink: INK_IDS.RED };
    }));
    // roads to the tower, with a dashed centre line
    const roads: { m: THREE.Matrix4; ink: number }[] = [], dashes: { m: THREE.Matrix4; ink: number }[] = [];
    for (const r of w.roads) {
      const dx = r.x1 - r.x0, dz = r.z1 - r.z0, len = Math.hypot(dx, dz) - 22, ux = dx / Math.hypot(dx, dz), uz = dz / Math.hypot(dx, dz);
      if (len <= 0) continue;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
      roads.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(r.x0 + ux * len / 2, 0.06, r.z0 + uz * len / 2), q, new THREE.Vector3(6, 0.12, len)), ink: INK_IDS.GRAPHITE });
      for (let s = 4; s < len - 4; s += 9) dashes.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(r.x0 + ux * s, 0.13, r.z0 + uz * s), q, new THREE.Vector3(0.3, 0.04, 3.5)), ink: INK_IDS.PAPER });
    }
    instanced(boxGeo, roads); instanced(boxGeo, dashes);
    // place names float over the map while you're up high
    for (const el of this.poiTags) el.remove();
    this.poiTags = w.pois.map((p) => { const el = document.createElement('div'); el.className = 'poi'; el.textContent = p.name; this.tagLayer.appendChild(el); return el; });
    // lakes: a flat disc with ripple rings
    for (const l of w.lakes) {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(l.r, l.r, 0.2, 40), ink.material(INK_IDS.BLUE));
      disc.position.set(l.x, 0.1, l.z);
      this.worldGroup.add(disc);
      for (let k = 1; k <= 3; k++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(l.r * (0.25 + k * 0.18), 0.05, 4, 40).rotateX(Math.PI / 2), ink.material(INK_IDS.BLUE)); ring.position.set(l.x, 0.22, l.z); this.worldGroup.add(ring); }
    }
    // biomes: sand and snow painted on the ground (a hair above it, below roads and lakes)
    for (const b of w.biomes) {
      const patch = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0, 0.04, b.z1 - b.z0), ink.material(b.kind === 'desert' ? INK_IDS.ORANGE : INK_IDS.BLUE));
      patch.position.set((b.x0 + b.x1) / 2, 0.02, (b.z0 + b.z1) / 2);
      this.worldGroup.add(patch);
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP_HALF * 7, MAP_HALF * 7).rotateX(-Math.PI / 2), ink.material(INK_IDS.PAPER));
    this.worldGroup.add(ground);
    // the island's edge sits well below the ground plane: coplanar surfaces shimmer from high up
    const edge = new THREE.Mesh(new THREE.BoxGeometry(MAP_HALF * 2 + 0.6, 2, MAP_HALF * 2 + 0.6), ink.material(INK_IDS.GRAPHITE));
    edge.position.y = -1.6;
    this.worldGroup.add(edge);
  }

  private makeBoxMesh() {
    const w = this.world!;
    if (this.boxMesh) { this.worldGroup.remove(this.boxMesh); this.boxMesh.geometry.dispose(); }
    const cap = w.boxes.length + WRECK_BUDGET + BUILD.cap + 4000;
    const g = new THREE.BoxGeometry(1, 1, 1);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aInk', attr);
    const mesh = new THREE.InstancedMesh(g, this.ink.material(0), cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.boxMesh = mesh; this.boxInk = attr;
    for (let i = 0; i < w.boxes.length; i++) this.setBox(i);
    this.dirtyBoxes = [];
    mesh.count = w.boxes.length;
    this.worldGroup.add(mesh);
  }
  private static ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  private static M = new THREE.Matrix4();
  private dirtyBoxes: number[] = [];
  private setBox(i: number) {
    const b = this.world!.boxes[i], mesh = this.boxMesh!;
    if (i >= mesh.instanceMatrix.count) return;
    this.dirtyBoxes.push(i);
    if (b.dead || this.sepIdx.has(i)) mesh.setMatrixAt(i, Game3D.ZERO);
    else mesh.setMatrixAt(i, Game3D.M.makeScale(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0).setPosition((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2));
    (this.boxInk!.array as Float32Array)[i] = b.ink;
  }
  // upload only the instances that changed (a blast touches a few dozen of ~50 000)
  private boxesChanged() {
    const mesh = this.boxMesh!, ink = this.boxInk!;
    if (this.world!.boxes.length > mesh.instanceMatrix.count) { this.makeBoxMesh(); this.dirtyBoxes = []; return; }
    mesh.count = this.world!.boxes.length;
    const d = [...new Set(this.dirtyBoxes)].sort((a, b) => a - b);
    this.dirtyBoxes = [];
    if (!d.length) return;
    mesh.instanceMatrix.clearUpdateRanges(); ink.clearUpdateRanges();
    let s = d[0], e = d[0];
    const flush = () => { mesh.instanceMatrix.addUpdateRange(s * 16, (e - s + 1) * 16); ink.addUpdateRange(s, e - s + 1); };
    for (let k = 1; k < d.length; k++) { if (d[k] - e <= 32) e = d[k]; else { flush(); s = e = d[k]; } }
    flush();
    mesh.instanceMatrix.needsUpdate = true; ink.needsUpdate = true;
  }

  // the world broke: blocks broken off or placed, boxes gone, whole buildings falling
  onWreck(add: Box[], kill: number[], falls: { sid: number; x: number; y: number; z: number }[], drop: number[] = []) {
    const w = this.world;
    if (!w || !this.boxMesh) return;
    const idx = w.addBoxes(add.map((b) => ({ ...b, hp: undefined })));
    if (w.boxes.length > this.boxMesh.instanceMatrix.count) this.makeBoxMesh();
    for (const i of idx) this.setBox(i);
    // a falling building: its boxes as one piece that tips, sinks and is gone in a cloud of dust
    const fell = new Set<number>();
    for (const f of falls) {
      const s = w.structures[f.sid - 1];
      if (!s) continue;
      fell.add(f.sid);
      const alive = s.boxes.filter((i) => !w.boxes[i].dead);
      if (!alive.length) continue;
      const g = new THREE.BoxGeometry(1, 1, 1), attr = new THREE.InstancedBufferAttribute(new Float32Array(alive.map((i) => w.boxes[i].ink)), 1);
      g.setAttribute('aInk', attr);
      const m = new THREE.InstancedMesh(g, this.ink.material(0), alive.length);
      const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
      alive.forEach((i, k) => { const b = w.boxes[i]; m.setMatrixAt(k, Game3D.M.makeScale(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0).setPosition((b.x0 + b.x1) / 2 - cx, (b.y0 + b.y1) / 2 - s.y0, (b.z0 + b.z1) / 2 - cz)); });
      m.frustumCulled = false;
      const pivot = new THREE.Group(); pivot.position.set(cx, s.y0, cz); pivot.add(m);
      this.ink.scene.add(pivot);
      const tall = s.y1 - s.y0;
      this.falling.push({ g: pivot, t: 0, v: 0, rx: (Math.random() - 0.5) * (tall > 30 ? 0.12 : 0.3), rz: (Math.random() - 0.5) * (tall > 30 ? 0.12 : 0.3) });
      for (let k = 0; k < Math.min(14, 4 + tall / 6); k++) this.onBoom(s.x0 + Math.random() * (s.x1 - s.x0), Math.random() * Math.min(tall, 12), s.z0 + Math.random() * (s.z1 - s.z0), 5 + Math.random() * 6, false);
      const cam = this.ink.camera.position;
      sfx.crumble(Math.hypot(cam.x - cx, cam.z - cz));
      // the pitched roofs sitting on it go too
      if (this.gableMesh) {
        w.gables.forEach((gb, k) => { if (gb.x0 >= s.x0 - 0.5 && gb.x1 <= s.x1 + 0.5 && gb.z0 >= s.z0 - 0.5 && gb.z1 <= s.z1 + 0.5 && gb.y <= s.y1 + 0.5) this.gableMesh!.setMatrixAt(k, Game3D.ZERO); });
        this.gableMesh.instanceMatrix.needsUpdate = true;
      }
    }
    // loose pieces (the top of a wall with its bottom blown out) drop straight down and break up
    const dropped = new Set(drop.filter((i) => w.boxes[i] && !w.boxes[i].dead));
    if (dropped.size) {
      const list = [...dropped], g = new THREE.BoxGeometry(1, 1, 1);
      g.setAttribute('aInk', new THREE.InstancedBufferAttribute(new Float32Array(list.map((i) => w.boxes[i].ink)), 1));
      const m = new THREE.InstancedMesh(g, this.ink.material(0), list.length);
      let lo = Infinity;
      list.forEach((i, k) => { const b = w.boxes[i]; lo = Math.min(lo, b.y0); m.setMatrixAt(k, Game3D.M.makeScale(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0).setPosition((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2)); });
      m.frustumCulled = false;
      const pivot = new THREE.Group(); pivot.add(m); this.ink.scene.add(pivot);
      this.falling.push({ g: pivot, t: 0, v: 0, rx: (Math.random() - 0.5) * 0.4, rz: (Math.random() - 0.5) * 0.4, land: lo, dust: true });
    }
    w.killBoxes(kill);
    let n = 0;
    for (const i of kill) {
      this.setBox(i);
      const fort = this.sepIdx.get(i);
      if (fort) { this.ink.scene.remove(fort); this.sepIdx.delete(i); }
      const b = w.boxes[i];
      // a few chunks fly off each broken block
      if (n < 36 && !(b.sid && fell.has(b.sid)) && !dropped.has(i) && World.isBlock(b)) {
        n++;
        const cam = this.ink.camera.position, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
        if (Math.hypot(cam.x - cx, cam.z - cz) > 160) continue;
        for (let k = 0; k < 3; k++) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), this.ink.material(b.ink));
          m.position.set(cx + (Math.random() - 0.5), cy + (Math.random() - 0.5), cz + (Math.random() - 0.5));
          this.ink.scene.add(m);
          this.debris.push({ m, vx: (Math.random() - 0.5) * 9, vy: 3 + Math.random() * 6, vz: (Math.random() - 0.5) * 9, t: 0 });
        }
      }
    }
    this.boxesChanged();
  }

  // forts are added and removed mid-match: they change collision for prediction too
  onBuild(id: number, boxes: Box[]) {
    if (!this.world || this.builds.has(id)) return;
    const idx = this.world.addBoxes(boxes.map((b) => ({ ...b })));
    const meshes = boxes.map((b) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0), this.ink.material(INK_IDS.BROWN));
      m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      m.scale.y = 0.01;
      this.ink.scene.add(m);
      return m;
    });
    idx.forEach((i, k) => { this.sepIdx.set(i, meshes[k]); this.setBox(i); });
    this.boxesChanged();
    this.builds.set(id, { idx, meshes });
  }
  onUnbuild(id: number) {
    const b = this.builds.get(id);
    if (!b || !this.world) return;
    const all = this.world.withShards(b.idx);
    this.world.killBoxes(all);
    for (const i of all) { this.sepIdx.delete(i); this.setBox(i); }
    this.boxesChanged();
    for (const m of b.meshes) this.ink.scene.remove(m);
    this.builds.delete(id);
  }
  onBoom(x: number, y: number, z: number, r: number, nuke: boolean) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.ink.material(nuke ? INK_IDS.RED : INK_IDS.ORANGE));
    m.position.set(x, y + (nuke ? 0 : 0.5), z);
    m.scale.setScalar(0.1);
    this.ink.scene.add(m);
    this.booms.push({ m, t: 0, r: nuke ? r * 0.8 : r * 0.6, life: nuke ? 1.4 : 0.4 });
  }

  // ---------------- avatars ----------------
  private avatar(id: number) {
    let a = this.avatars.get(id);
    if (a) return a;
    const fig = buildFigure(this.ink, id, this.seats.get(id)?.skin ?? id % 5);
    this.ink.scene.add(fig.root);
    const tag = document.createElement('div');
    tag.className = this.mates.has(id) ? 'tag mate' : 'tag';
    tag.textContent = this.seats.get(id)?.num ?? '';
    this.tagLayer.appendChild(tag);
    a = Object.assign(fig, { tag });
    this.avatars.set(id, a);
    return a;
  }

  private buildGuns() {
    const mats = { body: this.ink.material(INK_IDS.BLUE, true), dark: this.ink.material(INK_IDS.GRAPHITE, true), accent: this.ink.material(INK_IDS.ORANGE, true) };
    for (const id of WEAPON_IDS) {
      const g = buildGun(id, mats);
      g.scale.setScalar(0.62); g.position.set(0.2, -0.2, -0.5); g.visible = false;
      this.ink.viewScene.add(g); this.guns.set(id, g);
    }
    const axe = buildAxe(mats);
    axe.scale.setScalar(0.75); axe.position.set(0.28, -0.3, -0.35); axe.visible = false;
    this.ink.viewScene.add(axe); this.axeView = axe;
    // where a block would go: a wire cube, shown while the axe is out
    this.ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)), new THREE.LineBasicMaterial({ color: 0x2f7fd6, transparent: true, opacity: 0.9, depthTest: false }));
    this.ghost.visible = false;
    this.ink.overlay.add(this.ghost); // drawn on the finished picture, crisp, not through the ink pass
    this.target = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xd32336, transparent: true, opacity: 0.9, depthTest: false }));
    this.target.visible = false; this.target.renderOrder = 10;
    this.ink.overlay.add(this.target);
    const chute = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2.2, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2.6), this.ink.material(INK_IDS.RED, true));
    dome.position.set(0, 1.6, 0);
    chute.add(dome);
    chute.visible = false;
    this.ink.viewScene.add(chute);
    this.viewChute = chute;
  }

  // ---------------- loot / cases / fx from snapshots ----------------
  private syncLoot(list: SnapLoot[]) {
    const keep = new Set(list.map((l) => l[0]));
    for (const [id, v] of this.loot) if (!keep.has(id)) { this.ink.scene.remove(v.g); this.loot.delete(id); }
    const gunMats = { body: this.ink.material(INK_IDS.BLUE), dark: this.ink.material(INK_IDS.GRAPHITE), accent: this.ink.material(INK_IDS.ORANGE) };
    for (const d of list) {
      let v = this.loot.get(d[0]);
      if (!v) {
        const g = new THREE.Group();
        const rar = lootRarity(d[4], d[5]);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 16), this.ink.material(RARITY_INK[rar]));
        base.position.y = 0.02;
        const item = d[4] === 0 ? buildGun(d[5] as WeaponId, gunMats) : buildItem(d[5], this.ink);
        if (d[4] === 0) { item.rotation.set(0, Math.PI / 2, Math.PI / 2.3); item.position.y = 0.35; }
        item.name = 'item';
        g.add(base, item);
        this.ink.scene.add(g);
        v = { g, d, phase: Math.random() * 6 };
        this.loot.set(d[0], v);
      }
      v.d = d;
      v.g.position.set(d[1], d[2], d[3]);
    }
  }

  private syncCases(list: SnapCase[]) {
    const keep = new Set(list.map((c) => c[0]));
    for (const [id, v] of this.cases) if (!keep.has(id)) { this.ink.scene.remove(v.root); this.cases.delete(id); }
    for (const d of list) {
      let v = this.cases.get(d[0]);
      if (!v) {
        const { root, lid } = buildCase(this.ink, !!d[4]);
        root.position.set(d[1], d[2], d[3]);
        root.rotation.y = (d[0] * 1.7) % Math.PI;
        this.ink.scene.add(root);
        v = { root, lid, d, open: d[5] ? 1 : 0 };
        this.cases.set(d[0], v);
      }
      v.d = d;
    }
  }

  private syncFx(list: Snap['fx']) {
    const keep = new Set(list.map((f) => f[1]));
    for (const [id, v] of this.fx) if (!keep.has(id)) { this.ink.scene.remove(v.g); this.fx.delete(id); }
    this.nukes = [];
    this.drops = [];
    for (const f of list) {
      const [kind, id, x, y, z, t] = f;
      let v = this.fx.get(id);
      if (!v) {
        const g = kind === 'grenade' ? buildItem('grenade', this.ink) : kind === 'smoke' && t > 2 ? buildSmoke(this.ink) : kind === 'smoke' ? buildItem('smoke', this.ink)
          : kind === 'pad' ? buildPad(this.ink) : kind === 'c4' ? buildItem('c4', this.ink) : kind === 'bomb' ? buildItem('nuke', this.ink) : kind === 'drop' ? buildSupply(this.ink)
          : kind === 'rocket' || kind === 'missile' ? buildItem('rocket', this.ink) : kind === 'molotov' ? buildItem('molotov', this.ink) : kind === 'shock' ? buildItem('shock', this.ink) : kind === 'fire' ? buildFire(this.ink) : buildNukeMarker(this.ink);
        this.ink.scene.add(g);
        v = { g, kind };
        this.fx.set(id, v);
      }
      // rockets point the way they fly
      if ((kind === 'rocket' || kind === 'missile') && v.g.userData.px !== undefined) { const dx = x - v.g.userData.px, dy = y - v.g.userData.py, dz = z - v.g.userData.pz; if (Math.hypot(dx, dy, dz) > 0.01) v.g.lookAt(x + dx, y + dy, z + dz); }
      v.g.userData.px = x; v.g.userData.py = y; v.g.userData.pz = z;
      if (kind === 'fire') for (const f of v.g.children) f.scale.y = 0.7 + Math.random() * 0.6;
      v.g.position.set(x, y, z);
      if (kind === 'drop') { this.drops.push({ x, z }); v.g.rotation.y += 0.02; }
      if (kind === 'bomb') v.g.rotation.x = Math.PI;
      if (kind === 'nuke') {
        this.nukes.push({ x, z, t });
        const missile = v.g.getObjectByName('missile');
        if (missile) missile.position.y = 6 + (t / NUKE.delay) * 180;
      }
    }
  }

  // ---------------- network ----------------
  onSnap(s: Snap) {
    this.snaps.push({ s, at: performance.now() / 1000 });
    if (this.snaps.length > 30) this.snaps.shift();
    this.ring = s.ring; this.alive = s.alive; this.leader = s.leader; this.board = s.board ?? [];
    if (s.loot) this.syncLoot(s.loot);
    if (s.cases) this.syncCases(s.cases);
    this.syncFx(s.fx);
    const heard = new Set<number>();
    for (const sh of s.shots) {
      if (sh[6] === this.you && !((this.pred?.ride ?? 0) >= 2)) continue; // our own gunshots were drawn when we pulled the trigger
      this.tracers.push({ start: new THREE.Vector3(sh[0], sh[1] - 0.15, sh[2]), end: new THREE.Vector3(sh[3], sh[4], sh[5]), life: 0.12, mine: false });
      if (!heard.has(sh[6])) { // one bang per shooter per snapshot (shotgun pellets are one shot)
        heard.add(sh[6]);
        const o = s.others.find((p) => p[0] === sh[6]);
        const cam = this.ink.camera.position;
        sfx.shot(WEAPON_IDS[o?.[8] ?? 4] ?? 'ar', Math.max(1, Math.hypot(sh[0] - cam.x, sh[2] - cam.z)));
      }
    }
    if (!s.self) return;
    this.self = s.self;
    if (!s.self.alive && s.watch !== undefined && s.watch !== this.you) this.watch = s.watch;
    if (!this.world) return;
    if (!s.self.alive) { this.pred = null; return; }
    // reconcile: start from the server's state, replay what it hasn't seen yet
    const old = this.pred ? new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z) : null;
    const base = { ...s.self } as Body;
    this.pending = this.pending.filter((i) => i.seq > s.self!.ack);
    for (const i of this.pending) moveStep(this.world, base, i, DT, !!s.self.use);
    if (!this.pred) { this.pred = base; this.prevPos.set(base.x, base.y, base.z); }
    else copyBody(base, this.pred);
    if (old) {
      const err = old.clone().sub(new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z));
      if (err.length() < 4) this.offset.add(err); else this.offset.set(0, 0, 0); // big jumps snap, small ones melt away
    }
  }

  private viewTick = 0;
  get weapon(): WeaponId | null { return this.self && !this.self.axe ? this.self.slots[this.self.cur] : null; }

  // called at 30 Hz with sampled controls; returns the input to send (or null)
  tick(c: { fwd: number; strafe: number; sprint: boolean; grapple: boolean; jump: boolean; slide: boolean; reload: boolean; slot: number; fire: boolean; aim: boolean; yaw: number; pitch: number; interact: boolean; item: number; perk: boolean; up: number; hold: boolean; build?: boolean }): Input | null {
    if (!this.world || !this.self || !this.self.alive || !this.pred) return null;
    let slot = c.slot;
    if (slot < 0) { // wheel: cycle through filled slots
      const filled = this.self.slots.map((w, i) => (w ? i : -1)).filter((i) => i >= 0);
      const at = filled.indexOf(this.self.cur), n = filled.length;
      slot = filled[(at + (slot === -1 ? 1 : -1) + n) % n] + 1;
    }
    if (c.jump && (this.pred.grounded || this.pred.airJumps > 0)) sfx.jump();
    if (c.reload && this.self.reloadT === 0) sfx.reload();
    const inp: Input = { seq: ++this.seq, fwd: c.fwd, strafe: c.strafe, yaw: c.yaw, pitch: c.pitch, jump: c.jump, sprint: c.sprint, slide: c.slide, grapple: c.grapple, fire: c.fire, aim: c.aim || (!!c.build && this.self.axe), reload: c.reload, slot, view: this.viewTick, interact: c.interact, item: c.item, perk: c.perk, up: c.up, hold: c.hold };
    this.prevPos.set(this.pred.x, this.pred.y, this.pred.z);
    moveStep(this.world, this.pred, inp, DT, !!this.self.use);
    this.lastTickAt = performance.now() / 1000;
    this.pending.push(inp);
    if (this.pending.length > 90) this.pending.shift();
    // cosmetic: kick the gun and draw our tracer right away
    this.localCd = Math.max(0, this.localCd - DT);
    this.axeLocal = Math.max(0, this.axeLocal - DT);
    if (this.self.axe && c.fire && this.axeLocal === 0 && !this.pred.gliding && !this.pred.ride && !this.self.use) { this.axeLocal = AXE.cd; this.axeSwing = 1; sfx.swing(); }
    const w = this.weapon;
    if (w && c.fire && this.localCd === 0 && this.self.mags[this.self.cur] > 0 && this.self.reloadT === 0 && !this.pred.gliding && !this.self.use && (!covered(this.pred.ride) || this.pred.seat > 0)) {
      const def = WEAPONS[w];
      if (!def.spinUp || this.self.spin >= def.spinUp - 0.05) {
        this.localCd = def.burst ? def.cd + 0.15 : def.cd;
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

  // place names: visible from up high (the drop, rooftops, the tower, the lobby flyover)
  private placeNames(W: number, H: number) {
    if (!this.world) return;
    const cam = this.ink.camera, v = new THREE.Vector3(), high = cam.position.y > 22;
    this.world.pois.forEach((p, i) => {
      const el = this.poiTags[i];
      if (!el) return;
      v.set(p.x, 14, p.z).project(cam);
      const d = Math.hypot(p.x - cam.position.x, p.z - cam.position.z);
      if (high && v.z < 1 && d > 25 && d < 330 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1) {
        el.style.display = 'block';
        el.style.transform = `translate(${((v.x + 1) / 2) * W}px, ${((1 - v.y) / 2) * H}px) translate(-50%, -50%)`;
      } else el.style.display = 'none';
    });
  }

  // the lobby's live view of the island: a slow orbit around the tower, vehicles parked where they
  // spawn, one helicopter on patrol, rotors and props turning
  showcase(dt: number, W: number, H: number) {
    if (!this.world) return;
    this.time += dt;
    if (!this.vmodels.size) this.world.vehicleSpots.forEach((s, i) => {
      const m = buildVehicle(this.ink, VEHICLE_KINDS.indexOf(s.kind), i + 3);
      m.root.position.set(s.x, s.y, s.z); m.root.rotation.y = s.head;
      this.ink.scene.add(m.root); this.vmodels.set(-1 - i, m);
    });
    // a tour: the whole island, then a slow orbit around each place in turn
    const cam = this.ink.camera, SHOT = 6.5, pois = this.world.pois, k = Math.floor(this.time / SHOT), t = this.time - k * SHOT;
    const poi = k % (pois.length + 1) === 0 ? null : pois[(k - 1) % (pois.length + 1)];
    if (!poi) {
      const a = this.time * 0.05;
      cam.position.set(Math.cos(a) * 300, 120 + Math.sin(this.time * 0.13) * 18, Math.sin(a) * 300);
      cam.lookAt(Math.cos(a + 0.6) * 25, 6, Math.sin(a + 0.6) * 25);
      this.caption = 'the island';
    } else {
      const tall = poi.name === 'The Needle' ? 1 : poi.name === 'The Spire' ? 0.5 : 0, a = k * 2.1 + t * 0.12;
      const r = 70 + tall * 80, h = 34 + tall * 60;
      cam.position.set(poi.x + Math.cos(a) * r, h, poi.z + Math.sin(a) * r);
      cam.lookAt(poi.x, 6 + tall * 120, poi.z);
      this.caption = poi.name;
    }
    if (cam.fov !== 58) { cam.fov = 58; cam.updateProjectionMatrix(); }
    const patrol = -1 - this.world.vehicleSpots.findIndex((s) => s.kind === 'heli');
    for (const [id, m] of this.vmodels) {
      if (id === patrol) { const t = this.time * 0.2; m.root.position.set(Math.cos(t) * 110, 60 + Math.sin(t * 2) * 8, Math.sin(t) * 110); m.root.rotation.set(-0.15, -t, 0.2, 'YXZ'); }
      for (const s of m.spin) { if (s.name === 'rotor') s.rotation.y += dt * 24; else if (s.name === 'tail') s.rotation.x += dt * 30; else if (s.name === 'prop') s.rotation.z += dt * 10; }
    }
    this.placeNames(W, H);
    this.ink.setStorm(0, 0, 9999, 0, 0, 0);
    this.ink.render(this.time);
  }

  // vehicles: interpolated like players; the one you drive sits exactly where your prediction is
  private drawVehicles(dt: number) {
    const out: SnapVehicle[] = [];
    if (this.snaps.length) {
      const last = this.snaps[this.snaps.length - 1], now = performance.now() / 1000, rt = last.s.time + (now - last.at) - INTERP;
      let a = this.snaps[0], b = last;
      for (let i = 0; i < this.snaps.length - 1; i++) if (this.snaps[i].s.time <= rt && this.snaps[i + 1].s.time >= rt) { a = this.snaps[i]; b = this.snaps[i + 1]; break; }
      const span = b.s.time - a.s.time, k = span > 0 ? Math.min(1, Math.max(0, (rt - a.s.time) / span)) : 1;
      const prev = new Map((a.s.veh ?? []).map((v) => [v[0], v]));
      for (const vb of b.s.veh ?? []) {
        const va = prev.get(vb[0]) ?? vb, v = vb.slice();
        for (const j of [2, 3, 4, 6]) v[j] = va[j] + (vb[j] - va[j]) * k;
        let dh = vb[5] - va[5]; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
        v[5] = va[5] + dh * k;
        out.push(v);
      }
    }
    const mine = this.pred?.ride && this.self?.alive ? out.find((v) => v[8] === this.you) : null;
    if (mine && this.pred) { const k = Math.min(1, (performance.now() / 1000 - this.lastTickAt) / DT); const p = this.prevPos.clone().lerp(new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z), k).add(this.offset); mine[2] = p.x; mine[3] = p.y; mine[4] = p.z; mine[5] = this.pred.head; mine[6] = this.pred.vpitch; }
    this.vehiclesNow = out;
    const seen = new Set<number>();
    for (const v of out) {
      seen.add(v[0]);
      let m = this.vmodels.get(v[0]);
      if (!m) { m = buildVehicle(this.ink, v[1], v[0]); this.ink.scene.add(m.root); this.vmodels.set(v[0], m); }
      m.root.position.set(v[2], v[3], v[4]);
      // planes bank into turns, helicopters lean with their pitch
      let roll = 0;
      if ((v[1] === 2 || v[1] === 3) && m.root.userData.lastHead !== undefined) {
        let dh = v[5] - m.root.userData.lastHead; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
        roll = Math.max(-0.7, Math.min(0.7, (dh / Math.max(dt, 1e-3)) * (v[1] === 3 ? 0.25 : 0.45))); // bikes lean into turns too
      }
      m.root.userData.lastHead = v[5];
      m.root.userData.roll = (m.root.userData.roll ?? 0) + (roll - (m.root.userData.roll ?? 0)) * Math.min(1, dt * 5);
      m.root.rotation.set(v[6], v[5], m.root.userData.roll, 'YXZ');
      for (const s of m.spin) {
        if (s.name === 'rotor') s.rotation.y += dt * (v[8] ? 28 : 2); else if (s.name === 'tail') s.rotation.x += dt * (v[8] ? 40 : 3); else if (s.name === 'prop') s.rotation.z += dt * (v[8] ? 45 : 1);
        else if (s.name === 'turret' && v[8]) { // the driver's aim, relative to the hull
          const aim = v[8] === this.you ? this.lookYaw : this.infoOf(v[8])?.[4];
          if (aim !== undefined) { let d = aim - v[5]; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; s.rotation.y += (d - s.rotation.y) * Math.min(1, dt * 8); }
        }
      }
    }
    for (const [id, m] of this.vmodels) if (!seen.has(id)) { this.ink.scene.remove(m.root); this.vmodels.delete(id); }
  }

  private updatePrompt() {
    this.prompt = '';
    const p = this.pred, me = this.self;
    if (!p || !me?.alive || p.gliding) return;
    if (p.ride || p.down > 0) return; // the vehicle panel shows how to get out
    for (const id of this.mates) {
      const o = this.infoOf(id);
      if (o && o[7] & OTHER_DOWN && Math.hypot(o[1] - p.x, o[3] - p.z) < KNOCK.reach && Math.abs(o[2] - p.y) < 1.6) { this.prompt = 'hold E · revive your teammate'; return; }
    }
    for (const v of this.vehiclesNow) {
      const def = VEHICLES[VEHICLE_KINDS[v[1]]], name = ['car', 'helicopter', 'plane', 'motorbike', 'tank'][v[1]];
      if (Math.hypot(v[2] - p.x, v[4] - p.z) > def.reach || Math.abs(v[3] - p.y) > 2.5) continue;
      if (!v[8]) this.prompt = `E · ${v[1] === 1 || v[1] === 2 ? `fly the ${name}` : v[1] === 3 ? 'ride the motorbike' : `drive the ${name}`}`;
      else if (this.mates.has(v[8]) && (v[9] ?? 0) < def.seats) this.prompt = `E · ride in your teammate's ${name}`;
    }
    let best = INTERACT_R, text = '';
    for (const c of this.cases.values()) {
      if (c.d[5] || Math.abs(c.d[2] - p.y) > 1.6) continue;
      const d = Math.hypot(c.d[1] - p.x, c.d[3] - p.z);
      if (d < best) { best = d; text = c.d[4] ? 'E · open the GOLDEN pencil case' : 'E · open pencil case'; }
    }
    if (!text) for (const l of this.loot.values()) {
      if (l.d[4] !== 0 || Math.abs(l.d[2] - p.y) > 1.6) continue;
      const d = Math.hypot(l.d[1] - p.x, l.d[3] - p.z);
      if (d < best) {
        best = d;
        const full = !me.slots.includes(null);
        text = `E · ${full ? 'swap for' : 'pick up'} ${WEAPONS[l.d[5] as WeaponId].name} <i style="color:${RARITY_CSS[WEAPONS[l.d[5] as WeaponId].rarity]}">${WEAPONS[l.d[5] as WeaponId].rarity}</i>`;
      }
    }
    if (!text && this.world) for (const u of this.world.upgrades) {
      if (Math.hypot(u.x - p.x, u.z - p.z) < 2.4 && Math.abs(u.y - 0.95 - p.y) < 1.6) {
        const w = me.slots[me.cur];
        text = w ? (me.ups[me.cur] >= 3 ? `${WEAPONS[w].name} is maxed out ★★★` : `E · upgrade your ${WEAPONS[w].name} at the bench <i style="color:#e8a317">${'★'.repeat(me.ups[me.cur] + 1)}</i>`) : '';
      }
    }
    if (text) this.prompt = text;
  }

  // ---------------- frame ----------------
  frame(dt: number, look: { yaw: number; pitch: number; aim: boolean }) {
    this.lookYaw = look.yaw;
    if (!this.world) return;
    this.time += dt;
    const cam = this.ink.camera;
    const { others, tick } = this.interpolated();
    this.viewTick = tick;
    this.offset.multiplyScalar(Math.exp(-dt * 12));

    const me = this.self;
    if (me && me.alive && this.pred) {
      const k = Math.min(1, (performance.now() / 1000 - this.lastTickAt) / DT);
      const pos = this.prevPos.clone().lerp(new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z), k).add(this.offset);
      const crouch = this.pred.slideT > 0 ? -0.6 : 0;
      const speed = Math.hypot(this.pred.vx, this.pred.vz);
      if (this.pred.grounded && speed > 1) this.bob += dt * speed * (speed > 7.4 ? 2.1 : 1.6);
      if (this.pred.seat && me) {
        const v = this.vehiclesNow.find((x) => x[0] === me.rideV);
        if (v) pos.set(v[2], v[3], v[4]);
      }
      if (this.pred.ride) {
        // third person chase camera, orbiting with the mouse; pulls back with speed
        const air = isAir(this.pred.ride), dist = (air ? 12 : this.pred.ride === 5 ? 10 : this.pred.ride === 4 ? 5.5 : 7.5) + Math.min(6, Math.abs(this.pred.spd) * 0.08), cp = Math.cos(look.pitch);
        const tgt = pos.clone().add(new THREE.Vector3(0, air ? 2.4 : this.pred.ride === 5 ? 3.2 : 1.8, 0));
        const back = new THREE.Vector3(Math.sin(look.yaw) * cp, -Math.sin(look.pitch), Math.cos(look.yaw) * cp).multiplyScalar(dist);
        const eye = tgt.clone().add(back);
        if (eye.y < tgt.y - 1) eye.y = tgt.y - 1;
        if (eye.y < 0.5) eye.y = 0.5;
        cam.position.copy(eye);
        cam.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
      } else {
        cam.position.copy(pos.add(new THREE.Vector3(0, (this.pred.down > 0 ? KNOCK.eye : EYE_H + crouch) + Math.sin(this.bob) * (speed > 7.4 ? 0.07 : 0.04), 0)));
        cam.rotation.set(look.pitch, look.yaw, this.pred.slideT > 0 ? 0.06 : this.pred.down > 0 ? 0.12 : 0, 'YXZ');
      }
      const w = this.weapon;
      const zoom = look.aim && w ? WEAPONS[w].zoom : 1;
      // speed reads as a wider view: sprinting, sliding, dashing and swinging all open the lens
      const sprinting = this.pred.grounded && speed > 7.4 && this.pred.slideT <= 0;
      const fov = 78 / zoom + (this.pred.dashT > 0 || this.pred.hook ? 8 : sprinting || this.pred.slideT > 0 ? 7 : 0);
      if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 14); cam.updateProjectionMatrix(); }
    } else if (this.free) {
      cam.position.copy(this.free);
      cam.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
      if (cam.fov !== 78) { cam.fov = 78; cam.updateProjectionMatrix(); }
    } else {
      const target = (this.watch !== null && others.get(this.watch)) || [...others.values()][0];
      if (target) {
        const back = new THREE.Vector3(Math.sin(target[4]) * 4.5, 2.4, Math.cos(target[4]) * 4.5);
        cam.position.lerp(new THREE.Vector3(target[1], target[2], target[3]).add(back), Math.min(1, dt * 6));
        cam.lookAt(target[1], target[2] + 1.4, target[3]);
      }
      if (cam.fov !== 78) { cam.fov = 78; cam.updateProjectionMatrix(); }
    }

    // players
    const seen = new Set<number>();
    const v = new THREE.Vector3();
    for (const o of others.values()) {
      if (!(o[7] & OTHER_ALIVE) || o[7] & OTHER_RIDE) continue;
      seen.add(o[0]);
      const a = this.avatar(o[0]);
      a.root.visible = true;
      poseFigure(a, o[1], o[2], o[3], o[4], o[5], o[8] >= 0 ? WEAPON_IDS[o[8]] : null, !!(o[7] & OTHER_SLIDE), !!(o[7] & OTHER_GLIDE), this.leader?.[0] === o[0], dt, !!(o[7] & OTHER_DOWN), !!(o[7] & OTHER_AXE));
      const d = a.root.position.distanceTo(cam.position);
      v.set(o[1], o[2] + 2.5, o[3]).project(cam);
      const mate = this.mates.has(o[0]);
      // teammates are marked everywhere, through walls, with how far away they are
      const num = this.seats.get(o[0])?.num ?? '', knocked = !!(o[7] & OTHER_DOWN);
      const shown = (this.hitUntil.get(o[0]) ?? 0) > this.time;
      const hpk = Math.max(0, Math.min(1, o[6] / (knocked ? KNOCK.hp : PLAYER_HP)));
      const html = mate ? `${num}${d > 25 ? ` · ${Math.round(d)}m` : ''}${knocked ? ' · <b>knocked</b>' : ''}`
        : shown ? `${num}<span class="hpbar ${knocked ? 'knocked' : ''}"><i style="width:${Math.round(hpk * 100)}%"></i></span>` : num;
      if (a.html !== html) { a.tag.innerHTML = html; a.html = html; }
      if ((d < 50 || mate || shown) && v.z < 1) {
        a.tag.style.display = 'block';
        a.tag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
      } else a.tag.style.display = 'none';
    }
    for (const [id, a] of this.avatars) if (!seen.has(id)) { a.root.visible = false; a.tag.style.display = 'none'; }

    // loot bobs and spins; a rarity-coloured beam marks it from afar
    const bp = this.beamGeo.getAttribute('position') as THREE.BufferAttribute, bc = this.beamGeo.getAttribute('color') as THREE.BufferAttribute;
    let bn = 0;
    for (const l of this.loot.values()) {
      const item = l.g.getObjectByName('item');
      if (item) { item.rotation.y += dt * 1.2; item.position.y = (l.d[4] === 0 ? 0.35 : 0.1) + Math.sin(this.time * 2.5 + l.phase) * 0.06; }
      const rar = lootRarity(l.d[4], l.d[5]);
      if (bn < 400 && (rar !== 'common' || l.d[4] !== 0)) {
        const c = RARITY_RGB[rar], h = rar === 'legendary' ? 6 : rar === 'epic' ? 4 : 2.2;
        bp.setXYZ(bn * 2, l.d[1], l.d[2] + 0.1, l.d[3]); bp.setXYZ(bn * 2 + 1, l.d[1], l.d[2] + h, l.d[3]);
        bc.setXYZ(bn * 2, c[0], c[1], c[2]); bc.setXYZ(bn * 2 + 1, c[0], c[1], c[2]);
        bn++;
      }
    }
    bp.needsUpdate = true; bc.needsUpdate = true;
    this.beamGeo.setDrawRange(0, bn * 2);
    for (const c of this.cases.values()) {
      const target = c.d[5] ? 1 : 0;
      c.open += (target - c.open) * Math.min(1, dt * 6);
      c.lid.rotation.x = -c.open * 1.9;
      const star = c.root.getObjectByName('star');
      if (star) { star.rotation.y += dt * 2; star.visible = !c.d[5]; star.position.y = 0.95 + Math.sin(this.time * 3) * 0.08; }
    }
    for (const f of this.fx.values()) if (f.kind === 'grenade') f.g.rotation.x += dt * 8;
    for (const b of this.builds.values()) for (const m of b.meshes) m.scale.y = Math.min(1, m.scale.y + dt * 5);
    this.falling = this.falling.filter((f) => {
      f.t += dt;
      if (f.land !== undefined) { // a loose piece: real gravity, gone in a puff when it hits the ground
        f.v += 24 * dt; f.g.position.y -= f.v * dt;
        if (f.land + f.g.position.y <= 0.05 || f.t > 3) {
          if (f.dust) { const p = new THREE.Box3().setFromObject(f.g).getCenter(new THREE.Vector3()); this.onBoom(p.x, Math.max(0.5, p.y), p.z, 3.5, false); }
          this.ink.scene.remove(f.g); return false;
        }
        return true;
      }
      f.v += 7 * dt;
      f.g.position.y -= f.v * dt;
      f.g.rotation.x += f.rx * dt; f.g.rotation.z += f.rz * dt;
      if (f.t > 4) { this.ink.scene.remove(f.g); return false; }
      return true;
    });
    this.debris = this.debris.filter((d) => {
      d.t += dt; d.vy -= 24 * dt;
      d.m.position.x += d.vx * dt; d.m.position.y += d.vy * dt; d.m.position.z += d.vz * dt;
      d.m.rotation.x += dt * 6; d.m.rotation.y += dt * 4;
      if (d.m.position.y < 0.15) { d.m.position.y = 0.15; d.vy = Math.abs(d.vy) * 0.3; d.vx *= 0.6; d.vz *= 0.6; }
      if (d.t > 1.6) { this.ink.scene.remove(d.m); d.m.geometry.dispose(); return false; }
      return true;
    });
    this.booms = this.booms.filter((b) => {
      b.t += dt;
      const k = b.t / b.life;
      b.m.scale.setScalar(Math.max(0.1, b.r * Math.min(1, k * 2.5)) * (k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1));
      if (k >= 1) { this.ink.scene.remove(b.m); return false; }
      return true;
    });

    // ropes and tracers
    const rp = this.ropeGeo.getAttribute('position') as THREE.BufferAttribute;
    let rn = 0;
    const rope = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => { if (rn < 200) { rp.setXYZ(rn * 2, x0, y0, z0); rp.setXYZ(rn * 2 + 1, x1, y1, z1); rn++; } };
    if (this.pred?.hook && me?.alive) rope(cam.position.x, cam.position.y - 0.3, cam.position.z, this.pred.gx, this.pred.gy, this.pred.gz);
    for (const o of others.values()) if (o[7] & OTHER_HOOK && o.length >= 12) rope(o[1], o[2] + 1.3, o[3], o[9], o[10], o[11]);
    rp.needsUpdate = true;
    this.ropeGeo.setDrawRange(0, rn * 2);
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

    // first-person gun: sway, bob, recoil, reload dip; hidden while scoped with a sniper, gliding or healing
    const gliding = (!!this.pred?.gliding || !!this.pred?.ride) && !!me?.alive;
    const w = this.weapon;
    const scoped = look.aim && (w === 'heavy' || w === 'hunting');
    for (const [id, g] of this.guns) g.visible = !!me?.alive && w === id && !scoped && !gliding && !me.use && !((this.pred?.down ?? 0) > 0);
    if (this.viewChute) { this.viewChute.visible = gliding && !this.pred?.ride; this.viewChute.rotation.z = Math.sin(this.time * 1.3) * 0.04; }
    const axeOut = !!me?.alive && !!me.axe && !gliding && !me.use && !((this.pred?.down ?? 0) > 0);
    if (this.axeView) {
      this.axeView.visible = axeOut;
      this.axeSwing = Math.max(0, this.axeSwing - dt * 4.5);
      const s = Math.sin(this.axeSwing * Math.PI);
      this.axeView.rotation.set(0.5 - s * 1.5, 0.15, -0.2 + s * 0.3);
      this.axeView.position.set(0.28 - s * 0.1, -0.3 + Math.sin(this.bob) * 0.012, -0.35 - s * 0.15);
    }
    // with the axe out: outline what a swing would hit (the 2 m block a wall breaks into there)
    this.axeAim = null;
    if (this.target) {
      this.target.visible = false;
      if (axeOut && this.world && this.pred) {
        const cp = Math.cos(look.pitch), dx = -Math.sin(look.yaw) * cp, dy = Math.sin(look.pitch), dz = -Math.cos(look.yaw) * cp;
        const ox = this.pred.x, oy = this.pred.y + EYE_H, oz = this.pred.z;
        const hit = this.world.raycastBox(ox, oy, oz, dx, dy, dz, AXE.reach);
        if (hit.i >= 0) {
          const b = this.world.boxes[hit.i], hx = ox + dx * (hit.t + 0.05), hy = oy + dy * (hit.t + 0.05), hz = oz + dz * (hit.t + 0.05);
          let c: Box = b;
          if (!b.hard && !World.isBlock(b)) {
            if (this.shardCache?.i !== hit.i) this.shardCache = { i: hit.i, list: this.world.shards(hit.i) };
            c = this.shardCache.list.find((s) => hx >= s.x0 - 0.01 && hx <= s.x1 + 0.01 && hy >= s.y0 - 0.01 && hy <= s.y1 + 0.01 && hz >= s.z0 - 0.01 && hz <= s.z1 + 0.01) ?? b;
          }
          this.target.scale.set(c.x1 - c.x0 + 0.04, c.y1 - c.y0 + 0.04, c.z1 - c.z0 + 0.04);
          this.target.position.set((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2, (c.z0 + c.z1) / 2);
          (this.target.material as THREE.LineBasicMaterial).color.setHex(b.hard ? 0x7a7f8c : 0xd32336);
          this.target.visible = true;
          const wood = b.kind === 'crate' || b.kind === 'trunk' || b.kind === 'fort' || b.ink === 6, metal = b.kind === 'container' || b.kind === 'car' || b.ink === 2;
          this.axeAim = { mat: b.hard ? 'rock' : wood ? 'wood' : metal ? 'metal' : 'brick', hard: !!b.hard };
        }
      }
    }
    if (this.ghost) {
      this.ghost.visible = false;
      if (axeOut && this.world && this.pred && me.mats >= BUILD.cost) {
        const cp = Math.cos(look.pitch), dx = -Math.sin(look.yaw) * cp, dy = Math.sin(look.pitch), dz = -Math.cos(look.yaw) * cp;
        const c = this.world.placeCell(this.pred.x, this.pred.y + EYE_H, this.pred.z, dx, dy, dz, BUILD.reach);
        if (c) { this.ghost.position.set(c.x0 + 0.5, c.y0 + 0.5, c.z0 + 0.5); this.ghost.visible = true; }
      }
    }
    const g = w ? this.guns.get(w) : null;
    if (g && me && w) {
      this.gunKick = Math.max(0, this.gunKick - dt * 9);
      const reload = me.reloadT > 0 ? Math.sin(Math.min(1, me.reloadT / WEAPONS[w].reload) * Math.PI) : 0;
      const ads = look.aim ? 1 : 0;
      g.position.set(0.2 * (1 - ads), -0.2 + ads * 0.1 - reload * 0.22 + Math.sin(this.bob) * 0.012, -0.5 + this.gunKick * 0.06 + ads * 0.08);
      g.rotation.set(this.gunKick * 0.12 - reload * 0.6, 0, w === 'minigun' ? 0 : 0);
    }

    this.drawVehicles(dt);

    this.placeNames(innerWidth, innerHeight);
    this.updatePrompt();
    // the nearest incoming nuke paints its target on the ground
    const n = this.nukes.sort((a, b) => a.t - b.t)[0];
    this.ink.setDanger(n ? n.x : 0, n ? n.z : 0, n ? NUKE.radius : 0, n ? 0.6 + 0.4 * Math.sin(this.time * 12) : 0);
    this.ink.setStorm(this.ring.x, this.ring.y, this.ring.r, this.ring.nx, this.ring.ny, this.ring.nr);
    this.ink.render(this.time);
  }

  // screen rotation (0 = straight ahead, clockwise) of a world point, for damage indicators
  bearingTo(x: number, z: number, yaw: number) { if (!this.pred) return 0; return yaw + Math.PI - Math.atan2(x - this.pred.x, z - this.pred.z); }
  screenAt(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = new THREE.Vector3(x, y, z).project(this.ink.camera);
    return v.z < 1 ? { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight } : null;
  }
  screenOf(id: number, head: boolean): { x: number; y: number } | null {
    const a = this.avatars.get(id);
    if (!a || !a.root.visible) return null;
    const v = a.root.position.clone().add(new THREE.Vector3(0, head ? 1.8 : 1.2, 0)).project(this.ink.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  }
  positionOf(id: number) { const o = this.snaps.at(-1)?.s.others.find((p) => p[0] === id); return o ? { x: o[1], z: o[3] } : null; }
  get me() { return this.pred; }
  // latest known state of another player: [id, x, y, z, yaw, pitch, hp, flags, weapon]
  infoOf(id: number) { return this.snaps.at(-1)?.s.others.find((p) => p[0] === id) ?? null; }
  // free spectator camera: fly with the move keys, Space up, C down, Shift fast
  startFree() { const c = this.ink.camera.position; this.free = new THREE.Vector3(c.x, Math.max(c.y, 20), c.z); }
  fly(c: { fwd: number; strafe: number; sprint: boolean; jump: boolean; slide: boolean }, yaw: number, pitch: number, dt: number) {
    if (!this.free) return;
    const sp = (c.sprint ? 60 : 24) * dt, cp = Math.cos(pitch);
    this.free.x += (-Math.sin(yaw) * cp * c.fwd + Math.cos(yaw) * c.strafe) * sp;
    this.free.z += (-Math.cos(yaw) * cp * c.fwd - Math.sin(yaw) * c.strafe) * sp;
    this.free.y += (Math.sin(pitch) * c.fwd + (c.jump ? 1 : 0) - (c.slide ? 1 : 0)) * sp;
    const L = MAP_HALF + 60; this.free.x = Math.max(-L, Math.min(L, this.free.x)); this.free.z = Math.max(-L, Math.min(L, this.free.z)); this.free.y = Math.max(2, Math.min(200, this.free.y));
  }
}
