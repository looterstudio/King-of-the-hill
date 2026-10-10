// Hourly epochs. Every match scores points (a win, a top placement, kills); at the boundary the
// pot is snapshotted, paid out by the payout policy (by default the hour's top scorer takes it), and written out as a merkle root the on-chain
// vault will honour for claims.
//
// Two things stop "buy 5 minutes before the payout, sell right after":
//   - the hold requirement is checked at secret moments through the epoch (six balance snapshots)
//     and again at the close; below it at any of them and that wallet's points for the epoch are
//     void. The requirement is fixed in tokens when the epoch starts: min(HOLD_TOKENS, $HOLD_MIN_USD
//     at the hour's median price), so a price drop never pushes a holder out mid-epoch.
//   - scoring closes at a random minute inside the last 10 (a candle close): nobody can time it.
//     Points scored after it count for the next epoch.
// The snapshot times and the close minute come from the epoch secret, whose hash is published
// when the epoch starts and which is revealed at settlement, so anyone can check them afterwards.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { EPOCH_MS, epochEnd, epochOf } from '../../shared/src/constants.ts';
import type { SettledView } from '../../shared/src/protocol.ts';
import type { Config } from './config.ts';
import type { PotSource } from './pot.ts';
import { computePayouts } from './payout.ts';
import { buildTree } from './merkle.ts';

interface Tally { name: string; wins: number }

export const CANDLE_MS = 10 * 60_000; // scoring closes at a random moment inside the last 10 minutes
const SNAPSHOTS = 6;                  // hidden balance checks per epoch
const SWEEP_CONCURRENCY = 8;

export class Epochs extends EventEmitter {
  current: number;
  private tallies = new Map<number, Map<string, Tally>>();
  private secretKey: Buffer;
  private winsFile: string;
  private timer: NodeJS.Timeout | null = null;
  rolloverIn = 0n;
  lastSettled: SettledView | null = null;
  private voided = new Map<number, Map<string, string>>(); // epoch -> wallet -> why
  private reqTokens = new Map<number, number>();           // epoch -> tokens a wallet must hold
  private snapsDone = new Map<number, number>();           // epoch -> snapshots taken so far
  private sweeping = false;
  private pendingClose = new Set<number>(); // scoring over, waiting to settle (strictly in order)
  private settling = false;
  private retryAt = 0;
  private voidFile: string;
  private reqFile: string;

  // priceUsd: the token's median USD price (null when the feed is down)
  constructor(private cfg: Config, private pot: PotSource, private now = () => Date.now(), private priceUsd: () => number | null = () => null) {
    super();
    mkdirSync(join(cfg.dataDir, 'epochs'), { recursive: true });
    const keyFile = join(cfg.dataDir, 'server.secret');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.secretKey = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    this.winsFile = join(cfg.dataDir, 'wins.jsonl');
    this.voidFile = join(cfg.dataDir, 'voids.jsonl');
    this.reqFile = join(cfg.dataDir, 'requirements.jsonl');
    this.current = epochOf(this.now());
    this.replay();
  }

  // ---------- hold requirement, snapshots, candle close ----------
  private derive(epoch: number, tag: string) { return createHmac('sha256', this.secretFor(epoch)).update(tag).digest().readUInt32BE(0); }
  // when scoring for this epoch stops: a random minute in the last 10
  closeAt(epoch: number) { return epochEnd(epoch) - CANDLE_MS + (this.derive(epoch, 'close') % (CANDLE_MS / 60_000)) * 60_000; }
  snapshotTimes(epoch: number) {
    const start = epoch * EPOCH_MS;
    return Array.from({ length: SNAPSHOTS }, (_, k) => start + 60_000 + (this.derive(epoch, `snap:${k}`) % (EPOCH_MS - CANDLE_MS - 60_000))).sort((a, b) => a - b);
  }
  // points scored now count for this epoch, or for the next one once this one's scoring closed
  scoringEpoch() { const t = this.now(); return t >= this.closeAt(this.current) ? this.current + 1 : this.current; }

