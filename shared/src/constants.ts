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
export const REGEN_DELAY = 5;           // seconds without taking damage before health comes back
export const REGEN_RATE = 12;           // hp per second
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

// everyone drops with the same four guns: the better player wins, not the luckier looter
export type WeaponId = 'rifle' | 'shotgun' | 'sniper' | 'pistol';
export const WEAPON_ORDER: WeaponId[] = ['rifle', 'shotgun', 'sniper', 'pistol'];
export interface WeaponDef { name: string; dmg: number; cd: number; range: number; pellets: number; spread: number; mag: number; reload: number; zoom: number; auto: boolean }
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: { name: 'rifle', dmg: 14, cd: 0.105, range: 140, pellets: 1, spread: 0.02, mag: 30, reload: 1.7, zoom: 1.6, auto: true },
  shotgun: { name: 'shotgun', dmg: 10, cd: 0.85, range: 28, pellets: 9, spread: 0.075, mag: 6, reload: 2.1, zoom: 1.15, auto: false },
  sniper: { name: 'sniper', dmg: 82, cd: 1.35, range: 400, pellets: 1, spread: 0.04, mag: 5, reload: 2.5, zoom: 4, auto: false },
  pistol: { name: 'pistol', dmg: 20, cd: 0.26, range: 90, pellets: 1, spread: 0.014, mag: 12, reload: 1.1, zoom: 1.2, auto: false },
};

// economy
export const EPOCH_MS = 6 * 60 * 60 * 1000; // pot draws every 6h, aligned to 00/06/12/18 UTC
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const epochOf = (ms: number) => Math.floor(ms / EPOCH_MS);
export const epochEnd = (epoch: number) => (epoch + 1) * EPOCH_MS;

// squid-game style player numbers, stable for a session: 001..456
export const playerNumber = (seed: number) => String((seed % 456) + 1).padStart(3, '0');
