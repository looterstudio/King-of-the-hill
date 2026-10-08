// Offline demo transport: plays the server's role inside the browser with bots and a simulated
// fee stream. Same Sim, same snapshots, same input queue semantics, so the UI under test is real.
import {
  COUNTDOWN_MS, EYE_H, HEAD_Y, INTERACT_R, MAP_HALF, MODES, MODE_IDS, RARITY_ORDER, RESULT_MS, ROOM_MAX, SNAP_EVERY, TICK_HZ, WEAPONS, epochEnd, epochOf, playerNumber, type Mode, type WeaponId,
} from '../../shared/src/constants.ts';
import type { ClientMsg, LobbyRoom, RoomSeat, ServerMsg } from '../../shared/src/protocol.ts';
import { Sim, emptyInput, sanitizeInput, type Input, type PlayerState } from '../../shared/src/sim.ts';
import { frame, snapFor, type Viewer } from '../../shared/src/snap.ts';
import { makeTeams } from '../../shared/src/teams.ts';

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
  room: { id: string; seed: number; mode: Mode; seats: RoomSeat[]; bots: Bot[]; sim: Sim | null; timers: number[] } | null = null;
  private free: { x: number; z: number } | null = null;
  // the other rooms on the 'server', for the lobby list (simulated: this demo only runs yours)
  private fake: LobbyRoom[] = [];
  private loop = 0;
  private killer: number | null = null;
  private viewer: Viewer = { lootVer: -1, lootAt: -9 };

  constructor() {
    for (let i = 0; i < 6; i++) this.tickets.set(fakeWallet(), { name: NAMES[i], wins: (6 - i + Math.floor(Math.random() * 3)) * 2 });
    for (let i = 0; i < 5; i++) this.fake.push(this.fakeRoom(i < 3));
  }
  private fakeRoom(live: boolean): LobbyRoom {
    const mode = MODE_IDS[Math.floor(Math.random() * 3)];
    return live ? { id: Math.random().toString(16).slice(2, 10), mode, n: 70 + Math.floor(Math.random() * 31), state: 'live', startsIn: null }
      : { id: Math.random().toString(16).slice(2, 10), mode, n: 3 + Math.floor(Math.random() * 50), state: 'waiting', startsIn: 20 + Math.floor(Math.random() * 25) };
  }
  private emitLobby() {
    // filling rooms gain players, start, and eventually finish and make way for new ones
    this.fake = this.fake.map((r) => {
      if (r.state === 'live') return Math.random() < 0.02 ? this.fakeRoom(false) : r;
      const n = Math.min(ROOM_MAX, r.n + Math.floor(Math.random() * 4));
      const startsIn = Math.max(0, (r.startsIn ?? 30) - 1);
      return startsIn === 0 || n >= ROOM_MAX ? { ...r, n, state: 'live', startsIn: null } : { ...r, n, startsIn };
    });
    const mine = this.room ? [{ id: this.room.id, mode: this.room.mode, n: this.room.seats.length, state: this.room.sim ? 'live' : 'waiting', startsIn: null } as LobbyRoom] : [];
    const order = { waiting: 0, countdown: 1, live: 2, over: 3 } as const;
    this.emit({ t: 'lobby', rooms: [...mine, ...this.fake].sort((a, b) => order[a.state] - order[b.state] || b.n - a.n) });
  }

  on(h: Handler) { this.handlers.push(h); }
  private emit(m: ServerMsg) { for (const h of this.handlers) h(m); }

  connect() {
    setTimeout(() => { this.onOpen?.(); this.emit({ t: 'hello', nonce: 'demo', requireWallet: false, allowGuests: true, holdMinUsd: 50 }); this.emitPot(); }, 50);
    setInterval(() => this.emitPot(), 2000);
    setTimeout(() => this.emitLobby(), 60);
    setInterval(() => this.emitLobby(), 1000);
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
        this.me = { id: 1, num: playerNumber(Math.floor(Math.random() * 456)), name, verified: true, team: 0 };
        this.emit({ t: 'authed', name, wallet: this.myWallet, num: this.me.num });
        break;
      }
      case 'queue': {
        if (!this.me || this.room) break;
        const picked = this.fake.find((r) => r.id === m.room && r.state === 'waiting');
        this.openRoom(picked ? picked.mode : MODE_IDS.includes(m.mode as Mode) ? m.mode! : 'solo', picked?.id);
        if (picked) this.fake = this.fake.filter((r) => r !== picked);
        break;
      }
      case 'spec': this.spectate(m); break;
      case 'leave': this.closeRoom(); break;
      case 'in': this.queue.push(sanitizeInput(m)); if (this.queue.length > 10) this.queue.shift(); break;
    }
  }

  private announce(state: 'waiting' | 'countdown' | 'live' | 'over', startsAt: number | null) {
    const r = this.room!;
    this.emit({ t: 'room', roomId: r.id, you: 1, seats: r.seats, state, startsAt, seed: r.seed, mode: r.mode });
  }

  private openRoom(mode: Mode, id?: string) {
    this.me!.team = 0;
    const room = { id: id ?? Math.random().toString(16).slice(2, 10), seed: Math.floor(Math.random() * 2 ** 31), mode, seats: [this.me!], bots: [] as Bot[], sim: null as Sim | null, timers: [] as number[] };
    this.room = room;
    this.emit({ t: 'queued', position: 1 });
    this.announce('waiting', null);
    let delay = 200;
    const total = Math.min(ROOM_MAX, DEMO_PLAYERS);
    for (let i = 0; i < total - 1; i++) {
      delay += 40 + Math.random() * 90;
      room.timers.push(window.setTimeout(() => {
        const id = i + 2;
        room.seats.push({ id, num: playerNumber(Math.floor(Math.random() * 456)), name: NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''), verified: true, team: 0 });
        room.bots.push({ id, skill: 0.3 + Math.random() * 0.55, strafe: Math.random() < 0.5 ? 1 : -1, aimErr: 0, reaction: 0, target: null, los: false, losT: 0, wp: { x: 0, z: 0 }, stuck: 0, seq: 0, dropX: (Math.random() - 0.5) * 300, dropZ: (Math.random() - 0.5) * 300 });
        if (room.seats.length < total) this.announce('waiting', null);
        else { this.announce('countdown', Date.now() + COUNTDOWN_MS); room.timers.push(window.setTimeout(() => this.startRound(), COUNTDOWN_MS)); }
      }, delay));
    }
  }

  private startRound() {
    const r = this.room!;
    r.sim = new Sim(r.seed);
    const teams = makeTeams(r.seats.map((s) => ({ id: s.id, party: '' })), MODES[r.mode].size);
    r.seats = r.seats.map((s) => ({ ...s, team: teams.get(s.id)! }));
    r.sim.spawn(r.seats.map((s) => s.id), teams);
    // a team glides to the same spot
    const spot = new Map<number, { x: number; z: number }>();
    for (const b of r.bots) { const t = teams.get(b.id)!; const at = spot.get(t) ?? { x: b.dropX, z: b.dropZ }; spot.set(t, at); b.dropX = at.x + (Math.random() - 0.5) * 8; b.dropZ = at.z + (Math.random() - 0.5) * 8; }
    this.queue = []; this.last = emptyInput(); this.killer = null; this.free = null; this.viewer = { lootVer: -1, lootAt: -9 };
    this.announce('live', null);
    this.loop = window.setInterval(() => this.step(), 1000 / TICK_HZ);
  }

  // bots: glide to a drop spot, roam, rotate ahead of the storm, fight what they can see
  private botInput(b: Bot, sim: Sim): Input {
    const self = sim.players.get(b.id)!, g = sim.ring;
    const inp: Input = { ...emptyInput(), seq: ++b.seq, yaw: self.yaw, pitch: self.pitch };
    const yawTo = (x: number, z: number) => Math.atan2(-(x - self.x), -(z - self.z));
    if (self.gliding) { inp.yaw = yawTo(b.dropX, b.dropZ); inp.fwd = Math.hypot(b.dropX - self.x, b.dropZ - self.z) > 4 ? 1 : 0; return inp; }
    // driving: head for the circle, swerve into anyone close enough to run over, hop out when there
    if (self.ride === 1) {
      const enemy = [...sim.players.values()].find((q) => q.alive && !q.ride && q.team !== self.team && Math.hypot(q.x - self.x, q.z - self.z) < 35);
      const gx = enemy ? enemy.x : g.nx, gz = enemy ? enemy.z : g.ny;
      let d = yawTo(gx, gz) - self.head; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      inp.strafe = Math.max(-1, Math.min(1, -d * 2)); inp.fwd = 1; inp.sprint = !!enemy || Math.abs(d) < 0.4; inp.yaw = self.head;
      if (self.spd < 2 && Math.random() < 0.02) inp.fwd = -1;
      if (!enemy && Math.hypot(self.x - g.nx, self.z - g.ny) < g.nr * 0.6) inp.interact = true;
      return inp;
    }
    if (self.ride) { inp.interact = true; return inp; }

    // re-pick the nearest enemy a few times a second and check line of sight
    b.losT -= 1 / TICK_HZ;
    if (b.losT <= 0) {
      b.losT = 0.4 + Math.random() * 0.3;
      let best: PlayerState | null = null, bd = 130;
      // gliders can't shoot back, so bots leave them alone
      for (const q of sim.players.values()) { if (!q.alive || q.id === b.id || q.gliding || q.team === self.team) continue; const d = Math.hypot(q.x - self.x, q.z - self.z); if (d < bd) { bd = d; best = q; } }
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
    const rank = (w: WeaponId | null) => (w ? RARITY_ORDER.indexOf(WEAPONS[w].rarity) : -1);
    const fighting = !!(tgt && tgt.alive && b.los);

    if (self.use) { inp.fwd = 0; inp.strafe = b.strafe * 0.3; return inp; } // stand still and finish healing
    if (!fighting && self.shield < 60 && (self.items.big || self.items.mini) && Math.random() < 0.2) inp.item = 1;
    else if (!fighting && self.hp < 60 && self.items.med && Math.random() < 0.2) inp.item = 2;

    // far from the circle: grab a car if one is close
    const car = Math.hypot(self.x - g.nx, self.z - g.ny) > g.nr + 70 && !fighting ? sim.vehicles.find((v) => v.kind === 'car' && !v.driver && Math.hypot(v.body.x - self.x, v.body.z - self.z) < 30) : null;
    if (car) {
      const dc = Math.hypot(car.body.x - self.x, car.body.z - self.z);
      inp.yaw = yawTo(car.body.x, car.body.z); inp.fwd = 1; inp.sprint = true;
      if (dc < 2.8) inp.interact = true;
    } else if (!inRing || ((g.closing || g.nextAt - sim.t < 12) && !inNext)) {
      inp.yaw = yawTo(g.nx, g.ny); inp.fwd = 1; inp.sprint = true;
      if (self.perk?.kind === 'launch' && Math.hypot(self.x - g.nx, self.z - g.ny) > g.nr + 40) inp.perk = true; // pad, then run onto it
    } else if (fighting && tgt) {
      const d = Math.hypot(tgt.x - self.x, tgt.z - self.z);
      // pick the right gun for the range from what we carry
      const has = self.slots.map((w, i) => ({ w, i })).filter((x) => x.w) as { w: WeaponId; i: number }[];
      const shotgun = has.find((x) => x.w === 'pump' || x.w === 'tac'), sniper = has.find((x) => x.w === 'heavy' || x.w === 'hunting');
      const rifle = has.filter((x) => !['pump', 'tac', 'heavy', 'hunting'].includes(x.w)).sort((a, z) => rank(z.w) - rank(a.w))[0];
      const want = d < 12 && shotgun ? shotgun : d > 70 && sniper ? sniper : rifle ?? has[0];
      if (want && want.i !== self.cur) inp.slot = want.i + 1;
      if (b.reaction <= 0) { b.aimErr = (Math.random() - 0.5) * (1 - b.skill) * 0.12; b.reaction = 0.3 + Math.random() * 0.4; if (Math.random() < 0.15) b.strafe *= -1; }
      b.reaction -= 1 / TICK_HZ;
      const ty = tgt.y + HEAD_Y - 0.45 - (self.y + EYE_H);
      inp.yaw = yawTo(tgt.x, tgt.z) + b.aimErr;
      inp.pitch = Math.atan2(ty, d) + b.aimErr * 0.5;
      inp.strafe = b.strafe; inp.fwd = d > 25 ? 0.6 : d < 8 ? -0.5 : 0;
      const w = self.slots[self.cur];
      inp.fire = Math.random() < 0.3 + b.skill * 0.5 && (!w || WEAPONS[w].auto || Math.random() < 0.4);
      inp.aim = d > 30;
      if (self.perk) {
        const k = self.perk.kind;
        if (k === 'grenade' && d > 8 && d < 24 && Math.random() < 0.03) { inp.perk = true; inp.pitch += 0.25; }
        if ((k === 'smoke' || k === 'fort') && self.hp < 45 && Math.random() < 0.08) inp.perk = true;
        if (k === 'nuke' && d > 40 && Math.random() < 0.05) inp.perk = true;
      }
    } else {
      // loot run: open the nearest case, or grab a better gun
      let goal: { x: number; y: number; z: number } | null = null, gd = 45, open = false;
      for (const c of sim.cases) { if (c.open || Math.abs(c.y - self.y) > 3) continue; const d = Math.hypot(c.x - self.x, c.z - self.z); if (d < gd) { gd = d; goal = c; open = true; } }
      const worst = self.slots.includes(null) ? -1 : Math.min(...self.slots.map(rank));
      for (const l of sim.loot) {
        if (Math.abs(l.y - self.y) > 3) continue;
        const d = Math.hypot(l.x - self.x, l.z - self.z);
        const useful = l.kind === 'weapon' ? rank(l.what as WeaponId) > worst && !self.slots.includes(l.what as WeaponId) : l.kind === 'item' ? true : !self.perk;
        if (useful && d < gd * 0.8) { gd = d; goal = l; open = l.kind === 'weapon' && !self.slots.includes(null); }
      }
      if (goal && gd < INTERACT_R && open) inp.interact = true;
      if (goal) { inp.yaw = yawTo(goal.x, goal.z); inp.fwd = gd > 0.6 ? 1 : 0; inp.sprint = gd > 6; }
      else {
        if (Math.hypot(b.wp.x - self.x, b.wp.z - self.z) < 4 || Math.random() < 0.004) {
          const a = Math.random() * Math.PI * 2, rr = Math.random() * g.r * 0.7;
          b.wp = { x: g.x + Math.cos(a) * rr, z: g.y + Math.sin(a) * rr };
        }
        inp.yaw = yawTo(b.wp.x, b.wp.z); inp.fwd = 1; inp.sprint = true;
        if (tgt && !b.los) inp.yaw = yawTo(tgt.x, tgt.z);
      }
      const w = self.slots[self.cur];
      if (w && self.mags[self.cur] < WEAPONS[w].mag / 2) inp.reload = true;
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
    inputs.set(1, mine ?? { ...this.last, jump: false, slide: false, slot: 0, reload: false, interact: false, perk: false, item: 0 });
    for (const b of r.bots) if (sim.players.get(b.id)?.alive) inputs.set(b.id, this.botInput(b, sim));
    for (const e of sim.step(1 / TICK_HZ, inputs)) {
      if (e.kind === 'elim') {
        if (e.victim === 1) this.killer = e.by;
        this.emit({ t: 'event', kind: 'elim', victim: e.victim, by: e.by, cause: e.cause, left: sim.alive, head: e.head });
      } else if (e.kind === 'hit') { if (e.victim === 1 || e.by === 1) this.emit({ t: 'event', ...e }); }
      else if (e.kind === 'vhit') { if (e.by === 1) this.emit({ t: 'event', ...e }); }
      else this.emit({ t: 'event', ...e } as ServerMsg);
    }
    if (sim.tick % SNAP_EVERY === 0) {
      let watch = 1;
      const me = sim.players.get(1)!;
      if (!me.alive) {
        if (this.killer === null || !sim.players.get(this.killer)?.alive) this.killer = this.mate(sim) ?? [...sim.players.values()].find((p) => p.alive)?.id ?? 1;
        watch = this.killer;
        if (this.free && this.mate(sim) !== undefined) this.free = null;
      }
      const keep = new Set([...sim.players.values()].filter((p) => p.alive && p.team === me.team && p.id !== 1).map((p) => p.id));
      this.emit(snapFor(frame(sim), 1, watch, this.viewer, { at: this.free, keep }));
    }
    if (sim.teamsAlive.size <= 1) this.finish();
  }

  private mate(sim: Sim) { const me = sim.players.get(1)!; return [...sim.players.values()].find((p) => p.alive && p.team === me.team && p.id !== 1)?.id; }

  // same rules as the server: teammates first, free camera only once your team is out
  private spectate(m: Extract<ClientMsg, { t: 'spec' }>) {
    const sim = this.room?.sim, me = sim?.players.get(1);
    if (!sim || !me || me.alive) return;
    const mate = this.mate(sim);
    if (m.at !== undefined) {
      if (m.at === null || mate !== undefined) { this.free = null; return; }
      this.free = { x: Math.max(-MAP_HALF, Math.min(MAP_HALF, m.at[0])), z: Math.max(-MAP_HALF, Math.min(MAP_HALF, m.at[1])) };
      return;
    }
    this.free = null;
    const pool = [...sim.players.values()].filter((p) => p.alive && (mate === undefined || p.team === me.team)).map((p) => p.id).sort((a, b) => a - b);
    if (!pool.length) return;
    if (m.target !== undefined && pool.includes(m.target)) { this.killer = m.target; return; }
    const cur = pool.indexOf(this.killer ?? -1);
    this.killer = pool[cur < 0 ? 0 : (cur + (m.dir === -1 ? -1 : 1) + pool.length) % pool.length];
  }

  private finish() {
    const r = this.room!, sim = r.sim!;
    clearInterval(this.loop);
    const team = [...sim.teamsAlive][0];
    const winners = team === undefined ? [] : [...sim.players.values()].filter((p) => p.team === team).map((p) => p.id);
    const tickets = MODES[r.mode].tickets;
    for (const id of winners) {
      const seat = r.seats.find((s) => s.id === id)!;
      const key = id === 1 ? this.myWallet : `bot-${seat.name}`;
      const t = this.tickets.get(key) ?? { name: seat.name, wins: 0 };
      t.wins += tickets; this.tickets.set(key, t);
    }
    this.emit({ t: 'result', winner: winners[0] ?? null, winners, tickets, ticketAwarded: winners.length > 0, epoch: epochOf(Date.now()) });
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