  // tokens (whole units) a wallet must hold to keep its points this epoch, fixed at first use
  requirement(epoch = this.current): number {
    let r = this.reqTokens.get(epoch);
    if (r !== undefined) return r;
    if (this.cfg.holdMinUsd <= 0 && this.cfg.holdTokens <= 0) r = 0;
    else {
      const usd = this.priceUsd();
      const byUsd = this.cfg.holdMinUsd > 0 && usd ? this.cfg.holdMinUsd / usd : Infinity;
      r = Math.min(this.cfg.holdTokens > 0 ? this.cfg.holdTokens : Infinity, byUsd);
      if (!Number.isFinite(r)) r = this.cfg.holdTokens; // no price yet and no token cap: fall back to the cap
    }
    this.reqTokens.set(epoch, r);
    appendFileSync(this.reqFile, JSON.stringify({ epoch, tokens: r, at: this.now() }) + '\n');
    return r;
  }
  rawRequirement(epoch: number, decimals: number) { return BigInt(Math.ceil(this.requirement(epoch) * 10 ** decimals)); }

  isVoid(epoch: number, wallet: string) { return this.voided.get(epoch)?.has(wallet) ?? false; }
  private voidWallet(epoch: number, wallet: string, why: string) {
    let m = this.voided.get(epoch);
    if (!m) { m = new Map(); this.voided.set(epoch, m); }
    if (m.has(wallet)) return;
    m.set(wallet, why);
    appendFileSync(this.voidFile, JSON.stringify({ epoch, wallet, why, at: this.now() }) + '\n');
    this.emit('void', { epoch, wallet, why });
  }

