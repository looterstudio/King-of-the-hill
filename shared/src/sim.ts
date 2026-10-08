// Battle royale simulation (first person, 3D, up to 100 players). Authoritative on the server,
// mirrored in the offline demo. Deterministic for a seed; no timers, no I/O.
// Everyone drops with the same four guns, so the better player wins, not the luckier looter.
import {
  EYE_H, GRAVITY, HEADSHOT_MULT, HEAD_R, HEAD_Y, JUMP_V, PLAYER_HP, PLAYER_R, REGEN_DELAY, REGEN_RATE,
  REWIND_MAX_TICKS, RING_DPS_START, RING_PHASES, RING_START_R, SPRINT_SPEED, WALK_SPEED, WEAPONS,
  WEAPON_ORDER, type WeaponId,
} from './constants.ts';
import { rng } from './rng.ts';
import { World, moveBody, newBody, type Body } from './world.ts';

export { rng };

export interface PlayerState extends Body {
  id: number; yaw: number; pitch: number; hp: number; alive: boolean;
  weapon: WeaponId; mag: Record<WeaponId, number>; reloadT: number;
  fireCd: number; sinceHurt: number; kills: number; ack: number;
}
export interface Input {
  seq: number; fwd: number; strafe: number; yaw: number; pitch: number;
  jump: boolean; sprint: boolean; slide: boolean; grapple: boolean;
  fire: boolean; aim: boolean; reload: boolean; slot: number; view: number;
}
export interface Ring { x: number; y: number; r: number; nx: number; ny: number; nr: number; phase: number; closing: boolean; dps: number; nextAt: number }
export interface Shot { ox: number; oy: number; oz: number; ex: number; ey: number; ez: number; by: number; hit: boolean }
export type SimEvent =
  | { kind: 'hit'; victim: number; by: number; dmg: number; head: boolean }
  | { kind: 'elim'; victim: number; by: number | null; cause: 'shot' | 'ring' | 'left'; head: boolean };

export const emptyInput = (): Input => ({ seq: 0, fwd: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, sprint: false, slide: false, grapple: false, fire: false, aim: false, reload: false, slot: 0, view: 0 });
export const fullMags = (): Record<WeaponId, number> => ({ rifle: WEAPONS.rifle.mag, shotgun: WEAPONS.shotgun.mag, sniper: WEAPONS.sniper.mag, pistol: WEAPONS.pistol.mag });

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// inputs come from the network: never trust shape or range
export function sanitizeInput(raw: Partial<Input> | undefined): Input {
  return {
    seq: Math.floor(finite(raw?.seq)), fwd: clamp(finite(raw?.fwd), -1, 1), strafe: clamp(finite(raw?.strafe), -1, 1),
    yaw: finite(raw?.yaw), pitch: clamp(finite(raw?.pitch), -1.5, 1.5),
    jump: raw?.jump === true, sprint: raw?.sprint === true, slide: raw?.slide === true, grapple: raw?.grapple === true, fire: raw?.fire === true, aim: raw?.aim === true, reload: raw?.reload === true,
    slot: clamp(Math.floor(finite(raw?.slot)), 0, 4), view: Math.floor(finite(raw?.view)),
  };
}

export const moveStep = (w: World, p: Body, inp: Input, dt: number) =>
  moveBody(w, p, { ...inp, sprint: inp.sprint && !inp.aim }, dt, GRAVITY, inp.aim ? WALK_SPEED * 0.6 : WALK_SPEED, SPRINT_SPEED, JUMP_V);

// accuracy: aiming tightens it, moving and being airborne loosen it
export function spreadFor(p: Body, w: WeaponId, aim: boolean): number {
  const base = WEAPONS[w].spread, speed = Math.hypot(p.vx, p.vz);
  let s = base * (aim ? (w === 'sniper' ? 0.02 : 0.5) : 1) * (1 + speed / 8);
  if (!p.grounded) s *= 2;
  return s;
}

function nextCircle(r: () => number, x: number, y: number, rad: number, nr: number) {
  const room = Math.max(0, rad - nr), a = r() * Math.PI * 2, d = Math.sqrt(r()) * room;
  return { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d };
}

