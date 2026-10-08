// Gameplay and economy constants shared by server and client. The server is the only authority;
// the client reads these so it can draw the ring, predict cooldowns and label things correctly.

export const TICK_HZ = 30;            // simulation steps per second
export const SNAP_EVERY = 2;          // send a snapshot every N ticks (15 Hz)
export const ROOM_MAX = 100;
export const ROOM_MIN = 2;            // a room starts with fewer than 10 once the fill timer runs out
export const FILL_WAIT_MS = 45_000;   // how long a room waits for more players after the 2nd joins
export const COUNTDOWN_MS = 5_000;
export const RESULT_MS = 6_000;       // results screen before the room closes
export const ROUND_MAX_MS = 480_000;  // hard cap: the storm has fully closed (~6 min) well before this

// ---- world (meters) ----
export const MAP_HALF = 200;            // the island is 400 x 400 m
export const GRAVITY = 24;
export const PLAYER_R = 0.4;
export const PLAYER_H = 1.8;
export const EYE_H = 1.62;
export const HEAD_Y = 1.62, HEAD_R = 0.22;  // head sphere, offset from feet
export const WALK_SPEED = 6.2;
export const SPRINT_SPEED = 8.6;
export const JUMP_V = 7.6;
export const STEP_H = 0.55;             // stairs and curbs are climbed without jumping
export const PLAYER_HP = 100;
export const HEADSHOT_MULT = 1.8;
export const REWIND_MAX_TICKS = 9;      // lag compensation looks back at most 300 ms
export const VIEW_RANGE = 170;          // players farther than this are not sent to you

// battle royale storm: each phase waits, then shrinks toward a new circle inside the current one
export interface RingPhase { wait: number; shrink: number; radius: number; dps: number }
export const RING_START_R = 290;        // covers the corners of the island
export const RING_PHASES: RingPhase[] = [
  { wait: 50, shrink: 55, radius: 170, dps: 2 },
  { wait: 35, shrink: 40, radius: 100, dps: 5 },
  { wait: 25, shrink: 30, radius: 55, dps: 9 },
  { wait: 20, shrink: 25, radius: 25, dps: 15 },
  { wait: 12, shrink: 18, radius: 0, dps: 28 },
];
export const RING_DPS_START = 1;

// ---- loot ----
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export type WeaponId = 'pistol' | 'smg' | 'tac' | 'pump' | 'ar' | 'burst' | 'hunting' | 'minigun' | 'scar' | 'heavy';
export const WEAPON_IDS: WeaponId[] = ['pistol', 'smg', 'tac', 'pump', 'ar', 'burst', 'hunting', 'minigun', 'scar', 'heavy'];
export interface WeaponDef {
  name: string; rarity: Rarity; dmg: number; cd: number; range: number; pellets: number; spread: number;
  mag: number; reload: number; zoom: number; auto: boolean; burst?: number; spinUp?: number; headMult?: number;
}
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: { name: 'Pistol', rarity: 'common', dmg: 22, cd: 0.22, range: 90, pellets: 1, spread: 0.016, mag: 16, reload: 1.2, zoom: 1.2, auto: false },
  smg: { name: 'SMG', rarity: 'common', dmg: 13, cd: 0.07, range: 60, pellets: 1, spread: 0.034, mag: 30, reload: 1.6, zoom: 1.25, auto: true },
  tac: { name: 'Tactical Shotgun', rarity: 'common', dmg: 9, cd: 0.6, range: 22, pellets: 8, spread: 0.085, mag: 8, reload: 2.6, zoom: 1.1, auto: false },
  pump: { name: 'Pump Shotgun', rarity: 'uncommon', dmg: 12, cd: 1.0, range: 26, pellets: 9, spread: 0.065, mag: 5, reload: 2.8, zoom: 1.1, auto: false },
  ar: { name: 'Assault Rifle', rarity: 'uncommon', dmg: 17, cd: 0.11, range: 150, pellets: 1, spread: 0.022, mag: 30, reload: 1.9, zoom: 1.6, auto: true },
  burst: { name: 'Burst Rifle', rarity: 'rare', dmg: 21, cd: 0.45, range: 150, pellets: 1, spread: 0.015, mag: 24, reload: 2.0, zoom: 1.7, auto: false, burst: 3 },
  hunting: { name: 'Hunting Rifle', rarity: 'rare', dmg: 74, cd: 1.1, range: 320, pellets: 1, spread: 0.004, mag: 1, reload: 1.5, zoom: 2.4, auto: false, headMult: 2 },
  minigun: { name: 'Minigun', rarity: 'epic', dmg: 11, cd: 0.055, range: 100, pellets: 1, spread: 0.05, mag: 140, reload: 4.2, zoom: 1.2, auto: true, spinUp: 0.7 },
  scar: { name: 'SCAR', rarity: 'legendary', dmg: 25, cd: 0.11, range: 180, pellets: 1, spread: 0.011, mag: 30, reload: 1.8, zoom: 1.75, auto: true },
  heavy: { name: 'Heavy Sniper', rarity: 'legendary', dmg: 210, cd: 2.0, range: 500, pellets: 1, spread: 0.035, mag: 4, reload: 3.0, zoom: 5, auto: false },
};
export const SLOTS = 4;

export type ItemId = 'mini' | 'big' | 'med';
export const ITEMS: Record<ItemId, { name: string; rarity: Rarity; use: number; max: number; shield?: number; shieldCap?: number; heal?: number }> = {
  mini: { name: 'Mini Shield', rarity: 'uncommon', use: 1.0, max: 6, shield: 25, shieldCap: 50 },
  big: { name: 'Shield Potion', rarity: 'rare', use: 3.0, max: 3, shield: 50, shieldCap: 100 },
  med: { name: 'Medkit', rarity: 'uncommon', use: 4.0, max: 3, heal: 100 },
};
export type PerkId = 'grenade' | 'smoke' | 'launch' | 'fort' | 'nuke';
export const PERKS: Record<PerkId, { name: string; rarity: Rarity; count: number }> = {
  grenade: { name: 'Grenades', rarity: 'uncommon', count: 3 },
  smoke: { name: 'Smoke', rarity: 'uncommon', count: 2 },
  launch: { name: 'Launch Pad', rarity: 'rare', count: 1 },
  fort: { name: 'Instant Fort', rarity: 'epic', count: 1 },
  nuke: { name: 'Atomic Bomb', rarity: 'legendary', count: 1 },
};
export const SHIELD_MAX = 100;
export const GRENADE = { fuse: 2.2, radius: 7, dmg: 105, speed: 19 };
export const SMOKE = { radius: 7, life: 12 };
export const PAD = { life: 30, launch: 24 };
export const FORT = { life: 30, size: 2.2, height: 1.8 };
export const NUKE = { delay: 6, radius: 26, dmg: 400, range: 450 };
export const INTERACT_R = 2.3;

// economy
export const EPOCH_MS = 6 * 60 * 60 * 1000; // pot draws every 6h, aligned to 00/06/12/18 UTC
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const epochOf = (ms: number) => Math.floor(ms / EPOCH_MS);
export const epochEnd = (epoch: number) => (epoch + 1) * EPOCH_MS;

// squid-game style player numbers, stable for a session: 001..456
export const playerNumber = (seed: number) => String((seed % 456) + 1).padStart(3, '0');
