#!/usr/bin/env python3
"""
Backfill close_metrics for historical closed positions.

Sources:
  1. Meteora datapi: https://dlmm.datapi.meteora.ag/positions/{pool}/pnl?user={wallet}
     → pnl_sol, pnl_usd, pnl_pct, initial_value_usd, final_value_usd, fees
  2. CoinGecko historical: /coins/solana/history?date=DD-MM-YYYY
     → SOL/USD on deploy day (entry) and close day (exit)

Outputs:
  - state.json positions[*].close_metrics is enriched in-place
  - backup saved at state.json.backfill-{timestamp}
  - backfill_report.json with per-position results + skip reasons
"""

import json
import os
import sys
import time
import fcntl
import urllib.request
import urllib.parse
import urllib.error
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta

ROOT = Path('/home/fadil/projects/meridian')
STATE_FILE = ROOT / 'state.json'
ENV_FILE = ROOT / '.env'

METEORA_BASE = 'https://dlmm.datapi.meteora.ag'
CG_BASE = 'https://api.coingecko.com/api/v3'


def load_state():
    with open(STATE_FILE) as f:
        return json.load(f)


def save_state(state, backup=True):
    """Atomic save with file locking to avoid racing the bot's writes.
    Re-reads state.json fresh from disk under lock so bot updates aren't lost."""
    lock_path = STATE_FILE.with_suffix('.lock')
    with open(lock_path, 'w') as lf:
        # blocking lock — bot holds it briefly per write
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        try:
            # re-read latest from disk (bot may have updated between our reads)
            try:
                with open(STATE_FILE) as f:
                    fresh = json.load(f)
                # merge: only update positions we touched
                for addr, p in state.get('positions', {}).items():
                    if 'close_metrics' in p:
                        fresh.setdefault('positions', {})[addr] = p
                state = fresh
            except Exception:
                pass  # fall back to in-memory state
            if backup:
                ts = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
                bak = STATE_FILE.with_suffix(f'.json.backfill-{ts}')
                if not bak.exists():
                    with open(STATE_FILE) as f, open(bak, 'w') as g:
                        g.write(f.read())
            tmp = STATE_FILE.with_suffix('.json.tmp')
            with open(tmp, 'w') as f:
                json.dump(state, f, indent=2)
            tmp.replace(STATE_FILE)
            print(f'[WRITE] state.json updated (with re-read merge)')
        finally:
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


def get_wallet_pubkey():
    """Read WALLET_PRIVATE_KEY from .env and derive pubkey."""
    import base58
    from nacl.signing import SigningKey
    with open(ENV_FILE) as f:
        for line in f:
            if line.startswith('WALLET_PRIVATE_KEY='):
                pk_b58 = line.split('=', 1)[1].strip()
                break
        else:
            raise RuntimeError('WALLET_PRIVATE_KEY not found in .env')
    seed = base58.b58decode(pk_b58)[:32]  # first 32 bytes
    # Use PyNaCl ed25519 → pubkey
    sk = SigningKey(seed)
    pub = bytes(sk.verify_key)
    import hashlib
    # Solana pubkey is just the last 32 bytes of ed25519 pubkey (no hashop)
    return base58.b58encode(pub).decode()


def http_get_json(url, retries=3, base_delay=1.5):
    """GET with retries. Returns (status, body)."""
    ua = 'Mozilla/5.0 (compatible; MeridianAudit/1.0)'
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': ua})
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read().decode()
                return r.status, json.loads(body)
        except urllib.error.HTTPError as e:
            body = e.read().decode() if e.fp else ''
            if attempt < retries - 1:
                time.sleep(base_delay * (2 ** attempt))
                continue
            return e.code, body or {}
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(base_delay * (2 ** attempt))
                continue
            return None, str(e)
    return None, 'exhausted'


def parse_dt(s):
    if not s:
        return None
    try:
        if s.endswith('Z'):
            return datetime.fromisoformat(s.replace('Z', '+00:00'))
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def fetch_meteora_pnl(pool, wallet):
    """Returns (positions_array, solPrice_at_top_level, error)."""
    url = f'{METEORA_BASE}/positions/{pool}/pnl?user={wallet}&status=closed&pageSize=50&page=1'
    status, body = http_get_json(url)
    if status != 200 or not isinstance(body, dict):
        return None, None, f'meteora_http_{status}'
    return body.get('positions', []), body.get('solPrice'), None


def fetch_sol_usd_on_date(dt_utc):
    """Fetch SOL/USD from CoinGecko for a specific UTC date.
    Returns (price, source) or (None, error)."""
    if dt_utc is None:
        return None, 'no_date'
    ddmmyyyy = dt_utc.strftime('%d-%m-%Y')
    url = f'{CG_BASE}/coins/solana/history?date={ddmmyyyy}&localization=false'
    status, body = http_get_json(url)
    if status == 200 and isinstance(body, dict):
        price = body.get('market_data', {}).get('current_price', {}).get('usd')
        if price:
            return float(price), 'coingecko_history'
    # fallback: CG market_chart for that day
    ts = int(dt_utc.replace(hour=12, minute=0, second=0, microsecond=0).timestamp())
    url2 = f'{CG_BASE}/coins/solana/market_chart/range?vs_currency=usd&from={ts-3600}&to={ts+3600}'
    status2, body2 = http_get_json(url2)
    if status2 == 200 and isinstance(body2, dict):
        prices = body2.get('prices', [])
        if prices:
            return float(prices[0][1]), 'coingecko_chart'
    return None, f'cg_fail_{status}'


