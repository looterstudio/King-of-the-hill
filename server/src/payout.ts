// Pure payout math. bigint end to end: lamports never touch floating point.
import { createHash } from 'node:crypto';

export interface Payout { wallet: string; lamports: bigint }
export interface PayoutResult { payouts: Payout[]; rollover: bigint; distributable: bigint }

export interface PayoutPolicy {
  mode: 'winner' | 'prorata' | 'draw';
  rolloverBps: number;
  drawTiersBps: number[];
  seed: Buffer; // only used by draw
}

const BPS = 10_000n;
// the vault program's limit per epoch (programs/pot_vault MAX_CLAIMS): a bigger root can't be posted
export const MAX_CLAIMS = 8192;
// below this a claim costs about as much as it pays, and a transfer into an empty wallet that leaves
// it under the rent minimum fails; smaller shares roll over into the next pot
export const MIN_PAYOUT_LAMPORTS = 1_000_000n;

const byWallet = ([a]: [string, number], [b]: [string, number]) => (a < b ? -1 : a > b ? 1 : 0);

export function computePayouts(pot: bigint, wins: Map<string, number>, policy: PayoutPolicy): PayoutResult {
  if (pot <= 0n) return { payouts: [], rollover: 0n, distributable: 0n };
  let entries = [...wins.entries()].filter(([, w]) => w > 0).sort(byWallet);
  // more scoring wallets than one root can hold: the top MAX_CLAIMS by points (ties by wallet) are paid
  if (entries.length > MAX_CLAIMS) entries = [...entries].sort((a, b) => b[1] - a[1] || byWallet(a, b)).slice(0, MAX_CLAIMS).sort(byWallet);
  const totalTickets = entries.reduce((s, [, w]) => s + BigInt(w), 0n);
  if (totalTickets === 0n) return { payouts: [], rollover: pot, distributable: 0n };

  const distributable = (pot * (BPS - BigInt(policy.rolloverBps))) / BPS;
  const payouts = policy.mode === 'winner' ? winner(distributable, entries) : policy.mode === 'draw' ? draw(distributable, entries, policy) : prorata(distributable, entries, totalTickets);
  const kept = payouts.filter((p) => p.lamports >= MIN_PAYOUT_LAMPORTS);
  const paid = kept.reduce((s, p) => s + p.lamports, 0n);
  // rounding dust, shares under the minimum and any unawarded tiers stay in the pot
  return { payouts: kept, rollover: pot - paid, distributable };
}

// the hour's winner takes the pot: the most points; a tie splits it evenly (the dust rolls over)
function winner(dist: bigint, entries: [string, number][]): Payout[] {
  const top = Math.max(...entries.map(([, w]) => w)), best = entries.filter(([, w]) => w === top);
  return best.map(([wallet]) => ({ wallet, lamports: dist / BigInt(best.length) }));
}

function prorata(dist: bigint, entries: [string, number][], total: bigint): Payout[] {
  return entries.map(([wallet, w]) => ({ wallet, lamports: (dist * BigInt(w)) / total }));
}

// Weighted draw without replacement, one winner per tier. The seed comes from a commit-reveal
// (hash published at epoch start, secret revealed at settlement), so the operator cannot pick
// the seed after seeing who holds tickets.
function draw(dist: bigint, entries: [string, number][], policy: PayoutPolicy): Payout[] {
  const pool = entries.map(([wallet, w]) => ({ wallet, w: BigInt(w) }));
  const out: Payout[] = [];
  policy.drawTiersBps.forEach((bps, tier) => {
    const total = pool.reduce((s, e) => s + e.w, 0n);
    if (total === 0n) return;
    let pick = uniform(policy.seed, tier, total);
    const idx = pool.findIndex((e) => { if (pick < e.w) return true; pick -= e.w; return false; });
    const [winner] = pool.splice(idx, 1);
    out.push({ wallet: winner.wallet, lamports: (dist * BigInt(bps)) / BPS });
  });
  return out;
}

// uniform integer in [0, n) from sha256(seed || tier || counter), rejection sampled so there is no modulo bias
function uniform(seed: Buffer, tier: number, n: bigint): bigint {
  const limit = (1n << 256n) - ((1n << 256n) % n);
  for (let ctr = 0; ; ctr++) {
    const h = createHash('sha256').update(seed).update(Buffer.from([tier, ctr & 0xff, (ctr >> 8) & 0xff])).digest();
    const v = BigInt('0x' + h.toString('hex'));
    if (v < limit) return v % n;
  }
}
