import type { ItemId, Mode, PerkId, WeaponId } from './constants.ts';
import type { Input } from './sim.ts';
import type { Body, Box } from './world.ts';

// Wire protocol. JSON over a single WebSocket per player. Clients only ever send intent
// (inputs, queue requests); every outcome is decided by the server.

export interface PotView {
  epoch: number;
  epochEndMs: number;
  lamports: string;          // bigint as decimal string
  rolloverLamports: string;  // what this epoch started with from the last one
  commit: string;            // sha256(secret) published at epoch start (draw mode)
  online: number;
  rooms: number;
  tickets: { name: string; wallet: string; wins: number }[]; // top of the epoch, by points
  closeFrom: number;         // scoring closes at a random minute between this and epochEndMs
  holdTokens: number;        // tokens a wallet must hold this epoch to keep its points
  symbol: string;
  mint?: string;             // the token's contract address ('' before launch)
  holdMinUsd?: number;       // the USD side of the hold requirement
  solUsd: number | null;     // to show the pot in dollars
}

export interface InflowView { lamports: string; at: number; source: string }

// a connected wallet's corner of the lobby: what it holds, whether it qualifies this hour, its record
export interface ProfileView {
  wallet: string;
  symbol: string;
  balance: string | null;    // whole tokens, formatted; null when it couldn't be read (or no token yet)
  need: string | null;       // tokens to hold this hour to qualify; null when there is no requirement
  holdMinUsd: number;
  qualified: boolean;        // holds enough right now and wasn't voided this hour
  why: string | null;        // why not, when not
  points: number;            // this hour
  rank: number | null;       // this hour, 1 = takes the pot
  matches: number; wins: number; kills: number; best: number; // best: best place, 0 = none yet
  prizes: number; prizeLamports: string; // hourly pots won
}

export interface SettledView {
  epoch: number;
  potLamports: string;
  rollover: string;
  winners: { wallet: string; name: string; lamports: string }[];
  merkleRoot: string;
  reveal: string;
}

// your own player, in full: the client replays unacknowledged inputs from this exact state
export interface SnapSelf extends Body {
  yaw: number; pitch: number; hp: number; shield: number; alive: boolean;
  slots: (WeaponId | null)[]; mags: number[]; cur: number; ups: number[];
  items: Record<ItemId, number>; perk: { kind: PerkId; n: number } | null;
  use: { item: ItemId; t: number } | null;
  reloadT: number; spin: number; ack: number; kills: number; vhp: number; rideV: number; // vhp: your vehicle's health, 0 on foot
  reviveT: number;   // knocked: how far a teammate has got picking you up (s)
  reviving: number;  // you are picking up a teammate: progress (s), 0 when not
  axe: boolean; mats: number; // axe in hand; building material
}
// everyone else within VIEW_RANGE, compact: [id, x, y, z, yaw, pitch, hp, flags, weaponIdx, gx?, gy?, gz?]
// flags: 1 alive, 2 sliding, 4 grappling (anchor appended), 8 gliding, 16 healing; weaponIdx into WEAPON_IDS, -1 none
export type SnapOther = number[];
export const OTHER_ALIVE = 1, OTHER_SLIDE = 2, OTHER_HOOK = 4, OTHER_GLIDE = 8, OTHER_HEAL = 16, OTHER_RIDE = 32, OTHER_DOWN = 64, OTHER_AXE = 128;
// vehicles: [id, kind (0 car, 1 heli, 2 plane), x, y, z, heading, pitch, hp %, driver id or 0, passengers]
export type SnapVehicle = number[];
// loot on the floor near you: [id, x, y, z, kind (0 weapon, 1 item, 2 perk), what, n]
export type SnapLoot = [number, number, number, number, number, string, number];
// pencil cases near you: [id, x, y, z, golden 0/1 (2 = supply drop), open 0/1]
export type SnapCase = [number, number, number, number, number, number];
// grenades, smoke, launch pads, incoming nukes: [kind, id, x, y, z, secondsLeft]
export type SnapFx = [string, number, number, number, number, number];
// ring center is (x, y) on the ground plane, i.e. world x and z
export interface SnapRing { x: number; y: number; r: number; nx: number; ny: number; nr: number; closing: boolean; nextIn: number; phase: number }

