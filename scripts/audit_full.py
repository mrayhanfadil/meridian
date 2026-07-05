#!/usr/bin/env python3
"""
Comprehensive Meridian audit — combines every close metric captured by:
  1. The 2026-07-05 detailed-logging patch (new closes have wallet_sol_after, trough, slip, gas)
  2. The 2026-07-05 Meteora datapi backfill (504 historical closes enriched with pnl_sol, pnl_pct, sol_usd)

Reads state.json and prints:
  1. Coverage summary
  2. Aggregate PnL (in SOL + USD using accurate backfilled SOL price)
  3. Win rate + avg win/loss
  4. Rug-vs-non-rug split
  5. Slippage distribution (where available)
  6. Intra-trade drawdown (trough) — only post-patch closes
  7. Deploy-side metrics (entry_slippage, entry_gas)
  8. PnL by close-reason category
  9. Last 25 closes full table
"""

import json
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
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


def categorize_reason(reason):
    """Categorize from notes[] (older closes) or close_reason (newer)."""
    s = ""
    if isinstance(reason, list):
        # older format: notes is a list
        s = " ".join(reason).lower()
    elif reason:
        s = str(reason).lower()
    if "stop loss" in s:
        return "SL"
    if "trailing tp" in s:
        return "TRAILING_TP"
    if "pumped far above" in s:
        return "RUG"
    if "out of range" in s:
        return "OOR"
    if "low yield" in s:
        return "LOW_YIELD"
    if "agent decision" in s:
        return "AGENT"
    if "profit target" in s:
        return "PROFIT_TARGET"
    if "state sync" in s or "not found" in s:
        return "STATE_SYNC"
    if "manually" in s or "manual" in s:
        return "MANUAL"
    return "OTHER"


