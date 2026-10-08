// USD prices: the token (for the hold requirement, set once per epoch) and SOL (to show the pot
// in dollars). A thin pump.fun pool can be moved for a block or two, so nothing uses spot: the
// token price is the median of the last hour of samples.
import type { Config } from './config.ts';
import type { Holding } from './pot.ts';

const SAMPLE_MS = 30_000;
const WINDOW = 120;                 // 120 samples x 30 s = 1 h median
const STALE_MS = 20 * 60_000;

export class PriceFeed {
  private samples: { at: number; usd: number }[] = [];
  private sol: { at: number; usd: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private cfg: Config, private now = () => Date.now()) {}

  start() {
    if (this.cfg.potSource !== 'solana') { this.push(this.cfg.mockPriceUsd); this.sol = { at: Infinity, usd: this.cfg.mockSolUsd }; return; }
    const poll = async () => {
      try {
        const res = await fetch(this.cfg.priceUrl + `${this.cfg.tokenMint},${this.cfg.solMint}`, { signal: AbortSignal.timeout(8000) });
        const body = (await res.json()) as Record<string, { usdPrice?: number } | undefined>;
        const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
        const usd = body[this.cfg.tokenMint]?.usdPrice, sol = body[this.cfg.solMint]?.usdPrice;
        if (ok(usd)) this.push(usd);
        if (ok(sol)) this.sol = { at: this.now(), usd: sol };
      } catch (e) { console.warn('[price] poll failed:', (e as Error).message); }
      this.timer = setTimeout(poll, SAMPLE_MS);
    };
    void poll();
  }
  stop() { if (this.timer) clearTimeout(this.timer); }

  push(usd: number) {
    this.samples.push({ at: this.now(), usd });
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  solUsd(): number | null { return this.sol && this.now() - this.sol.at < STALE_MS ? this.sol.usd : this.sol?.at === Infinity ? this.sol.usd : null; }

  // median of the window, or null when there is nothing recent enough to trust
  usd(): number | null {
    const fresh = this.samples.filter((s) => this.now() - s.at < STALE_MS).map((s) => s.usd).sort((a, b) => a - b);
    if (fresh.length === 0) return null;
    const m = fresh.length >> 1;
    return fresh.length % 2 ? fresh[m] : (fresh[m - 1] + fresh[m]) / 2;
  }
}

// raw units needed to be worth `minUsd`, rounded up so $49.999 never passes. Float is fine here:
// it is a threshold, no lamports move, and the error is far below one token.
export function rawNeeded(minUsd: number, priceUsd: number, decimals: number): bigint {
  return BigInt(Math.ceil((minUsd / priceUsd) * 10 ** decimals));
}

export const holdUsd = (h: Holding, priceUsd: number) => (Number(h.raw) / 10 ** h.decimals) * priceUsd;
