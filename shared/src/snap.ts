// Snapshot encoding, shared by the server and the offline demo. Work that is the same for every
// recipient (rounding, packing) happens once per tick; each recipient then only gets their own
// full state plus what is near them. Loot and cases go out at most a few times a second.
import { VIEW_RANGE, WEAPON_IDS } from './constants.ts';
import { OTHER_ALIVE, OTHER_GLIDE, OTHER_HEAL, OTHER_HOOK, OTHER_SLIDE, type ServerMsg, type SnapCase, type SnapFx, type SnapLoot, type SnapOther, type SnapRing, type SnapSelf } from './protocol.ts';
import type { PlayerState, Sim } from './sim.ts';

const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
type Snap = Extract<ServerMsg, { t: 'snap' }>;
const LOOT_R = 60, CASE_R = 120;
const KIND = { weapon: 0, item: 1, perk: 2 } as const;

export interface Frame {
  tick: number; time: number; alive: number; ring: SnapRing; others: Map<number, SnapOther>; shots: number[][];
  leader: [number, number] | null; fx: SnapFx[]; loot: SnapLoot[]; cases: SnapCase[]; lootVer: number; sim: Sim;
}

export function frame(sim: Sim): Frame {
  const g = sim.ring;
  const others = new Map<number, SnapOther>();
  let leader: [number, number] | null = null;
  for (const p of sim.players.values()) {
    if (p.kills > 0 && p.alive && (!leader || p.kills > leader[1])) leader = [p.id, p.kills];
    if (!p.alive) continue;
    const flags = OTHER_ALIVE | (p.slideT > 0 ? OTHER_SLIDE : 0) | (p.hook ? OTHER_HOOK : 0) | (p.gliding ? OTHER_GLIDE : 0) | (p.use ? OTHER_HEAL : 0);
    const w = p.slots[p.cur];
    const o = [p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.pitch), Math.ceil(p.hp), flags, w ? WEAPON_IDS.indexOf(w) : -1];
    if (p.hook) o.push(r1(p.gx), r1(p.gy), r1(p.gz));
    others.set(p.id, o);
  }
  const shots = sim.shots.map((s) => [r1(s.ox), r1(s.oy), r1(s.oz), r1(s.ex), r1(s.ey), r1(s.ez), s.by, s.hit ? 1 : 0]);
  sim.shots.length = 0;
  const fx: SnapFx[] = [
    ...sim.projectiles.map((p): SnapFx => [p.kind, p.id, r1(p.x), r1(p.y), r1(p.z), r1(p.t)]),
    ...sim.effects.map((e): SnapFx => [e.kind, e.id, r1(e.x), r1(e.y), r1(e.z), r1(e.t)]),
  ];
  return {
    sim, tick: sim.tick, time: r2(sim.t), alive: sim.alive, others, shots, leader, fx, lootVer: sim.lootVer,
    loot: sim.loot.map((l): SnapLoot => [l.id, r1(l.x), r1(l.y), r1(l.z), KIND[l.kind], l.what, l.n]),
    cases: sim.cases.map((c): SnapCase => [c.id, r1(c.x), r1(c.y), r1(c.z), c.golden ? 1 : 0, c.open ? 1 : 0]),
    ring: { x: r1(g.x), y: r1(g.y), r: r1(g.r), nx: r1(g.nx), ny: r1(g.ny), nr: r1(g.nr), closing: g.closing, nextIn: Math.max(0, Math.ceil(g.nextAt - sim.t)), phase: g.phase },
  };
}

function selfOf(p: PlayerState): SnapSelf {
  return {
    x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, grounded: p.grounded, gliding: p.gliding,
    airJumps: p.airJumps, wallX: p.wallX, wallZ: p.wallZ, wallT: Math.min(p.wallT, 9), slideT: p.slideT, dashT: p.dashT, dashX: p.dashX, dashZ: p.dashZ,
    dashReady: p.dashReady, hook: p.hook, gx: p.gx, gy: p.gy, gz: p.gz, hookCd: p.hookCd, launchT: p.launchT,
    yaw: p.yaw, pitch: p.pitch, hp: Math.max(0, Math.ceil(p.hp)), shield: Math.ceil(p.shield), alive: p.alive,
    slots: [...p.slots], mags: [...p.mags], cur: p.cur, items: { ...p.items }, perk: p.perk ? { ...p.perk } : null,
    use: p.use ? { item: p.use.item, t: r2(p.use.t) } : null, reloadT: r2(p.reloadT), spin: r2(p.spin), ack: p.ack, kills: p.kills,
  };
}

// per-recipient bookkeeping so loot is only resent when it changed (and not too often)
export interface Viewer { lootVer: number; lootAt: number }

// `watch` is where the recipient is looking from: themselves, or the player they spectate
export function snapFor(f: Frame, recipient: number, watch: number, viewer: Viewer): Snap {
  const me = f.sim.players.get(recipient);
  const center = f.sim.players.get(watch) ?? me;
  const cx = center?.x ?? 0, cz = center?.z ?? 0, far = !center;
  const near = (x: number, z: number, r: number) => far || (Math.abs(x - cx) < r && Math.abs(z - cz) < r);
  const others: SnapOther[] = [];
  for (const [id, o] of f.others) if (id !== recipient && near(o[1], o[3], VIEW_RANGE)) others.push(o);
  const msg: Snap = {
    t: 'snap', tick: f.tick, time: f.time, alive: f.alive, ring: f.ring, self: me ? selfOf(me) : null, others, leader: f.leader,
    shots: f.shots.filter((s) => near(s[0], s[2], VIEW_RANGE)),
    fx: f.fx.filter((e) => e[0] === 'nuke' || near(e[2], e[4], VIEW_RANGE)),
  };
  const moved = f.time - viewer.lootAt;
  if ((viewer.lootVer !== f.lootVer && moved > 0.3) || moved > 1) {
    msg.loot = f.loot.filter((l) => near(l[1], l[3], LOOT_R));
    msg.cases = f.cases.filter((c) => near(c[1], c[3], CASE_R));
    viewer.lootVer = f.lootVer; viewer.lootAt = f.time;
  }
  return msg;
}
