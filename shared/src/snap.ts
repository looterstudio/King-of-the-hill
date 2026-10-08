// One snapshot encoder for the server and the offline demo, so both send exactly the same shape.
import type { ServerMsg, SnapLoot } from './protocol.ts';
import type { Sim } from './sim.ts';

const r1 = (v: number) => Math.round(v * 10) / 10;

export function encodeSnap(sim: Sim, tick: number, withLoot: boolean): Extract<ServerMsg, { t: 'snap' }> {
  const g = sim.ring;
  const msg: Extract<ServerMsg, { t: 'snap' }> = {
    t: 'snap', tick, time: r1(sim.t),
    ring: { x: r1(g.x), y: r1(g.y), r: r1(g.r), nx: r1(g.nx), ny: r1(g.ny), nr: r1(g.nr), closing: g.closing, nextIn: Math.max(0, Math.ceil(g.nextAt - sim.t)), phase: g.phase },
    players: [...sim.players.values()].map((p) => ({
      id: p.id, x: r1(p.x), y: r1(p.y), aim: Math.round(p.aim * 100) / 100, hp: Math.max(0, Math.ceil(p.hp)), armor: Math.ceil(p.armor),
      alive: p.alive, dash: p.dashT > 0, weapon: p.weapon, ammo: Number.isFinite(p.ammo) ? p.ammo : -1,
    })),
    bullets: sim.bullets.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), vx: r1(b.vx), vy: r1(b.vy) })),
  };
  if (withLoot) msg.loot = sim.loot.map((l): SnapLoot => ({ id: l.id, x: r1(l.x), y: r1(l.y), kind: l.kind }));
  return msg;
}
