// Gameplay and economy constants shared by server and client. The server is the only authority;
// the client reads these so it can draw the ring, predict cooldowns and label things correctly.

export const TICK_HZ = 30;            // simulation steps per second
export const SNAP_EVERY = 2;          // send a snapshot every N ticks (15 Hz)
export const ROOM_MAX = 100;
// solo, duos and squads. Every mode pays the same per player on average: a solo win is worth 4
// tickets, each duo winner gets 2, each squad winner 1 (a squad wins 4x as often per player).
export type Mode = 'solo' | 'duo' | 'squad';
export const MODE_IDS: Mode[] = ['solo', 'duo', 'squad'];
export const MODES: Record<Mode, { name: string; size: number; tickets: number }> = {
  solo: { name: 'Solo', size: 1, tickets: 4 },
  duo: { name: 'Duos', size: 2, tickets: 2 },
  squad: { name: 'Squads', size: 4, tickets: 1 },
};
export const OPEN_ROOMS = 5;          // rooms filling at the same time, across modes
export const ROOM_MIN = 2;            // a room starts with fewer than 10 once the fill timer runs out
export const FILL_WAIT_MS = 45_000;   // how long a room waits for more players after the 2nd joins
export const COUNTDOWN_MS = 5_000;
export const RESULT_MS = 6_000;       // results screen before the room closes
export const ROUND_MAX_MS = 720_000;  // hard cap: the storm has fully closed (~9 min) well before this

// ---- world (meters) ----
export const MAP_HALF = 400;            // the island is 800 x 800 m
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
export const RING_START_R = 580;        // covers the corners of the island
export const RING_PHASES: RingPhase[] = [
  { wait: 60, shrink: 70, radius: 330, dps: 2 },
  { wait: 45, shrink: 55, radius: 190, dps: 4 },
  { wait: 35, shrink: 40, radius: 105, dps: 7 },
  { wait: 25, shrink: 30, radius: 55, dps: 11 },
  { wait: 20, shrink: 25, radius: 25, dps: 16 },
  { wait: 12, shrink: 18, radius: 0, dps: 28 },
];
export const RING_DPS_START = 1;

// ---- loot ----
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export type WeaponId = 'pistol' | 'smg' | 'tac' | 'pump' | 'ar' | 'burst' | 'hunting' | 'minigun' | 'scar' | 'heavy' | 'rocket' | 'stinger';
export const WEAPON_IDS: WeaponId[] = ['pistol', 'smg', 'tac', 'pump', 'ar', 'burst', 'hunting', 'minigun', 'scar', 'heavy', 'rocket', 'stinger'];
export interface WeaponDef {
  name: string; rarity: Rarity; dmg: number; cd: number; range: number; pellets: number; spread: number;
  mag: number; reload: number; zoom: number; auto: boolean; burst?: number; spinUp?: number; headMult?: number;
  proj?: 'rocket' | 'missile'; // fires a projectile instead of a bullet
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
  rocket: { name: 'Rocket Launcher', rarity: 'epic', dmg: 115, cd: 1.1, range: 400, pellets: 1, spread: 0.004, mag: 1, reload: 2.6, zoom: 1.4, auto: false, proj: 'rocket' },
  stinger: { name: 'Stinger', rarity: 'rare', dmg: 200, cd: 1.6, range: 500, pellets: 1, spread: 0, mag: 2, reload: 3.2, zoom: 1.8, auto: false, proj: 'missile' },
};
// rockets fly straight and blow up on whatever they touch; Stinger missiles lock onto the nearest
// helicopter or plane in front of you and chase it
export const ROCKET = { speed: 58, radius: 6, life: 7 };
export const MISSILE = { speed: 64, turn: 2.6, cone: 0.45, range: 420, radius: 5, life: 8 };
// weapon upgrades: each level adds damage; benches upgrade once per player, kits anywhere
export const UPGRADE = { max: 3, perLevel: 0.22, benchReach: 2.4 };
export const MOLOTOV = { radius: 4.5, life: 7, dps: 15 };
export const SHOCK = { radius: 7, push: 22, fuse: 1.4 };
export const SLOTS = 4;

