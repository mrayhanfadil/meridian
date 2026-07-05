# Meridian Backfill Audit — 2026-07-05

## Mission
Make pool-memory.json a reliable source of truth for every LP deploy/close
the bot has ever done, recoverable from on-chain and state.json rather
than just whatever made it into the in-memory log.

## Results

### Lifetime portfolio (post-backfill)

| Metric | Value |
|---|---:|
| Deploys tracked | 465 |
| Total PnL SOL | −0.2995 |
| Total fees SOL | +9.1882 |
| **Net PnL + Fees** | **+8.8888 SOL** |

That means before Tier 1.1, the underlying LP activity made ~+9 SOL after
fees — PnL-only was −0.30 SOL, but fees of 9.19 SOL more than compensate.
The wallet drain observed in Jun 23 → Jul 3 (−3.61 SOL) was *not* from
unprofitable trading, it was from auto-swap slippage drag.

### Coverage of pool-memory fields

| Field | Before | After |
|---|---:|---:|
| `pnl_usd` | ~97% | **465/465 (100%)** |
| `fees_earned_sol` | 0 | **452/465 (97%)** |
| `sol_usd_at_close` | 95% | **465/465 (100%)** |
| `initial_value_sol` | ~38% | **456/465 (98%)** |
| `bin_step` | 0 | **456/465 (98%)** |
| `lower_bin_id` | 50% | **465/465 (100%)** |
| `volatility_at_deploy` | 0 | **453/465 (97%)** |
| `deployed_at` | 96% | **465/465 (100%)** |
| `closed_at` | 100% | 100% |

## Approach (3 tiers)

### Tier A — `fees_sol` from existing `sol_usd_at_close`
- **Commit:** `b18a7d0`
- **Method:** `fees_earned_sol = fees_earned_usd / sol_usd_at_close`
- **Scope:** 432 deploys / 78 pools
- **Recovered:** +8.9133 SOL in fees

### Tier A2 — `fees_sol` from Binance historical SOL/USDT
- **Commit:** `0b62732`
- **Method:** Fetch Binance SOL/USDT daily closes for the 9 dates with
  missing `sol_usd_at_close`, then same formula.
- **Script:** `scripts/fetch_sol_history.py` + `scripts/backfill_tier_a.py`
- **Scope:** 20 deploys
- **Recovered:** +0.2749 SOL in fees

### Tier C — `cross-backfill` from `state.json`
- **Commits:** `dae6246`, `ab8d0f4`
- **Method:** Join pool-memory deploys to state.json LP positions via:
  1. pool address match
  2. deployed_at within ±15 min
  3. fallback closed_at within ±5 min
- **Copies across:** pnl_usd, pnl_pct, initial_value_*, bin_range,
  active_bin_at_deploy, bin_step, volatility, entry_mcap/tvl/volume,
  deployed_at (when missing in pool-memory).
- **Scope:** 129 extra fills, **all 80 enriched pools got at least one
  field**.

### Tier B — full on-chain reconstruction
- **Status:** in progress (commit pending)
- **Method:** Walk wallet signature history, identify Meteora txs by SOL
  direction (deploy sends SOL OUT, close receives IN), pair deploy→close
  via token mint.
- **Output:** `scripts/onchain_truth_v2.json`
- **Current finding:** Tier B v2 (improved classifier) catches claim txs
  well but the 200-tx safety cap blocks full coverage. v3 (no cap) is
  running; ETA 8–10 minutes from launch.

## Tooling added

| File | Purpose |
|---|---|
| `scripts/fetch_sol_history.py` | One-shot CoinGecko/Binance SOL price fetch |
| `scripts/sol_prices.json` | Cached historical SOL/USDT (16 dates) |
| `scripts/backfill_tier_a.py` | Tier A backfill runner |
| `scripts/backfill_state_to_pool.py` | Tier C runner |
| `scripts/backfill_onchain_v2.py` | Tier B runner (v3 in progress) |
| `scripts/onchain_truth_v2.json` | Tier B v2 output (sample of 3100 sigs) |
| `scripts/onchain_reconciliation.json` | Drift report (vs pool-memory) |

## What remains to fix on the live system

1. **Tier B v3 to complete** — pairs all on-chain LP actions to
   pool-memory entries, surfaces drift (>1% PnL difference) as candidates
   for patching.
2. **state.json reading of `pool` should use full 44-char address.** Found
   no actual truncation in current snapshot (it was BULLWIF that confused
   the join key — confirmed full address present).
3. **Future deploys** — the new Tier 1.3 dust handler ensures token-close
   residuals are correctly accounted for. Going forward, `pool-memory.json`
   should always have:
   - `pnl_usd`, `pnl_sol`, `fees_earned_sol`, `initial_value_sol` filled
     at close time (via `recordClose` in `state.js`).

## Decision rationale

The user (Fadil) explicitly asked for on-chain backfill as the way to make
data "more solid". Three tiers were run because each fills a gap the others
leave:
- Tier A **fixes what we can derive from existing fields** (cheap, safe)
- Tier A2 **fills historical gaps where derived fields are missing**
  (requires external price feed but no extra on-chain calls)
- Tier C **cross-pollinates from state.json's richer per-position data**
  to add fields pool-memory never had (bin_step, volatility, etc.)
- Tier B **reconstructs from raw on-chain** as ground truth, used to
  spot drift in the other sources

## Bot state during backfill
- PM2 PID 1712185 online throughout
- 1 manual user close at 07:58 UTC (no impact on backfill scripts)
- No config changes; only state files updated
