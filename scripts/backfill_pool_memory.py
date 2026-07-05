#!/usr/bin/env python3
"""Backfill pool-memory.json deploys with extra fields from state.json close_metrics.

Matching strategy:
  Primary: (pool_name, closed_at within 10s) — pool-memory timestamps are recorded
           with small drift vs state.json (typically 0-7s).
  Verification: pnl_pct within 0.05% (fuzzy match — pool-memory stores rounded pct,
           state.json has high precision).

Fields added per deploy record (from close_metrics):
  pnl_sol, pnl_pct_sol_native, initial_value_usd, initial_value_sol,
  final_value_usd, final_value_sol, fees_sol, fees_usd,
  sol_usd_at_close, sol_usd_at_entry,
  is_out_of_range, pool_active_bin_id, lower_bin_id, upper_bin_id,
  deployed_at_meteora, closed_at_meteora

Also backfilled:
  deployed_at (was always null in pool-memory) ← state.json deployed_at
  position (new field) ← state.json position address
"""
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state.json"
PM = ROOT / "pool-memory.json"

CM_FIELDS = [
    "pnl_sol",
    "pnl_pct_sol_native",
    "initial_value_usd",
    "initial_value_sol",
    "final_value_usd",
    "final_value_sol",
    "fees_sol",
    "fees_usd",
    "sol_usd_at_close",
    "sol_usd_at_entry",
    "is_out_of_range",
    "pool_active_bin_id",
    "lower_bin_id",
    "upper_bin_id",
    "deployed_at_meteora",
    "closed_at_meteora",
]

MATCH_TOLERANCE_SEC = 10.0  # pool-memory timestamps drift up to ~7s from state
PNL_PCT_TOLERANCE = 0.1  # pool-memory stores 2-decimal pct, state has high precision


def parse_iso(s):
    if not s:
        return None
    s = s.replace("+00:00", "Z").replace("Z", "")
    return datetime.fromisoformat(s)


def load_json(path):
    with open(path) as f:
        return json.load(f)


def save_json(path, data):
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    tmp.replace(path)


def main():
    state = load_json(STATE)
    pm = load_json(PM)

    # Index state closes by pool_name → list of (timestamp, pos)
    state_by_pool = {}
    for k, pos in state.get("positions", {}).items():
        if not pos.get("closed"):
            continue
        cm = pos.get("close_metrics")
        if not cm:
            continue
        pool_name = pos.get("pool_name")
        closed_at_str = pos.get("closed_at")
        if not pool_name or not closed_at_str:
            continue
        t = parse_iso(closed_at_str)
        if t is None:
            continue
        state_by_pool.setdefault(pool_name, []).append((t, pos, cm))

    # Sort each pool's closes by time for nearest-neighbor matching
    for pool_name in state_by_pool:
        state_by_pool[pool_name].sort(key=lambda x: x[0])

    matched = 0
    unmatched = 0
    fields_added = 0
    deploys_with_deployed_at = 0
    deploys_with_position = 0

    unmatched_samples = []

    for pool_addr, pool_data in pm.items():
        pool_name = pool_data.get("name")
        if pool_name not in state_by_pool:
            unmatched += sum(1 for _ in pool_data.get("deploys", []))
            unmatched_samples.append(f"{pool_name}: no state entries")
            continue

        for deploy in pool_data.get("deploys", []):
            closed_at_str = deploy.get("closed_at")
            pm_pct = deploy.get("pnl_pct")
            if not closed_at_str:
                unmatched += 1
                continue

            pm_t = parse_iso(closed_at_str)
            if pm_t is None:
                unmatched += 1
                continue

            # Find best state match: closest timestamp with matching pnl_pct
            best = None
            best_dt = 999999.0
            for s_t, s_pos, s_cm in state_by_pool[pool_name]:
                dt = abs((pm_t - s_t).total_seconds())
                if dt > MATCH_TOLERANCE_SEC:
                    continue
                if pm_pct is not None and s_cm.get("pnl_pct") is not None:
                    if abs(pm_pct - s_cm["pnl_pct"]) > PNL_PCT_TOLERANCE:
                        continue
                if dt < best_dt:
                    best_dt = dt
                    best = (s_pos, s_cm)

            if not best:
                unmatched += 1
                unmatched_samples.append(
                    f"{pool_name} @ {closed_at_str} pct={pm_pct}"
                )
                continue

            s_pos, s_cm = best

            # Backfill fields from close_metrics
            for f in CM_FIELDS:
                if f in s_cm and s_cm[f] is not None:
                    if deploy.get(f) is None:
                        deploy[f] = s_cm[f]
                        fields_added += 1

            # Backfill deployed_at
            if deploy.get("deployed_at") is None and s_pos.get("deployed_at"):
                deploy["deployed_at"] = s_pos["deployed_at"]
                deploys_with_deployed_at += 1

            # Add position address (new field on pool-memory deploys)
            if "position" not in deploy and s_pos.get("position"):
                deploy["position"] = s_pos["position"]
                deploys_with_position += 1

            matched += 1

    total_deploys = sum(len(v.get("deploys", [])) for v in pm.values())
    print(f"=== Backfill results ===")
    print(f"Total pool-memory deploys: {total_deploys}")
    print(f"Matched: {matched}")
    print(f"Unmatched: {unmatched}")
    print(f"Fields added: {fields_added}")
    print(f"deploys_with_deployed_at: {deploys_with_deployed_at}")
    print(f"deploys_with_position: {deploys_with_position}")
    if unmatched_samples:
        print(f"\nFirst 10 unmatched samples:")
        for s in unmatched_samples[:10]:
            print(f"  {s}")

    save_json(PM, pm)
    print(f"\nWrote {PM}")


if __name__ == "__main__":
    main()