// team: who you drop and win with (0 until the match starts; in solo everyone is their own team)
export interface RoomSeat { id: number; num: string; name: string; verified: boolean; team: number; skin?: number; bot?: boolean }
// rooms filling or playing right now, for the lobby's room list
export interface LobbyRoom { id: string; mode: Mode; n: number; state: RoomPhase; startsIn: number | null }

export type ServerMsg =
  | { t: 'hello'; nonce: string; requireWallet: boolean; allowGuests: boolean; holdMinUsd: number }
  | { t: 'authed'; name: string; wallet: string | null; num: string; eligible?: string | null } // eligible: null = scores points, else why not
  | { t: 'error'; msg: string }
  | { t: 'pot'; pot: PotView }
  | { t: 'inflow'; inflow: InflowView }
  | { t: 'settled'; settled: SettledView }
  | { t: 'profile'; profile: ProfileView }
  | { t: 'queued'; position: number }
  | { t: 'room'; roomId: string; you: number; seats: RoomSeat[]; state: RoomPhase; startsAt: number | null; seed: number; mode: Mode }
  | { t: 'lobby'; rooms: LobbyRoom[] }
  | { t: 'snap'; tick: number; time: number; alive: number; ring: SnapRing; self: SnapSelf | null; others: SnapOther[]; shots: number[][]; leader: [number, number] | null; board?: number[][]; watch: number; fx: SnapFx[]; veh: SnapVehicle[]; loot?: SnapLoot[]; cases?: SnapCase[] } // leader = [id, kills], board = top teams [team, kills, alive, best player] // shot = [ox,oy,oz,ex,ey,ez,by,hit]
  | { t: 'event'; kind: 'elim'; victim: number; by: number | null; cause: 'shot' | 'ring' | 'left' | 'boom' | 'ram'; left: number; head: boolean }
  | { t: 'event'; kind: 'vhit'; vehicle: number; by: number; dmg: number }
  | { t: 'event'; kind: 'knock'; victim: number; by: number | null; head: boolean }
  | { t: 'event'; kind: 'wreck'; add: Box[]; kill: number[]; falls: { sid: number; x: number; y: number; z: number }[]; drop?: number[] }
  | { t: 'event'; kind: 'chop'; by: number; x: number; y: number; z: number; broke: boolean }
  | { t: 'event'; kind: 'revive'; victim: number; by: number }
  | { t: 'event'; kind: 'drop'; x: number; z: number; landed: boolean }
  | { t: 'event'; kind: 'upgrade'; by: number; level: number }
  | { t: 'event'; kind: 'hit'; victim: number; by: number; dmg: number; head: boolean; shield: boolean; broke: boolean }
  | { t: 'event'; kind: 'boom'; x: number; y: number; z: number; r: number; nuke: boolean }
  | { t: 'event'; kind: 'build'; id: number; boxes: Box[] }
  | { t: 'event'; kind: 'unbuild'; id: number }
  | { t: 'event'; kind: 'nuke'; x: number; z: number; by: number; at: number }
  | { t: 'event'; kind: 'open'; caseId: number; by: number; golden: boolean }
  | { t: 'rtc'; from: number; data: unknown } // squad voice: WebRTC signalling relayed from a teammate
  | { t: 'result'; winner: number | null; winners: number[]; points: Record<number, number>; awarded: boolean; epoch: number }; // points: what each player scored

export type RoomPhase = 'waiting' | 'countdown' | 'live' | 'over';

export type ClientMsg =
  | { t: 'auth'; wallet: string; sig: string }
  | { t: 'guest'; name: string }
  | { t: 'queue'; mode?: Mode; party?: string; room?: string; skin?: number }   // party: friends typing the same code drop on one team
  | { t: 'spec'; dir?: 1 | -1; target?: number; at?: [number, number] | null } // dead: switch who you watch, or fly a free camera
  | { t: 'leave' }
  | { t: 'me' }                               // ask for your profile again
  | { t: 'rtc'; to: number; data: unknown }   // squad voice signalling, only ever relayed to a teammate in your match
  | ({ t: 'in' } & Input);

export const loginMessage = (nonce: string) => `Pot Royale login\nnonce: ${nonce}`;