export type ItemId = 'mini' | 'big' | 'med';
export const ITEMS: Record<ItemId, { name: string; rarity: Rarity; use: number; max: number; shield?: number; shieldCap?: number; heal?: number }> = {
  mini: { name: 'Mini Shield', rarity: 'uncommon', use: 1.0, max: 6, shield: 25, shieldCap: 50 },
  big: { name: 'Shield Potion', rarity: 'rare', use: 3.0, max: 3, shield: 50, shieldCap: 100 },
  med: { name: 'Medkit', rarity: 'uncommon', use: 4.0, max: 3, heal: 100 },
};
export type PerkId = 'grenade' | 'molotov' | 'shock' | 'smoke' | 'launch' | 'fort' | 'kit' | 'c4' | 'nuke';
export const PERKS: Record<PerkId, { name: string; rarity: Rarity; count: number }> = {
  grenade: { name: 'Grenades', rarity: 'uncommon', count: 3 },
  molotov: { name: 'Molotov', rarity: 'uncommon', count: 2 },
  shock: { name: 'Shockwave', rarity: 'rare', count: 2 },
  smoke: { name: 'Smoke', rarity: 'uncommon', count: 2 },
  launch: { name: 'Launch Pad', rarity: 'rare', count: 1 },
  fort: { name: 'Instant Fort', rarity: 'epic', count: 1 },
  kit: { name: 'Upgrade Kit', rarity: 'rare', count: 1 },
  c4: { name: 'C4', rarity: 'epic', count: 2 },
  nuke: { name: 'Atomic Bomb', rarity: 'legendary', count: 1 },
};
export const SHIELD_MAX = 100;
export const GRENADE = { fuse: 2.2, radius: 7, dmg: 105, speed: 19 };
export const SMOKE = { radius: 7, life: 12 };
export const PAD = { life: 30, launch: 24 };
export const FORT = { life: 30, size: 2.2, height: 1.8 };
export const NUKE = { delay: 6, radius: 26, dmg: 400, range: 450 };
export const INTERACT_R = 2.3;
// C4: throw it (it sticks where it lands), press again to set it off. Up to 100 damage, walls
// block it, shields soak it first: with shields up you survive your own charge, without you don't.
export const C4 = { radius: 7, dmg: 100, speed: 15, core: 2.5 };
// supply drops: a crate on a balloon falls into the next circle every time the storm moves
export const SUPPLY = { height: 110, fall: 7 };

// ---- vehicles ----
// ride code on the body: 0 on foot, 1 car, 2 helicopter, 3 plane
export type VehicleKind = 'car' | 'heli' | 'plane';
export const VEHICLE_KINDS: VehicleKind[] = ['car', 'heli', 'plane'];
// seats: passengers besides the driver (teammates only); they can shoot out of any vehicle
export const VEHICLES: Record<VehicleKind, { name: string; hp: number; r: number; h: number; top: number; boost: number; accel: number; reach: number; seats: number }> = {
  car: { name: 'Car', hp: 500, r: 1.25, h: 1.7, top: 24, boost: 34, accel: 16, reach: 3.2, seats: 3 },
  heli: { name: 'Helicopter', hp: 650, r: 2.3, h: 2.6, top: 25, boost: 32, accel: 14, reach: 4.2, seats: 3 },
  plane: { name: 'Plane', hp: 350, r: 2.4, h: 1.8, top: 46, boost: 62, accel: 11, reach: 4.6, seats: 1 },
};
export const RAM = { minSpeed: 7, dmgPerMs: 4.2, cooldown: 0.6 };      // running people over
export const CRASH = { minSpeed: 9, dmgPerMs: 9 };                     // hitting walls hurts the vehicle
export const VEH_BOOM = { radius: 7.5, dmg: 110 };                     // a wrecked vehicle explodes
export const HELI_GUN = { dmg: 14, cd: 0.09, range: 170, spread: 0.028 };
export const PLANE_GUN = { dmg: 12, cd: 0.07, range: 200, spread: 0.02 };
export const BOMB = { radius: 8, dmg: 125, cd: 2.5 };

// economy
export const EPOCH_MS = 6 * 60 * 60 * 1000; // pot draws every 6h, aligned to 00/06/12/18 UTC
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const epochOf = (ms: number) => Math.floor(ms / EPOCH_MS);
export const epochEnd = (epoch: number) => (epoch + 1) * EPOCH_MS;

// squid-game style player numbers, stable for a session: 001..456
export const playerNumber = (seed: number) => String((seed % 456) + 1).padStart(3, '0');
