#!/usr/bin/env python3
"""
Meridian Daily Dashboard
Sends a single Telegram summary each day with:
  - Yesterday's PnL (closes, wins, losses, WR%, total $)
  - Rolling 7-day stats (sum, mean, days profitable)
  - Big picture: total cumulative PnL, open positions, wallet balance
  - Top 3 winners / worst 3 losers from yesterday
  - 1-line interpretation (heuristic based on close count and WR)

Runs via cron. No LLM, no autonomous decisions — just data → markdown → Telegram.
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path("/home/fadil/projects/meridian")
LOGS = REPO / "logs"
STATE = REPO / "state.json"
TELEGRAM_TOKEN_FILE = REPO / ".env"

# ── Telegram send via Bot API (independent of telegram.js so this works even if PM2 is down) ──

def load_env():
    """Minimal .env loader for TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID."""
    env = {}
    if not TELEGRAM_TOKEN_FILE.exists():
        return env
    for line in TELEGRAM_TOKEN_FILE.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def send_telegram(text: str) -> bool:
    import urllib.request
    import urllib.parse
    env = load_env()
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        print("telegram: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID", file=sys.stderr)
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    # Telegram hard cap is 4096 chars; safety split at 3500
    chunks = []
    while len(text) > 3500:
        # try to split on newline
        cut = text.rfind("\n", 0, 3500)
        if cut < 1000:
            cut = 3500
        chunks.append(text[:cut])
        text = text[cut:]
    chunks.append(text)
    for chunk in chunks:
        data = urllib.parse.urlencode({
            "chat_id": chat_id,
            "text": chunk,
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        }).encode()
        req = urllib.request.Request(url, data=data, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status != 200:
                    print(f"telegram: status {resp.status}", file=sys.stderr)
                    return False
        except Exception as e:
            print(f"telegram: {e}", file=sys.stderr)
            return False
    return True


# ── Data loading ────────────────────────────────────────────────────────────

def load_closes():
    """Return list of {date, pnl_pct, pnl_usd, reason, pool, source} for all closes.

    Source priority (Tier 1.7, July 5 2026):
      1. onchain_postclose_backfill_2026_07_05 → ground-truth SOL delta
      2. onchain_fallback                          → live Tier 1.7 fallback
      3. meteora_api                                → original Meteora API path
    PnL value in USD when available, else 0 — but `onchain_pnl_sol` always set.
    """
    out = []
    if not LOGS.exists():
        return out
    for fn in sorted(LOGS.iterdir()):
        if not fn.name.startswith("actions-") or not fn.name.endswith(".jsonl"):
            continue
        date = fn.name.replace("actions-", "").replace(".jsonl", "")
        for line in fn.read_text().splitlines():
            try:
                a = json.loads(line)
            except Exception:
                continue
            tool = a.get("tool") or a.get("action") or a.get("type") or ""
            if tool != "close_position":
                continue
            r = a.get("result")
            if not isinstance(r, dict):
                continue
            # USD preferred when solMode off, SOL otherwise. Always emit USD.
            # Use captured sol_usd_at_close first (live price), fall back to 150.
            sol_usd = r.get("sol_usd_at_close") or 150
            if r.get("pnl_usd"):
                pnl_usd = float(r["pnl_usd"])
            elif r.get("pnl_sol") is not None:
                pnl_usd = float(r["pnl_sol"]) * sol_usd
            else:
                pnl_usd = 0.0
            out.append({
                "date": date,
                "pnl_pct": r.get("pnl_pct") or 0,
                "pnl_usd": pnl_usd,
                "pnl_sol": r.get("pnl_sol"),
                "reason": (a.get("args") or {}).get("reason", ""),
                "pool": r.get("pool_name", ""),
                "source": r.get("source", "meteora_api"),
            })
    return out


# ── SOL price lookup for backfill records ─────────────────────────────────────

def get_sol_usd_at_close(close_at_iso):
    """Get SOL/USD price as close to close_at as possible. Falls back to latest
    captured price (from walletUsdAfter / walletSolAfter ratios) or 150."""
    # Try resolve via state.json close_metrics (closest valid sample)
    if not STATE.exists(): return 80.0
    try:
        s = json.loads(STATE.read_text())
    except: return 80.0
    try:
        target = datetime.fromisoformat(close_at_iso.replace("Z", "+00:00"))
    except: return 80.0
    # Search all positions for the nearest sol_usd_at_close sample
    best = None
    best_diff = float('inf')
    for p in s.get("positions", {}).values():
        if not isinstance(p, dict): continue
        cm = p.get("close_metrics") or {}
        cs = p.get("closed_at") or ""
        if not cm.get("sol_usd_at_close") or not cs: continue
        try: d = datetime.fromisoformat(cs.replace("Z","+00:00"))
        except: continue
        diff = abs((target - d).total_seconds())
        if diff < best_diff:
            best_diff = diff
            best = float(cm["sol_usd_at_close"])
    return best or 80.0


def load_state_backfilled_closes(target_date):
    """Close-level reconcile via state.json close_metrics — picks up backfilled
    records that the live action log missed (e.g. silent 0/0 closes from
    earlier days where Tier 1.7 fallback was offline)."""
    if not STATE.exists():
        return []
    try:
        s = json.loads(STATE.read_text())
    except Exception:
        return []
    out = []
    day_start = int(datetime.fromisoformat(target_date + "T00:00:00+00:00").timestamp())
    day_end = day_start + 86400
    for addr, p in s.get("positions", {}).items():
        if not isinstance(p, dict) or not p.get("closed"): continue
        cm = p.get("close_metrics") or {}
        cs = p.get("closed_at") or p.get("closedAt") or ""
        try: ct = datetime.fromisoformat(cs.replace("Z", "+00:00"))
        except: continue
        if not (day_start <= ct.timestamp() < day_end): continue
        # Only count ONCHAIN truth sources (not the silent 0/0 meteora_api ones)
        src = cm.get("source", "")
        if src != "onchain_postclose_backfill_2026_07_05":
            continue
        # Convert pnl_sol → pnl_usd using the live SOL price captured at that close
        pnl_sol = float(cm.get("pnl_sol") or 0)
        sol_usd = float(cm.get("sol_usd_at_close") or get_sol_usd_at_close(cs))
        out.append({
            "date": target_date,
            "pnl_pct": cm.get("pnl_pct") or 0,
            "pnl_usd": pnl_sol * sol_usd,
            "pnl_sol": pnl_sol,
            "sol_usd_at_close": sol_usd,
            "reason": "onchain backfill",
            "pool": p.get("pool_name", "?"),
            "source": src,
        })
    return out


def daily_summary(closes, target_date):
    rows = [c for c in closes if c["date"] == target_date]
    n = len(rows)
    wins = sum(1 for r in rows if r["pnl_pct"] > 0)
    losses = n - wins
    total = sum(r["pnl_usd"] for r in rows)
    wr = (wins / n * 100) if n else 0
    avg = (total / n) if n else 0
    best = max((r for r in rows), key=lambda x: x["pnl_usd"], default=None)
    worst = min((r for r in rows), key=lambda x: x["pnl_usd"], default=None)
    return {
        "n": n, "wins": wins, "losses": losses, "wr": wr,
        "total": total, "avg": avg, "best": best, "worst": worst,
        "rows": rows,
    }


def ghost_positions():
    """Return list of currently-open positions with deployed SOL value."""
    if not STATE.exists(): return []
    try: s = json.loads(STATE.read_text())
    except: return []
    out = []
    for addr, p in s.get("positions", {}).items():
        if isinstance(p, dict) and not p.get("closed"):
            deployed = p.get("amount_sol") or 0
            out.append({
                "address": addr[:12] + "...",
                "pool": p.get("pool_name", "?"),
                "deployed_sol": deployed,
                "deployed_at": p.get("deployed_at", "?"),
                "peak_pnl_pct": p.get("peak_pnl_pct"),
            })
    return out


def rolling_summary(closes, target_date, window=7):
    cutoff = (datetime.fromisoformat(target_date) - timedelta(days=window - 1)).date().isoformat()
    rows = [c for c in closes if c["date"] >= cutoff and c["date"] <= target_date]
    n = len(rows)
    wins = sum(1 for r in rows if r["pnl_pct"] > 0)
    total = sum(r["pnl_usd"] for r in rows)
    # daily breakdown
    daily = defaultdict(lambda: {"n": 0, "pnl": 0.0})
    for r in rows:
        daily[r["date"]]["n"] += 1
        daily[r["date"]]["pnl"] += r["pnl_usd"]
    profitable_days = sum(1 for d in daily.values() if d["pnl"] > 0)
    return {
        "n": n, "wins": wins, "wr": (wins / n * 100) if n else 0,
        "total": total, "daily": dict(daily),
        "profitable_days": profitable_days,
        "days_in_window": len(daily),
    }


def open_positions():
    if not STATE.exists():
        return []
    try:
        s = json.loads(STATE.read_text())
    except Exception:
        return []
    out = []
    for addr, p in s.get("positions", {}).items():
        if isinstance(p, dict) and not p.get("closed"):
            out.append({
                "address": addr[:12] + "...",
                "pool": p.get("pool_name") or "?",
                "deployed_at": p.get("deployed_at", "?"),
                "peak_pnl_pct": p.get("peak_pnl_pct"),
                "pnl_pct": p.get("pnl_pct"),
            })
    return out


def wallet_balance():
    """Latest wallet SOL balance from action logs."""
    last = None
    if not LOGS.exists():
        return None
    for fn in sorted(LOGS.iterdir()):
        if not fn.name.startswith("actions-") or not fn.name.endswith(".jsonl"):
            continue
        for line in fn.read_text().splitlines():
            try:
                a = json.loads(line)
            except Exception:
                continue
            if (a.get("tool") or "") == "get_wallet_balance":
                r = a.get("result")
                if isinstance(r, dict) and "sol" in r:
                    last = (a.get("timestamp", ""), float(r["sol"]))
    return last


# ── Formatting ───────────────────────────────────────────────────────────────

def fmt_money(v):
    sign = "+" if v >= 0 else ""
    return f"{sign}${v:.2f}"


def fmt_pct(v):
    sign = "+" if v >= 0 else ""
    return f"{sign}{v:.2f}%"


def interpret(yest, rolling):
    """One-line qualitative read on yesterday's performance."""
    if yest["n"] == 0:
        return "no closes yesterday — bot idle or all positions still open"
    if yest["wr"] >= 60 and yest["total"] > 0:
        return "✅ profitable day, WR above 60%"
    if yest["wr"] < 40 and yest["total"] < 0:
        return "⚠️ losing day with low WR — consider whether config needs review"
    if yest["total"] > 0:
        return "→ small win, recovery in progress"
    if yest["total"] < 0:
        return "→ small loss, no panic needed yet"
    return "→ flat"


