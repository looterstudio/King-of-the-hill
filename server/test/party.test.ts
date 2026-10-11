// The party pre-lobby: create, join, ready, leave, reconnect, and the whole party queued into one
// room on one team.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import { ROOM_MAX } from '../../shared/src/constants.ts';
import type { PartyView } from '../../shared/src/protocol.ts';
import { Client, Matchmaker, Room } from '../src/room.ts';
import type { MatchHost } from '../src/host.ts';
import { PARTY_GRACE_MS, Parties } from '../src/party.ts';

function fakeClient(id: number, name = `p${id}`) {
  const sent: string[] = [];
  const ws = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s: string) => sent.push(s), terminate() {}, close() {} } as unknown as WebSocket;
  const c = new Client(id, ws, String(id), 'n', 30);
  c.name = name; c.authed = true;
  return { c, sent, ws };
}
type Msg = { t: string; party?: PartyView | null; token?: string; msg?: string };
const msgs = (sent: string[]) => sent.map((s) => JSON.parse(s) as Msg);
const lastParty = (sent: string[]) => msgs(sent).filter((m) => m.t === 'party').at(-1);
const lastError = (sent: string[]) => msgs(sent).filter((m) => m.t === 'error').at(-1)?.msg;

function setup(fillWithBots = true) {
  const started: { ids: number[]; teams: Record<number, number> }[] = [];
  const host = { start: (_r: string, _s: number, ids: number[], teams: Record<number, number>) => started.push({ ids, teams }), input() {}, spectate() {}, leave() {}, stats: () => ({ tickMs: 0, workers: 0 }) } as unknown as MatchHost;
  const mm = new Matchmaker({ minVerifiedForTicket: 1, fillWithBots, onScore: () => ({ awarded: true, epoch: 1 }) }, 10, 5);
  mm.host = host;
  let now = 1_000_000;
  const parties = new Parties(mm, () => now);
  const assign = () => (mm as unknown as { assign(): void }).assign();
  return { mm, parties, started, assign, advance: (ms: number) => { now += ms; return now; }, now: () => now };
}

test('create gives a code; friends join with it and everyone sees every slot', () => {
  const { parties } = setup();
  const a = fakeClient(1, 'alice'), b = fakeClient(2, 'bob');
  parties.handle(a.c, { t: 'party', op: 'create', mode: 'squad', skin: 3 });
  const pa = lastParty(a.sent)!.party!;
  assert.match(pa.code, /^[A-Z2-9]{5}$/);
  assert.equal(pa.size, 4); assert.equal(pa.leader, 1); assert.equal(pa.members.length, 1);
  assert.equal(pa.members[0].skin, 3); assert.equal(pa.members[0].ready, true, 'the leader is always ready');
  parties.handle(b.c, { t: 'party', op: 'join', code: pa.code.toLowerCase(), skin: 1 });
  for (const s of [a.sent, b.sent]) {
    const v = lastParty(s)!.party!;
    assert.deepEqual(v.members.map((m) => m.name), ['alice', 'bob']);
    assert.equal(v.members[1].skin, 1); assert.equal(v.members[1].ready, false);
  }
  assert.equal(lastParty(b.sent)!.party!.you, 2);
  assert.ok(lastParty(b.sent)!.token, 'a member gets a token to reclaim the slot');
});

test('wrong code and a full party are turned away', () => {
  const { parties } = setup();
  const a = fakeClient(1), b = fakeClient(2), c = fakeClient(3);
  parties.handle(a.c, { t: 'party', op: 'create', mode: 'duo' });
  const code = lastParty(a.sent)!.party!.code;
  parties.handle(b.c, { t: 'party', op: 'join', code: 'NOPE1' });
  assert.equal(lastParty(b.sent)!.party, null); assert.equal(lastParty(b.sent)!.msg, 'No party with that code');
  parties.handle(b.c, { t: 'party', op: 'join', code });
  parties.handle(c.c, { t: 'party', op: 'join', code });
  assert.equal(lastParty(c.sent)!.party, null); assert.equal(lastParty(c.sent)!.msg, 'That party is full');
  assert.equal(lastParty(a.sent)!.party!.members.length, 2);
});

test('ready check gates Play; only the leader can pick the mode and hit Play', () => {
  const { parties, mm } = setup();
  const a = fakeClient(1), b = fakeClient(2), c = fakeClient(3);
  parties.handle(a.c, { t: 'party', op: 'create', mode: 'squad' });
  const code = lastParty(a.sent)!.party!.code;
  parties.handle(b.c, { t: 'party', op: 'join', code });
  parties.handle(c.c, { t: 'party', op: 'join', code });
  parties.handle(b.c, { t: 'party', op: 'play' });
  assert.equal(lastError(b.sent), 'Only the party leader can do that');
  parties.handle(a.c, { t: 'party', op: 'mode', mode: 'duo' });
  assert.match(lastError(a.sent)!, /Too many/);
  assert.equal(parties.play(a.c), false);
  assert.equal(lastError(a.sent), 'Waiting for everyone to be ready');
  parties.handle(b.c, { t: 'party', op: 'ready', ready: true });
  assert.equal(lastParty(a.sent)!.party!.members[1].ready, true);
  parties.handle(c.c, { t: 'party', op: 'ready', ready: true });
  parties.handle(c.c, { t: 'party', op: 'ready', ready: false });
  assert.equal(parties.play(a.c), false);
  parties.handle(c.c, { t: 'party', op: 'ready', ready: true });
  assert.equal(parties.play(a.c), true);
  assert.equal(mm.queued, 3);
  assert.equal(lastParty(b.sent)!.party!.state, 'queued');
});

