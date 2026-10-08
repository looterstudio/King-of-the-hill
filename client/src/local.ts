// Offline demo transport: plays the server's role inside the browser with bots and a simulated
// fee stream. Same Sim, same snapshots, same input queue semantics, so the UI under test is real.
import {
  COUNTDOWN_MS, EYE_H, HEAD_Y, RESULT_MS, ROOM_MAX, SNAP_EVERY, TICK_HZ, WEAPONS, WEAPON_ORDER, epochEnd, epochOf, playerNumber,
} from '../../shared/src/constants.ts';
import type { ClientMsg, RoomSeat, ServerMsg } from '../../shared/src/protocol.ts';
import { Sim, emptyInput, sanitizeInput, type Input, type PlayerState } from '../../shared/src/sim.ts';
import { frame, snapFor } from '../../shared/src/snap.ts';

type Handler = (m: ServerMsg) => void;
const NAMES = ['degen.sol', 'wagmi', 'ser_pump', 'rugless', 'bonkbro', 'paperhand', 'diamond', 'jeet', 'moonboi', 'gmgm', 'solchad', 'wifhat', 'ape420', 'fomo', 'ngmi', 'rekt', 'gigabrain', 'anon', 'whale', 'hodl'];
const fakeWallet = () => Array.from({ length: 44 }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 58)]).join('');
export const DEMO_PLAYERS = 40;

interface Bot { id: number; skill: number; strafe: number; aimErr: number; reaction: number; target: number | null; los: boolean; losT: number; wp: { x: number; z: number }; stuck: number; seq: number; dropX: number; dropZ: number }

export class LocalNet {
  private handlers: Handler[] = [];
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private lamports = 7_400_000_000n;
  private tickets = new Map<string, { name: string; wins: number }>();
  private me: RoomSeat | null = null;
  private myWallet = fakeWallet();
  private queue: Input[] = [];
  private last: Input = emptyInput();
  private room: { id: string; seed: number; seats: RoomSeat[]; bots: Bot[]; sim: Sim | null; timers: number[] } | null = null;
  private loop = 0;
  private killer: number | null = null;

  constructor() { for (let i = 0; i < 6; i++) this.tickets.set(fakeWallet(), { name: NAMES[i], wins: 6 - i + Math.floor(Math.random() * 3) }); }

  on(h: Handler) { this.handlers.push(h); }
  private emit(m: ServerMsg) { for (const h of this.handlers) h(m); }

  connect() {
    setTimeout(() => { this.onOpen?.(); this.emit({ t: 'hello', nonce: 'demo', requireWallet: false, allowGuests: true, holdMinUsd: 50 }); this.emitPot(); }, 50);
    setInterval(() => this.emitPot(), 2000);
    const fee = () => {
      const whale = Math.random() < 0.08, sol = whale ? 0.4 + Math.random() * 2.2 : 0.004 + Math.random() * 0.07, add = BigInt(Math.round(sol * 1e9));
      this.lamports += add;
      this.emit({ t: 'inflow', inflow: { lamports: add.toString(), at: Date.now(), source: whale ? 'whale buy' : 'trading fees' } });
      setTimeout(fee, 1200 + Math.random() * 3000);
    };
    setTimeout(fee, 900);
  }

  private emitPot() {
    const epoch = epochOf(Date.now());
    const top = [...this.tickets.entries()].map(([wallet, t]) => ({ wallet, name: t.name, wins: t.wins })).sort((a, b) => b.wins - a.wins).slice(0, 8);
    this.emit({ t: 'pot', pot: { epoch, epochEndMs: epochEnd(epoch), lamports: this.lamports.toString(), rolloverLamports: '0', commit: '', online: 1287 + Math.floor(Math.random() * 40), rooms: 31 + Math.floor(Math.random() * 4), tickets: top } });
  }

  send(m: ClientMsg) {
    switch (m.t) {
      case 'guest': {
        const name = (m.name || 'guest').slice(0, 14);
        this.me = { id: 1, num: playerNumber(Math.floor(Math.random() * 456)), name, verified: true };
        this.emit({ t: 'authed', name, wallet: this.myWallet, num: this.me.num });
        break;
      }
      case 'queue': if (this.me && !this.room) this.openRoom(); break;
      case 'leave': this.closeRoom(); break;
      case 'in': this.queue.push(sanitizeInput(m)); if (this.queue.length > 10) this.queue.shift(); break;
    }
  }

