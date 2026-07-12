# 📑 Master Blueprint: Porting 18 HawkFi Osprey V2 Strategies to Meridian OS
## Deconstructing HawkFi's Core Algorithms into a 100% Sovereign, Free-Tier Friendly System

This document outlines the complete technical mapping, parameter configurations, risk profiles, and code-level implementation plans to port **all 18 variations of HawkFi's Osprey V2 strategies** directly into **Meridian OS**.

---

## 📐 1. The Strategy Matrix (3 Risk Profiles × 6 Execution Models)

HawkFi's Osprey V2 ecosystem is built by combining **3 Risk/Sizing Profiles** (Selective, Standard, Aggressive) with **6 core Liquidity Execution Models**. This matrix yields exactly **18 unique strategy configurations**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        OSPREY V2 18-STRATEGY MATRIX                    │
├───────────────────┬───────────────────┬────────────────────────────────┤
│ SELECTIVE (Low)   │ STANDARD (Medium) │ AGGRESSIVE (High)              │
│ • Sizing: 0.1-0.2 │ • Sizing: 0.5 SOL │ • Sizing: 1.0+ SOL             │
│ • Filters: Strict │ • Filters: Normal │ • Filters: Loose/Degen         │
├───────────────────┴───────────────────┴────────────────────────────────┤
│ 1. HFL Wide (Flat 41 Bins, Symmetrical, Defensive)                     │
│ 2. Precision Flip (Gaussian Curve 15 Bins, Flip Buffer Reshape)       │
│ 3. MCU Curve / Bullish Sniper (Up-Only Symmetrical/Asymmetrical Trend) │
│ 4. Heart Attack Ping Pong (Ultra-Concentrated 7 Bins, High-Frequency) │
│ 5. Bid-Ask Spread Maker (Makelar Spread, Symmetrical Spot Asymmetrical)│
│ 6. Inventory Drift Stabilizer (Delta-Neutral Flat, Ratio-Skew Offset)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ 2. The 18 Strategies Technical Specifications

### Group A: Selective Risk Profile (Strategies 1 - 6)
*Target: Maximum capital preservation. High screening thresholds, small position sizing (0.2 SOL max), strict 6-hour re-entry cooldowns.*

#### 1. Selective - HFL Wide (Defensive Yield)
* **Description:** Wide flat distribution. Rarely rebalances.
* **Math Shape:** `flat` (via `generateFlatWeights(41)`)
* **Width:** 41 bins (20 below, 1 active, 20 above).
* **Rebalance Trigger:** Active price goes completely outside range (OOR > 120 minutes).
* **Meridian Call:** `rebalancePosition({ position_address, shape: "flat", width: 41 })`

#### 2. Selective - Precision Flip (Dynamic Organic)
* **Description:** Symmetrical Gaussian curve with conservative flip buffer.
* **Math Shape:** `curve` (via `generateGaussianWeights(15, 3.75)`)
* **Width:** 15 bins (7 below, 1 active, 7 above).
* **Rebalance Trigger:** Active bin shifts $\geq 5$ bins away from position center.
* **Meridian Call:** `rebalancePosition({ position_address, shape: "curve", width: 15 })`

#### 3. Selective - MCU Curve (Bullish Sniper)
* **Description:** Symmetrical Curve. Up-only rebalance to follow uptrends safely.
* **Math Shape:** `curve` (via `generateGaussianWeights(15)`)
* **Width:** 15 bins.
* **Rebalance Trigger:** Upward OOR only. No downward rebalance (refuse falling knife).
* **Meridian Call:** Only trigger `rebalancePosition` if `activeBin > upperBin`.

#### 4. Selective - Heart Attack Ping Pong (High Volatility Squeeze)
* **Description:** Symmetrical flat, super concentrated. Hit and run on highly active low-caps.
* **Math Shape:** `flat` (via `generateFlatWeights(7)`)
* **Width:** 7 bins.
* **Rebalance Trigger:** Any active bin change (instant reshape). Cooldown 12h after close.
* **Meridian Call:** `rebalancePosition({ position_address, shape: "flat", width: 7 })`

#### 5. Selective - Bid-Ask Spread Maker (Spread Makelar)
* **Description:** Active bin left empty. modal placed as bid-ask limits.
* **Math Shape:** Spot-Skewed flat (using `generateSpotSkewedWeights(15, 0)`) with center bin weights hard-zeroed.
* **Width:** 15 bins (7 bids, active bin empty, 7 asks).
* **Rebalance Trigger:** Price crosses center.
* **Meridian Call:** Custom DLO deployment via `tools/dlmm/dlo.ts`.

#### 6. Selective - Inventory Drift Stabilizer (IL Hedge)
* **Description:** Mitigates Impermanent Loss. Automatically skews weights against price trend to re-balance token ratio.
* **Math Shape:** `spot` (using `generateSpotSkewedWeights(21, -0.2)`) skewing heavier to SOL side.
* **Width:** 21 bins.
* **Rebalance Trigger:** Token ratio skews past 70/30.
* **Meridian Call:** `rebalancePosition({ position_address, shape: "spot", width: 21, skew: -0.2 })`

