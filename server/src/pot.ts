// Where the pot comes from. The token's trading fees (pump.fun creator fees, or a Token-2022
// transfer fee harvested and swapped to SOL) are claimed into the vault PDA by a keeper; this
// module only observes the vault and turns balance increases into "inflow" events for the UI.
import { EventEmitter } from 'node:events';
import type { Config } from './config.ts';

export interface PotSource extends EventEmitter {
  start(): void;
  stop(): void;
  balance(): bigint;                       // spendable lamports (vault minus reserve and unclaimed)
  markPaid(lamports: bigint): void;        // settlement reserved this much for claims
  holderBalance(wallet: string): Promise<bigint>;
}

// Local/dev: fake fee flow shaped like real trading (bursty, mostly small, occasional whale).
export class MockPot extends EventEmitter implements PotSource {
  private lamports = 0n;
  private timer: NodeJS.Timeout | null = null;
  constructor(start = 2_500_000_000n) { super(); this.lamports = start; }
  start() {
    const tick = () => {
      const whale = Math.random() < 0.06;
      const sol = whale ? 0.4 + Math.random() * 2.5 : 0.002 + Math.random() * 0.06;
      const add = BigInt(Math.round(sol * 1e9));
      this.lamports += add;
      this.emit('inflow', { lamports: add, source: whale ? 'whale buy fees' : 'trading fees' });
      this.timer = setTimeout(tick, 1500 + Math.random() * 4000);
    };
    this.timer = setTimeout(tick, 1000);
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  balance() { return this.lamports; }
  markPaid(l: bigint) { this.lamports -= l; }
  async holderBalance() { return 1n << 62n; }
}

// Production: poll the vault over JSON-RPC. No @solana/web3.js dependency; two calls is all we need.
export class SolanaPot extends EventEmitter implements PotSource {
  private raw = 0n;          // last observed vault lamports
  private reserved = 0n;       // settled since boot, possibly not yet posted on chain by the keeper
  private chainReserved = 0n;  // Config.reserved read from the vault program
  private timer: NodeJS.Timeout | null = null;
  private holderCache = new Map<string, { at: number; v: bigint }>();
  constructor(private cfg: Config) { super(); if (!cfg.vaultAddress) throw new Error('VAULT_ADDRESS is required for POT_SOURCE=solana'); }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.cfg.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  start() {
    const poll = async () => {
      try {
        const r = await this.rpc<{ value: number }>('getBalance', [this.cfg.vaultAddress, { commitment: 'confirmed' }]);
        const now = BigInt(r.value);
        if (this.raw !== 0n && now > this.raw) this.emit('inflow', { lamports: now - this.raw, source: 'trading fees' });
        this.raw = now;
        if (this.cfg.configAddress) {
          const a = await this.rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [this.cfg.configAddress, { encoding: 'base64', commitment: 'confirmed' }]);
          // Config layout: disc 8 | authority 32 | epoch_seconds 8 | last_settled 8 | settled_any 1 | reserved 8
          if (a.value) this.chainReserved = Buffer.from(a.value.data[0], 'base64').readBigUInt64LE(57);
        }
      } catch (e) { console.warn('[pot] poll failed:', (e as Error).message); }
      this.timer = setTimeout(poll, 10_000);
    };
    void poll();
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  balance() {
    // whichever is larger: a restart forgets local reservations, the chain lags until the keeper posts
    const held = this.chainReserved > this.reserved ? this.chainReserved : this.reserved;
    const free = this.raw - this.cfg.vaultReserveLamports - held;
    return free > 0n ? free : 0n;
  }
  markPaid(l: bigint) { this.reserved += l; }

  async holderBalance(wallet: string): Promise<bigint> {
    if (!this.cfg.tokenMint) return 0n;
    const hit = this.holderCache.get(wallet);
    if (hit && Date.now() - hit.at < 60_000) return hit.v;
    type Acc = { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } };
    const r = await this.rpc<{ value: Acc[] }>('getTokenAccountsByOwner', [
      wallet, { mint: this.cfg.tokenMint }, { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    const v = r.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    this.holderCache.set(wallet, { at: Date.now(), v });
    return v;
  }
}

export const makePot = (cfg: Config): PotSource => (cfg.potSource === 'solana' ? new SolanaPot(cfg) : new MockPot());
