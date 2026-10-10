// Each wallet's record for its lobby profile: matches, wins, kills, best place, hourly pots won.
// One small JSON file, rewritten (atomically) a second after the last change.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PlayerRecord { matches: number; wins: number; kills: number; best: number; prizes: number; prizeLamports: string }
const blank = (): PlayerRecord => ({ matches: 0, wins: 0, kills: 0, best: 0, prizes: 0, prizeLamports: '0' });

export class Profiles {
  private map = new Map<string, PlayerRecord>();
  private file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'profiles.json');
    if (existsSync(this.file)) {
      try { for (const [w, r] of Object.entries(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, PlayerRecord>)) this.map.set(w, { ...blank(), ...r }); }
      catch (e) { console.warn('[profiles] unreadable, starting over:', (e as Error).message); }
    }
  }

  get(wallet: string): PlayerRecord { return this.map.get(wallet) ?? blank(); }

  // a match ended: place 1 is a win (a team win counts for every member)
  match(wallet: string, place: number, kills: number) {
    const r = { ...this.get(wallet) };
    r.matches++; r.kills += kills;
    if (place === 1) r.wins++;
    if (place > 0 && (r.best === 0 || place < r.best)) r.best = place;
    this.map.set(wallet, r); this.save();
  }

  prize(wallet: string, lamports: bigint) {
    const r = { ...this.get(wallet) };
    r.prizes++; r.prizeLamports = (BigInt(r.prizeLamports) + lamports).toString();
    this.map.set(wallet, r); this.save();
  }

  private save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000);
    this.timer.unref?.();
  }
  flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
    renameSync(tmp, this.file);
  }
}