// ray vs player hitboxes (vertical cylinder body + head sphere); returns {t, head} or null
export function rayPlayer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, px: number, py: number, pz: number): { t: number; head: boolean } | null {
  let best: { t: number; head: boolean } | null = null;
  const hx = ox - px, hy = oy - (py + HEAD_Y), hz = oz - pz;
  const b = hx * dx + hy * dy + hz * dz, c = hx * hx + hy * hy + hz * hz - HEAD_R * HEAD_R, disc = b * b - c;
  if (disc >= 0) { const t = -b - Math.sqrt(disc); if (t >= 0) best = { t, head: true }; }
  const fx = ox - px, fz = oz - pz, a2 = dx * dx + dz * dz;
  if (a2 > 1e-9) {
    const br = fx * dx + fz * dz, cr = fx * fx + fz * fz - (PLAYER_R + 0.05) ** 2, dr = br * br - a2 * cr;
    if (dr >= 0) {
      const t = (-br - Math.sqrt(dr)) / a2, y = oy + dy * t;
      if (t >= 0 && y >= py && y <= py + HEAD_Y - HEAD_R && (!best || t < best.t)) best = { t, head: false };
    }
  }
  return best;
}

export class Sim {
  world: World;
  players = new Map<number, PlayerState>();
  ring: Ring;
  shots: Shot[] = [];   // drained by whoever encodes snapshots
  t = 0;
  tick = 0;
  private rand: () => number;
  private phaseStart = 0;
  private from = { x: 0, y: 0, r: RING_START_R };
  private history: { tick: number; pos: Map<number, { x: number; y: number; z: number }> }[] = [];

  constructor(public seed: number, world?: World) {
    this.world = world ?? new World(seed);
    this.rand = rng(seed ^ 0x9e3779b9);
    const first = RING_PHASES[0], c = nextCircle(this.rand, 0, 0, RING_START_R - 110, first.radius);
    this.ring = { x: 0, y: 0, r: RING_START_R, nx: c.x, ny: c.y, nr: first.radius, phase: 0, closing: false, dps: RING_DPS_START, nextAt: first.wait };
  }

  // everyone drops in from the sky over the island and glides down wherever they like
  spawn(ids: number[]) {
    ids.forEach((id) => {
      const a = this.rand() * Math.PI * 2, d = 40 + Math.sqrt(this.rand()) * 140;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      this.players.set(id, {
        ...newBody(x, 90 + this.rand() * 20, z), gliding: true, id,
        yaw: Math.atan2(x, z), pitch: -0.5, hp: PLAYER_HP, alive: true,
        weapon: 'rifle', mag: fullMags(), reloadT: 0, fireCd: 0.5, sinceHurt: 99, kills: 0, ack: 0,
      });
    });
  }

  get alive() { let n = 0; for (const p of this.players.values()) if (p.alive) n++; return n; }