  private announce(state: 'waiting' | 'countdown' | 'live' | 'over', startsAt: number | null) {
    const r = this.room!;
    this.emit({ t: 'room', roomId: r.id, you: 1, seats: r.seats, state, startsAt, seed: r.seed });
  }

  private openRoom() {
    const room = { id: Math.random().toString(16).slice(2, 10), seed: Math.floor(Math.random() * 2 ** 31), seats: [this.me!], bots: [] as Bot[], sim: null as Sim | null, timers: [] as number[] };
    this.room = room;
    this.emit({ t: 'queued', position: 1 });
    this.announce('waiting', null);
    let delay = 200;
    const total = Math.min(ROOM_MAX, DEMO_PLAYERS);
    for (let i = 0; i < total - 1; i++) {
      delay += 40 + Math.random() * 90;
      room.timers.push(window.setTimeout(() => {
        const id = i + 2;
        room.seats.push({ id, num: playerNumber(Math.floor(Math.random() * 456)), name: NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''), verified: true });
        room.bots.push({ id, skill: 0.3 + Math.random() * 0.55, strafe: Math.random() < 0.5 ? 1 : -1, aimErr: 0, reaction: 0, target: null, los: false, losT: 0, wp: { x: 0, z: 0 }, stuck: 0, seq: 0, dropX: (Math.random() - 0.5) * 300, dropZ: (Math.random() - 0.5) * 300 });
        if (room.seats.length < total) this.announce('waiting', null);
        else { this.announce('countdown', Date.now() + COUNTDOWN_MS); room.timers.push(window.setTimeout(() => this.startRound(), COUNTDOWN_MS)); }
      }, delay));
    }
  }

  private startRound() {
    const r = this.room!;
    r.sim = new Sim(r.seed);
    r.sim.spawn(r.seats.map((s) => s.id));
    this.queue = []; this.last = emptyInput(); this.killer = null;
    this.announce('live', null);
    this.loop = window.setInterval(() => this.step(), 1000 / TICK_HZ);
  }

  // bots: glide to a drop spot, roam, rotate ahead of the storm, fight what they can see
  private botInput(b: Bot, sim: Sim): Input {
    const self = sim.players.get(b.id)!, g = sim.ring;
    const inp: Input = { ...emptyInput(), seq: ++b.seq, yaw: self.yaw, pitch: self.pitch };
    const yawTo = (x: number, z: number) => Math.atan2(-(x - self.x), -(z - self.z));
    if (self.gliding) { inp.yaw = yawTo(b.dropX, b.dropZ); inp.fwd = Math.hypot(b.dropX - self.x, b.dropZ - self.z) > 4 ? 1 : 0; return inp; }

    // re-pick the nearest enemy a few times a second and check line of sight
    b.losT -= 1 / TICK_HZ;
    if (b.losT <= 0) {
      b.losT = 0.4 + Math.random() * 0.3;
      let best: PlayerState | null = null, bd = 130;
      // gliders can't shoot back, so bots leave them alone
      for (const q of sim.players.values()) { if (!q.alive || q.id === b.id || q.gliding) continue; const d = Math.hypot(q.x - self.x, q.z - self.z); if (d < bd) { bd = d; best = q; } }
      b.target = best ? best.id : null;
      b.los = false;
      if (best) {
        const ox = self.x, oy = self.y + EYE_H, oz = self.z, tx = best.x - ox, ty = best.y + HEAD_Y - 0.4 - oy, tz = best.z - oz, d = Math.hypot(tx, ty, tz);
        b.los = sim.world.raycast(ox, oy, oz, tx / d, ty / d, tz / d, d) >= d - 0.5;
      }
    }
    const tgt = b.target !== null ? sim.players.get(b.target) : null;
    const inNext = Math.hypot(self.x - g.nx, self.z - g.ny) < g.nr * 0.8;
    const inRing = Math.hypot(self.x - g.x, self.z - g.y) < g.r * 0.92;

    if (!inRing || ((g.closing || g.nextAt - sim.t < 12) && !inNext)) { inp.yaw = yawTo(g.nx, g.ny); inp.fwd = 1; inp.sprint = true; }
    else if (tgt && tgt.alive && b.los) {
      const d = Math.hypot(tgt.x - self.x, tgt.z - self.z);
      const want = d < 14 ? 'shotgun' : d > 70 ? 'sniper' : 'rifle';
      if (self.weapon !== want) inp.slot = WEAPON_ORDER.indexOf(want) + 1;
      if (b.reaction <= 0) { b.aimErr = (Math.random() - 0.5) * (1 - b.skill) * 0.12; b.reaction = 0.3 + Math.random() * 0.4; if (Math.random() < 0.15) b.strafe *= -1; }
      b.reaction -= 1 / TICK_HZ;
      const ty = tgt.y + HEAD_Y - 0.45 - (self.y + EYE_H);
      inp.yaw = yawTo(tgt.x, tgt.z) + b.aimErr;
      inp.pitch = Math.atan2(ty, d) + b.aimErr * 0.5;
      inp.strafe = b.strafe; inp.fwd = d > 25 ? 0.6 : d < 8 ? -0.5 : 0;
      inp.fire = Math.random() < 0.3 + b.skill * 0.5 && (WEAPONS[self.weapon].auto || Math.random() < 0.4);
      inp.aim = d > 30;
    } else {
      if (Math.hypot(b.wp.x - self.x, b.wp.z - self.z) < 4 || Math.random() < 0.004) {
        const a = Math.random() * Math.PI * 2, rr = Math.random() * g.r * 0.7;
        b.wp = { x: g.x + Math.cos(a) * rr, z: g.y + Math.sin(a) * rr };
      }
      inp.yaw = yawTo(b.wp.x, b.wp.z); inp.fwd = 1; inp.sprint = true;
      if (tgt && !b.los) inp.yaw = yawTo(tgt.x, tgt.z);
      if (self.mag[self.weapon] < WEAPONS[self.weapon].mag / 2) inp.reload = true;
    }
    // stuck against something: hop it, or swing round it
    const sp = Math.hypot(self.vx, self.vz);
    b.stuck = inp.fwd > 0 && sp < 1.5 && self.grounded ? b.stuck + 1 : 0;
    if (b.stuck > 6) { inp.jump = true; if (b.stuck > 20) { inp.yaw += 1.6; b.wp = { x: self.x + Math.sin(-inp.yaw) * 30, z: self.z + Math.cos(-inp.yaw) * 30 }; b.stuck = 0; } }
    return inp;
  }

  private step() {
    const r = this.room;
    if (!r || !r.sim) return;
    const sim = r.sim;
    const inputs = new Map<number, Input>();
    const mine = this.queue.shift();
    if (mine) this.last = mine;
    inputs.set(1, mine ?? { ...this.last, jump: false, slide: false, slot: 0, reload: false });
    for (const b of r.bots) if (sim.players.get(b.id)?.alive) inputs.set(b.id, this.botInput(b, sim));
    for (const e of sim.step(1 / TICK_HZ, inputs)) {
      if (e.kind === 'elim') {
        if (e.victim === 1) this.killer = e.by;
        this.emit({ t: 'event', kind: 'elim', victim: e.victim, by: e.by, cause: e.cause, left: sim.alive, head: e.head });
      } else if (e.kind === 'hit' && (e.victim === 1 || e.by === 1)) this.emit({ t: 'event', kind: 'hit', victim: e.victim, by: e.by, dmg: e.dmg, head: e.head });
    }
    if (sim.tick % SNAP_EVERY === 0) {
      let watch = 1;
      if (!sim.players.get(1)?.alive) {
        if (this.killer === null || !sim.players.get(this.killer)?.alive) this.killer = [...sim.players.values()].find((p) => p.alive)?.id ?? 1;
        watch = this.killer;
      }
      this.emit(snapFor(frame(sim), 1, watch));
    }
    if (sim.alive <= 1) this.finish();
  }

  private finish() {
    const r = this.room!, sim = r.sim!;
    clearInterval(this.loop);
    const w = [...sim.players.values()].find((p) => p.alive) ?? null;
    if (w) {
      const seat = r.seats.find((s) => s.id === w.id)!;
      const key = w.id === 1 ? this.myWallet : `bot-${seat.name}`;
      const t = this.tickets.get(key) ?? { name: seat.name, wins: 0 };
      t.wins++; this.tickets.set(key, t);
    }
    this.emit({ t: 'result', winner: w ? w.id : null, ticketAwarded: !!w, epoch: epochOf(Date.now()) });
    this.emitPot();
    r.timers.push(window.setTimeout(() => this.closeRoom(), RESULT_MS - 300)); // free the seat before the client shows the lobby
  }

  private closeRoom() {
    if (!this.room) return;
    for (const t of this.room.timers) clearTimeout(t);
    clearInterval(this.loop);
    this.room = null;
  }
}
