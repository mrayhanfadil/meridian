#!/usr/bin/env python3
"""Tier A: Fetch historical SOL/USD for 20 missing deploys from CoinGecko."""
import json, urllib.request, sys

dates = [
    ("21", "06", "2026"),
    ("22", "06", "2026"),
    ("23", "06", "2026"),
    ("24", "06", "2026"),
    ("28", "06", "2026"),
    ("01", "07", "2026"),
    ("03", "07", "2026"),
    ("04", "07", "2026"),
    ("05", "07", "2026"),
]

prices = {}
for d, m, y in dates:
    url = f"https://api.coingecko.com/api/v3/coins/solana/history?date={d}-{m}-{y}&localization=false"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode())
        usd = data.get("market_data", {}).get("current_price", {}).get("usd")
        if usd:
            prices[f"2026-{m}-{d}"] = usd
            print(f"  2026-{m}-{d}: ${usd:.2f}", flush=True)
        else:
            print(f"  2026-{m}-{d}: no price", flush=True)
    except Exception as e:
        print(f"  2026-{m}-{d}: ERR {e}", flush=True)

with open("scripts/sol_prices.json", "w") as f:
    json.dump(prices, f, indent=2)
print(f"\nSaved {len(prices)} prices to scripts/sol_prices.json")
