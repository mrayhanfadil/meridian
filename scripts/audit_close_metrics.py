#!/usr/bin/env python3
"""
Audit close_metrics — read structured on-chain close data from state.json.

Use after the bot closes positions with the new detailed logging patch:
    python3 scripts/audit_close_metrics.py

Prints lifetime PnL split by source (meteora_api vs relay_fallback vs
local_fallback), reveals true slippage, and shows which categories of close
are silent vs logged.

Why this exists:
    Pre-patch: 98.5% of rug/OOR/agent-decision closes logged no PnL%, hiding
    slippage. Post-patch: every close writes a `close_metrics` block with
    pnl_sol, pnl_pct, initial_value_usd, final_value_usd, fees_usd,
    slippage_pct, source.
"""

import json
import sys
from datetime import datetime, timezone
from collections import Counter, defaultdict
from pathlib import Path

STATE_PATH = Path(__file__).resolve().parent.parent / "state.json"


def parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def load_state():
    with open(STATE_PATH) as f:
        return json.load(f)


def main():
    state = load_state()
    positions = state.get("positions", {}) or {}
    closed = [p for p in positions.values() if p.get("closed")]

    with_metrics = [p for p in closed if p.get("close_metrics")]
    without_metrics = [p for p in closed if not p.get("close_metrics")]

    print(f"=== Close-metrics audit ({STATE_PATH.name}) ===\n")
    print(f"Total closed positions:     {len(closed)}")
    print(f"With close_metrics:        {len(with_metrics)} ({len(with_metrics) / max(1, len(closed)) * 100:.1f}%)")
    print(f"Without close_metrics:     {len(without_metrics)} (older closes pre-patch)")

    if not with_metrics:
        print("\nNo close_metrics yet — wait for first post-patch close.")
        return

    # By source
    by_source = Counter(p["close_metrics"].get("source", "unknown") for p in with_metrics)
    print(f"\nBy source:")
    for src, n in by_source.most_common():
        print(f"  {src:20s}  {n:>4}")

    # Aggregate PnL
    total_pnl_sol = sum(p["close_metrics"].get("pnl_sol") or 0 for p in with_metrics)
    total_pnl_pct = [p["close_metrics"].get("pnl_pct") for p in with_metrics if p["close_metrics"].get("pnl_pct") is not None]
    print(f"\nAggregate PnL (logged closes): {total_pnl_sol:+.4f} SOL")

    if total_pnl_pct:
        avg = sum(total_pnl_pct) / len(total_pnl_pct)
        wins = sum(1 for x in total_pnl_pct if x > 0)
        losses = sum(1 for x in total_pnl_pct if x < 0)
        print(f"Avg PnL%: {avg:+.2f}%  | WR: {wins / len(total_pnl_pct) * 100:.1f}%  ({wins}W / {losses}L)")

    # Slippage distribution
    slips = [p["close_metrics"].get("slippage_pct") for p in with_metrics if p["close_metrics"].get("slippage_pct") is not None]
    if slips:
        slips_sorted = sorted(slips)
        print(f"\nSlippage distribution (n={len(slips)}):")
        print(f"  min={slips_sorted[0]:+.2f}%  median={slips_sorted[len(slips) // 2]:+.2f}%  max={slips_sorted[-1]:+.2f}%")
        pos_slip = [s for s in slips if s > 0]
        neg_slip = [s for s in slips if s < 0]
        if pos_slip:
            print(f"  positive slip (lost vs deposit): {len(pos_slip)} trades, mean {sum(pos_slip) / len(pos_slip):+.2f}%")
        if neg_slip:
            print(f"  negative slip (gained vs deposit): {len(neg_slip)} trades, mean {sum(neg_slip) / len(neg_slip):+.2f}%")

    # Last 20 closes with metrics
    with_metrics.sort(key=lambda p: p.get("closed_at") or "", reverse=True)
    print(f"\nLast 20 closes with metrics:")
    print(f"{'#':>3} {'Token':<22} {'Closed':<14} {'PnL_SOL':<10} {'PnL%':<8} {'Slip%':<8} {'Source':<14}")
    print("-" * 90)
    for i, p in enumerate(with_metrics[:20], 1):
        cm = p["close_metrics"]
        sym = (p.get("pool_name") or "?")[:22]
        closed_at = (p.get("closed_at") or "")[:16].replace("T", " ")
        pnl_sol = cm.get("pnl_sol")
        pnl_pct = cm.get("pnl_pct")
        slip = cm.get("slippage_pct")
        src = cm.get("source", "unknown")
        pnl_sol_s = f"{pnl_sol:+.4f}" if pnl_sol is not None else "n/a"
        pnl_pct_s = f"{pnl_pct:+.2f}" if pnl_pct is not None else "n/a"
        slip_s = f"{slip:+.2f}" if slip is not None else "n/a"
        print(f"{i:>3} {sym:<22} {closed_at:<14} {pnl_sol_s:<10} {pnl_pct_s:<8} {slip_s:<8} {src:<14}")

    # Daily trend (last 7 days)
    cutoff = datetime.now(timezone.utc).timestamp() - 7 * 86400
    recent = []
    for p in with_metrics:
        if not p.get("closed_at"):
            continue
        dt = parse_dt(p["closed_at"])
        if dt and dt.timestamp() > cutoff:
            recent.append(p)
    if recent:
        recent_pnl = sum(p["close_metrics"].get("pnl_sol") or 0 for p in recent)
        print(f"\nLast 7 days (post-patch, n={len(recent)}): net {recent_pnl:+.4f} SOL")


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError:
        print(f"state.json not found at {STATE_PATH}")
        sys.exit(1)