# Architecture

## Why not peer to peer

The game this started from (Doodle District / iifor/doodleshooter) is peer to peer: one player's
browser hosts the match and keeps the score. That works for a free game. With a pot on the line, the
host would decide who wins. Here a server runs the simulation, and clients only ever send inputs
(move vector, aim angle, fire, dash), which the server clamps (`sanitizeInput`).

## Server

```
ws ──> Client (rate-limited, auth'd) ──> Matchmaker queue ──> Room (≤10) ──> Sim (30 Hz)
                                                             │
                                          win ──> Epochs (append-only wins.jsonl)
Pot source (mock | vault RPC) ──> inflow events ──> every client (lobby animation)
Every hour: Epochs.settle ──> payout.ts ──> merkle.ts ──> data/epochs/N.json ──> keeper ──> chain
```

- **One tick loop per process** drives every room (drift-corrected `setTimeout`). The cost scales
  with active rooms, not with timers.
- **Snapshots are serialised once per room** and the same string goes to all 10 sockets. Clients that fall behind
  (`bufferedAmount` > 256 KB) skip snapshots; past 2 MB they get dropped.
- **Lag compensation**: clients render 100 ms in the past and interpolate between 15 Hz snapshots.
  Bullets are extrapolated from velocity. Bullet hits use a swept segment, so nothing tunnels at 30 Hz.
- **Crash safety**: every win is appended to `wins.jsonl` before it is acknowledged. On boot the log
  is replayed, and any epoch that closed while the process was down settles immediately (`catchUp`).
- **One seat per wallet**: signing in from a second tab closes the first.

## Scaling past one process

Rooms never talk to each other, so they shard trivially:

1. Run N game processes (one per core) behind a router that sends each new socket to the least-loaded process
   (`/health` exposes clients, rooms and tick ms).
2. Move the tickets ledger from `wins.jsonl` to Postgres or Redis (one table: epoch, wallet, room_id, at).
   Settlement runs once, on a single elected node, from that table.
3. Pot inflow events come from one watcher that publishes to all nodes (Redis pub/sub).

From the load test, one process holds ~2000 players at <30% of its tick budget, so 8 cores ≈ 15k
concurrent players before you need a second machine.

## Trust model, honestly

| who | can | cannot |
| --- | --- | --- |
| player | send inputs | move faster, shoot faster, or win while disconnected |
| game server | decide who won rooms; publish the root | pay out more than the free vault balance, settle early or twice |
| vault authority | post one root per ended epoch | withdraw outside a root; touch reserved claims |

The remaining trust is in the **server's win reports**. Mitigations, in order of cost:
publish every room result (players, winner, seed, kill log) for audit; make the authority a
Squads multisig; later, have rooms sign results with a TEE key, or post room results on chain.

## Before mainnet (not done yet)

- [ ] Keeper script: read `data/epochs/N.json`, propose `settle_epoch` to the Squads multisig (authority = Squads vault PDA via `set_authority`), and a claim UI.
- [ ] Confirm the Jupiter price v3 response format against the live API (not reachable from the build sandbox).
- [ ] Fee sweep: claim pump.fun creator fees (or harvest Token-2022 withheld fees, then swap) into the vault on a schedule.
- [ ] `draw` mode: mix a future slot hash or Switchboard VRF into the seed. A commit-reveal alone
      still lets the operator, who knows the secret, steer the result with sybil tickets.
- [ ] Anchor integration tests on a local validator (`anchor test`); the unit tests cover only the merkle math.
- [ ] Bot/sybil detection on input patterns. KYC or geofencing according to legal advice.
- [ ] Client-side prediction for your own player (right now input lag = RTT + 100 ms interpolation).
