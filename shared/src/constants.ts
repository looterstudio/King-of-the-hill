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
// points for the pot, every match: a win, or a top placement (top 10 players: top 10 in solo,
// top 5 duos, top 3 squads), plus kills. Payouts split the pot by points.
export const POINTS = { win: { solo: 100, duo: 50, squad: 25 } as Record<Mode, number>, top: 20, kill: 5, killCap: 10 };
export const topPlaces = (mode: Mode) => Math.ceil(10 / MODES[mode].size);
// field: teams at the start. A top place only pays in the top half of the field, so a room of a
// few of your own wallets doesn't hand placement points to everyone in it.
export function matchPoints(mode: Mode, place: number, kills: number, won: boolean, field = Infinity) {
  const top = Math.min(topPlaces(mode), Math.floor(field / 2));
  return (won ? POINTS.win[mode] : place > 0 && place <= top ? POINTS.top : 0) + Math.min(kills, POINTS.killCap) * POINTS.kill;
}
// characters to pick from before a match: looks only, every one plays the same
export const SKINS = ['Scribble', 'Crayon Knight', 'Ink Ninja', 'Robo Pen', 'Captain Blot', 'Chill House', 'Cupsey', 'Retardio', 'Kimchi', 'Unipcs', 'Alon'];
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
// 100 health + 100 shield: an assault rifle takes a full-shield player down in about 1.2 s, a pump
// shotgun in two shots up close, a Heavy Sniper headshot in one. (It was 250 + 250 and fights
// dragged on: playtesters called the shotgun useless.) Blast damage below is what a player takes;
// walls take BLAST_WORLD times as much, so buildings break exactly as they did at 250
export const PLAYER_HP = 100;
export const BLAST_WORLD = 2.5;
export const HEADSHOT_MULT = 1.8;
// duos and squads: at 0 health you are knocked, not out, while a teammate is still standing.
// You crawl, bleed out in 30 s, and a teammate holding E next to you for 5 s brings you back.
// If nobody on your team is left standing, everyone knocked is out.
export const KNOCK = { hp: 40, bleed: 30, revive: 5, reach: 2.2, reviveHp: 30, crawl: 1.9, eye: 0.55 };
export const REWIND_MAX_TICKS = 9;      // lag compensation looks back at most 300 ms
export const VIEW_RANGE = 170;          // players farther than this are not sent to you

// battle royale storm: each phase waits, then shrinks toward a new circle inside the current one.
// It moves early and never stops for long: the first close starts while the last players are still
// gliding, and the circle keeps coming in every half minute, so fights are pushed together and a
// match is decided in the last circles (about 4 minutes in), not by whoever lands next to whom.
// dps applies once the phase's circle is reached; the storm hits health only.
export interface RingPhase { wait: number; shrink: number; radius: number; dps: number }
export const RING_START_R = 580;        // covers the corners of the island
export const RING_PHASES: RingPhase[] = [ // about 18 minutes from the first wait to the last close, a classic battle royale's length
  { wait: 90, shrink: 120, radius: 300, dps: 1 },
  { wait: 120, shrink: 90, radius: 190, dps: 1 },
  { wait: 90, shrink: 75, radius: 120, dps: 2 },
  { wait: 75, shrink: 60, radius: 75, dps: 4 },
  { wait: 60, shrink: 50, radius: 40, dps: 6 },
  { wait: 45, shrink: 45, radius: 18, dps: 8 },
  { wait: 30, shrink: 40, radius: 6, dps: 10 },
  { wait: 20, shrink: 40, radius: 0, dps: 12 },
]
export const RING_DPS_START = 1;
// the storm hurries as the field thins out: its clock runs at normal pace while half the teams are
// still in, then faster and faster, up to max times as fast with a tenth of them left
export const RING_HURRY = { from: 0.25, to: 0.05, max: 1.5 };

