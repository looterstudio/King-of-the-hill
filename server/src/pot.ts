// Where the pot comes from. The token's trading fees (pump.fun creator fees, or a Token-2022
// transfer fee harvested and swapped to SOL) are claimed into the vault PDA by a keeper; this
// module only observes the vault and turns balance increases into "inflow" events for the UI.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';

export interface Holding { raw: bigint; decimals: number }

// raw units -> human string for messages, e.g. 49_500_000n @ 6 -> "49.5"
export function fromRaw(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export interface PotSource extends EventEmitter {
  start(): void;
  stop(): void;
  balance(): bigint;                       // spendable lamports (vault minus reserve and unclaimed)
  markPaid(epoch: number, lamports: bigint): void; // settling `epoch` reserved this much for claims
  ready(): boolean;                        // balance() reflects a recent successful read (safe to settle on)
  holderTokens(wallet: string, fresh?: boolean): Promise<Holding>; // fresh: skip the cache (sweeps)
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
  markPaid(_epoch: number, l: bigint) { this.lamports -= l; }
  ready() { return true; }
  async holderTokens(_wallet?: string, _fresh?: boolean): Promise<Holding> { return { raw: 1n << 62n, decimals: 6 }; }
}

// Before the token launches: matches are real, the pot is empty and never fills, nobody holds anything.
export class OffPot extends EventEmitter implements PotSource {
  start() {}
  stop() {}
  balance() { return 0n; }
  markPaid() {}
  ready() { return true; }
  async holderTokens(): Promise<Holding> { return { raw: 0n, decimals: 6 }; }
}

// JSON-RPC reads shared by the on-chain pots: holders' token balances. No @solana/web3.js dependency.
abstract class RpcPot extends EventEmitter {
  private holderCache = new Map<string, { at: number; v: Holding }>();
  private decimals = -1;
  constructor(protected cfg: Config) { super(); }

  protected async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.cfg.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  // sums every account of the mint the wallet owns (works for SPL Token and Token-2022 mints)
  // the cache only serves sign-in messages: a sweep reads fresh, or a wallet could sign in holding the
  // tokens, pass them on, and still pass the close on the cached balance
  async holderTokens(wallet: string, fresh = false): Promise<Holding> {
    const hit = this.holderCache.get(wallet);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.v;
    type Acc = { account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } };
    const r = await this.rpc<{ value: Acc[] }>('getTokenAccountsByOwner', [
      wallet, { mint: this.cfg.tokenMint }, { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    let raw = 0n, decimals = this.decimals;
    for (const a of r.value) { const t = a.account.data.parsed.info.tokenAmount; raw += BigInt(t.amount); decimals = t.decimals; }
    if (r.value.length === 0 && decimals < 0) {
      // no account yet: read decimals from the mint so the comparison is still exact
      const m = await this.rpc<{ value: { data: { parsed: { info: { decimals: number } } } } | null }>('getAccountInfo', [this.cfg.tokenMint, { encoding: 'jsonParsed' }]);
      decimals = m.value?.data.parsed.info.decimals ?? 6;
    }
    this.decimals = decimals;
    const v = { raw, decimals };
    this.holderCache.delete(wallet); this.holderCache.set(wallet, { at: Date.now(), v });
    if (this.holderCache.size > 20_000) this.holderCache.delete(this.holderCache.keys().next().value!); // oldest first
    return v;
  }
}

// Production: poll the vault over JSON-RPC; two calls is all we need.
export class SolanaPot extends RpcPot implements PotSource {
  private raw = 0n;            // last observed vault lamports
  // epochs this server settled -> total reserved. Until the keeper posts an epoch on chain its total
  // is not in Config.reserved yet, so it is held here; posted epochs are dropped (the chain counts
  // them, and claims shrink Config.reserved). Kept across restarts by reading data/epochs/*.json.
  private local = new Map<number, bigint>();
  private chain = { reserved: 0n, lastSettled: 0n, settledAny: false, read: false };
  private polledAt = 0;          // last poll that read both the vault and the config account
  private timer: NodeJS.Timeout | null = null;
  constructor(cfg: Config) {
    super(cfg);
    if (!cfg.vaultAddress) throw new Error('VAULT_ADDRESS is required for POT_SOURCE=solana');
    // without the config account the server can't see what is already reserved and would allocate it twice
    if (!cfg.configAddress) throw new Error('CONFIG_ADDRESS is required for POT_SOURCE=solana');
    // fail at boot, not by silently locking every player out
    if (cfg.holdMinUsd > 0 && !cfg.tokenMint) throw new Error('TOKEN_MINT is required when HOLD_MIN_USD > 0');
    const dir = join(cfg.dataDir, 'epochs');
    if (existsSync(dir)) for (const f of readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (!m) continue;
      try { this.local.set(Number(m[1]), BigInt((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { paid: string }).paid)); } catch { /* unreadable file: the chain still counts it once posted */ }
    }
  }

  async poll() {
    const r = await this.rpc<{ value: number }>('getBalance', [this.cfg.vaultAddress, { commitment: 'confirmed' }]);
    const now = BigInt(r.value);
    if (this.raw !== 0n && now > this.raw) this.emit('inflow', { lamports: now - this.raw, source: 'trading fees' });
    this.raw = now;
    const a = await this.rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [this.cfg.configAddress, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!a.value) return;
    // Config layout: disc 8 | authority 32 | epoch_seconds 8 | last_settled 8 | settled_any 1 | reserved 8 | ...
    const d = Buffer.from(a.value.data[0], 'base64');
    this.chain = { lastSettled: d.readBigUInt64LE(48), settledAny: d[56] === 1, reserved: d.readBigUInt64LE(57), read: true };
    if (this.chain.settledAny) for (const e of this.local.keys()) if (BigInt(e) <= this.chain.lastSettled) this.local.delete(e);
    this.polledAt = Date.now();
  }
  ready() { return this.chain.read && Date.now() - this.polledAt < 30_000; }

  start() {
    const tick = async () => {
      try { await this.poll(); } catch (e) { console.warn('[pot] poll failed:', (e as Error).message); }
      this.timer = setTimeout(tick, 10_000);
    };
    void tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  // exactly what settle_epoch will accept: vault minus the reserve floor, minus what the chain has
  // reserved, minus what this server settled that the chain hasn't seen yet
  balance() {
    if (!this.chain.read) return 0n; // nothing allocated before the first successful read
    let held = this.chain.reserved;
    for (const [e, l] of this.local) if (!this.chain.settledAny || BigInt(e) > this.chain.lastSettled) held += l;
    const free = this.raw - this.cfg.vaultReserveLamports - held;
    return free > 0n ? free : 0n;
  }
  markPaid(epoch: number, l: bigint) { this.local.set(epoch, l); }
}

// Launch without the vault program: the token's creator fees are claimed into a wallet the team holds,
// its balance is the pot, and the team sends each hour's prizes by hand. What this server settled stays
// reserved (owed) until the team marks it paid, so the next pot never counts money that is already owed.
export class WalletPot extends RpcPot implements PotSource {
  private raw = 0n;
  private read = false;
  private polledAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private owed = new Map<number, bigint>();   // settled epochs not paid yet -> lamports
  private paidLog: { epoch: number; tx: string; at: number }[] = [];
  // the pig: POT_SHARE_BPS (60%) of every fee that lands in the wallet, less the prizes settled from it. The
  // wallet also holds the team's 40% (and whatever else the team keeps there): taking that out never
  // shrinks the pig. It starts empty, so only fees from the day it's switched on fill it
  private treasury = 0n;
  constructor(cfg: Config) {
    super(cfg);
    if (!cfg.potWallet) throw new Error('POT_WALLET is required for POT_SOURCE=wallet');
    if (existsSync(this.treasuryFile())) this.treasury = BigInt((JSON.parse(readFileSync(this.treasuryFile(), 'utf8')) as { lamports: string }).lamports);
    if (cfg.holdMinUsd > 0 && !cfg.tokenMint) throw new Error('TOKEN_MINT is required when HOLD_MIN_USD > 0');
    const paidFile = this.paidFile();
    if (existsSync(paidFile)) this.paidLog = JSON.parse(readFileSync(paidFile, 'utf8')) as typeof this.paidLog;
    const paid = new Set(this.paidLog.map((p) => p.epoch));
    const dir = join(cfg.dataDir, 'epochs');
    if (existsSync(dir)) for (const f of readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (!m || paid.has(Number(m[1]))) continue;
      try { const l = BigInt((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { paid: string }).paid); if (l > 0n) this.owed.set(Number(m[1]), l); } catch { /* unreadable: nothing reserved for it */ }
    }
  }
  private paidFile() { return join(this.cfg.dataDir, 'paid.json'); }
  private treasuryFile() { return join(this.cfg.dataDir, 'treasury.json'); }
  private saveTreasury() { writeFileSync(this.treasuryFile(), JSON.stringify({ lamports: this.treasury.toString(), shareBps: this.cfg.potShareBps, at: Date.now() })); }

  async poll() {
    const r = await this.rpc<{ value: number }>('getBalance', [this.cfg.potWallet, { commitment: 'confirmed' }]);
    const now = BigInt(r.value);
    if (this.read && now > this.raw) {
      const share = ((now - this.raw) * BigInt(this.cfg.potShareBps)) / 10_000n; // the pig's part of the fees that came in
      this.treasury += share; this.saveTreasury();
      this.emit('inflow', { lamports: share, source: 'trading fees' });
    }
    this.raw = now; this.read = true; this.polledAt = Date.now();
  }
  ready() { return this.read && Date.now() - this.polledAt < 30_000; }
  start() {
    const tick = async () => {
      try { await this.poll(); } catch (e) { console.warn('[pot] poll failed:', (e as Error).message); }
      this.timer = setTimeout(tick, 10_000);
    };
    void tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  balance() {
    if (!this.read) return 0n;
    let held = this.cfg.vaultReserveLamports;
    for (const l of this.owed.values()) held += l;
    const free = this.raw - held;
    // the pig, never more than the wallet can actually pay
    return this.treasury < free ? this.treasury : free > 0n ? free : 0n;
  }
  markPaid(epoch: number, l: bigint) { if (l > 0n) { this.owed.set(epoch, l); this.treasury = this.treasury > l ? this.treasury - l : 0n; this.saveTreasury(); } }
  // what the team still has to send, oldest first
  unpaid() { return [...this.owed.entries()].sort((a, b) => a[0] - b[0]).map(([epoch, lamports]) => ({ epoch, lamports })); }
  // the team sent epoch's prizes (tx: the transfer signature, for the public record)
  settlePaid(epoch: number, tx: string): boolean {
    if (!this.owed.has(epoch)) return false;
    this.owed.delete(epoch);
    this.paidLog.push({ epoch, tx, at: Date.now() });
    writeFileSync(this.paidFile(), JSON.stringify(this.paidLog, null, 2));
    return true;
  }
  paidTx(epoch: number) { return this.paidLog.find((p) => p.epoch === epoch)?.tx ?? null; }
}

export const makePot = (cfg: Config): PotSource =>
  cfg.potSource === 'solana' ? new SolanaPot(cfg) : cfg.potSource === 'wallet' ? new WalletPot(cfg) : cfg.potSource === 'off' ? new OffPot() : new MockPot();
