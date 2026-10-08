// Snapshot encoding, shared by the server and the offline demo. Work that is the same for every
// recipient (rounding, packing) happens once per tick; each recipient then only gets their own
// full state plus the players and shots within VIEW_RANGE of them.
import { VIEW_RANGE, WEAPON_ORDER } from './constants.ts';
import { OTHER_ALIVE, OTHER_GLIDE, OTHER_HOOK, OTHER_SLIDE, type ServerMsg, type SnapOther, type SnapRing, type SnapSelf } from './protocol.ts';
import type { PlayerState, Sim } from './sim.ts';

const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
type Snap = Extract<ServerMsg, { t: 'snap' }>;

export interface Frame { tick: number; time: number; alive: number; ring: SnapRing; others: Map<number, SnapOther>; shots: number[][]; sim: Sim }

export function frame(sim: Sim): Frame {
  const g = sim.ring;
  const others = new Map<number, SnapOther>();
  for (const p of sim.players.values()) {
    if (!p.alive) continue;
    const flags = OTHER_ALIVE | (p.slideT > 0 ? OTHER_SLIDE : 0) | (p.hook ? OTHER_HOOK : 0) | (p.gliding ? OTHER_GLIDE : 0);
    const o = [p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.pitch), Math.ceil(p.hp), flags, WEAPON_ORDER.indexOf(p.weapon)];
    if (p.hook) o.push(r1(p.gx), r1(p.gy), r1(p.gz));
    others.set(p.id, o);
  }
  const shots = sim.shots.map((s) => [r1(s.ox), r1(s.oy), r1(s.oz), r1(s.ex), r1(s.ey), r1(s.ez), s.by, s.hit ? 1 : 0]);
  sim.shots.length = 0;
  return {
    sim, tick: sim.tick, time: r2(sim.t), alive: sim.alive, others, shots,
    ring: { x: r1(g.x), y: r1(g.y), r: r1(g.r), nx: r1(g.nx), ny: r1(g.ny), nr: r1(g.nr), closing: g.closing, nextIn: Math.max(0, Math.ceil(g.nextAt - sim.t)), phase: g.phase },
  };
}

function selfOf(p: PlayerState): SnapSelf {
  return {
    x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, grounded: p.grounded, gliding: p.gliding,
    airJumps: p.airJumps, wallX: p.wallX, wallZ: p.wallZ, wallT: Math.min(p.wallT, 9), slideT: p.slideT, dashT: p.dashT, dashX: p.dashX, dashZ: p.dashZ,
    dashReady: p.dashReady, hook: p.hook, gx: p.gx, gy: p.gy, gz: p.gz, hookCd: p.hookCd,
    yaw: p.yaw, pitch: p.pitch, hp: Math.max(0, Math.ceil(p.hp)), alive: p.alive, weapon: p.weapon,
    mag: [p.mag.rifle, p.mag.shotgun, p.mag.sniper, p.mag.pistol], reloadT: r2(p.reloadT), ack: p.ack, kills: p.kills,
  };
}

// `watch` is where the recipient is looking from: themselves, or the player they spectate
export function snapFor(f: Frame, recipient: number, watch: number): Snap {
  const me = f.sim.players.get(recipient);
  const center = f.sim.players.get(watch) ?? me;
  const cx = center?.x ?? 0, cz = center?.z ?? 0, far = !center;
  const others: SnapOther[] = [];
  for (const [id, o] of f.others) if (id !== recipient && (far || (Math.abs(o[1] - cx) < VIEW_RANGE && Math.abs(o[3] - cz) < VIEW_RANGE))) others.push(o);
  const shots = f.shots.filter((s) => far || (Math.abs(s[0] - cx) < VIEW_RANGE && Math.abs(s[2] - cz) < VIEW_RANGE));
  return { t: 'snap', tick: f.tick, time: f.time, alive: f.alive, ring: f.ring, self: me ? selfOf(me) : null, others, shots };
}
