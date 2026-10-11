// The party pre-lobby: a leader makes a party (a short code and an invite link), friends join it,
// pick a character and tick ready, and the leader queues everyone into one room on one team.
// The state lives here, on the main thread next to the matchmaker, and every member gets it pushed
// whenever it changes. A dropped socket keeps its slot for a while so a reload or a flaky
// connection gets back in (the token proves it was that slot).
import { randomBytes } from 'node:crypto';
import { MODES, SKINS, type Mode } from '../../shared/src/constants.ts';
import type { ClientMsg, PartyView, ServerMsg } from '../../shared/src/protocol.ts';
import type { Client, Matchmaker } from './room.ts';

export const PARTY_GRACE_MS = 30_000; // how long a dropped member's slot waits for them
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I: codes get read out loud
const PARTY_MODES = new Set<Mode>(['duo', 'squad']);

interface Seat { c: Client | null; id: number; token: string; name: string; num: string; skin: number; ready: boolean; goneAt: number }
interface Party { code: string; mode: Mode; leader: Seat; seats: Seat[]; sent: Map<Seat, string>; wasBusy: boolean }

const busy = (c: Client | null) => !!c && (c.queued || (!!c.room && c.room.phase !== 'over'));
const cleanCode = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const cleanSkin = (n: unknown) => Math.max(0, Math.min(SKINS.length - 1, Math.floor(Number(n)) || 0));

export class Parties {
  private byCode = new Map<string, Party>();
  private of = new Map<Client, Party>();

  constructor(private mm: Matchmaker, private clock: () => number = Date.now) {}

  get count() { return this.byCode.size; }
  partyOf(c: Client) { return this.of.get(c) ?? null; }

  handle(c: Client, m: Extract<ClientMsg, { t: 'party' }>) {
    switch (m.op) {
      case 'create': return this.create(c, m.mode, m.skin);
      case 'join': return this.join(c, m.code, m.token, m.skin);
      case 'leave': return this.leave(c, 'left');
      case 'ready': return this.setReady(c, m.ready !== false);
      case 'mode': return this.setMode(c, m.mode);
      case 'skin': return this.setSkin(c, m.skin);
      case 'play': return this.play(c);
      case 'kick': return this.kick(c, Number(m.id));
    }
  }

  create(c: Client, mode?: unknown, skin?: unknown) {
    if (this.of.has(c)) this.leave(c, 'left');
    let code = '';
    do { code = Array.from(randomBytes(5), (b) => ABC[b % ABC.length]).join(''); } while (this.byCode.has(code));
    c.skin = cleanSkin(skin ?? c.skin);
    const seat = this.seat(c);
    const p: Party = { code, mode: PARTY_MODES.has(mode as Mode) ? mode as Mode : 'duo', leader: seat, seats: [seat], sent: new Map(), wasBusy: false };
    this.byCode.set(code, p); this.of.set(c, p);
    this.sync(p);
    return p;
  }

  join(c: Client, code?: unknown, token?: unknown, skin?: unknown) {
    const p = this.byCode.get(cleanCode(code));
    if (!p) return this.out(c, 'No party with that code');
    if (this.of.get(c) === p) return this.sync(p);
    // a reconnect: the slot this token held is yours again, full party or not, even when the
    // server hasn't seen the old socket close yet (the new one often arrives first)
    const back = typeof token === 'string' && token ? p.seats.find((s) => s.token === token) : undefined;
    if (!back && p.seats.length >= MODES[p.mode].size) return this.out(c, 'That party is full');
    if (back?.c && back.c !== c) { this.of.delete(back.c); p.sent.delete(back); }
    if (this.of.has(c)) this.leave(c, 'left');
    c.skin = cleanSkin(skin ?? c.skin);
    if (back) Object.assign(back, { c, id: c.id, name: c.name, num: c.num, skin: c.skin, ready: false, goneAt: 0 });
    else p.seats.push(this.seat(c));
    this.of.set(c, p);
    if (!p.leader.c) p.leader = p.seats.find((s) => s.c) ?? p.leader; // nobody was home: the first one back leads
    this.sync(p);
  }

  // why: 'left' (on purpose, the slot goes), 'gone' (the socket dropped, the slot waits)
  leave(c: Client, why: 'left' | 'gone') {
    const p = this.of.get(c);
    if (!p) { if (why === 'left') this.out(c); return; }
    this.of.delete(c);
    const seat = p.seats.find((s) => s.c === c)!;
    if (why === 'gone') { seat.c = null; seat.ready = false; seat.goneAt = this.clock(); }
    else { p.seats = p.seats.filter((s) => s !== seat); p.sent.delete(seat); this.out(c); }
    if (p.leader === seat || !p.seats.includes(p.leader)) p.leader = p.seats.find((s) => s.c) ?? p.seats[0] ?? seat;
    if (!p.seats.length) { this.byCode.delete(p.code); return; }
    this.sync(p);
  }