def main():
    state = load_state()
    positions = state.get("positions", {}) or {}
    closed = [p for p in positions.values() if p.get("closed")]
    open_pos = [p for p in positions.values() if not p.get("closed")]

    with_metrics = [p for p in closed if p.get("close_metrics")]
    without_metrics = [p for p in closed if not p.get("close_metrics")]

    print(f"=== Meridian Comprehensive Audit ({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}) ===\n")
    print(f"Open positions: {len(open_pos)}")
    print(f"Closed positions: {len(closed)}")
    print(f"With close_metrics:    {len(with_metrics)} ({len(with_metrics) / max(1, len(closed)) * 100:.1f}%)")
    print(f"Without close_metrics: {len(without_metrics)} (older notes-only closes)")
    by_source = Counter(p["close_metrics"].get("source", "unknown") for p in with_metrics)
    print(f"\n  by source:")
    for src, n in by_source.most_common():
        print(f"    {src:25s} {n:>4}")

    # ─── 2. AGGREGATE PnL ───────────────────────────────────────
    print(f"\n[2] AGGREGATE PnL (closes with metrics)")
    total_pnl_sol = 0.0
    total_pnl_usd = 0.0
    pnl_pcts = []
    wins, losses = [], []
    rug_wins, rug_losses = [], []
    non_rug_wins, non_rug_losses = [], []

    for p in with_metrics:
        cm = p["close_metrics"]
        pnl_sol = cm.get("pnl_sol") or 0
        pnl_usd = cm.get("pnl_usd") or 0
        pnl_pct = cm.get("pnl_pct")
        total_pnl_sol += pnl_sol
        total_pnl_usd += pnl_usd
        if pnl_pct is not None:
            pnl_pcts.append(pnl_pct)
            cat = categorize_reason(p.get("notes") or p.get("close_reason"))
            if pnl_pct > 0:
                wins.append(pnl_pct)
                if cat == "RUG":
                    rug_wins.append(pnl_pct)
                else:
                    non_rug_wins.append(pnl_pct)
            else:
                losses.append(pnl_pct)
                if cat == "RUG":
                    rug_losses.append(pnl_pct)
                else:
                    non_rug_losses.append(pnl_pct)

    avg_sol_close = SOL_PRICE_MEAN if SOL_PRICE_MEAN else 150
    print(f"  Total pnl_sol:        {total_pnl_sol:+.4f} SOL (${total_pnl_sol * avg_sol_close:+.2f})")
    print(f"  Total pnl_usd:        {total_pnl_usd:+.2f} USD")
    if pnl_pcts:
        wr = len(wins) / len(pnl_pcts) * 100
        print(f"  Avg PnL%:             {sum(pnl_pcts) / len(pnl_pcts):+.2f}%")
        print(f"  Win rate:             {wr:.1f}% ({len(wins)}W / {len(losses)}L)")
        if wins:
            print(f"    Avg win:            {sum(wins) / len(wins):+.2f}%")
        if losses:
            print(f"    Avg loss:           {sum(losses) / len(losses):+.2f}%")
        if rug_wins or rug_losses:
            rwr = len(rug_wins) / max(1, len(rug_wins) + len(rug_losses)) * 100
            print(f"  Rug-close WR:         {rwr:.1f}% ({len(rug_wins)}W / {len(rug_losses)}L)")
            if rug_wins:
                print(f"    Avg rug win:        {sum(rug_wins) / len(rug_wins):+.2f}%")
            if rug_losses:
                print(f"    Avg rug loss:       {sum(rug_losses) / len(rug_losses):+.2f}%")
        if non_rug_wins or non_rug_losses:
            nwr = len(non_rug_wins) / max(1, len(non_rug_wins) + len(non_rug_losses)) * 100
            print(f"  Non-rug WR:           {nwr:.1f}% ({len(non_rug_wins)}W / {len(non_rug_losses)}L)")

    # ─── 3. By category ──────────────────────────────────────────
    print(f"\n[3] PnL BY CLOSE-REASON CATEGORY")
    cat_data = defaultdict(lambda: {'count': 0, 'pnl_sol': 0.0, 'pct_list': [], 'wins': 0, 'losses': 0})
    for p in with_metrics:
        cm = p["close_metrics"]
        cat = categorize_reason(p.get("notes") or p.get("close_reason"))
        d = cat_data[cat]
        d['count'] += 1
        d['pnl_sol'] += cm.get("pnl_sol") or 0
        pct = cm.get("pnl_pct")
        if pct is not None:
            d['pct_list'].append(pct)
            if pct > 0:
                d['wins'] += 1
            elif pct < 0:
                d['losses'] += 1

    print(f"  {'Category':<14} {'N':>4} {'WR%':>6} {'Avg%':>7} {'SumSOL':>10} {'SumUSD':>10}")
    for cat, d in sorted(cat_data.items(), key=lambda x: -x[1]['count']):
        n = d['count']
        wr = (d['wins'] / n * 100) if n else 0
        avg = sum(d['pct_list']) / len(d['pct_list']) if d['pct_list'] else 0
        sum_sol = d['pnl_sol']
        sum_usd = sum_sol * avg_sol_close
        print(f"  {cat:<14} {n:>4} {wr:>5.1f}% {avg:>+6.2f}% {sum_sol:>+10.4f} ${sum_usd:>+9.2f}")

    # ─── 4. Slippage (close-side, only post-patch) ───────────────
    print(f"\n[4] CLOSE-SIDE SLIPPAGE (only post-patch closes)")
    slips = [
        p["close_metrics"].get("slippage_pct")
        for p in with_metrics
        if p["close_metrics"].get("slippage_pct") is not None
    ]
    if slips:
        slips_sorted = sorted(slips)
        n = len(slips_sorted)
        med = slips_sorted[n // 2]
        mean = sum(slips) / n
        print(f"  n={n}  min={slips_sorted[0]:+.2f}%  median={med:+.2f}%  max={slips_sorted[-1]:+.2f}%  mean={mean:+.2f}%")

    # ─── 5. Intra-trade drawdown (only post-patch closes) ────────
    print(f"\n[5] INTRA-TRADE DRAWDOWN (trough_pnl_pct — only post-patch closes)")
    troughs = [
        (p["close_metrics"]["trough_pnl_pct"], p["close_metrics"].get("pnl_pct"))
        for p in with_metrics
        if p["close_metrics"].get("trough_pnl_pct") is not None
    ]
    if troughs:
        drawn = [t for t, _ in troughs if t < 0]
        if drawn:
            print(f"  Trades with drawdown: {len(drawn)}/{len(with_metrics)}")
            print(f"    trough: mean {sum(drawn) / len(drawn):+.2f}%  deepest {min(drawn):+.2f}%")
        # "Dipped to -X% but recovered" — KEY question for SL tightening
        dipped_but_won = [(t, c) for t, c in troughs if t <= -3 and c is not None and c > 0]
        if dipped_but_won:
            print(f"\n  KEY: dipped ≤ -3% then closed positive: {len(dipped_but_won)} trades")
            for t, c in sorted(dipped_but_won, key=lambda x: x[0])[:5]:
                print(f"    trough={t:+.2f}% close={c:+.2f}%")
    else:
        print(f"  No trough data yet (new patch — only fires on post-patch closes with drawdown)")

    # ─── 6. Deploy-side metrics ──────────────────────────────────
    print(f"\n[6] DEPLOY-SIDE METRICS")
    entry_slips = [p.get("entry_slippage_pct") for p in closed if p.get("entry_slippage_pct") is not None]
    entry_gases = [p.get("entry_gas_sol") for p in closed if p.get("entry_gas_sol") is not None]
    print(f"  Deploys with entry_slippage_pct: {len(entry_slips)}/{len(closed)}")
    if entry_slips:
        print(f"    mean {sum(entry_slips) / len(entry_slips):+.2f}%  max {max(entry_slips):+.2f}%")
    print(f"  Deploys with entry_gas_sol:      {len(entry_gases)}/{len(closed)}")
    if entry_gases:
        total_gas = sum(entry_gases)
        print(f"    mean {total_gas / len(entry_gases):.6f} SOL  total {total_gas:.6f} SOL")

    # ─── 7. Rug signature analysis ───────────────────────────────
    print(f"\n[7] RUG CLOSE SIGNATURE")
    rug_closes = [p for p in with_metrics if categorize_reason(p.get("notes") or p.get("close_reason")) == "RUG"]
    if rug_closes:
        rug_pnl_sol = sum(p["close_metrics"].get("pnl_sol") or 0 for p in rug_closes)
        rug_pnl_usd = sum(p["close_metrics"].get("pnl_usd") or 0 for p in rug_closes)
        rug_pct = [p["close_metrics"].get("pnl_pct") for p in rug_closes if p["close_metrics"].get("pnl_pct") is not None]
        print(f"  Total rug closes: {len(rug_closes)}")
        print(f"  Rug PnL total:    {rug_pnl_sol:+.4f} SOL (${rug_pnl_usd:+.2f})")
        if rug_pct:
            print(f"  Rug PnL% mean:    {sum(rug_pct) / len(rug_pct):+.2f}%")
            print(f"  Rug PnL% max:     {max(rug_pct):+.2f}%")
            print(f"  Rug PnL% min:     {min(rug_pct):+.2f}%")
        rug_oor = [p for p in rug_closes if p["close_metrics"].get("is_out_of_range")]
        print(f"  Rugs where is_out_of_range=true: {len(rug_oor)}/{len(rug_closes)}")
        # Rug signature: high bin_distance = price crashed well below our lower bin
        bin_dists = []
        for p in rug_closes:
            cm = p["close_metrics"]
            lb, ub, ab = cm.get("lower_bin_id"), cm.get("upper_bin_id"), cm.get("pool_active_bin_id")
            if lb is not None and ab is not None:
                bin_dists.append(ab - lb)  # active bin position relative to lower
        if bin_dists:
            print(f"  Active bin offset from lower_bin: mean {sum(bin_dists) / len(bin_dists):+.1f} bins")

    # ─── 8. Last 25 closes full table ────────────────────────────
    print(f"\n[8] LAST 25 CLOSES (full metrics)")
    print(f"{'#':>3} {'Token':<22} {'Closed':<16} {'PnL%':<7} {'PnL_SOL':<9} {'Slip%':<7} "
          f"{'Peak':<6} {'Trough':<7} {'Cat':<14} {'Source':<20}")
    print("-" * 130)
    with_metrics.sort(key=lambda p: p.get("closed_at") or "", reverse=True)
    for i, p in enumerate(with_metrics[:25], 1):
        cm = p["close_metrics"]
        sym = (p.get("pool_name") or "?")[:22]
        closed_at = (p.get("closed_at") or "")[:16].replace("T", " ")
        pnl_pct = cm.get("pnl_pct")
        pnl_sol = cm.get("pnl_sol")
        slip = cm.get("slippage_pct")
        peak = cm.get("peak_pnl_pct")
        trough = cm.get("trough_pnl_pct")
        cat = categorize_reason(p.get("notes") or p.get("close_reason"))
        src = cm.get("source", "unknown")[:20]
        pnl_s = f"{pnl_pct:+.2f}" if pnl_pct is not None else "n/a"
        psol_s = f"{pnl_sol:+.4f}" if pnl_sol is not None else "n/a"
        slip_s = f"{slip:+.2f}" if slip is not None else "n/a"
        peak_s = f"{peak:+.1f}" if peak is not None else "n/a"
        trough_s = f"{trough:+.2f}" if trough is not None else "n/a"
        print(f"{i:>3} {sym:<22} {closed_at:<16} {pnl_s:<7} {psol_s:<9} {slip_s:<7} "
              f"{peak_s:<6} {trough_s:<7} {cat:<14} {src:<20}")


if __name__ == "__main__":
    # Compute mean SOL price from backfilled data for accurate USD totals
    try:
        with open(STATE_PATH) as f:
            _s = json.load(f)
        prices = [p.get("close_metrics", {}).get("sol_usd_at_close") for p in _s.get("positions", {}).values()]
        prices = [x for x in prices if x]
        SOL_PRICE_MEAN = sum(prices) / len(prices) if prices else 150
    except Exception:
        SOL_PRICE_MEAN = 150

    try:
        main()
    except FileNotFoundError:
        print(f"state.json not found at {STATE_PATH}")
        sys.exit(1)