  // read the balance of every wallet holding points this epoch; below the requirement = void.
  // A failed read never voids anyone (an RPC outage must not wipe an epoch): it is retried, and the
  // count of wallets still unread comes back so the close can wait for them instead.
  async sweep(epoch: number, why: string): Promise<number> {
    const wallets = [...(this.tallies.get(epoch)?.keys() ?? [])].filter((w) => !this.isVoid(epoch, w));
    let i = 0, unread = 0;
    const worker = async () => {
      while (i < wallets.length) {
        const w = wallets[i++];
        for (let attempt = 0; ; attempt++) {
          try {
            const h = await this.pot.holderTokens(w, true);
            if (h.raw < this.rawRequirement(epoch, h.decimals)) this.voidWallet(epoch, w, why);
            break;
          } catch {
            if (attempt >= 2) { unread++; break; }
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
    return unread;
  }

  // a crash mid-epoch must not lose tickets: every win is appended before it is acknowledged
  private replay() {
    const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
    for (const line of lines(this.winsFile)) {
      try { const w = JSON.parse(line) as { epoch: number; wallet: string; name: string; tickets?: number }; this.bump(w.epoch, w.wallet, w.name, w.tickets ?? 1); } catch { /* torn last line */ }
    }
    for (const line of lines(this.reqFile)) { try { const r = JSON.parse(line) as { epoch: number; tokens: number }; this.reqTokens.set(r.epoch, r.tokens); } catch { /* torn */ } }
    for (const line of lines(this.voidFile)) {
      try {
        const v = JSON.parse(line) as { epoch: number; wallet: string; why: string };
        let m = this.voided.get(v.epoch); if (!m) { m = new Map(); this.voided.set(v.epoch, m); } m.set(v.wallet, v.why);
      } catch { /* torn */ }
    }
  }
  private settledFile(epoch: number) { return join(this.cfg.dataDir, 'epochs', `${epoch}.json`); }
  private bump(epoch: number, wallet: string, name: string, n = 1) {
    if (epoch < this.current && existsSync(this.settledFile(epoch))) return; // already paid out
    let m = this.tallies.get(epoch);
    if (!m) { m = new Map(); this.tallies.set(epoch, m); }
    const t = m.get(wallet) ?? { name, wins: 0 };
    t.wins += n; t.name = name; m.set(wallet, t);
  }

  // points for one match (see POINTS); scored into whichever epoch is open for scoring
  recordWin(wallet: string, name: string, tickets = 1): number {
    const epoch = this.scoringEpoch();
    appendFileSync(this.winsFile, JSON.stringify({ epoch, wallet, name, tickets, at: this.now() }) + '\n');
    this.bump(epoch, wallet, name, tickets);
    return epoch;
  }

  secretFor(epoch: number) { return createHmac('sha256', this.secretKey).update(`epoch:${epoch}`).digest(); }
  commitFor(epoch: number) { return createHash('sha256').update(this.secretFor(epoch)).digest('hex'); }
  get endsAt() { return epochEnd(this.current); }

  leaderboard(limit = 10) {
    const m = this.tallies.get(this.current) ?? new Map<string, Tally>();
    // voided wallets stay listed until the settlement: dropping them live told everyone when a hidden snapshot ran
    return [...m.entries()].map(([wallet, t]) => ({ wallet, name: t.name, wins: t.wins }))
      .sort((a, b) => b.wins - a.wins).slice(0, limit);
  }

  // the process was down across a boundary: settle every closed epoch that still holds tickets
  async catchUp() {
    for (const e of this.tallies.keys()) if (e < this.current && !existsSync(this.settledFile(e))) this.pendingClose.add(e);
    await this.drainCloses();
  }

  start() {
    const run = (p: Promise<unknown>) => { p.catch((e) => console.error('[epoch]', e)); };
    run(this.catchUp());
    this.timer = setInterval(() => run(this.check()), 1000);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async check() {
    const t = this.now(), e = epochOf(t);
    // hidden snapshots of the epoch in progress
    const times = this.snapshotTimes(this.current), done = this.snapsDone.get(this.current) ?? 0;
    if (done < times.length && t >= times[done] && !this.sweeping) {
      this.snapsDone.set(this.current, done + 1);
      this.sweeping = true;
      try { await this.sweep(this.current, `below the hold requirement at snapshot ${done + 1}`); } finally { this.sweeping = false; }
    }
    if (e !== this.current) { this.pendingClose.add(this.current); this.current = e; }
    await this.drainCloses();
  }

  // the last balance check, then the payout, one epoch at a time and oldest first. Never on a pot that
  // hasn't been read (right after a restart, or with the RPC down): that settled an epoch with nothing
  // and deleted its points. Wallets whose balance couldn't be read hold the close until they can be.
  private async drainCloses() {
    if (this.settling || this.pendingClose.size === 0 || this.now() < this.retryAt) return;
    this.settling = true;
    try {
      for (const epoch of [...this.pendingClose].sort((a, b) => a - b)) {
        if (existsSync(this.settledFile(epoch))) { this.pendingClose.delete(epoch); continue; }
        if (!this.pot.ready()) { this.retryAt = this.now() + 5_000; return; }
        const unread = await this.sweep(epoch, 'below the hold requirement at the close');
        if (unread > 0 || !this.pot.ready()) {
          console.warn(`[epoch] ${epoch}: ${unread} balance reads failed, settling again in 30 s`);
          this.retryAt = this.now() + 30_000; return;
        }
        this.settle(epoch);
        this.pendingClose.delete(epoch);
      }
    } finally { this.settling = false; }
  }

  settle(epoch: number): SettledView {
    const tally = this.tallies.get(epoch) ?? new Map<string, Tally>();
    const wins = new Map([...tally.entries()].filter(([w]) => !this.isVoid(epoch, w)).map(([w, t]) => [w, t.wins]));
    const potLamports = this.pot.balance();
    const reveal = this.secretFor(epoch);
    const seed = createHash('sha256').update(reveal).update(`draw:${epoch}`).digest();
    const res = computePayouts(potLamports, wins, {
      mode: this.cfg.payoutMode, rolloverBps: this.cfg.rolloverBps, drawTiersBps: this.cfg.drawTiersBps, seed,
    });
    const tree = buildTree(epoch, res.payouts);
    const paid = res.payouts.reduce((s, p) => s + p.lamports, 0n);
    this.pot.markPaid(epoch, paid);
    this.rolloverIn = res.rollover;

    const record = {
      epoch, potLamports: potLamports.toString(), paid: paid.toString(), rollover: res.rollover.toString(),
      mode: this.cfg.payoutMode, merkleRoot: tree.root.toString('hex'), commit: this.commitFor(epoch), reveal: reveal.toString('hex'),
      claims: res.payouts.map((p, i) => ({ index: i, wallet: p.wallet, lamports: p.lamports.toString(), proof: tree.proofs[i].map((h) => h.toString('hex')) })),
      tickets: Object.fromEntries(wins),
      voided: Object.fromEntries(this.voided.get(epoch) ?? []),
      holdTokens: this.requirement(epoch), closeAt: this.closeAt(epoch), snapshots: this.snapshotTimes(epoch),
    };
    // the keeper reads this file and submits settle_epoch(root, total, count) to the vault program
    writeFileSync(this.settledFile(epoch), JSON.stringify(record, null, 2));
    this.tallies.delete(epoch); this.voided.delete(epoch); this.snapsDone.delete(epoch);

    const view: SettledView = {
      epoch, potLamports: record.potLamports, rollover: record.rollover, merkleRoot: record.merkleRoot, reveal: record.reveal,
      winners: res.payouts.map((p) => ({ wallet: p.wallet, name: tally.get(p.wallet)?.name ?? '', lamports: p.lamports.toString() })),
    };
    this.lastSettled = view;
    this.emit('settled', view);
    return view;
  }
}