  eliminate(id: number, by: number | null, cause: 'shot' | 'ring' | 'left', ev: SimEvent[], head = false) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false; p.hp = 0;
    if (by !== null) { const k = this.players.get(by); if (k) k.kills++; }
    ev.push({ kind: 'elim', victim: id, by, cause, head });
  }

  private stepRing() {
    const ring = this.ring, phase = RING_PHASES[ring.phase];
    if (!phase) return;
    const since = this.t - this.phaseStart;
    if (since < phase.wait) { ring.closing = false; ring.nextAt = this.phaseStart + phase.wait; return; }
    ring.closing = true;
    const k = Math.min(1, (since - phase.wait) / phase.shrink);
    ring.x = this.from.x + (ring.nx - this.from.x) * k;
    ring.y = this.from.y + (ring.ny - this.from.y) * k;
    ring.r = this.from.r + (ring.nr - this.from.r) * k;
    ring.nextAt = this.phaseStart + phase.wait + phase.shrink;
    if (k >= 1) {
      ring.dps = phase.dps; ring.phase++; this.phaseStart = this.t;
      this.from = { x: ring.x, y: ring.y, r: ring.r };
      const next = RING_PHASES[ring.phase];
      if (next) { const c = nextCircle(this.rand, ring.x, ring.y, ring.r, next.radius); ring.nx = c.x; ring.ny = c.y; ring.nr = next.radius; }
    }
  }

  private hurt(p: PlayerState, amount: number) { p.hp -= amount; p.sinceHurt = 0; }

  // where everyone was at a past tick, for lag-compensated hits
  private positionsAt(tick: number) { return this.history.find((e) => e.tick === tick)?.pos ?? null; }

  private fire(p: PlayerState, inp: Input, ev: SimEvent[]) {
    const w = WEAPONS[p.weapon];
    p.fireCd = w.cd;
    p.mag[p.weapon]--;
    const spread = spreadFor(p, p.weapon, inp.aim);
    const view = clamp(inp.view, this.tick - REWIND_MAX_TICKS, this.tick);
    const past = this.positionsAt(view);
    const ox = p.x, oy = p.y + EYE_H, oz = p.z;
    for (let i = 0; i < w.pellets; i++) {
      const yaw = p.yaw + (this.rand() - 0.5) * 2 * spread, pitch = p.pitch + (this.rand() - 0.5) * 2 * spread;
      const cp = Math.cos(pitch), dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
      const tWorld = this.world.raycast(ox, oy, oz, dx, dy, dz, w.range);
      let hit: { t: number; head: boolean; q: PlayerState } | null = null;
      for (const q of this.players.values()) {
        if (!q.alive || q.id === p.id) continue;
        const at = past?.get(q.id) ?? q;
        if (Math.abs(at.x - ox) > w.range || Math.abs(at.z - oz) > w.range) continue;
        const h = rayPlayer(ox, oy, oz, dx, dy, dz, at.x, at.y, at.z);
        if (h && h.t < tWorld && (!hit || h.t < hit.t)) hit = { ...h, q };
      }
      const t = hit ? hit.t : tWorld;
      this.shots.push({ ox, oy, oz, ex: ox + dx * t, ey: oy + dy * t, ez: oz + dz * t, by: p.id, hit: !!hit });
      if (hit && hit.q.alive) {
        const dmg = w.dmg * (hit.head ? HEADSHOT_MULT : 1);
        this.hurt(hit.q, dmg);
        ev.push({ kind: 'hit', victim: hit.q.id, by: p.id, dmg: Math.round(dmg), head: hit.head });
        if (hit.q.hp <= 0) this.eliminate(hit.q.id, p.id, 'shot', ev, hit.head);
      }
    }
  }

  step(dt: number, inputs: Map<number, Input>): SimEvent[] {
    const ev: SimEvent[] = [];
    this.t += dt; this.tick++;
    this.stepRing();
    const ring = this.ring;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const inp = inputs.get(p.id) ?? { ...emptyInput(), yaw: p.yaw, pitch: p.pitch };
      p.ack = inp.seq;
      p.yaw = inp.yaw; p.pitch = inp.pitch;
      p.fireCd = Math.max(0, p.fireCd - dt);
      p.sinceHurt += dt;

      if (inp.slot >= 1 && inp.slot <= 4 && WEAPON_ORDER[inp.slot - 1] !== p.weapon) {
        p.weapon = WEAPON_ORDER[inp.slot - 1]; p.reloadT = 0; p.fireCd = Math.max(p.fireCd, 0.25); // swapping cancels a reload
      }
      const def = WEAPONS[p.weapon];
      if (p.reloadT > 0) { p.reloadT -= dt; if (p.reloadT <= 0) { p.reloadT = 0; p.mag[p.weapon] = def.mag; } }
      else if ((inp.reload && p.mag[p.weapon] < def.mag) || (inp.fire && p.mag[p.weapon] === 0)) p.reloadT = def.reload;

      moveStep(this.world, p, inp, dt);
      if (inp.fire && p.fireCd === 0 && p.reloadT === 0 && p.mag[p.weapon] > 0 && !p.gliding) this.fire(p, inp, ev);

      if (p.sinceHurt > REGEN_DELAY && p.hp < PLAYER_HP) p.hp = Math.min(PLAYER_HP, p.hp + REGEN_RATE * dt);
      if (Math.hypot(p.x - ring.x, p.z - ring.y) > ring.r) {
        this.hurt(p, ring.dps * dt);
        if (p.hp <= 0) this.eliminate(p.id, null, 'ring', ev);
      }
    }

    const pos = new Map<number, { x: number; y: number; z: number }>();
    for (const p of this.players.values()) if (p.alive) pos.set(p.id, { x: p.x, y: p.y, z: p.z });
    this.history.push({ tick: this.tick, pos });
    if (this.history.length > REWIND_MAX_TICKS + 2) this.history.shift();
    return ev;
  }
}
