// Merkle tree over an epoch's payouts. Byte layout must match programs/pot_vault/src/lib.rs:
//   leaf   = sha256(0x00 || epoch u64le || index u32le || wallet[32] || amount u64le)
//   parent = sha256(0x01 || min(a,b) || max(a,b))
// The domain bytes stop a leaf from being replayed as an inner node.
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import type { Payout } from './payout.ts';

const sha = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();

export function leafHash(epoch: number, index: number, wallet: string, lamports: bigint): Buffer {
  const pk = Buffer.from(bs58.decode(wallet));
  if (pk.length !== 32) throw new Error(`bad wallet ${wallet}`);
  const e = Buffer.alloc(8); e.writeBigUInt64LE(BigInt(epoch));
  const i = Buffer.alloc(4); i.writeUInt32LE(index);
  const a = Buffer.alloc(8); a.writeBigUInt64LE(lamports);
  return sha(Buffer.from([0]), e, i, pk, a);
}

export function parent(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0 ? sha(Buffer.from([1]), a, b) : sha(Buffer.from([1]), b, a);
}

export interface Tree { root: Buffer; proofs: Buffer[][]; leaves: Buffer[] }

export function buildTree(epoch: number, payouts: Payout[]): Tree {
  const leaves = payouts.map((p, i) => leafHash(epoch, i, p.wallet, p.lamports));
  if (leaves.length === 0) return { root: Buffer.alloc(32), proofs: [], leaves };
  const proofs: Buffer[][] = leaves.map(() => []);
  let level = leaves.map((h, i) => ({ h, idx: [i] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = level[i + 1];
      if (!r) { next.push(l); continue; } // odd node is promoted unchanged
      for (const k of l.idx) proofs[k].push(r.h);
      for (const k of r.idx) proofs[k].push(l.h);
      next.push({ h: parent(l.h, r.h), idx: [...l.idx, ...r.idx] });
    }
    level = next;
  }
  return { root: level[0].h, proofs, leaves };
}

export function verify(leaf: Buffer, proof: Buffer[], root: Buffer): boolean {
  return proof.reduce((h, sib) => parent(h, sib), leaf).equals(root);
}
