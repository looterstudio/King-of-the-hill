// Demo-only autopilot for the gameplay recording (scripts/record-gameplay.mjs): the bots' own brain
// plays your seat, through the same input path as your keyboard and mouse, so the camera, the HUD and
// the prediction all behave exactly as they do for a person. Loaded only on #autotest in the demo build.
import { botInput, newBot, type Bot } from '../../shared/src/bots.ts';
import type { Sim } from '../../shared/src/sim.ts';
import type { FpsInput } from './fpsinput.ts';
import type { LocalNet } from './local.ts';

export interface AutopilotOpts {
  skill?: number;  // 0.3 to 0.85 for the bots; higher aims and reacts better
  smooth?: number; // how much of the turn the camera makes per tick (1 = snap, as the bots do)
  tough?: number;  // health the pilot never drops under (0 = off): keeps a short recording going
}

const angDiff = (a: number, b: number) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

// the busiest drop early on the plane's line: where most bots plan to land, so the fight comes to us
// soon, and not so far along that the clip spends its first half on the plane
function busiestDrop(bots: Bot[], sim: Sim): { x: number; z: number } {
  const B = sim.bus;
  let best = { x: 0, z: 0 }, most = -Infinity;
  for (const b of bots) {
    const along = B ? (b.dropX - B.x) * B.dx + (b.dropZ - B.z) * B.dz : 0, side = B ? Math.abs(-(b.dropX - B.x) * B.dz + (b.dropZ - B.z) * B.dx) : 0;
    if (B && (along < 60 || side > 140)) continue;
    let n = 0;
    for (const o of bots) if (Math.hypot(o.dropX - b.dropX, o.dropZ - b.dropZ) < 70) n++;
    const score = n - Math.max(0, along - 250) / 40;
    if (score > most) { most = score; best = { x: b.dropX, z: b.dropZ }; }
  }
  return best;
}

export function autopilot(net: LocalNet, input: FpsInput, opts: AutopilotOpts = {}) {
  const room = net.room, sim = room?.sim as Sim | null | undefined;
  if (!room || !sim) throw new Error('autopilot: no match running');
  const me = room.seats.find((s) => !s.bot)?.id ?? 1;
  const bot = newBot(me, Math.random);
  bot.skill = opts.skill ?? 0.95;
  const drop = busiestDrop(room.bots, sim);
  bot.dropX = drop.x + 6; bot.dropZ = drop.z + 6; bot.wp = { x: bot.dropX, z: bot.dropZ }; bot.dest = { ...bot.wp };
  const smooth = opts.smooth ?? 0.4, tough = opts.tough ?? 0;
  const status = { mode: 'plane', kills: 0, alive: true, x: 0, z: 0 };
  input.sample = () => {
    const self = sim.players.get(me);
    if (!self || !self.alive) { status.alive = false; return { fwd: 0, strafe: 0, sprint: false, grapple: false, jump: false, slide: false, reload: false, slot: 0, up: 0, interact: false, perk: false, item: 0, hold: false, build: false, fire: false, aim: false, yaw: input.yaw, pitch: input.pitch }; }
    if (tough && self.hp < tough) self.hp = tough;
    const i = botInput(bot, sim);
    const firing = i.fire || i.aim;
    const k = firing ? Math.max(smooth, 0.75) : smooth;
    input.yaw += angDiff(i.yaw, input.yaw) * k;
    input.pitch += (i.pitch - input.pitch) * k;
    input.aim = i.aim; input.fire = i.fire;
    status.mode = self.bus ? 'plane' : bot.mode; status.kills = self.kills; status.x = self.x; status.z = self.z;
    return {
      fwd: i.fwd, strafe: i.strafe, sprint: i.sprint, grapple: i.grapple, jump: i.jump, slide: i.slide, reload: i.reload,
      slot: i.slot, up: i.up, interact: i.interact, perk: i.perk, item: i.item, hold: i.hold, build: false,
      fire: i.fire, aim: i.aim, yaw: firing ? i.yaw : input.yaw, pitch: firing ? i.pitch : input.pitch,
    };
  };
  return status;
}
