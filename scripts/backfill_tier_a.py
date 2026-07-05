#!/usr/bin/env python3
"""
Tier A: Final fees_sol backfill.

Uses Binance SOL/USDT daily closes (scripts/sol_prices.json) for the 20
deploys that have fees_earned_usd but no sol_usd_at_close recorded.

For each missing deploy, looks up SOL/USD on the close-date (UTC) and
computes fees_earned_sol = fees_earned_usd / sol_usd_at_close.

Idempotent: re-running on already-filled deploys is a no-op.
"""
import json, sys
from pathlib import Path
from collections import Counter

ROOT = Path("/home/fadil/projects/meridian")
POOL_MEM = ROOT / "pool-memory.json"
PRICES = ROOT / "scripts" / "sol_prices.json"

def main():
    pm = json.loads(POOL_MEM.read_text())
    prices = json.loads(PRICES.read_text())

    backfilled = 0
    by_date = Counter()
    total_fees_sol = 0.0
    total_fees_usd = 0.0
    for pool_addr, val in pm.items():
        pool_name = val.get('name', pool_addr[:8])
        for d in val.get('deploys', []):
            if d.get('fees_earned_sol') is not None: continue
            fees_usd = d.get('fees_earned_usd')
            if not fees_usd or fees_usd <= 0: continue
            if d.get('sol_usd_at_close'): continue  # already has price
            closed_at = d.get('closed_at','')[:10]
            sol_usd = prices.get(closed_at)
            if not sol_usd:
                print(f"  ⚠️  no SOL price for {closed_at} (pool={pool_name})", file=sys.stderr)
                continue
            fees_sol = fees_usd / sol_usd
            d['fees_earned_sol'] = round(fees_sol, 8)
            d['sol_usd_at_close'] = sol_usd
            d['_backfill_notes'] = (
                f"tier-a-binance-daily-close {closed_at}: {fees_usd:.4f} USD / {sol_usd:.2f} SOL/USD"
            )
            backfilled += 1
            total_fees_sol += fees_sol
            total_fees_usd += fees_usd
            by_date[closed_at] += 1

    POOL_MEM.write_text(json.dumps(pm, indent=2))
    print(f"\nTier A: backfilled {backfilled} deploys")
    print(f"  +{total_fees_sol:.6f} SOL in fees (+${total_fees_usd:.2f} USD)")
    print(f"  by date:")
    for dt, cnt in sorted(by_date.items()):
        print(f"    {dt}: {cnt}")

if __name__ == '__main__':
    main()
