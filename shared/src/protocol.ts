import type { WeaponId } from './constants.ts';
import type { Input } from './sim.ts';
import type { Body } from './world.ts';

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
  tickets: { name: string; wallet: string; wins: number }[]; // top of the epoch
}

export interface InflowView { lamports: string; at: number; source: string }

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
  yaw: number; pitch: number; hp: number; alive: boolean; weapon: WeaponId;
  mag: [number, number, number, number]; // rifle, shotgun, sniper, pistol
  reloadT: number; ack: number; kills: number;
}
// everyone else within VIEW_RANGE, compact: [id, x, y, z, yaw, pitch, hp, flags, weaponIdx, gx?, gy?, gz?]
// flags: 1 alive, 2 sliding, 4 grappling (anchor appended), 8 gliding
export type SnapOther = number[];
export const OTHER_ALIVE = 1, OTHER_SLIDE = 2, OTHER_HOOK = 4, OTHER_GLIDE = 8;
// ring center is (x, y) on the ground plane, i.e. world x and z
export interface SnapRing { x: number; y: number; r: number; nx: number; ny: number; nr: number; closing: boolean; nextIn: number; phase: number }

export interface RoomSeat { id: number; num: string; name: string; verified: boolean }

export type ServerMsg =
  | { t: 'hello'; nonce: string; requireWallet: boolean; allowGuests: boolean; holdMinUsd: number }
  | { t: 'authed'; name: string; wallet: string | null; num: string }
  | { t: 'error'; msg: string }
  | { t: 'pot'; pot: PotView }
  | { t: 'inflow'; inflow: InflowView }
  | { t: 'settled'; settled: SettledView }
  | { t: 'queued'; position: number }
  | { t: 'room'; roomId: string; you: number; seats: RoomSeat[]; state: RoomPhase; startsAt: number | null; seed: number }
  | { t: 'snap'; tick: number; time: number; alive: number; ring: SnapRing; self: SnapSelf | null; others: SnapOther[]; shots: number[][]; leader: [number, number] | null } // leader = [id, kills] // shot = [ox,oy,oz,ex,ey,ez,by,hit]
  | { t: 'event'; kind: 'elim'; victim: number; by: number | null; cause: 'shot' | 'ring' | 'left'; left: number; head: boolean }
  | { t: 'event'; kind: 'hit'; victim: number; by: number; dmg: number; head: boolean }
  | { t: 'result'; winner: number | null; ticketAwarded: boolean; epoch: number };

export type RoomPhase = 'waiting' | 'countdown' | 'live' | 'over';

export type ClientMsg =
  | { t: 'auth'; wallet: string; sig: string }
  | { t: 'guest'; name: string }
  | { t: 'queue' }
  | { t: 'leave' }
  | ({ t: 'in' } & Input);

export const loginMessage = (nonce: string) => `Pot Royale login\nnonce: ${nonce}`;
