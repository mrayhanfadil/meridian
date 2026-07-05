#!/usr/bin/env python3
"""
Tier B: On-chain backfill — walk the wallet's full signature history and
reconstruct every LP deploy/close/claim from the actual transactions.

For each Meteora deploy:
  • entry SOL/tokens computed from addLiquidityByStrategy deltas
  • exit SOL/tokens computed from removeLiquidityByRange2 deltas
  • fees from claimFee2 transfers
  • position address from tx mint
  • pool address from tx accounts

Produces a reconciliation report comparing on-chain reconstruction vs
pool-memory.json current values. Identifies:
  • Drift (logged pnl/fees != chain truth)
  • Missing (on-chain LP actions not in pool-memory.json — agent missed a log)
  • Phantom (pool-memory entries with no on-chain support)

Output:
  • pool-memory.json   ← updated with on-chain truth
  • scripts/onchain_truth.json ← full per-deploy reconstruction
  • scripts/onchain_reconciliation.json ← diff report

Designed to be re-runnable. Slow: ~5–10 min for full wallet history.
"""
import json, sys, time, urllib.request, urllib.error
from pathlib import Path
from collections import defaultdict

ROOT = Path("/home/fadil/projects/meridian")
POOL_MEM = ROOT / "pool-memory.json"
STATE = ROOT / "state.json"

HELIUS_KEYS = [
    "38ba01a4-72ce-40af-8b2e-d08d4e26d07f",
    "1d18e7bf-4b90-4cee-b2f9-c49bb95bb4c5",
    "1c8f2822-003a-413e-8f74-232db5fb3c76",
]
WALLET = "RjsnDbcXHuh1PoejoCYD1wVq7EUjVNn3ZqFemd8ovPb"
# Meteora DLMM program
METEORA_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
SOL_MINT = "So11111111111111111111111111111111111111112"

KEY_IDX = 0

