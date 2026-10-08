// Gameplay and economy constants shared by server and client. The server is the only authority;
// the client reads these so it can draw the ring, predict cooldowns and label things correctly.

export const TICK_HZ = 30;            // simulation steps per second
export const SNAP_EVERY = 2;          // send a snapshot every N ticks (15 Hz)
export const ROOM_MAX = 10;
export const ROOM_MIN = 2;            // a room starts with fewer than 10 once the fill timer runs out
export const FILL_WAIT_MS = 20_000;   // how long a room waits for more players after the 2nd joins
export const COUNTDOWN_MS = 5_000;
export const RESULT_MS = 6_000;       // results screen before the room closes
export const ROUND_MAX_MS = 150_000;  // hard cap: ring has fully closed well before this

export const ARENA_R = 1000;

export const PLAYER_R = 18;
export const PLAYER_SPEED = 270;
export const PLAYER_HP = 100;
export const ARMOR_MAX = 50;
export const DASH_SPEED = 820;
export const DASH_TIME = 0.14;
export const DASH_CD = 2.2;
export const PILLARS = 13;
export const PICKUP_R = 30;

// battle royale storm: each phase waits, then shrinks toward a new circle inside the current one
export interface RingPhase { wait: number; shrink: number; radius: number; dps: number }
export const RING_PHASES: RingPhase[] = [
  { wait: 14, shrink: 18, radius: 640, dps: 6 },
  { wait: 10, shrink: 14, radius: 380, dps: 10 },
  { wait: 8, shrink: 12, radius: 190, dps: 16 },
  { wait: 6, shrink: 10, radius: 60, dps: 26 },
  { wait: 4, shrink: 8, radius: 0, dps: 40 },
];
export const RING_DPS_START = 4;

export type WeaponId = 'pistol' | 'shotgun' | 'rifle' | 'sniper';
export interface WeaponDef { name: string; dmg: number; cd: number; speed: number; life: number; pellets: number; spread: number; ammo: number }
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: { name: 'pistol', dmg: 18, cd: 0.34, speed: 950, life: 0.75, pellets: 1, spread: 0.03, ammo: Infinity },
  shotgun: { name: 'shotgun', dmg: 11, cd: 0.85, speed: 900, life: 0.32, pellets: 6, spread: 0.32, ammo: 8 },
  rifle: { name: 'rifle', dmg: 13, cd: 0.11, speed: 1100, life: 0.8, pellets: 1, spread: 0.06, ammo: 45 },
  sniper: { name: 'sniper', dmg: 75, cd: 1.3, speed: 2000, life: 1.0, pellets: 1, spread: 0, ammo: 5 },
};
export type LootKind = 'shotgun' | 'rifle' | 'sniper' | 'medkit' | 'armor';
export const LOOT_COUNT = 26;
export const MEDKIT_HP = 45;

// economy
export const EPOCH_MS = 6 * 60 * 60 * 1000; // pot draws every 6h, aligned to 00/06/12/18 UTC
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const epochOf = (ms: number) => Math.floor(ms / EPOCH_MS);
export const epochEnd = (epoch: number) => (epoch + 1) * EPOCH_MS;

// squid-game style player numbers, stable for a session: 001..456
export const playerNumber = (seed: number) => String((seed % 456) + 1).padStart(3, '0');