test('the party queues together: one room, one team, never split over a nearly full room', () => {
  const { parties, mm, assign, started } = setup();
  // a duo room one seat short of full: the party of two must not be split across it
  const filler = Array.from({ length: ROOM_MAX - 1 }, (_, i) => fakeClient(100 + i));
  for (const f of filler) mm.enqueue(f.c, { mode: 'duo' });
  assign();
  const full = [...mm.rooms.values()][0];
  assert.equal(full.seats.length, ROOM_MAX - 1);
  const a = fakeClient(1), b = fakeClient(2);
  parties.handle(a.c, { t: 'party', op: 'create', mode: 'duo' });
  parties.handle(b.c, { t: 'party', op: 'join', code: lastParty(a.sent)!.party!.code });
  parties.handle(b.c, { t: 'party', op: 'ready' });
  assert.equal(parties.play(a.c), true);
  assign();
  assert.ok(a.c.room && a.c.room === b.c.room, 'same room');
  assert.notEqual(a.c.room, full, 'not squeezed into the room with one seat');
  // the room starts (bots fill it) and the two are teammates
  const room = a.c.room as Room;
  let now = Date.now();
  for (let t = 0; t < 30 && room.phase !== 'live'; t++) { room.update(now); now += 5_000; }
  assert.equal(room.phase, 'live');
  const s = started.at(-1)!;
  assert.equal(s.teams[1], s.teams[2], 'one team');
  assert.equal(Object.values(s.teams).filter((t) => t === s.teams[1]).length, 2, 'nobody else on it');
  parties.tick();
  assert.equal(lastParty(a.sent)!.party!.state, 'playing');
});

test('the leader leaving hands the party on; the last one out closes it', () => {
  const { parties } = setup();
  const a = fakeClient(1), b = fakeClient(2), c = fakeClient(3);
  parties.handle(a.c, { t: 'party', op: 'create', mode: 'squad' });
  const code = lastParty(a.sent)!.party!.code;
  parties.handle(b.c, { t: 'party', op: 'join', code });
  parties.handle(a.c, { t: 'party', op: 'leave' });
  assert.equal(lastParty(a.sent)!.party, null);
  const v = lastParty(b.sent)!.party!;
  assert.equal(v.leader, 2); assert.equal(v.members.length, 1);
  parties.handle(b.c, { t: 'party', op: 'leave' });
  assert.equal(parties.count, 0);
  parties.handle(c.c, { t: 'party', op: 'join', code });
  assert.equal(lastParty(c.sent)!.msg, 'No party with that code');
});

test('a dropped member keeps the slot for a reconnect, then loses it', () => {
  const { parties, advance } = setup();
  const a = fakeClient(1), b = fakeClient(2, 'bob');
  parties.handle(a.c, { t: 'party', op: 'create', mode: 'duo' });
  const code = lastParty(a.sent)!.party!.code;
  parties.handle(b.c, { t: 'party', op: 'join', code });
  const token = lastParty(b.sent)!.token!;
  parties.leave(b.c, 'gone');
  let v = lastParty(a.sent)!.party!;
  assert.equal(v.members.length, 2); assert.equal(v.members[1].away, true);
  assert.equal(parties.play(a.c), false, 'no Play while someone is reconnecting');
  // the party is full meanwhile: a stranger can't take the slot, the token can
  const x = fakeClient(9);
  parties.handle(x.c, { t: 'party', op: 'join', code });
  assert.equal(lastParty(x.sent)!.msg, 'That party is full');
  advance(PARTY_GRACE_MS / 2);
  const b2 = fakeClient(7, 'bob');
  parties.handle(b2.c, { t: 'party', op: 'join', code, token });
  v = lastParty(a.sent)!.party!;
  assert.deepEqual(v.members.map((m) => [m.id, !!m.away]), [[1, false], [7, false]]);
  // the new socket can arrive before the server sees the old one close: the token still wins
  const b3 = fakeClient(8, 'bob');
  parties.handle(b3.c, { t: 'party', op: 'join', code, token });
  assert.deepEqual(lastParty(a.sent)!.party!.members.map((m) => m.id), [1, 8]);
  assert.equal(parties.partyOf(b2.c), null, 'the stale socket is out');
  parties.leave(b2.c, 'gone');                                 // its close arriving late changes nothing
  assert.equal(lastParty(a.sent)!.party!.members[1].away, undefined);
  // dropped again, and this time nobody comes back
  parties.leave(b3.c, 'gone');
  advance(PARTY_GRACE_MS + 1); parties.tick();
  assert.equal(lastParty(a.sent)!.party!.members.length, 1);
  // the leader drops too: the party waits for them, then goes
  parties.leave(a.c, 'gone');
  assert.equal(parties.count, 1);
  advance(PARTY_GRACE_MS + 1); parties.tick();
  assert.equal(parties.count, 0);
});

test('the leader backing out of a filling room brings the party back; after a match ready resets', () => {
  const { parties, mm, assign } = setup();
  const a = fakeClient(1), b = fakeClient(2);
  parties.handle(a.c, { t: 'party', op: 'create', mode: 'duo' });
  parties.handle(b.c, { t: 'party', op: 'join', code: lastParty(a.sent)!.party!.code });
  parties.handle(b.c, { t: 'party', op: 'ready' });
  parties.play(a.c); assign();
  assert.ok(b.c.room);
  parties.cancel(a.c); mm.leave(a.c);
  assert.equal(b.c.room, null, 'the member came back with the leader');
  parties.tick();
  const v = lastParty(b.sent)!.party!;
  assert.equal(v.state, 'idle');
  assert.equal(v.members[1].ready, false, 'ready again for the next one');
});