---

### Group B: Standard Risk Profile (Strategies 7 - 12)
*Target: Maximum fee yield on mid-to-high caps. Standard screening thresholds, medium sizing (0.5 SOL), 3-hour re-entry cooldowns.*

#### 7. Standard - HFL Wide (Standard Defensive)
* **Description:** Symmetrical wide flat. Very robust for stable trading.
* **Math Shape:** `flat` (via `generateFlatWeights(31)`)
* **Width:** 31 bins (15 below, 1 active, 15 above).
* **Rebalance Trigger:** Price exits 31-bin boundaries (OOR > 60 minutes).
* **Meridian Call:** `rebalancePosition({ position_address, shape: "flat", width: 31 })`

#### 8. Standard - Precision Flip (Standard Dynamic)
* **Description:** High fee yield curve with dynamic reshape buffer.
* **Math Shape:** `curve` (via `generateGaussianWeights(11, 2.75)`)
* **Width:** 11 bins (5 below, 1 active, 5 above).
* **Rebalance Trigger:** Active bin shifts $\geq 3$ bins away from center.
* **Meridian Call:** `rebalancePosition({ position_address, shape: "curve", width: 11 })`

#### 9. Standard - MCU Curve (Standard Uptrend)
* **Description:** Trend-following curve.
* **Math Shape:** `curve` (via `generateGaussianWeights(11)`)
* **Width:** 11 bins.
* **Rebalance Trigger:** Up-only rebalance on upward OOR.
* **Meridian Call:** Trigger `rebalancePosition` only on upward price shift.

#### 10. Standard - Heart Attack Ping Pong (Standard Volatility)
* **Description:** Concentrated flat for high-yield launchpools.
* **Math Shape:** `flat` (via `generateFlatWeights(9)`)
* **Width:** 9 bins.
* **Rebalance Trigger:** Active bin shifts $\geq 2$ bins away from center.
* **Meridian Call:** `rebalancePosition({ position_address, shape: "flat", width: 9 })`

#### 11. Standard - Bid-Ask Spread Maker (Standard Spread)
* **Description:** Symmetrical spot bids/asks with 1-bin empty spread.
* **Width:** 11 bins (5 bids, center empty, 5 asks).
* **Rebalance Trigger:** Price crosses center.

#### 12. Standard - Inventory Drift Stabilizer (Standard Hedge)
* **Description:** Balances inventory drift on steady volatile pools.
* **Math Shape:** `spot` (via `generateSpotSkewedWeights(15, -0.3)`)
* **Width:** 15 bins.
* **Rebalance Trigger:** Token ratio skews past 80/20.

---

### Group C: Aggressive Risk Profile (Strategies 13 - 18)
*Target: Maximum capital compounding on hyper-active meme/launchpool tokens. Sizing 1.0+ SOL, loose filters, 1-hour re-entry cooldowns.*

#### 13. Aggressive - HFL Wide (Yield Max Wide)
* **Description:** Symmetrical flat with moderate width to capture heavy swings.
* **Math Shape:** `flat` (via `generateFlatWeights(21)`)
* **Width:** 21 bins.
* **Rebalance Trigger:** Price exits 21-bin boundaries (OOR > 30 minutes).
* **Meridian Call:** `rebalancePosition({ position_address, shape: "flat", width: 21 })`

#### 14. Aggressive - Precision Flip (Yield Max Curve)
* **Description:** Symmetrical concentrated curve. Ultra-dense fee capture.
* **Math Shape:** `curve` (via `generateGaussianWeights(9, 2.25)`)
* **Width:** 9 bins.
* **Rebalance Trigger:** Active bin shifts $\geq 2$ bins away from center.
* **Meridian Call:** `rebalancePosition({ position_address, shape: "curve", width: 9 })`

#### 15. Aggressive - MCU Curve (High Leverage Trend)
* **Description:** Concentrated curve for aggressive bullish breakout snipes.
* **Math Shape:** `curve` (via `generateGaussianWeights(7)`)
* **Width:** 7 bins.
* **Rebalance Trigger:** Immediate up-only rebalance on any upward price move.
* **Meridian Call:** Instant rebalance on positive bin changes.

#### 16. Aggressive - Heart Attack Ping Pong (DeFi Degen Launchpad)
* **Description:** Symmetrical flat, maximum concentration. Pure degen hit and run.
* **Math Shape:** `flat` (via `generateFlatWeights(5)`)
* **Width:** 5 bins (2 below, 1 active, 2 above).
* **Rebalance Trigger:** Instant rebalance on ANY active bin change.
* **Meridian Call:** `rebalancePosition({ position_address, shape: "flat", width: 5 })`

#### 17. Aggressive - Bid-Ask Spread Maker (Degen Arbitrage)
* **Description:** Ultra-tight limit bid-ask offsets.
* **Width:** 7 bins (3 bids, center empty, 3 asks).
* **Rebalance Trigger:** Price crosses center.

