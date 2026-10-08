// Offline demo transport: plays the server's role inside the browser, with 9 bots per room and a
// simulated fee stream. Same Sim, same messages, so the UI under test is the real one.
import {
  COUNTDOWN_MS, RESULT_MS, ROOM_MAX, SNAP_EVERY, TICK_HZ, epochEnd, epochOf, playerNumber,
} from '../../shared/src/constants.ts';
import type { ClientMsg, RoomSeat, ServerMsg } from '../../shared/src/protocol.ts';
import { Sim, sanitizeInput, type Input } from '../../shared/src/sim.ts';

type Handler = (m: ServerMsg) => void;
const BOT_NAMES = ['degen.sol', 'wagmi', 'ser_pump', 'rugless', 'bonkbro', 'paperhand', 'diamond', 'jeet', 'moonboi', 'gmgm', 'solchad', 'wifhat', 'ape420', 'fomo'];
const fakeWallet = () => Array.from({ length: 44 }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 58)]).join('');

interface Bot { id: number; seat: RoomSeat; wander: number; skill: number; strafe: number; reaction: number; aimErr: number }

export class LocalNet {
  private handlers: Handler[] = [];
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private lamports = 7_400_000_000n;
  private tickets = new Map<string, { name: string; wins: number }>();
  private me: RoomSeat | null = null;
  private myWallet = fakeWallet();
  private myInput: Input = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
  private room: { id: string; seed: number; seats: RoomSeat[]; bots: Bot[]; sim: Sim | null; tick: number; timers: number[] } | null = null;
  private loop = 0;

  constructor() {
    // a lively leaderboard to start from
    for (let i = 0; i < 6; i++) this.tickets.set(fakeWallet(), { name: BOT_NAMES[i], wins: 6 - i + Math.floor(Math.random() * 3) });
  }

  on(h: Handler) { this.handlers.push(h); }
  private emit(m: ServerMsg) { for (const h of this.handlers) h(m); }

  connect() {
    setTimeout(() => {
      this.onOpen?.();
      this.emit({ t: 'hello', nonce: 'demo', requireWallet: false, allowGuests: true, holdMinUsd: 50 });
      this.emitPot();
    }, 50);
    setInterval(() => this.emitPot(), 2000);
    const fee = () => {
      const whale = Math.random() < 0.08;
      const sol = whale ? 0.4 + Math.random() * 2.2 : 0.004 + Math.random() * 0.07;
      const add = BigInt(Math.round(sol * 1e9));
      this.lamports += add;
      this.emit({ t: 'inflow', inflow: { lamports: add.toString(), at: Date.now(), source: whale ? 'compra ballena' : 'fees de trading' } });
      setTimeout(fee, 1200 + Math.random() * 3000);
    };
    setTimeout(fee, 900);
  }

  private emitPot() {
    const epoch = epochOf(Date.now());
    const top = [...this.tickets.entries()].map(([wallet, t]) => ({ wallet, name: t.name, wins: t.wins })).sort((a, b) => b.wins - a.wins).slice(0, 8);
    this.emit({ t: 'pot', pot: { epoch, epochEndMs: epochEnd(epoch), lamports: this.lamports.toString(), rolloverLamports: '0', commit: '', online: 1287 + Math.floor(Math.random() * 40), rooms: 131 + Math.floor(Math.random() * 6), tickets: top } });
  }

  send(m: ClientMsg) {
    switch (m.t) {
      case 'guest': {
        const name = (m.name || 'guest').slice(0, 14);
        this.me = { id: 1, num: playerNumber(Math.floor(Math.random() * 456)), name, verified: true };
        this.emit({ t: 'authed', name, wallet: this.myWallet, num: this.me.num });
        break;
      }
      case 'auth': break;
      case 'queue': if (this.me && !this.room) this.openRoom(); break;
      case 'leave': this.closeRoom(); break;
      case 'in': this.myInput = sanitizeInput(m); break;
    }
  }

  private announce(state: 'waiting' | 'countdown' | 'live' | 'over', startsAt: number | null) {
    const r = this.room!;
    this.emit({ t: 'room', roomId: r.id, you: 1, seats: r.seats, state, startsAt, seed: r.seed });
  }

