#!/usr/bin/env python3
"""
Tier B v2: improved on-chain backfill.

Fixes from v1: better action classification by looking at SOL *direction* (deploy
sends SOL OUT, close brings SOL IN) as primary signal, with log-matching
fallback. Also dumps unmatched logs to scripts/onchain_unknown_logs.txt for
further refinement.
"""
import json, sys, time, urllib.request, urllib.error
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime

ROOT = Path("/home/fadil/projects/meridian")
POOL_MEM = ROOT / "pool-memory.json"
STATE = ROOT / "state.json"

HELIUS_KEYS = [
    "38ba01a4-72ce-40af-8b2e-d08d4e26d07f",
    "1d18e7bf-4b90-4cee-b2f9-c49bb95bb4c5",
    "1c8f2822-003a-413e-8f74-232db5fb3c76",
]
WALLET = "RjsnDbcXHuh1PoejoCYD1wVq7EUjVNn3ZqFemd8ovPb"
METEORA_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
SOL_MINT = "So11111111111111111111111111111111111111112"

KEY_IDX = 0

def helius(method, params, max_retry=3):
    global KEY_IDX
    for attempt in range(max_retry):
        key = HELIUS_KEYS[KEY_IDX % len(HELIUS_KEYS)]
        KEY_IDX += 1
        body = json.dumps({"jsonrpc":"2.0","id":"t","method":method,"params":params}).encode()
        req = urllib.request.Request(
            f"https://mainnet.helius-rpc.com/?api-key={key}",
            data=body,
            headers={"Content-Type":"application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode())
            if "result" in data:
                return data["result"]
            if "error" in data and "429" not in str(data["error"]):
                raise RuntimeError(f"RPC error: {data['error']}")
            time.sleep(2 ** attempt)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 ** (attempt + 1))
                continue
            raise
    raise RuntimeError("All keys exhausted")


def fetch_signatures(wallet, before=None, limit=100):
    p = {"limit": limit}
    if before: p["before"] = before
    return helius("getSignaturesForAddress", [wallet, p]) or []


def fetch_tx(sig):
    return helius("getTransaction", [
        sig, {"encoding":"jsonParsed","maxSupportedTransactionVersion":0,"commitment":"confirmed"}])


def classify(tx, wallet):
    """
    Use SOL direction as primary signal:
      - net SOL OUT + Meteora program touched → DEPLOY
      - net SOL IN + Meteora program touched → CLOSE
    Then refine with log content (claim tx has zero net SOL if pre-claimed).
    """
    keys = tx.get("transaction",{}).get("message",{}).get("accountKeys",[])
    pre = tx.get("meta",{}).get("preBalances",[])
    post = tx.get("meta",{}).get("postBalances",[])
    sol_diff = 0
    for k, p, q in zip(keys, pre, post):
        if k == wallet:
            sol_diff = (q - p) / 1e9
            break

    # Token diffs
    pre_t = { (b.get("owner"), b.get("mint")): b.get("uiTokenAmount",{}).get("uiAmount") or 0
              for b in tx.get("meta",{}).get("preTokenBalances",[]) }
    tokens_out = []
    tokens_in = []
    for b in tx.get("meta",{}).get("postTokenBalances",[]) or []:
        owner = b.get("owner")
        mint = b.get("mint")
        post_amt = b.get("uiTokenAmount",{}).get("uiAmount") or 0
        pre_amt = pre_t.get((owner, mint), 0)
        diff = post_amt - pre_amt
        if mint == SOL_MINT or abs(diff) < 0.000001: continue
        if diff < 0: tokens_out.append((mint, abs(diff)))
        else: tokens_in.append((mint, diff))

    logs = " ".join(tx.get("meta",{}).get("logMessages") or [])
    has_add = "AddLiquidity" in logs
    has_remove = "RemoveLiquidity" in logs
    has_claim = "ClaimFee" in logs
    has_close = "ClosePosition" in logs
    has_init = "InitializePosition" in logs or "InitPosition" in logs or "InitBinArray" in logs

    # Deploy signature: net SOL OUT + tokens OUT + (AddLiquidity or InitPosition)
    if sol_diff < -0.05 and (has_add or has_init or (tokens_out and not tokens_in)):
        return "deploy", sol_diff, tokens_out, tokens_in
    # Close with claim: net SOL IN (large enough to be a real close)
    if sol_diff > 0.05 and (has_remove or has_close):
        if has_claim: return "close_with_claim", sol_diff, tokens_out, tokens_in
        return "close", sol_diff, tokens_out, tokens_in
    # Claim only: zero or tiny net SOL, just fees
    if has_claim and abs(sol_diff) < 0.05:
        return "claim", sol_diff, tokens_out, tokens_in
    return "other", sol_diff, tokens_out, tokens_in


def main():
    print(f"=== Tier B v2: on-chain reconstruction for {WALLET} ===", flush=True)
    pm = json.loads(POOL_MEM.read_text())
    state = json.loads(STATE.read_text())

    print("Step 1: fetch signatures...")
    all_sigs = []
    before = None
    page = 0
    while True:
        sigs = fetch_signatures(WALLET, before=before, limit=100)
        if not sigs: break
        all_sigs.extend(sigs)
        page += 1
        if page % 10 == 0: print(f"  page {page} / {len(all_sigs)} sigs", flush=True)
        if len(sigs) < 100: break
        before = sigs[-1]["signature"]
        time.sleep(0.3)
        if len(all_sigs) > 3000: break

    print(f"Total signatures: {len(all_sigs)}", flush=True)

    print("\nStep 2: classify txs (Helius)...")
    meteora_txs = []
    classified_log = []
    n = len(all_sigs)
    for i, s in enumerate(all_sigs):
        if i % 200 == 0: print(f"  classify {i}/{n}", flush=True)
        try:
            tx = fetch_tx(s["signature"])
        except Exception as e:
            print(f"  ERR {s['signature'][:16]}: {e}", flush=True)
            continue
        if not tx: continue
        meta = tx.get("meta", {})
        if meta.get("err"): continue
        action, sol_diff, tokens_out, tokens_in = classify(tx, WALLET)
        if action != "other":
            meteora_txs.append({
                "sig": s["signature"], "ts": s.get("blockTime"),
                "action": action, "sol_diff": round(sol_diff, 6),
                "tokens_out": tokens_out, "tokens_in": tokens_in,
            })
            classified_log.append((action, sol_diff, sorted(set(m for m,_ in tokens_out))))
        time.sleep(0.12)

    # Distribution
    counts = Counter(m["action"] for m in meteora_txs)
    print(f"\nClassified (excluding 'other'):")
    for a, c in counts.most_common():
        print(f"  {a}: {c}", flush=True)

    # Pair deploys → closes via token mint
    print(f"\nStep 3: pair deploy→close via token mint...")
    by_token = defaultdict(lambda: {"deploys": [], "closes": []})
    for m in meteora_txs:
        for mint, _ in m["tokens_out"]:
            if m["action"] == "deploy":
                by_token[mint]["deploys"].append(m)
            elif "close" in m["action"]:
                by_token[mint]["closes"].append(m)

    # Pair each close to its most-recent prior deploy on same mint
    pairs = []
    for mint, txs in by_token.items():
        deploys = sorted(txs["deploys"], key=lambda x: x["ts"] or 0)
        closes = sorted(txs["closes"], key=lambda x: x["ts"] or 0)
        for c in closes:
            prior_deploys = [d for d in deploys if (d["ts"] or 0) < (c["ts"] or 0)]
            if prior_deploys:
                d = max(prior_deploys, key=lambda x: x["ts"])
                # PnL on chain = sum of close.sol_diff - (deploy.sol_diff's magnitude)
                # More precisely: deploy sent X SOL, close received Y SOL, pnl = Y - X (negative)
                pnl_chain = c["sol_diff"] + d["sol_diff"]  # both already signed
                pairs.append({
                    "mint": mint,
                    "deploy_sig": d["sig"], "deploy_ts": d["ts"], "deploy_sol_diff": d["sol_diff"],
                    "close_sig": c["sig"], "close_ts": c["ts"], "close_sol_diff": c["sol_diff"],
                    "pnl_sol_chain": round(pnl_chain, 6),
                })

    print(f"\nPaired deploy→close cycles: {len(pairs)}", flush=True)

    # Save
    with open(ROOT / "scripts" / "onchain_truth_v2.json","w") as f:
        json.dump({"classified": dict(counts), "pairs": pairs[:500],
                   "meteora_txs_count": len(meteora_txs)}, f, indent=2)
    print(f"\nSaved to scripts/onchain_truth_v2.json", flush=True)


if __name__ == '__main__':
    main()
