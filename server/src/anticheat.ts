// Server-side cheat checks. The server already owns movement, fire rate, damage and loot, so a
// modified client cannot speed up, teleport, shoot faster or spawn items. What is left is what
// a client can still fake with honest-looking inputs, and what it could learn from snapshots:
//   - replayed or reordered inputs        -> dropped (seq must go up)
//   - aimbots                             -> statistics: snap-to-target hits, headshot rate
//   - wallhacks (ESP)                     -> handled in match.ts: hidden enemies are not sent
// A flagged player keeps playing (no tells for the cheat author) but cannot earn a ticket, and is
// logged for review.

const FLICK_RAD = 0.55;      // > ~31 degrees of turn inside one 33 ms tick
const FLICK_WINDOW = 3;      // a hit within this many ticks of a flick counts as a flick-hit
const MIN_SAMPLES = 25;

interface Stats {
  lastSeq: number; lastYaw: number; lastPitch: number; flickTick: number;
  shots: number; heads: number; flickHits: number; lastHitTick: number;
  dropped: number; flagged: string | null;
}

export interface Flag { id: number; reason: string }

const wrap = (a: number) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };

export class Watchdog {
  private stats = new Map<number, Stats>();
  private fresh: Flag[] = [];

  private of(id: number): Stats {
    let s = this.stats.get(id);
    if (!s) { s = { lastSeq: -1, lastYaw: 0, lastPitch: 0, flickTick: -99, shots: 0, heads: 0, flickHits: 0, lastHitTick: -1, dropped: 0, flagged: null }; this.stats.set(id, s); }
    return s;
  }

  // false = drop this input
  input(id: number, seq: number, yaw: number, pitch: number, tick: number): boolean {
    const s = this.of(id);
    if (seq <= s.lastSeq) { if (++s.dropped > 300) this.flag(id, 'input replay'); return false; }
    if (s.lastSeq >= 0 && Math.hypot(wrap(yaw - s.lastYaw), pitch - s.lastPitch) > FLICK_RAD) s.flickTick = tick;
    s.lastSeq = seq; s.lastYaw = yaw; s.lastPitch = pitch;
    return true;
  }

  // one sample per shooter per tick: shotgun pellets landing together are one shot, not nine
  hit(by: number, head: boolean, tick: number) {
    const s = this.of(by);
    if (s.lastHitTick === tick) return;
    s.lastHitTick = tick;
    s.shots++;
    if (head) s.heads++;
    if (tick - s.flickTick <= FLICK_WINDOW) s.flickHits++;
    if (s.shots < MIN_SAMPLES || s.flagged) return;
    // good players hit heads a lot, but not three quarters of the time over dozens of hits
    if (s.shots >= 40 && s.heads / s.shots > 0.75) this.flag(by, `headshot rate ${Math.round((s.heads / s.shots) * 100)}% over ${s.shots} hits`);
    // humans flick and miss; a bot snaps onto targets and lands it every time
    else if (s.flickHits / s.shots > 0.45) this.flag(by, `snap hits ${s.flickHits}/${s.shots}`);
  }

  private flag(id: number, reason: string) {
    const s = this.of(id);
    if (s.flagged) return;
    s.flagged = reason;
    this.fresh.push({ id, reason });
  }

  isFlagged(id: number) { return !!this.stats.get(id)?.flagged; }
  drain(): Flag[] { const f = this.fresh; this.fresh = []; return f; }
}