def render(target_date):
    closes = load_closes()
    # Reconcile by overlaying state.json backfilled closes (Tier 1.7+dedicated entries).
    # The backfill only counts source=='onchain_postclose_backfill_2026_07_05', which is
    # for records the action log silently zeroed on the same day. We extend (not replace)
    # so other action-log entries from the same day still count.
    backfilled = load_state_backfilled_closes(target_date)
    closes.extend(backfilled)

    yest = daily_summary(closes, target_date)
    roll = rolling_summary(closes, target_date)
    ghosts = ghost_positions()
    wallet = wallet_balance()

    # All-time PnL
    all_pnl = sum(c["pnl_usd"] for c in closes)

    lines = []
    lines.append(f"<b>📊 Meridian Daily Dashboard — {target_date} UTC</b>")
    lines.append("")

    # Yesterday
    if yest["n"] == 0:
        lines.append("<b>Yesterday</b>: no closes")
    else:
        # Source breakdown
        sources = defaultdict(int)
        sources_pnl = defaultdict(float)
        for r in yest["rows"]:
            sources[r["source"]] += 1
            sources_pnl[r["source"]] += r["pnl_usd"]
        src_parts = [f"{k}: {sources[k]} (${sources_pnl[k]:+.2f})" for k in sources]
        lines.append(
            f"<b>Yesterday</b>: <code>{yest['n']}</code> closes, "
            f"<code>{yest['wins']}W / {yest['losses']}L</code> "
            f"({yest['wr']:.0f}% WR) → <code>{fmt_money(yest['total'])}</code>"
        )
        if yest.get("best"):
            b = yest["best"]
            lines.append(
                f"  best: <code>{b['pool']}</code> {fmt_money(b['pnl_usd'])} "
                f"({fmt_pct(b['pnl_pct'])})"
            )
        if yest.get("worst") and yest["worst"]["pnl_usd"] != (yest["best"] or {}).get("pnl_usd", 0):
            w = yest["worst"]
            lines.append(
                f"  worst: <code>{w['pool']}</code> <code>{fmt_money(w['pnl_usd'])}</code> "
                f"({fmt_pct(w['pnl_pct'])})"
            )
        # Source breakdown line
        if len(src_parts) > 1 or (src_parts and "meteora_api" not in src_parts[0]):
            lines.append(f"  source: {', '.join(src_parts)}")

    # Ghost positions (open at EOD)
    if ghosts:
        # Use the most recent sol_usd_at_close as the live price reference
        sol_usd_live = 80.0  # fallback
        if STATE.exists():
            try:
                s = json.loads(STATE.read_text())
                for p in s.get("positions", {}).values():
                    if isinstance(p, dict):
                        cm = p.get("close_metrics") or {}
                        if cm.get("sol_usd_at_close"):
                            sol_usd_live = float(cm["sol_usd_at_close"])
                            break
            except: pass
        total_locked = sum(g["deployed_sol"] for g in ghosts)
        lines.append("")
        lines.append(f"<b>Open (locked)</b>: <code>{len(ghosts)}</code>  [{total_locked:.2f} SOL locked, ~${total_locked*sol_usd_live:.0f} @ ${sol_usd_live:.2f}/SOL]")
        for g in ghosts[:5]:
            peak = g.get("peak_pnl_pct")
            peak_str = f"peak {fmt_pct(peak)}" if peak is not None else "peak —"
            lines.append(f"  • <code>{g['pool']}</code> ({g['deployed_sol']:.2f} SOL, {peak_str})")

    # Rolling 7-day
    lines.append("")
    lines.append(
        f"<b>Rolling 7d</b>: <code>{roll['n']}</code> closes, "
        f"{roll['wins']}W / {roll['n'] - roll['wins']}L "
        f"({roll['wr']:.0f}% WR) → <code>{fmt_money(roll['total'])}</code>"
    )
    if roll["days_in_window"] > 0:
        lines.append(
            f"  profitable days: <code>{roll['profitable_days']}/{roll['days_in_window']}</code>"
        )

    # All-time
    lines.append("")
    lines.append(f"<b>Cumulative</b>: <code>{fmt_money(all_pnl)}</code>")

    # (Open positions section replaced by ghost section above)

    # Wallet
    if wallet:
        ts, bal = wallet
        lines.append("")
        lines.append(f"<b>Wallet</b>: <code>{bal:.3f} SOL</code> (last sample: {ts[:16]})")

    # Interpretation
    lines.append("")
    lines.append(f"<b>Read</b>: {interpret(yest, roll)}")

    msg = "\n".join(lines)
    return msg


# ── Entry ────────────────────────────────────────────────────────────────────

def main():
    # Date = yesterday UTC by default (so 8:00 WIB sees yesterday's stats)
    if len(sys.argv) > 1:
        target = sys.argv[1]
    else:
        target = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()

    msg = render(target)
    print(msg)
    if "--dry-run" in sys.argv:
        return
    if not send_telegram(msg):
        print("FAILED to send telegram", file=sys.stderr)
        sys.exit(1)
    print(f"\n→ sent to telegram (target={target})")


if __name__ == "__main__":
    main()
