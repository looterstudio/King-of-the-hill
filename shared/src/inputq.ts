// Which of a player's inputs the simulation runs this tick: the server side of client prediction,
// shared by the game server and the offline demo.
//
// A player's body only ever moves with that player's own inputs, one per tick, in order, so it
// stays exactly where the client predicted it. When an input is late the body waits that tick
// (the old code ran a guessed stand-in AND the real input later: a double move, and every input
// after a hiccup stayed queued for good, +267 ms of input lag after one 250 ms stall). The next
// tick catches up with a second input: never more inputs than ticks, so no speed hack. A player
// silent for 1.5 s (a frozen tab, a dead connection) gets neutral inputs: they stop, and fall.
import type { Input } from './sim.ts';

const MAX_QUEUED = 4;       // inputs waiting beyond what waiting earned (133 ms): more is input lag
const JITTER_KEEP = 2;      // a backlog that never drains keeps this many; the rest is trimmed
const OWED_MAX = 30;        // catch-up owed after waiting, at most a second (one extra input per tick)
const SILENT_TICKS = 45;    // no input for 1.5 s (paused clients send still inputs: this is a frozen or vanished one): neutral inputs

export class InputQueue {
  queue: Input[] = [];
  last: Input;
  private newest = -1;        // highest sequence number received (duplicates and replays are ignored)
  private missed = 0;         // ticks in a row with no input
  private owed = 0;           // ticks the body waited and may catch up
  private low = Infinity; private lowT = 0; // the smallest backlog seen over the last second

  constructor(empty: Input, private tickHz = 30) { this.last = empty; }

  push(i: Input) {
    if (i.seq <= this.newest) return;
    this.newest = i.seq;
    this.queue.push(i);
    // inputs the body waited for are owed, not lag (TCP delivers a late packet with the ones behind it)
    if (this.queue.length > MAX_QUEUED + this.owed) this.queue.shift();
  }

  next(): Input[] {
    this.low = Math.min(this.low, this.queue.length);
    if (++this.lowT >= this.tickHz) {
      // a whole second with more waiting than the jitter buffer (a client clock running fast): trim
      for (let k = JITTER_KEEP; k < this.low && this.queue.length > JITTER_KEEP; k++) this.queue.shift();
      this.low = Infinity; this.lowT = 0;
    }
    const i = this.queue.shift();
    if (!i) {
      if (this.newest >= 0) this.owed = Math.min(OWED_MAX, this.owed + 1);
      if (++this.missed <= SILENT_TICKS) return []; // late packet: the body waits a tick
      return [{ ...this.last, fwd: 0, strafe: 0, sprint: false, fire: false, aim: false, grapple: false, hold: false, up: 0,
        jump: false, slide: false, slot: 0, reload: false, interact: false, item: 0, perk: false }];
    }
    this.missed = 0; this.last = i;
    const out = [i];
    if (this.owed > 0 && this.queue.length) { const j = this.queue.shift()!; this.last = j; this.owed--; out.push(j); }
    return out;
  }
}
