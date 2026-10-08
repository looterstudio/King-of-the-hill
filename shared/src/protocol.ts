import type { LootKind, WeaponId } from './constants.ts';

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

export interface SnapPlayer {
  id: number; x: number; y: number; aim: number; hp: number; armor: number; alive: boolean; dash: boolean;
  weapon: WeaponId; ammo: number; // ammo -1 = unlimited (pistol)
}
export interface SnapRing { x: number; y: number; r: number; nx: number; ny: number; nr: number; closing: boolean; nextIn: number; phase: number }
export interface SnapLoot { id: number; x: number; y: number; kind: LootKind }
export interface SnapBullet { id: number; x: number; y: number; vx: number; vy: number }

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
  | { t: 'snap'; tick: number; time: number; ring: SnapRing; players: SnapPlayer[]; bullets: SnapBullet[]; loot?: SnapLoot[] }
  | { t: 'event'; kind: 'elim'; victim: number; by: number | null; cause: 'shot' | 'ring' | 'left'; left: number }
  | { t: 'event'; kind: 'pickup'; player: number; loot: LootKind }
  | { t: 'result'; winner: number | null; ticketAwarded: boolean; epoch: number };

export type RoomPhase = 'waiting' | 'countdown' | 'live' | 'over';

export type ClientMsg =
  | { t: 'auth'; wallet: string; sig: string }
  | { t: 'guest'; name: string }
  | { t: 'queue' }
  | { t: 'leave' }
  | { t: 'in'; seq: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean };

export const loginMessage = (nonce: string) => `Pot Royale login\nnonce: ${nonce}`;
