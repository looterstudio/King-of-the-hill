//! Pot Royale prize vault.
//!
//! Token trading fees are swept (as SOL) into the `vault` PDA. Every 6h epoch the operator posts
//! one merkle root of (wallet, amount) payouts; winners pull their own share with a proof.
//!
//! What the operator key CAN do: allocate the free vault balance to a root it publishes.
//! What it CANNOT do: withdraw to itself outside a root, settle an epoch before it has ended,
//! settle an epoch twice, allocate more than the free balance, or touch funds already reserved
//! for unclaimed winners. The root and the full claims list are published off chain
//! (`/api/epochs/:id`), so every allocation is auditable. Put the authority behind a multisig.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const MAX_CLAIMS: u32 = 8192;
pub const MAX_PROOF: usize = 14; // ceil(log2(8192)) + 1
pub const CLAIM_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;

#[program]
pub mod pot_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, epoch_seconds: i64) -> Result<()> {
        require!(epoch_seconds >= 60, VaultError::BadEpochLength);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.epoch_seconds = epoch_seconds;
        c.last_settled = 0;
        c.settled_any = false;
        c.reserved = 0;
        c.vault_bump = ctx.bumps.vault;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn settle_epoch(ctx: Context<SettleEpoch>, epoch: u64, root: [u8; 32], total: u64, count: u32) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(count > 0 && count <= MAX_CLAIMS, VaultError::BadCount);
        require!(!c.settled_any || epoch > c.last_settled, VaultError::AlreadySettled);

        let ends = (epoch as i128 + 1) * c.epoch_seconds as i128;
        let now = Clock::get()?.unix_timestamp;
        require!((now as i128) >= ends, VaultError::EpochNotOver);

        // only the free balance can be allocated: never the rent floor, never other epochs' claims
        let rent_min = Rent::get()?.minimum_balance(0);
        let free = ctx.accounts.vault.lamports()
            .checked_sub(rent_min).ok_or(VaultError::Insufficient)?
            .checked_sub(c.reserved).ok_or(VaultError::Insufficient)?;
        require!(total <= free, VaultError::Insufficient);

        c.reserved = c.reserved.checked_add(total).ok_or(VaultError::Overflow)?;
        c.last_settled = epoch;
        c.settled_any = true;

        let e = &mut ctx.accounts.epoch_state;
        e.epoch = epoch;
        e.root = root;
        e.total = total;
        e.claimed = 0;
        e.count = count;
        e.settled_at = now;
        e.bump = ctx.bumps.epoch_state;
        e.bitmap = vec![0u8; bitmap_len(count)];

        emit!(EpochSettled { epoch, root, total, count });
        Ok(())
    }

    /// Anyone may submit a claim (a relayer can pay the fee); the lamports always go to `claimant`,
    /// the wallet committed in the leaf.
    pub fn claim(ctx: Context<Claim>, epoch: u64, index: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        require!(proof.len() <= MAX_PROOF, VaultError::BadProof);
        let e = &mut ctx.accounts.epoch_state;
        require!(index < e.count, VaultError::BadIndex);
        let (byte, bit) = ((index / 8) as usize, 1u8 << (index % 8));
        require!(e.bitmap[byte] & bit == 0, VaultError::AlreadyClaimed);

        let leaf = leaf_hash(epoch, index, &ctx.accounts.claimant.key(), amount);
        require!(verify(leaf, &proof, e.root), VaultError::BadProof);

        let claimed = e.claimed.checked_add(amount).ok_or(VaultError::Overflow)?;
        require!(claimed <= e.total, VaultError::Insufficient);
        e.claimed = claimed;
        e.bitmap[byte] |= bit;

        let c = &mut ctx.accounts.config;
        c.reserved = c.reserved.checked_sub(amount).ok_or(VaultError::Overflow)?;

        let seeds: &[&[u8]] = &[b"vault", &[c.vault_bump]];
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.claimant.to_account_info() },
                &[seeds],
            ),
            amount,
        )?;
        emit!(Claimed { epoch, index, claimant: ctx.accounts.claimant.key(), amount });
        Ok(())
    }

    /// After the claim window, unclaimed prizes are released back into the free balance (they roll
    /// into the next pot, they do not go to the authority) and the epoch account's rent is refunded.
    pub fn expire_epoch(ctx: Context<ExpireEpoch>, _epoch: u64) -> Result<()> {
        let e = &ctx.accounts.epoch_state;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= e.settled_at.saturating_add(CLAIM_WINDOW_SECS), VaultError::ClaimWindowOpen);
        let unclaimed = e.total - e.claimed;
        let c = &mut ctx.accounts.config;
        c.reserved = c.reserved.checked_sub(unclaimed).ok_or(VaultError::Overflow)?;
        Ok(())
    }

    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }
}

pub fn bitmap_len(count: u32) -> usize { count.div_ceil(8) as usize }

pub fn leaf_hash(epoch: u64, index: u32, wallet: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[&[0u8], &epoch.to_le_bytes(), &index.to_le_bytes(), wallet.as_ref(), &amount.to_le_bytes()]).to_bytes()
}