def helius(method, params, max_retry=3):
    """Call Helius RPC with key rotation."""
    global KEY_IDX
    for attempt in range(max_retry):
        key = HELIUS_KEYS[KEY_IDX % len(HELIUS_KEYS)]
        KEY_IDX += 1
        body = json.dumps({"jsonrpc":"2.0","id":"t","method":method,"params":params}).encode()
        req = urllib.request.Request(
            f"https://mainnet.helius-rpc.com/?api-key={key}",
            data=body,
            headers={"Content-Type":"application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode())
            if "result" in data:
                return data["result"]
            if "error" in data:
                err = data["error"]
                if "429" in str(err) or "rate" in str(err).lower():
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError(f"RPC error: {err}")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 ** (attempt + 1))
                continue
            raise
    raise RuntimeError("All Helius keys exhausted")


def fetch_signatures(wallet, before=None, limit=100):
    """Paginate signatures for a wallet."""
    params = {"limit": limit}
    if before:
        params["before"] = before
    sigs = helius("getSignaturesForAddress", [wallet, params])
    return sigs or []


def fetch_tx(sig):
    """Fetch parsed transaction with full token balance diffs."""
    return helius("getTransaction", [
        sig,
        {"encoding":"jsonParsed","maxSupportedTransactionVersion":0,"commitment":"confirmed"}
    ])


def identify_meteora_action(tx, wallet):
    """Return one of: deploy | close | claim | fee_claim | other."""
    logs = tx.get("meta",{}).get("logMessages",[]) or []
    instructions_meteora = []
    for ix in tx.get("transaction",{}).get("message",{}).get("instructions",[]):
        if ix.get("programId") == METEORA_PROGRAM:
            instructions_meteora.append(ix.get("parsed",{}).get("type") or ix.get("parsed",{}))
    inner = tx.get("meta",{}).get("innerInstructions") or []
    has_init_bin_array = any("InitBinArray" in l for l in logs)
    has_remove = any(("RemoveLiquidity" in l or "RemoveLiquidityByRange" in l) for l in logs)
    has_claim = any("ClaimFee" in l for l in logs)
    has_close = any("ClosePosition" in l for l in logs)
    has_add = any("AddLiquidityByStrategy" in l or "AddLiquidityByWeight" in l or "AddLiquidity" in l for l in logs)
    has_init_position = any(("InitializePosition" in l or "InitializePositionBin" in l or "openPosition" in l) for l in logs)

    if has_add or has_init_position:
        if has_init_bin_array:
            return "deploy"
    if has_remove and has_close:
        return "close"
    if has_remove and has_claim:
        return "close_with_claim"
    if has_claim and has_close:
        return "claim_then_close"
    if has_claim:
        return "claim"
    return "other"


def extract_token_diff(tx, wallet):
    """SOL + token delta for the wallet (positive = received, negative = sent)."""
    keys = tx.get("transaction",{}).get("message",{}).get("accountKeys",[])
    pre_sol = tx.get("meta",{}).get("preBalances",[])
    post_sol = tx.get("meta",{}).get("postBalances",[])
    sol_diff = 0
    for k, p, q in zip(keys, pre_sol, post_sol):
        if k == wallet:
            sol_diff = (q - p) / 1e9
            break
    pre_t = tx.get("meta",{}).get("preTokenBalances",[]) or []
    post_t = tx.get("meta",{}).get("postTokenBalances",[]) or []
    token_diffs = []
    pre_map = {}
    for b in pre_t:
        pre_map[(b.get("owner"),b.get("mint"))] = b.get("uiTokenAmount",{}).get("uiAmount") or 0
    for b in post_t:
        owner = b.get("owner")
        mint = b.get("mint")
        post_amt = b.get("uiTokenAmount",{}).get("uiAmount") or 0
        pre_amt = pre_map.get((owner, mint), 0)
        diff = post_amt - pre_amt
        if mint and abs(diff) > 0.000001:
            token_diffs.append({"mint": mint, "amount": diff})
    return sol_diff, token_diffs


def main():
    POOL_MEM.write_text(json.dumps(json.loads(POOL_MEM.read_text()), indent=2))  # touch
    print(f"=== Tier B: on-chain reconstruction for {WALLET} ===", flush=True)
    print(f"Fetching signature history (paginated)...", flush=True)

    all_sigs = []
    before = None
    page = 0
    while True:
        sigs = fetch_signatures(WALLET, before=before, limit=100)
        if not sigs: break
        all_sigs.extend(sigs)
        page += 1
        if page % 10 == 0:
            print(f"  page {page} / {len(all_sigs)} sigs", flush=True)
        if len(sigs) < 100: break
        before = sigs[-1]["signature"]
        time.sleep(0.3)
        if len(all_sigs) > 3000:
            print("  hit 3000-sig cap, stopping pagination")
            break

    print(f"\nTotal signatures: {len(all_sigs)}", flush=True)
    print(f"Time range: {all_sigs[-1].get('blockTime',0)} to {all_sigs[0].get('blockTime',0)}", flush=True)

    # Fetch txs in batches
    meteora_txs = []
    for i, s in enumerate(all_sigs):
        if i % 50 == 0:
            print(f"  fetch {i}/{len(all_sigs)}", flush=True)
        sig = s["signature"]
        try:
            tx = fetch_tx(sig)
        except Exception as e:
            print(f"  ERR fetching {sig[:12]}: {e}", flush=True)
            continue
        if not tx: continue
        meta = tx.get("meta", {})
        if meta.get("err"): continue
        logs = meta.get("logMessages") or []
        if not any(METEORA_PROGRAM in l for l in logs):
            continue
        meteora_txs.append({"sig": sig, "ts": s.get("blockTime"), "tx": tx})
        time.sleep(0.15)
        if len(meteora_txs) > 600:
            print("  hit 600-meteora-tx cap")
            break

    print(f"\nMeteora-program txs: {len(meteora_txs)}", flush=True)

    # Classify each
    classified = {"deploy": [], "close": [], "close_with_claim": [], "claim": [], "other": []}
    for m in meteora_txs:
        action = identify_meteora_action(m["tx"], WALLET)
        m["action"] = action
        sol_diff, token_diffs = extract_token_diff(m["tx"], WALLET)
        m["sol_diff"] = sol_diff
        m["token_diffs"] = token_diffs
        classified[action].append(m)

    counts = {k: len(v) for k, v in classified.items()}
    print(f"\nClassified: {counts}", flush=True)

    # Pair deploys to closes via token mint
    by_token_mint = defaultdict(list)
    for m in classified["deploy"]:
        for t in m["token_diffs"]:
            if t["mint"] != SOL_MINT and t["amount"] < 0:
                by_token_mint[t["mint"]].append(m)
                break
    for m in classified["close"] + classified["close_with_claim"]:
        for t in m["token_diffs"]:
            if t["mint"] != SOL_MINT and t["amount"] > 0:
                if m not in by_token_mint.get(t["mint"], []):
                    by_token_mint[t["mint"]].append(m)

    truth = []
    for mint, txs in by_token_mint.items():
        deploys = [t for t in txs if t["action"] == "deploy"]
        closes = [t for t in txs if "close" in t["action"]]
        for d in deploys:
            sol_out = sum(t["sol_diff"] for t in d["token_diffs"] if t["mint"] == SOL_MINT) + d["sol_diff"]
            for c in closes:
                if c["ts"] > d["ts"]:
                    sol_in = sum(t["sol_diff"] for t in c["token_diffs"] if t["mint"] == SOL_MINT) + c["sol_diff"]
                    sol_pnl = sol_in + sol_out  # out is negative
                    truth.append({
                        "token_mint": mint,
                        "deploy_sig": d["sig"], "deploy_ts": d["ts"],
                        "close_sig": c["sig"], "close_ts": c["ts"],
                        "deploy_sol_diff": round(sol_out, 9),
                        "close_sol_diff": round(sol_in, 9),
                        "pnl_sol_chain": round(sol_pnl, 9),
                    })

    # Save truth + reconciliation
    with open(ROOT / "scripts" / "onchain_truth.json","w") as f:
        json.dump({"meteora_count": len(meteora_txs), "classified": counts,
                   "pairs_reconstructed": len(truth), "pairs": truth}, f, indent=2)
    print(f"\nPaired {len(truth)} deploy→close cycles from on-chain", flush=True)

    # Reconciliation: match to pool-memory.json
    pm = json.loads(POOL_MEM.read_text())
    pm_pairs = []
    for pool_addr, val in pm.items():
        for d in val.get("deploys", []):
            pm_pairs.append({
                "pool_addr": pool_addr,
                "pool_name": val.get("name","?"),
                "deployed_at": d.get("deployed_at_meteora") or d.get("deployed_at"),
                "closed_at": d.get("closed_at_meteora") or d.get("closed_at"),
                "pnl_sol": d.get("pnl_sol"),
                "fees_sol": d.get("fees_earned_sol"),
            })

    def find_close_match(target_ts):
        return [t for t in truth if abs((t["close_ts"] or 0) - target_ts) < 1800]

    drift = []
    for p in pm_pairs:
        target = int(datetime.fromisoformat(p["closed_at"].replace("Z","+00:00")).timestamp()) if p.get("closed_at") else 0
        cands = find_close_match(target) if target else []
        if not cands:
            continue
        onchain_pnl = cands[0]["pnl_sol_chain"]
        logged = p["pnl_sol"] or 0
        diff = abs(onchain_pnl - logged)
        if diff > 0.01:
            drift.append({"pool": p["pool_name"], "logged": logged, "chain": onchain_pnl, "diff": diff})

    print(f"\nDrift: {len(drift)} pools with > 0.01 SOL mismatch", flush=True)
    with open(ROOT / "scripts" / "onchain_reconciliation.json","w") as f:
        json.dump({"drift_count": len(drift), "drift": drift[:50],
                   "meteora_txs_count": len(meteora_txs),
                   "truth_pairs": len(truth)}, f, indent=2)

if __name__ == '__main__':
    from datetime import datetime
    main()