// ---- loot ----
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export type WeaponId = 'pistol' | 'smg' | 'tac' | 'pump' | 'ar' | 'burst' | 'hunting' | 'minigun' | 'scar' | 'heavy' | 'rocket' | 'stinger' | 'guided' | 'blade' | 'wand';
export const WEAPON_IDS: WeaponId[] = ['pistol', 'smg', 'tac', 'pump', 'ar', 'burst', 'hunting', 'minigun', 'scar', 'heavy', 'rocket', 'stinger', 'guided', 'blade', 'wand'];
// aiming down sights, by kind of gun: iron sights (a notch and a post), a red dot in a little frame, a
// real scope (snipers only: the screen goes dark around the lens), a launcher's open ring that never
// hides the view, or none (hip-fired: the minigun, the wand, the blade). zoom is how far it magnifies
export type Sight = 'iron' | 'dot' | 'scope' | 'ring' | 'hip';
export interface WeaponDef {
  name: string; rarity: Rarity; dmg: number; cd: number; range: number; pellets: number; spread: number;
  mag: number; reload: number; zoom: number; auto: boolean; burst?: number; spinUp?: number; headMult?: number;
  sight: Sight; // what aiming down sights (right click) shows: see SIGHTS
  proj?: 'rocket' | 'missile' | 'guided' | 'spell'; // fires a projectile instead of a bullet
  melee?: { reach: number; arc: number; block: number }; // swung, not fired: everyone in the arc in front of you (no ammo)
  ammo?: AmmoId; // what a reload takes from your reserve (none: the blade, and the wand recharging itself)
}
// ammo: everyone drops with only the pickaxe, guns come with one box of their ammo, and a reload takes from
// what you carry (boxes on the floor and in cases, and whatever the fallen leave behind)
export type AmmoId = 'light' | 'medium' | 'heavy' | 'shells' | 'rockets';
export const AMMO: Record<AmmoId, { name: string; box: number; max: number }> = {
  light: { name: 'Light Ammo', box: 36, max: 360 },
  medium: { name: 'Medium Ammo', box: 30, max: 300 },
  heavy: { name: 'Heavy Ammo', box: 6, max: 30 },
  shells: { name: 'Shells', box: 10, max: 60 },
  rockets: { name: 'Rockets', box: 2, max: 8 },
};
export const AMMO_IDS = Object.keys(AMMO) as AmmoId[];
// a burst gun fires its rounds this far apart (3 ticks: 0.1 s), then waits its cd before the next burst
export const BURST_GAP = 0.075;
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: { name: 'Pistol', rarity: 'common', dmg: 16, cd: 0.25, range: 90, pellets: 1, spread: 0.016, mag: 16, reload: 1.2, zoom: 1.15, sight: 'iron', auto: false, ammo: 'light' },
  smg: { name: 'SMG', rarity: 'common', dmg: 13, cd: 0.07, range: 60, pellets: 1, spread: 0.034, mag: 30, reload: 1.6, zoom: 1.2, sight: 'iron', auto: true, ammo: 'light' },
  tac: { name: 'Tactical Shotgun', rarity: 'common', dmg: 12, cd: 0.6, range: 24, pellets: 9, spread: 0.06, mag: 8, reload: 2.6, zoom: 1.08, sight: 'iron', auto: false, ammo: 'shells' },
  pump: { name: 'Pump Shotgun', rarity: 'uncommon', dmg: 15, cd: 0.9, range: 28, pellets: 10, spread: 0.048, mag: 5, reload: 2.8, zoom: 1.08, sight: 'iron', auto: false, ammo: 'shells' },
  ar: { name: 'Assault Rifle', rarity: 'uncommon', dmg: 17, cd: 0.11, range: 150, pellets: 1, spread: 0.022, mag: 30, reload: 1.9, zoom: 1.35, sight: 'dot', auto: true, ammo: 'medium' },
  burst: { name: 'Burst Rifle', rarity: 'rare', dmg: 21, cd: 0.45, range: 150, pellets: 1, spread: 0.015, mag: 24, reload: 2.0, zoom: 1.45, sight: 'dot', auto: false, burst: 3, ammo: 'medium' },
  hunting: { name: 'Hunting Rifle', rarity: 'rare', dmg: 74, cd: 1.1, range: 320, pellets: 1, spread: 0.004, mag: 1, reload: 1.5, zoom: 2.4, sight: 'scope', auto: false, headMult: 2, ammo: 'heavy' },
  minigun: { name: 'Minigun', rarity: 'epic', dmg: 11, cd: 0.055, range: 100, pellets: 1, spread: 0.05, mag: 140, reload: 4.2, zoom: 1.05, sight: 'hip', auto: true, spinUp: 0.7, ammo: 'light' },
  scar: { name: 'SCAR', rarity: 'legendary', dmg: 25, cd: 0.11, range: 180, pellets: 1, spread: 0.011, mag: 30, reload: 1.8, zoom: 1.45, sight: 'dot', auto: true, ammo: 'medium' },
  heavy: { name: 'Heavy Sniper', rarity: 'legendary', dmg: 150, cd: 2.0, range: 500, pellets: 1, spread: 0.035, mag: 4, reload: 3.0, zoom: 5, sight: 'scope', auto: false, ammo: 'heavy' },
  rocket: { name: 'Rocket Launcher', rarity: 'epic', dmg: 115, cd: 1.1, range: 400, pellets: 1, spread: 0.004, mag: 1, reload: 2.6, zoom: 1.12, sight: 'ring', auto: false, proj: 'rocket', ammo: 'rockets' },
  stinger: { name: 'Stinger', rarity: 'rare', dmg: 200, cd: 1.6, range: 500, pellets: 1, spread: 0, mag: 2, reload: 3.2, zoom: 1.15, sight: 'ring', auto: false, proj: 'missile', ammo: 'rockets' },
  guided: { name: 'Guided Missile', rarity: 'legendary', dmg: 120, cd: 1.4, range: 450, pellets: 1, spread: 0, mag: 1, reload: 3.4, zoom: 1.12, sight: 'ring', auto: false, proj: 'guided', ammo: 'rockets' },
  blade: { name: 'Plasma Blade', rarity: 'epic', dmg: 40, cd: 0.42, range: 3.6, pellets: 1, spread: 0, mag: 1, reload: 0, zoom: 1, sight: 'hip', auto: true, melee: { reach: 3.4, arc: 0.8, block: 75 } },
  wand: { name: 'Magic Wand', rarity: 'rare', dmg: 30, cd: 0.55, range: 220, pellets: 1, spread: 0.006, mag: 6, reload: 2.4, zoom: 1.15, sight: 'hip', auto: false, proj: 'spell' },
};
// rockets fly straight and blow up on whatever they touch; Stinger missiles lock onto the nearest
// helicopter or plane in front of you and chase it
export const ROCKET = { speed: 58, radius: 6, life: 7 };
export const MISSILE = { speed: 64, turn: 2.6, cone: 0.45, range: 420, radius: 5, life: 8 };
// the guided missile flies (slowly) toward whatever your crosshair is on, as long as you hold the launcher;
// the wand's spell is a fast bolt that hurts and throws whoever it hits back through the air
export const GUIDED = { speed: 36, turn: 3.2, radius: 6.5, life: 10 };
export const SPELL = { speed: 72, push: 19, lift: 7.5, life: 3 };
// weapon upgrades: each level adds damage; benches upgrade once per player, kits anywhere
export const UPGRADE = { max: 3, perLevel: 0.22, benchReach: 2.4 };
export const MOLOTOV = { radius: 4.5, life: 7, dps: 15 };
export const SHOCK = { radius: 7, push: 22, fuse: 1.4 };
// the drop: everyone starts aboard a giant paper plane crossing the island in a straight line (near the
// middle, from a random side) and jumps out where they like (Space); at the far edge everyone left is
// thrown out
export const BUS = { y: 140, speed: 44, len: 2 * MAP_HALF + 120, offset: 90, exit: 0.35 };
export const SLOTS = 4;
// the axe: always in your pocket (X). Swing it at walls, cars and people; broken blocks give you
// material, right click with the axe out places a 1 m block (Minecraft style)
export const AXE = { reach: 3.2, cd: 0.34, player: 20, vehicle: 30, block: 50 }; // wood 2 hits, brick 3, metal 6
export const BUILD = { cost: 2, maxMats: 400, reach: 6, cd: 0.16, cap: 3000, startMats: 30 };
// destruction: block health by material, and how much material a broken block gives back
export const MATERIAL = { wood: { hp: 70, yield: 3 }, brick: { hp: 150, yield: 5 }, metal: { hp: 270, yield: 7 } };
export const WRECK_BUDGET = 30000; // blocks a match may break off before big boxes stop shattering

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
// C4: throw it (it sticks where it lands), press again to set it off. Up to 100 damage (a full
// health bar), walls block it, shields soak it first: with shields up you survive your own
// charge, without you don't.
export const C4 = { radius: 7, dmg: 100, speed: 15, core: 2.5 };
// supply drops: a crate on a balloon falls into the next circle every time the storm moves
export const SUPPLY = { height: 110, fall: 7 };