#### 18. Aggressive - Drift Stabilizer (Dynamic Leveraged IL Hedge)
* **Description:** High-frequency ratio stabilizer.
* **Math Shape:** `spot` (via `generateSpotSkewedWeights(11, -0.5)`)
* **Width:** 11 bins.
* **Rebalance Trigger:** Token ratio skews past 85/15.

---

## 💻 3. Code Implementation & Automation Plan

To make these 18 strategies fully automated, we will construct a **Strategy Controller Configuration Map** and wire it directly into Meridian's `state.ts` and monitoring daemon.

### Step 1: Define the Master Strategy Config File
We will create `config/osprey-strategies.ts` to store the exact parameters for all 18 variations:

```typescript
export interface OspreyStrategy {
  id: number;
  name: string;
  risk: "selective" | "standard" | "aggressive";
  model: "hfl_wide" | "precision_flip" | "mcu_curve" | "heart_attack" | "spread_maker" | "drift_stabilizer";
  width: number;
  shape: "flat" | "curve" | "spot";
  skew?: number;
  flipBuffer?: number;
  oorMinutesWait: number;
  cooldownHours: number;
  sizingSol: number;
  minTvl: number;
  minVolume: number;
  minOrganic: number;
}

export const ospreyStrategies: OspreyStrategy[] = [
  {
    id: 1,
    name: "Selective - HFL Wide",
    risk: "selective",
    model: "hfl_wide",
    width: 41,
    shape: "flat",
    oorMinutesWait: 120,
    cooldownHours: 6,
    sizingSol: 0.2,
    minTvl: 15000,
    minVolume: 10000,
    minOrganic: 40
  },
  {
    id: 2,
    name: "Selective - Precision Flip",
    risk: "selective",
    model: "precision_flip",
    width: 15,
    shape: "curve",
    flipBuffer: 5,
    oorMinutesWait: 60,
    cooldownHours: 6,
    sizingSol: 0.2,
    minTvl: 15000,
    minVolume: 10000,
    minOrganic: 40
  },
  // ... (Full mapping of all 18 strategies mapped identically)
];
```

### Step 2: Wire the Strategy Controller into the MANAGER Loop
In our daemon manager loop (`index.js`), we will add a hook that evaluates these strategy-specific rebalance and flip conditions on every slot/WebSocket push received via `stream-client.ts`:

```typescript
import { ospreyStrategies } from "./config/osprey-strategies.js";
import { rebalancePosition } from "./tools/dlmm/rebalancer.js";

export async function runOspreyMonitoringCycle(positionAddress, activeBinId) {
  const tracked = getTrackedPosition(positionAddress);
  const strategy = ospreyStrategies.find(s => s.name === tracked.strategy);
  if (!strategy) return; // default to standard Meridian logic if not an Osprey setup

  // Check Precision Flip Reshape Condition
  if (strategy.model === "precision_flip" && strategy.flipBuffer) {
    const centerBin = Math.floor((tracked.bin_range.max + tracked.bin_range.min) / 2);
    const delta = Math.abs(activeBinId - centerBin);
    if (delta >= strategy.flipBuffer) {
      log("osprey", `Triggering Reshape: Active bin ${activeBinId} shifted ${delta} bins away from center ${centerBin} (limit ${strategy.flipBuffer})`);
      await rebalancePosition({
        position_address: positionAddress,
        new_active_bin: activeBinId,
        shape: strategy.shape,
        width: strategy.width
      });
    }
  }

  // Check HFL Wide Out of Range Condition
  if (strategy.model === "hfl_wide") {
    if (activeBinId < tracked.bin_range.min || activeBinId > tracked.bin_range.max) {
      const minutesOOR = minutesOutOfRange(positionAddress);
      if (minutesOOR >= strategy.oorMinutesWait) {
        log("osprey", `Triggering HFL Wide Rebalance: OOR for ${minutesOOR}m (limit ${strategy.oorMinutesWait}m)`);
        await rebalancePosition({
          position_address: positionAddress,
          new_active_bin: activeBinId,
          shape: strategy.shape,
          width: strategy.width
        });
      }
    }
  }
  
  // ... (Continuous checks for MCU curve, Heart Attack, Bid-Ask Flip and stabilizers)
}
```

---

## 📈 4. Feasibility & Risk Safeguards

1. **Gas Fee Optimization:** Symmetrical 41-bin ("HFL Wide") and 15-bin ("Precision Flip") setups are optimized to only rebalance when absolutely necessary, preserving SOL.
2. **Free Helius Tier Compliance:** Because our stream-client runs on native, free WebSockets, monitoring 18 active strategy configurations simultaneously in the background incurs **zero Helius credits cost**, keeping ops 100% free!
3. **Double Rebalance Guard:** We hard-cap the maximum rebalances per position to `12 times per 24 hours` to protect against hyper-volatile, sideways-bleeding tokens (e.g. during a rugpull).
