#!/usr/bin/env python3
"""
Tier C: cross-backfill pool-memory.json from state.json close_metrics.

state.json retains rich pnl/fees data per position. pool-memory.json retains
deploy history per pool. Cross-pollinate:

  For each pool-memory deploy, find the matching state.json position by:
    1. Pool address match (primary)
    2. Time window: deployed_at within ±15 minutes of state.position.deployed_at
    3. Fallback: closed_at within ±5 minutes of state.position.closed_at
       (covers deploys where pool-memory lost deployed_at but kept closed_at)

  When matched, fill in fields pool-memory might be missing from
  state.json's close_metrics.

Idempotent and side-effect-safe: only fills null/missing fields.
"""
import json
from pathlib import Path
from collections import defaultdict
from datetime import datetime

ROOT = Path("/home/fadil/projects/meridian")
STATE = ROOT / "state.json"
POOL_MEM = ROOT / "pool-memory.json"


def parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def main():
    state = json.loads(STATE.read_text())
    pm = json.loads(POOL_MEM.read_text())

    positions = state.get("positions", {})
    # state.positions keys are LP-position addresses (Meteora LP NFTs), not pool addresses.
    # Pool address is in each pos as `p["pool"]`. We need to fan-out by pool.
    pool_positions = defaultdict(list)
    for lp_addr, p in positions.items():
        pool_addr = p.get("pool")
        if pool_addr:
            pool_positions[pool_addr].append(p)

    filled = 0
    by_field = defaultdict(int)
    by_pool = defaultdict(int)

    for pool_addr, val in pm.items():
        pool_name = val.get("name", pool_addr[:8])
        s_positions = pool_positions.get(pool_addr, [])
        if not s_positions:
            continue

        for d in val.get("deploys", []):
            deployed_at = d.get("deployed_at")
            closed_at = d.get("closed_at")
            dep_dt = parse_dt(deployed_at)
            cls_dt = parse_dt(closed_at)

            # Primary match: deployed_at within ±15 min
            best = None
            best_dt = None
            for sp in s_positions:
                sp_dep_dt = parse_dt(sp.get("deployed_at"))
                if dep_dt and sp_dep_dt:
                    dt = abs(sp_dep_dt - dep_dt)
                    if best_dt is None or dt < best_dt:
                        best_dt = dt
                        best = sp
            # Fallback: closed_at within ±5 min
            if best is None and cls_dt:
                for sp in s_positions:
                    sp_cls_dt = parse_dt(sp.get("closed_at"))
                    if sp_cls_dt:
                        dt = abs(sp_cls_dt - cls_dt)
                        if dt.total_seconds() <= 300:
                            best = sp
                            break

            if best is None or (best_dt and best_dt.total_seconds() > 900):
                continue

            cm = best.get("close_metrics") or {}

            # Fill missing fields from close_metrics
            pairs = [
                ("initial_value_sol", cm.get("initial_value_sol"), 8),
                ("initial_value_usd", cm.get("initial_value_usd"), 4),
                ("pnl_usd", cm.get("pnl_usd"), 4),
                ("pnl_pct", cm.get("pnl_pct"), 4),
            ]
            for fname, val2, prec in pairs:
                if (d.get(fname) is None or d.get(fname) == 0) and val2:
                    d[fname] = round(val2, prec)
                    by_field[fname] += 1
                    filled += 1

            # Bin range
            br = best.get("bin_range", {})
            if br.get("min") is not None and d.get("lower_bin_id") is None:
                d["lower_bin_id"] = br["min"]
                d["upper_bin_id"] = br["max"]
                by_field["bin_range"] += 1
                filled += 1
            if best.get("active_bin_at_deploy") is not None and d.get("pool_active_bin_id_at_deploy") is None:
                d["pool_active_bin_id_at_deploy"] = best["active_bin_at_deploy"]
                by_field["active_bin"] += 1
                filled += 1
            if best.get("bin_step") is not None and d.get("bin_step") is None:
                d["bin_step"] = best["bin_step"]
                by_field["bin_step"] += 1
                filled += 1
            if best.get("volatility") is not None and d.get("volatility_at_deploy") is None:
                d["volatility_at_deploy"] = best["volatility"]
                by_field["volatility_at_deploy"] += 1
                filled += 1
            if best.get("entry_mcap") is not None and d.get("entry_mcap") is None:
                d["entry_mcap"] = best["entry_mcap"]
                by_field["entry_mcap"] += 1
                filled += 1
            if best.get("entry_tvl") is not None and d.get("entry_tvl") is None:
                d["entry_tvl"] = best["entry_tvl"]
                by_field["entry_tvl"] += 1
                filled += 1
            if best.get("entry_volume") is not None and d.get("entry_volume") is None:
                d["entry_volume"] = best["entry_volume"]
                by_field["entry_volume"] += 1
                filled += 1
            # Also pull deployed_at if pool-memory missing it
            if d.get("deployed_at") is None and best.get("deployed_at"):
                d["deployed_at"] = best["deployed_at"]
                by_field["deployed_at"] += 1
                filled += 1

            by_pool[pool_name] += 1

    POOL_MEM.write_text(json.dumps(pm, indent=2))

    print(f"\nstate.json → pool-memory.json cross-backfill:")
    print(f"  Total fields filled: {filled}")
    print(f"  Per-field breakdown:")
    for f, n in sorted(by_field.items(), key=lambda x: -x[1]):
        print(f"    {f}: {n}")
    print(f"  Pools enriched: {len(by_pool)}")


if __name__ == "__main__":
    main()