  // the leader backed out of a room that hasn't started: the whole party comes back with them
  cancel(c: Client) {
    const p = this.of.get(c);
    if (!p || p.leader.c !== c) return;
    if (c.room?.phase === 'live' || c.room?.phase === 'over') return;
    for (const s of p.seats) if (s.c && s.c !== c && (s.c.queued || (s.c.room && s.c.room === c.room))) this.mm.leave(s.c);
  }

  private setReady(c: Client, ready: boolean) {
    const p = this.of.get(c);
    if (!p) return;
    p.seats.find((s) => s.c === c)!.ready = ready;
    this.sync(p);
  }

  private setSkin(c: Client, skin: unknown) {
    const p = this.of.get(c);
    c.skin = cleanSkin(skin);
    if (!p) return;
    p.seats.find((s) => s.c === c)!.skin = c.skin;
    this.sync(p);
  }

  private setMode(c: Client, mode: unknown) {
    const p = this.lead(c);
    if (!p || p.mode === mode) return;
    if (!PARTY_MODES.has(mode as Mode)) return c.send({ t: 'error', msg: 'Parties play duos or squads' });
    if (p.seats.length > MODES[mode as Mode].size) return c.send({ t: 'error', msg: `Too many of you for ${MODES[mode as Mode].name.toLowerCase()}` });
    if (this.busy(p)) return c.send({ t: 'error', msg: 'Wait for the match to end' });
    p.mode = mode as Mode;
    this.sync(p);
  }

  private kick(c: Client, id: number) {
    const p = this.lead(c);
    const seat = p?.seats.find((s) => s.id === id && s !== p.leader);
    if (!p || !seat) return;
    p.seats = p.seats.filter((s) => s !== seat); p.sent.delete(seat);
    if (seat.c) { this.of.delete(seat.c); this.out(seat.c, 'The leader removed you from the party'); }
    this.sync(p);
  }

  play(c: Client) {
    const p = this.lead(c);
    if (!p) return false;
    if (this.busy(p)) { c.send({ t: 'error', msg: 'The party is already in a match' }); return false; }
    const away = p.seats.find((s) => !s.c);
    if (away) { c.send({ t: 'error', msg: `Waiting for ${away.name} to reconnect` }); return false; }
    if (p.seats.some((s) => s !== p.leader && !s.ready)) { c.send({ t: 'error', msg: 'Waiting for everyone to be ready' }); return false; }
    const ok = this.mm.enqueueGroup(p.seats.map((s) => s.c!), p.mode, p.code);
    if (ok) { p.wasBusy = true; this.sync(p); }
    return ok;
  }

  // drops the slots nobody came back to, and pushes whatever changed (a room filling, a match
  // starting or ending) to every member
  tick(now = this.clock()) {
    for (const p of this.byCode.values()) {
      const gone = p.seats.filter((s) => !s.c && now - s.goneAt > PARTY_GRACE_MS);
      if (gone.length) {
        p.seats = p.seats.filter((s) => !gone.includes(s));
        for (const s of gone) p.sent.delete(s);
        if (!p.seats.length) { this.byCode.delete(p.code); continue; }
        if (!p.seats.includes(p.leader)) p.leader = p.seats.find((s) => s.c) ?? p.seats[0];
      }
      this.sync(p);
    }
  }

  view(p: Party, you: number): PartyView {
    const live = p.seats.some((s) => s.c?.room?.phase === 'live');
    return {
      code: p.code, mode: p.mode, size: MODES[p.mode].size, leader: p.leader.id, you,
      members: p.seats.map((s) => ({ id: s.id, name: s.name, num: s.num, skin: s.skin, ready: s === p.leader || s.ready, ...(s.c ? {} : { away: true }), ...(busy(s.c) ? { busy: true } : {}) })),
      state: live ? 'playing' : this.busy(p) ? 'queued' : 'idle',
    };
  }

  private sync(p: Party) {
    // back from a match: everyone ticks ready again for the next one
    const b = this.busy(p);
    if (p.wasBusy && !b) for (const s of p.seats) s.ready = false;
    p.wasBusy = b;
    for (const s of p.seats) {
      if (!s.c) continue;
      const msg = JSON.stringify({ t: 'party', party: this.view(p, s.id), token: s.token } satisfies ServerMsg);
      if (p.sent.get(s) === msg) continue;
      p.sent.set(s, msg); s.c.sendRaw(msg);
    }
  }

  private busy(p: Party) { return p.seats.some((s) => busy(s.c)); }
  private lead(c: Client) {
    const p = this.of.get(c);
    if (p && p.leader.c !== c) { c.send({ t: 'error', msg: 'Only the party leader can do that' }); return null; }
    return p ?? null;
  }
  private seat(c: Client): Seat { return { c, id: c.id, token: randomBytes(9).toString('base64url'), name: c.name, num: c.num, skin: c.skin, ready: false, goneAt: 0 }; }
  private out(c: Client, msg?: string) { c.send({ t: 'party', party: null, ...(msg ? { msg } : {}) }); }
}
