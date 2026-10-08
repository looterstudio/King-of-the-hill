# King of the Hill Royale

A first-person battle royale drawn in ballpoint on graph paper, for up to 100 players per match.
Glide in, loot guns, shields and perks off the floor and out of pencil cases, and fight your way to
the King's Tower in the middle of the island: the final circle always closes on it. Ten guns from
common to legendary (the SCAR and a one-shot Heavy Sniper are the prizes), shields and medkits, and
five perks: grenades, smoke, launch pads, instant forts and, for the luckiest, an atomic bomb you
can drop anywhere on the map. Play **solo, duos or squads**; the last player (or team) standing
wins tickets, and the token's trading fees fill one shared pot that pays out to the winners every
6 hours (00/06/12/18 UTC).

- **The island.** 800 × 800 m, 23 named places, a snowfield across the north and a desert in the
  south-east. New: The Spire (a 30-floor skyscraper with a helipad), Mount Doodle, Snowpeak and
  Eraser Ridge (terraced mountains to climb), Frost Lodge (ski lodge, chalets, chairlift), Dune
  Town, Dust Fort, the Ink Pyramid and an Oasis. The classics, around downtown Crown City and the
  King's Tower, joined by a ring road: Scribble Suburbs (house grid, mansion, sports park), Castle Crayon (walls, corner
  towers and a keep on a two-step hill), Margin Mart (shops, a supermarket with aisles, a water
  tower), Paper Port (piers, a cargo ship you can board, gantry cranes, a lighthouse), Staple Depot
  (warehouses with catwalks, a factory with chimneys and tanks), Crumple Junk (car-stack alleys,
  crusher, crane), Eraser Lake (island house, piers, boathouse), Inkwood (forest lookout lodge),
  Tally Farms (barns with haylofts, twin silos), Doodle Drive-In (giant screen with a walkway),
  Pit Stop (gas station, diner, motel), Graphite Mine (tunnels through a hill) and Paper Plane
  Field (runway, hangar, control tower). `npm run check:map` walks the whole island with the
  game's own movement rules and fails on any case or loot spot you can't reach on foot.
- **Vehicles.** Cars on the roads (run people over, drive-by with your own gun, hop with Space),
  helicopters on rooftops (a nose gun that aims where you look) and planes at Paper Plane Field
  (wing guns and bombs). Crashes dent them, bullets and blasts wreck them, a wreck explodes on
  whoever is near. Driving uses the same client prediction as walking, so it responds instantly.
- **Arsenal.** 12 guns including a Rocket Launcher and a Stinger whose missiles lock onto
  helicopters and planes. 9 perks: grenades, molotovs (fire on the ground), shockwaves (throw people
  through the air, yourself included), smoke, launch pads, instant forts, upgrade kits, C4 and the
  atomic bomb. Upgrade benches and kits add up to three stars (+66% damage) to a gun.
- **Squads in vehicles.** Teammates ride along as passengers (3 in cars and helicopters, 1 in a
  plane) and shoot out of the windows; bail out of an aircraft and your glider opens.
- **C4 and supply drops.** C4 sticks where it lands and goes off on the second press: 100 damage
  inside 2.5 m, your own included, so you survive your charge only with shields up. Every time the
  storm moves, a balloon crate drops into the next circle with a legendary gun, C4 or a nuke.
- **Modes.** Solo win = 4 tickets, duo win = 2 each, squad win = 1 each, so every mode is worth the
  same per player on average. Friends type the same **party code** to drop on one team; empty spots
  are filled. No friendly fire; teammates are marked through walls and always on the minimap.
- **Rooms.** The lobby lists every room filling or live, with a join button. Up to 5 rooms fill at
  once (`OPEN_ROOMS`), 10 full matches run per process (`MAX_ROOMS`), spread over worker threads.
- **Spectating.** Out? Click / right-click to switch players. While a teammate lives you can only
  watch your team (no ghosting); once your team is out, `F` gives you a free flying camera.
- **Anti-cheat.** The server is the authority for movement, fire rate, damage and loot. On top:
  replayed inputs are dropped, aimbot patterns (snap-to-target hits, absurd headshot rates) flag the
  player, and enemies you have no line of sight to beyond 40 m are never sent to your client, so a
  wallhack has nothing to draw. Flagged players earn no tickets and land in `data/flags.jsonl`
  (`GET /api/admin/flags` with `ADMIN_TOKEN`).

The look and feel follow the ballpoint-shooter and classic battle-royale genres; all code here is
original, and every place name and item is our own.

## Run it locally

```bash
npm install
npm run dev:server      # game server on :8787 (mock pot, guests allowed)
npm run dev:client      # vite on :5173, proxies /ws and /api to the server
```

Open two tabs at http://localhost:5173, join as guests, pick a mode and click **Drop in** in both.
A match starts at 100 players, or 45 s after the second player joins. `npm run build:demo` builds a
single-player version that runs entirely in the browser against bots.

Production: `npm run build && npm run build:server && npm start` (plain-JS server bundle in
`dist-server/`, serves `dist/`). Or `docker build -t pot-royale .`

## Checks

```bash
npm run typecheck
npm test                            # sim, payouts, merkle, epoch settlement and crash recovery
cargo test -p pot_vault             # on-chain merkle matches the server tree byte for byte
npm run loadtest -- --bots 2000     # bot swarm against a running server
```

Measured on the production bundle, one process with 3 match workers (4 vCPU container),
line-of-sight culling and vehicles on: **1000 bots in ten full 100-player matches (solo, duos and
squads), 3–8 ms per tick against a 33 ms budget, ~14 000 snapshots/s, 0 errors.**

## How a round of money moves

1. Token fees (pump.fun creator fees, or a Token-2022 transfer fee swapped to SOL) are swept into the
   `vault` PDA of `programs/pot_vault`.
2. Players sign in with Phantom (signed nonce, verified with ed25519 on the server) and must hold
   **$50 worth of the token** (`HOLD_MIN_USD`). Value = balance × the **15-minute median** Jupiter
   price, so pumping the price for a block does not let a small wallet in. The check runs at login
   **and on every room join**, so selling after signing in doesn't keep you playing. If the price
   feed is down, new joins are refused (fail closed). Guests can't play when a hold is required.
3. Winning a match is worth tickets (solo 4, duo 2 each, squad 1 each). A ticket only counts if the match started with at least
   `MIN_VERIFIED_FOR_TICKET` distinct wallets, so a handful of your own wallets can't farm a near-empty match.
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
| `MAX_ROOMS`, `OPEN_ROOMS`, `MAX_CONNECTIONS` | 10 / 5 / 5000 | per-process caps |
| `WORKERS` | cores − 1 | threads that run live matches |
| `ADMIN_TOKEN` | | bearer token for `/api/admin/flags` |

See `docs/ARCHITECTURE.md` for the design and what is still missing before mainnet.