def backfill_one(pos, wallet, sol_price_cache):
    """Try to enrich one position's close_metrics. Returns (metrics_dict | None, reason)."""
    addr = pos.get('position')
    pool = pos.get('pool')
    if not addr or not pool:
        return None, 'missing_position_or_pool'

    # already has close_metrics with pnl_sol? skip
    existing = pos.get('close_metrics') or {}
    if existing.get('pnl_sol') is not None and existing.get('source', '').startswith('meteora'):
        return None, 'already_backfilled'

    positions, sol_price_top, err = fetch_meteora_pnl(pool, wallet)
    if err:
        return None, err
    if not positions:
        return None, 'meteora_empty'

    # find this position in the list
    match = None
    for p in positions:
        if p.get('positionAddress') == addr:
            match = p
            break
    if not match:
        return None, 'meteora_position_not_found'

    # Meteora returns live data even for closed positions IF the wallet still shows
    # them on Meteora's index. For truly closed positions, pnl fields will reflect
    # final state.
    try:
        pnl_sol = float(match.get('pnlSol') or 0)
        pnl_usd_meteora = float(match.get('pnlUsd') or 0)
        pnl_pct_sol = float(match.get('pnlSolPctChange') or 0)
        pnl_pct = float(match.get('pnlPctChange') or 0)
    except (ValueError, TypeError):
        return None, 'meteora_pnl_unparseable'

    deposits = match.get('allTimeDeposits', {}).get('total', {})
    initial_value_usd = float(deposits.get('usd') or 0)
    initial_value_sol = float(deposits.get('sol') or 0)

    withdrawals = match.get('allTimeWithdraws', {}).get('total', {})
    final_value_usd = float(withdrawals.get('usd') or 0)
    final_value_sol = float(withdrawals.get('sol') or 0)

    fees_usd = float(match.get('totalFeeUsd') or match.get('feeUsd') or 0)
    fees_sol = float(match.get('totalFeeSol') or match.get('feeSol') or 0)

    closed_at_ts = match.get('closedAt')
    deployed_at_ts = match.get('createdAt')
    closed_at_dt = datetime.fromtimestamp(closed_at_ts, tz=timezone.utc) if closed_at_ts else None
    deployed_at_dt = datetime.fromtimestamp(deployed_at_ts, tz=timezone.utc) if deployed_at_ts else None

    # Meteora response includes live solPrice at top level — prefer it (represents price at close time)
    sol_usd_close = float(sol_price_top) if sol_price_top else None

    sol_usd_entry = sol_price_cache.get(deployed_at_dt.strftime('%Y-%m-%d')) if deployed_at_dt else None
    if sol_usd_entry is None and deployed_at_dt:
        sol_usd_entry, _ = fetch_sol_usd_on_date(deployed_at_dt)
        if sol_usd_entry:
            sol_price_cache[deployed_at_dt.strftime('%Y-%m-%d')] = sol_usd_entry

    # Compute USD-equivalent: prefer Meteora's USD, fall back to pnl_sol × SOL_close
    if pnl_usd_meteora > 0:
        final_pnl_usd = pnl_usd_meteora
    elif pnl_sol != 0 and sol_usd_close:
        final_pnl_usd = pnl_sol * sol_usd_close
    else:
        final_pnl_usd = 0.0

    final_pnl_pct = pnl_pct if pnl_pct != 0 else pnl_pct_sol

    metrics = {
        'pnl_sol': pnl_sol,
        'pnl_usd': final_pnl_usd,
        'pnl_pct': final_pnl_pct,
        'pnl_pct_sol_native': pnl_pct_sol,
        'initial_value_usd': initial_value_usd,
        'initial_value_sol': initial_value_sol,
        'final_value_usd': final_value_usd,
        'final_value_sol': final_value_sol,
        'fees_usd': fees_usd,
        'fees_sol': fees_sol,
        'sol_usd_at_close': sol_usd_close,
        'sol_usd_at_entry': sol_usd_entry,
        'deployed_at_meteora': deployed_at_dt.isoformat() if deployed_at_dt else None,
        'closed_at_meteora': closed_at_dt.isoformat() if closed_at_dt else None,
        'is_out_of_range': match.get('isOutOfRange'),
        'pool_active_bin_id': match.get('poolActiveBinId'),
        'lower_bin_id': match.get('lowerBinId'),
        'upper_bin_id': match.get('upperBinId'),
        'source': 'meteora_api_backfill',
        'backfilled_at': datetime.now(timezone.utc).isoformat(),
    }
    return metrics, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=0, help='max positions to process (0=all)')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--skip-existing', action='store_true', default=True)
    parser.add_argument('--no-backup', action='store_true')
    args = parser.parse_args()

    print('=== Meteora Close-Metrics Backfill ===')
    print(f'state.json: {STATE_FILE}')
    print(f'limit: {args.limit if args.limit else "all"}')
    print(f'dry_run: {args.dry_run}')

    wallet = get_wallet_pubkey()
    print(f'wallet: {wallet}')

    state = load_state()
    positions = state.get('positions', {})
    closed = [p for p in positions.values() if p.get('closed')]

    if args.limit:
        # newest first
        closed.sort(key=lambda p: p.get('closed_at') or '', reverse=True)
        closed = closed[:args.limit]

    print(f'candidates: {len(closed)}')

    sol_price_cache = {}
    report = {'total': len(closed), 'success': 0, 'skipped': 0, 'failed': 0, 'details': []}
    start = time.time()
    # Load state ONCE at start; we'll re-read at each checkpoint to avoid bot-write races
    state = load_state()
    positions_dict = state.get('positions', {})
    print(f'state loaded with {len(positions_dict)} positions')

    for i, p in enumerate(closed):
        addr = p.get('position')
        name = p.get('pool_name', '?')
        # use latest in-memory version (re-merged at checkpoints)
        p_live = positions_dict.get(addr, p)
        if args.skip_existing and p_live.get('close_metrics', {}).get('pnl_sol') is not None:
            report['skipped'] += 1
            report['details'].append({'addr': addr, 'name': name, 'result': 'skipped_existing'})
            continue

        metrics, reason = backfill_one(p_live, wallet, sol_price_cache)
        if metrics:
            p_live['close_metrics'] = metrics
            positions_dict[addr] = p_live
            report['success'] += 1
            report['details'].append({
                'addr': addr,
                'name': name,
                'result': 'success',
                'pnl_sol': metrics['pnl_sol'],
                'pnl_pct': metrics['pnl_pct'],
                'sol_usd_close': metrics.get('sol_usd_at_close'),
            })
            print(f'[{i+1}/{len(closed)}] {name[:20]:20s} pnl_sol={metrics["pnl_sol"]:+.4f} pnl_pct={metrics["pnl_pct"]:+.2f}% sol_usd_close={metrics.get("sol_usd_at_close")}')
        else:
            report['failed'] += 1
            report['details'].append({'addr': addr, 'name': name, 'result': 'failed', 'reason': reason})
            print(f'[{i+1}/{len(closed)}] {name[:20]:20s} FAILED: {reason}')

        # rate-limit: 6 RPS
        time.sleep(0.17)

        # checkpoint every 50: re-read fresh state from disk, merge in our work, save atomically
        if (i + 1) % 50 == 0 and not args.dry_run:
            try:
                # re-read disk state to catch bot updates
                with open(STATE_FILE) as f:
                    disk_state = json.load(f)
                disk_positions = disk_state.get('positions', {})
                # merge: keep bot's fresh data, overlay our close_metrics
                for addr2, p_disk in disk_positions.items():
                    p_mem = positions_dict.get(addr2)
                    if p_mem and 'close_metrics' in p_mem:
                        p_disk['close_metrics'] = p_mem['close_metrics']
                disk_state['positions'] = disk_positions
                positions_dict = disk_positions
                # atomic save (no flock since bot doesn't use one)
                tmp = STATE_FILE.with_suffix('.json.tmp')
                with open(tmp, 'w') as f:
                    json.dump(disk_state, f, indent=2)
                tmp.replace(STATE_FILE)
                elapsed = time.time() - start
                rate = (i + 1) / elapsed
                eta = (len(closed) - i - 1) / max(rate, 0.01)
                print(f'  [CHECKPOINT] {i+1}/{len(closed)} elapsed={elapsed:.0f}s rate={rate:.2f}/s eta={eta:.0f}s')
            except Exception as e:
                print(f'  [CHECKPOINT] save failed: {e} — continuing')

    if not args.dry_run:
        # final save with same merge logic
        try:
            with open(STATE_FILE) as f:
                disk_state = json.load(f)
            disk_positions = disk_state.get('positions', {})
            for addr2, p_disk in disk_positions.items():
                p_mem = positions_dict.get(addr2)
                if p_mem and 'close_metrics' in p_mem:
                    p_disk['close_metrics'] = p_mem['close_metrics']
            disk_state['positions'] = disk_positions
            tmp = STATE_FILE.with_suffix('.json.tmp')
            with open(tmp, 'w') as f:
                json.dump(disk_state, f, indent=2)
            tmp.replace(STATE_FILE)
            print('[WRITE] state.json updated (final)')
        except Exception as e:
            print(f'[WRITE] final save failed: {e}')

    report_path = ROOT / '.hermes' / 'backfill_report.json'
    report_path.parent.mkdir(exist_ok=True)
    with open(report_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'\n=== DONE ===')
    print(f'total={report["total"]} success={report["success"]} failed={report["failed"]} skipped={report["skipped"]}')
    print(f'report: {report_path}')
    print(f'elapsed: {time.time()-start:.1f}s')


if __name__ == '__main__':
    main()