// ---- vehicles ----
// ride code on the body: 0 on foot, 1 car, 2 helicopter, 3 plane, 4 motorbike, 5 tank
export type VehicleKind = 'car' | 'heli' | 'plane' | 'moto' | 'tank';
export const VEHICLE_KINDS: VehicleKind[] = ['car', 'heli', 'plane', 'moto', 'tank'];
export const isAir = (ride: number) => ride === 2 || ride === 3;
// inside armour: bullets hit the vehicle, not the driver (aircraft pilots, tank crews)
export const covered = (ride: number) => ride === 2 || ride === 3 || ride === 5;
// seats: passengers besides the driver (teammates only); they can shoot out of any vehicle
export const VEHICLES: Record<VehicleKind, { name: string; hp: number; r: number; h: number; top: number; boost: number; accel: number; reach: number; seats: number }> = {
  car: { name: 'Car', hp: 500, r: 1.25, h: 1.7, top: 24, boost: 34, accel: 16, reach: 3.2, seats: 3 },
  heli: { name: 'Helicopter', hp: 650, r: 2.3, h: 2.6, top: 25, boost: 32, accel: 14, reach: 4.2, seats: 3 },
  plane: { name: 'Plane', hp: 350, r: 2.4, h: 1.8, top: 46, boost: 62, accel: 11, reach: 4.6, seats: 1 },
  moto: { name: 'Motorbike', hp: 260, r: 0.75, h: 1.4, top: 30, boost: 44, accel: 24, reach: 2.4, seats: 1 },
  tank: { name: 'Tank', hp: 2200, r: 2.1, h: 2.3, top: 8, boost: 11, accel: 6, reach: 3.8, seats: 1 },
};
// the tank's cannon (left click): a shell that blows up buildings; its tracks plough through walls.
// Right click: the machine gun beside it. Both fire at the crosshair (tankAim)
export const TANK = { dmg: 136, cd: 2.4, speed: 70, radius: 6.5 };
export const TANK_MG = { dmg: 11, cd: 0.1, range: 160, spread: 0.02 };
export const RAM = { minSpeed: 7, dmgPerMs: 4.2, cooldown: 0.6 };      // running people over
export const CRASH = { minSpeed: 9, dmgPerMs: 9 };                     // hitting walls hurts the vehicle
export const VEH_BOOM = { radius: 7.5, dmg: 110 };                     // a wrecked vehicle explodes
// an aircraft flown into something faster than minSpeed (or set down harder than land) is wrecked on the
// spot and blows up: the fireball tears through what it hit along its path (r across, depth along it,
// flat: the slab of floors it takes, as a share of r), every building it reaches takes struct damage (a
// house is ~1 600, the King's Tower 4 900, the Spire 19 200, The Needle 50 000), and dmg hits whoever
// is within boom (the crew in full). All of it at full speed (at); slower is less, boosting a bit more.
export const AIR_CRASH = {
  minSpeed: 16, land: 24,
  plane: { at: 46, r: 12, depth: 20, flat: 0.45, struct: 14000, dmg: 170, boom: 11 },
  heli: { at: 25, r: 7.5, depth: 10, flat: 0.5, struct: 3600, dmg: 136, boom: 9 },
};
export const HELI_GUN = { dmg: 14, cd: 0.09, range: 170, spread: 0.028 };
export const PLANE_GUN = { dmg: 12, cd: 0.07, range: 200, spread: 0.02 };
export const BOMB = { radius: 8, dmg: 125, cd: 2.5 };

// economy
export const EPOCH_MS = 60 * 60 * 1000; // the pot pays out every hour, on the hour (UTC)
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const epochOf = (ms: number) => Math.floor(ms / EPOCH_MS);
export const epochEnd = (epoch: number) => (epoch + 1) * EPOCH_MS;

// squid-game style player numbers, stable for a session: 001..456
export const playerNumber = (seed: number) => String((seed % 456) + 1).padStart(3, '0');
