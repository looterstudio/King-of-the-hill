// 6-hour epochs. Room wins are tickets; at the boundary the pot is snapshotted, split by the
// payout policy, and written out as a merkle root the on-chain vault will honour for claims.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { epochEnd, epochOf } from '../../shared/src/constants.ts';
import type { SettledView } from '../../shared/src/protocol.ts';
import type { Config } from './config.ts';
import type { PotSource } from './pot.ts';
import { computePayouts } from './payout.ts';
import { buildTree } from './merkle.ts';

interface Tally { name: string; wins: number }

export class Epochs extends EventEmitter {
  current: number;
  private tallies = new Map<number, Map<string, Tally>>();
  private secretKey: Buffer;
  private winsFile: string;
  private timer: NodeJS.Timeout | null = null;
  rolloverIn = 0n;
  lastSettled: SettledView | null = null;

  constructor(private cfg: Config, private pot: PotSource, private now = () => Date.now()) {
    super();
    mkdirSync(join(cfg.dataDir, 'epochs'), { recursive: true });
    const keyFile = join(cfg.dataDir, 'server.secret');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.secretKey = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    this.winsFile = join(cfg.dataDir, 'wins.jsonl');
    this.current = epochOf(this.now());
    this.replay();
  }

  // a crash mid-epoch must not lose tickets: every win is appended before it is acknowledged
  private replay() {
    if (!existsSync(this.winsFile)) return;
    for (const line of readFileSync(this.winsFile, 'utf8').split('\n')) {
      if (!line) continue;
      try { const w = JSON.parse(line) as { epoch: number; wallet: string; name: string }; this.bump(w.epoch, w.wallet, w.name); } catch { /* torn last line */ }
    }
  }
  private settledFile(epoch: number) { return join(this.cfg.dataDir, 'epochs', `${epoch}.json`); }
  private bump(epoch: number, wallet: string, name: string) {
    if (epoch < this.current && existsSync(this.settledFile(epoch))) return; // already paid out
    let m = this.tallies.get(epoch);
    if (!m) { m = new Map(); this.tallies.set(epoch, m); }
    const t = m.get(wallet) ?? { name, wins: 0 };
    t.wins++; t.name = name; m.set(wallet, t);
  }

  recordWin(wallet: string, name: string): number {
    const epoch = this.current;
    appendFileSync(this.winsFile, JSON.stringify({ epoch, wallet, name, at: this.now() }) + '\n');
    this.bump(epoch, wallet, name);
    return epoch;
  }

  secretFor(epoch: number) { return createHmac('sha256', this.secretKey).update(`epoch:${epoch}`).digest(); }
  commitFor(epoch: number) { return createHash('sha256').update(this.secretFor(epoch)).digest('hex'); }
  get endsAt() { return epochEnd(this.current); }

  leaderboard(limit = 10) {
    const m = this.tallies.get(this.current) ?? new Map<string, Tally>();
    return [...m.entries()].map(([wallet, t]) => ({ wallet, name: t.name, wins: t.wins }))
      .sort((a, b) => b.wins - a.wins).slice(0, limit);
  }

  // the process was down across a boundary: settle every closed epoch that still holds tickets
  catchUp() {
    for (const e of [...this.tallies.keys()].sort((a, b) => a - b)) if (e < this.current && !existsSync(this.settledFile(e))) this.settle(e);
  }

  start() { this.catchUp(); this.timer = setInterval(() => this.check(), 1000); }
  stop() { if (this.timer) clearInterval(this.timer); }

  check() {
    const e = epochOf(this.now());
    if (e === this.current) return;
    const closing = this.current;
    this.current = e;
    this.settle(closing);
  }

  settle(epoch: number): SettledView {
    const tally = this.tallies.get(epoch) ?? new Map<string, Tally>();
    const wins = new Map([...tally.entries()].map(([w, t]) => [w, t.wins]));
    const potLamports = this.pot.balance();
    const reveal = this.secretFor(epoch);
    const seed = createHash('sha256').update(reveal).update(`draw:${epoch}`).digest();
    const res = computePayouts(potLamports, wins, {
      mode: this.cfg.payoutMode, rolloverBps: this.cfg.rolloverBps, drawTiersBps: this.cfg.drawTiersBps, seed,
    });
    const tree = buildTree(epoch, res.payouts);
    const paid = res.payouts.reduce((s, p) => s + p.lamports, 0n);
    this.pot.markPaid(paid);
    this.rolloverIn = res.rollover;

    const record = {
      epoch, potLamports: potLamports.toString(), paid: paid.toString(), rollover: res.rollover.toString(),
      mode: this.cfg.payoutMode, merkleRoot: tree.root.toString('hex'), commit: this.commitFor(epoch), reveal: reveal.toString('hex'),
      claims: res.payouts.map((p, i) => ({ index: i, wallet: p.wallet, lamports: p.lamports.toString(), proof: tree.proofs[i].map((h) => h.toString('hex')) })),
      tickets: Object.fromEntries(wins),
    };
    // the keeper reads this file and submits settle_epoch(root, total, count) to the vault program
    writeFileSync(this.settledFile(epoch), JSON.stringify(record, null, 2));
    this.tallies.delete(epoch);

    const view: SettledView = {
      epoch, potLamports: record.potLamports, rollover: record.rollover, merkleRoot: record.merkleRoot, reveal: record.reveal,
      winners: res.payouts.map((p) => ({ wallet: p.wallet, name: tally.get(p.wallet)?.name ?? '', lamports: p.lamports.toString() })),
    };
    this.lastSettled = view;
    this.emit('settled', view);
    return view;
  }
}
