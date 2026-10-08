# Pot Royale

10-player elimination rooms. The token's trading fees fill one shared pot; every 6 hours
(00/06/12/18 UTC) the pot pays out to the wallets that won rooms during those 6 hours.
The game is drawn in ballpoint on notebook paper, and the lobby shows the pot as a glass piggy bank
hanging from the ceiling that fills with coins as fees come in.

## Run it locally

```bash
npm install
npm run dev:server      # game server on :8787 (mock pot, guests allowed)
npm run dev:client      # vite on :5173, proxies /ws and /api to the server
```

Open two tabs at http://localhost:5173, join as guests, and click **Find a room** in both.
A room starts at 10 players, or 20 s after the second player joins.

Production: `npm run build && npm start` (the server serves `dist/`). Or `docker build -t pot-royale .`

## Checks

```bash
npm run typecheck
npm test                            # sim, payouts, merkle, epoch settlement and crash recovery
cargo test -p pot_vault             # on-chain merkle matches the server tree byte for byte
npm run loadtest -- --bots 2000     # bot swarm against a running server
```

Measured on one Node process (4 vCPU container): **2000 bots, 192 rooms at once, 6–10 ms per
tick against a 33 ms budget, 0 errors.**

## How a round of money moves

1. Token fees (pump.fun creator fees, or a Token-2022 transfer fee swapped to SOL) are swept into the
   `vault` PDA of `programs/pot_vault`.
2. Players sign in with Phantom (signed nonce, verified with ed25519 on the server) and must hold
   **$50 worth of the token** (`HOLD_MIN_USD`). Value = balance × the **15-minute median** Jupiter
   price, so pumping the price for a block does not let a small wallet in. The check runs at login
   **and on every room join**, so selling after signing in doesn't keep you playing. If the price
   feed is down, new joins are refused (fail closed). Guests can't play when a hold is required.
3. Winning a room is worth 1 ticket. A ticket only counts if the room started with at least
   `MIN_VERIFIED_FOR_TICKET` distinct wallets, so two of your own wallets can't farm a 2-player room.
4. At the 6h boundary the server takes a snapshot of the free vault balance, keeps `ROLLOVER_BPS` (10%) to start
   the next pot, splits the rest (`PAYOUT_MODE=prorata` by tickets, or `draw` with weighted 60/25/15
   tiers seeded by commit-reveal), and writes `data/epochs/<epoch>.json` with a merkle root and a proof per winner.
5. The authority (your Squads multisig) posts `settle_epoch(root, total, count)` on chain. Winners call `claim` with their proof.
   The program never lets the authority pay out more than the free balance, settle an epoch early or twice,
   or touch funds already owed to unclaimed winners. Unclaimed prizes go back into the pot after 30 days.

## Config (env)

| var | default | meaning |
| --- | --- | --- |
| `POT_SOURCE` | `mock` | `solana` polls the real vault |
| `SOLANA_RPC_URL` | mainnet | use a paid RPC in production |
| `VAULT_ADDRESS` / `CONFIG_ADDRESS` | | PDAs of the vault program |
| `TOKEN_MINT` | | the game's coin (required when `HOLD_MIN_USD` > 0) |
| `HOLD_MIN_USD` | `50` | USD of the token needed to play |
| `PRICE_URL` | Jupiter price v3 | mint is appended to it |
| `REQUIRE_WALLET` / `ALLOW_GUESTS` | `false` / `true` | set `true` / `false` in production |
| `MIN_VERIFIED_FOR_TICKET` | 4 with wallets, 1 in dev | anti-farm floor |
| `PAYOUT_MODE` | `prorata` | or `draw` |
| `ROLLOVER_BPS` | `1000` | share of each pot carried into the next |
| `MAX_ROOMS`, `MAX_CONNECTIONS` | 600 / 5000 | per-process caps |

See `docs/ARCHITECTURE.md` for the design and what is still missing before mainnet.