  private openRoom() {
    const me = this.me!;
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const room = { id: Math.random().toString(16).slice(2, 10), seed: Math.floor(Math.random() * 2 ** 31), seats: [me], bots: [] as Bot[], sim: null as Sim | null, tick: 0, timers: [] as number[] };
    this.room = room;
    this.emit({ t: 'queued', position: 1 });
    this.announce('waiting', null);
    // bots trickle in like real players
    let delay = 300;
    for (let i = 0; i < ROOM_MAX - 1; i++) {
      delay += 250 + Math.random() * 550;
      room.timers.push(window.setTimeout(() => {
        const id = i + 2;
        const seat = { id, num: playerNumber(Math.floor(Math.random() * 456)), name: names[i], verified: true };
        room.seats.push(seat);
        room.bots.push({ id, seat, wander: Math.random() * 6.28, skill: 0.35 + Math.random() * 0.5, strafe: Math.random() < 0.5 ? 1 : -1, reaction: 0, aimErr: 0 });
        if (room.seats.length < ROOM_MAX) this.announce('waiting', null);
        else {
          const startsAt = Date.now() + COUNTDOWN_MS;
          this.announce('countdown', startsAt);
          room.timers.push(window.setTimeout(() => this.startRound(), COUNTDOWN_MS));
        }
      }, delay));
    }
  }

  private startRound() {
    const r = this.room!;
    r.sim = new Sim(r.seed);
    r.sim.spawn(r.seats.map((s) => s.id));
    this.myInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
    this.announce('live', null);
    this.loop = window.setInterval(() => this.step(), 1000 / TICK_HZ);
  }

  private botInput(b: Bot, sim: Sim, dt: number): Input {
    const self = sim.players.get(b.id)!;
    let target = null, best = Infinity;
    for (const p of sim.players.values()) if (p.alive && p.id !== b.id) { const d = Math.hypot(p.x - self.x, p.y - self.y); if (d < best) { best = d; target = p; } }
    b.wander += (Math.random() - 0.5) * 0.5;
    b.reaction -= dt;
    if (Math.random() < 0.01) b.strafe *= -1;
    let mv = b.wander;
    const ring = sim.ringR, dist = Math.hypot(self.x, self.y);
    if (dist > ring * 0.8) mv = Math.atan2(-self.y, -self.x) + (Math.random() - 0.5) * 0.6;
    else if (target && best < 700) {
      const to = Math.atan2(target.y - self.y, target.x - self.x);
      mv = best > 330 ? to + b.strafe * 0.5 : to + b.strafe * Math.PI / 2;
    }
    let aim = self.aim, fire = false;
    if (target && best < 650) {
      if (b.reaction <= 0) { b.aimErr = (Math.random() - 0.5) * (1 - b.skill) * 0.7; b.reaction = 0.25 + Math.random() * 0.35; }
      aim = Math.atan2(target.y - self.y, target.x - self.x) + b.aimErr;
      fire = Math.random() < 0.35 + b.skill * 0.5;
    }
    return { mx: Math.cos(mv), my: Math.sin(mv), aim, fire, dash: self.hp < 50 && Math.random() < 0.03 };
  }

  private step() {
    const r = this.room;
    if (!r || !r.sim) return;
    const sim = r.sim, dt = 1 / TICK_HZ;
    const inputs = new Map<number, Input>([[1, this.myInput]]);
    for (const b of r.bots) if (sim.players.get(b.id)?.alive) inputs.set(b.id, this.botInput(b, sim, dt));
    for (const e of sim.step(dt, inputs)) if (e.kind === 'elim') this.emit({ t: 'event', kind: 'elim', victim: e.victim, by: e.by, cause: e.cause, left: sim.alive });
    if (++r.tick % SNAP_EVERY === 0) this.snap();
    if (sim.alive <= 1) this.finish();
  }

  private snap() {
    const sim = this.room!.sim!;
    this.emit({
      t: 'snap', tick: this.room!.tick, time: sim.t, ringR: sim.ringR,
      players: [...sim.players.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, aim: p.aim, hp: Math.max(0, Math.ceil(p.hp)), alive: p.alive, dash: p.dashT > 0 })),
      bullets: sim.bullets.map((b) => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy })),
    });
  }

  private finish() {
    const r = this.room!;
    clearInterval(this.loop);
    this.snap();
    const w = [...r.sim!.players.values()].find((p) => p.alive) ?? null;
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

