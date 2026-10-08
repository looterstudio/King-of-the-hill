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

export const ARENA_R = 900;
export const RING_START_S = 10;       // ring starts closing this many seconds into the round
export const RING_CLOSE_S = 80;       // and reaches RING_MIN_R after this many more
export const RING_MIN_R = 90;
export const RING_DPS = 18;

export const PLAYER_R = 18;
export const PLAYER_SPEED = 270;
export const PLAYER_HP = 100;
export const DASH_SPEED = 820;
export const DASH_TIME = 0.14;
export const DASH_CD = 2.2;

export const BULLET_SPEED = 950;
export const BULLET_LIFE = 0.85;
export const BULLET_DMG = 25;
export const FIRE_CD = 0.3;
export const PILLARS = 11;

// economy
export const EPOCH_MS = 6 * 60 * 60 * 1000; // pot draws every 6h, aligned to 00/06/12/18 UTC
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const epochOf = (ms: number) => Math.floor(ms / EPOCH_MS);
export const epochEnd = (epoch: number) => (epoch + 1) * EPOCH_MS;

// squid-game style player numbers, stable for a session: 001..456
export const playerNumber = (seed: number) => String((seed % 456) + 1).padStart(3, '0');