pub fn parent(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    if a <= b { hashv(&[&[1u8], a, b]).to_bytes() } else { hashv(&[&[1u8], b, a]).to_bytes() }
}

pub fn verify(leaf: [u8; 32], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    proof.iter().fold(leaf, |h, sib| parent(&h, sib)) == root
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub epoch_seconds: i64,
    pub last_settled: u64,
    pub settled_any: bool,
    pub reserved: u64,
    pub vault_bump: u8,
    pub bump: u8,
}
impl Config { pub const SPACE: usize = 8 + 32 + 8 + 8 + 1 + 8 + 1 + 1; }

#[account]
pub struct EpochState {
    pub epoch: u64,
    pub root: [u8; 32],
    pub total: u64,
    pub claimed: u64,
    pub count: u32,
    pub settled_at: i64,
    pub bump: u8,
    pub bitmap: Vec<u8>,
}
impl EpochState { pub fn space(count: u32) -> usize { 8 + 8 + 32 + 8 + 8 + 4 + 8 + 1 + 4 + bitmap_len(count) } }

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = Config::SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    // system-owned PDA that only holds lamports; it exists once the first deposit lands
    #[account(seeds = [b"vault"], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64, root: [u8; 32], total: u64, count: u32)]
pub struct SettleEpoch<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(init, payer = authority, space = EpochState::space(count), seeds = [b"epoch", epoch.to_le_bytes().as_ref()], bump)]
    pub epoch_state: Account<'info, EpochState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"epoch", epoch.to_le_bytes().as_ref()], bump = epoch_state.bump)]
    pub epoch_state: Account<'info, EpochState>,
    #[account(mut)]
    pub claimant: SystemAccount<'info>,
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct ExpireEpoch<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, close = authority, seeds = [b"epoch", epoch.to_le_bytes().as_ref()], bump = epoch_state.bump)]
    pub epoch_state: Account<'info, EpochState>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[event]
pub struct EpochSettled { pub epoch: u64, pub root: [u8; 32], pub total: u64, pub count: u32 }
#[event]
pub struct Claimed { pub epoch: u64, pub index: u32, pub claimant: Pubkey, pub amount: u64 }

#[error_code]
pub enum VaultError {
    #[msg("epoch length too short")] BadEpochLength,
    #[msg("claim count out of range")] BadCount,
    #[msg("epoch already settled or out of order")] AlreadySettled,
    #[msg("epoch has not ended yet")] EpochNotOver,
    #[msg("not enough free balance in the vault")] Insufficient,
    #[msg("arithmetic overflow")] Overflow,
    #[msg("claim index out of range")] BadIndex,
    #[msg("already claimed")] AlreadyClaimed,
    #[msg("merkle proof does not match")] BadProof,
    #[msg("claim window still open")] ClaimWindowOpen,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet(b: u8) -> Pubkey { Pubkey::new_from_array(core::array::from_fn(|i| b.wrapping_add(i as u8))) }
    fn h(s: &str) -> [u8; 32] { hex::decode(s).unwrap().try_into().unwrap() }

    // vector produced by server/src/merkle.ts: the off-chain tree and this program must agree byte for byte
    const ROOT: &str = "d2c38c65af2ae0a7988a6ee26cf5504d716a95d8dc966136268aa19cb1bbb3ad";

    #[test]
    fn matches_server_tree() {
        let root = h(ROOT);
        let cases: [(u32, Pubkey, u64, Vec<&str>); 3] = [
            (0, wallet(1), 1_000_000, vec!["a3cf1c8f4a54223988c5986218296a8fadfda91887abaec805760b8a43c9b5dd", "61724acc03637d35508332080e33afc1309d7bbd36409161eed56bf3168386ef"]),
            (1, wallet(50), 2_500_000_000, vec!["28a769ecc8a3d1e42c20b67c108e335c7c276847a88578686d6dc01ed037f204", "61724acc03637d35508332080e33afc1309d7bbd36409161eed56bf3168386ef"]),
            (2, wallet(200), 7, vec!["3965eab869af875bffd71ca71e579863002a1ff151864d584430d3782ad2111f"]),
        ];
        for (i, w, amt, proof) in cases {
            let proof: Vec<[u8; 32]> = proof.iter().map(|s| h(s)).collect();
            assert!(verify(leaf_hash(7, i, &w, amt), &proof, root), "leaf {i}");
            assert!(!verify(leaf_hash(7, i, &w, amt + 1), &proof, root), "tampered amount {i}");
            assert!(!verify(leaf_hash(8, i, &w, amt), &proof, root), "wrong epoch {i}");
        }
    }

    #[test]
    fn bitmap_sizes() {
        assert_eq!(bitmap_len(1), 1);
        assert_eq!(bitmap_len(8), 1);
        assert_eq!(bitmap_len(9), 2);
        assert_eq!(bitmap_len(MAX_CLAIMS), 1024);
    }
}
