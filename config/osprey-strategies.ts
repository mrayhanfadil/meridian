/**
 * DIY HawkFi Osprey V2 Strategies Configuration (Meridian OS)
 *
 * Defines the complete quantitative parameter set for all 18 variations
 * of HawkFi's Osprey V2 strategies (3 Risk Profiles x 6 Execution Models).
 * Fully integrated with Meridian OS's mathematical shapes and rebalancer.
 */

export interface OspreyStrategy {
  id: number;
  name: string;
  risk: "selective" | "standard" | "aggressive";
  model: "hfl_wide" | "precision_flip" | "mcu_curve" | "heart_attack" | "spread_maker" | "drift_stabilizer";
  width: number;
  shape: "flat" | "curve" | "spot";
  sigma?: number; // Standard deviation for Gaussian curves
  skew?: number;  // Biasing skew (-1.0 to 1.0)
  flipBuffer?: number; // Reshape trigger buffer (distance from center in bins)
  oorMinutesWait: number; // Out of range cooldown wait time before rebalance
  cooldownHours: number; // Re-entry cooldown time for pool after position close
  sizingSol: number; // Allocated capital per position
  minTvl: number; // Minimum pool TVL filter ($)
  minVolume: number; // Minimum 24h pool volume filter ($)
  minOrganic: number; // Minimum Jupiter Organic score filter (0-100)
  dloOffsetBins?: number; // Offset from active price for Limit orders (spread maker)
  dloWidthBins?: number;  // Width of limit order range
}

export const ospreyStrategies: OspreyStrategy[] = [
  // ─── Group A: SELECTIVE RISK PROFILE (Strategies 1 - 6) ───────────────────
  // Focus: Extreme capital preservation, strict filters, low sizing, 6h cooldown.
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
    minOrganic: 40,
  },
  {
    id: 2,
    name: "Selective - Precision Flip",
    risk: "selective",
    model: "precision_flip",
    width: 15,
    shape: "curve",
    sigma: 3.75, // width / 4
    flipBuffer: 5,
    oorMinutesWait: 60,
    cooldownHours: 6,
    sizingSol: 0.2,
    minTvl: 15000,
    minVolume: 10000,
    minOrganic: 40,
  },
  {
    id: 3,
    name: "Selective - MCU Curve",
    risk: "selective",
    model: "mcu_curve",
    width: 15,
    shape: "curve",
    sigma: 3.75,
    oorMinutesWait: 60,
    cooldownHours: 6,
    sizingSol: 0.2,
    minTvl: 15000,
    minVolume: 10000,
    minOrganic: 40,
  },
  {
    id: 4,
    name: "Selective - Heart Attack",
    risk: "selective",
    model: "heart_attack",
    width: 7,
    shape: "flat",
    oorMinutesWait: 30,
    cooldownHours: 12, // heavy cooldown on launchpool failures
    sizingSol: 0.1, // tiny sizing on aggressive launches
    minTvl: 10000,
    minVolume: 25000,
    minOrganic: 30,
  },
  {
    id: 5,
    name: "Selective - Bid-Ask Maker",
    risk: "selective",
    model: "spread_maker",
    width: 15,
    shape: "flat",
    oorMinutesWait: 45,
    cooldownHours: 6,
    sizingSol: 0.2,
    minTvl: 20000,
    minVolume: 15000,
    minOrganic: 45,
    dloOffsetBins: 10,
    dloWidthBins: 10,
  },
  {
    id: 6,
    name: "Selective - Drift Stabilizer",
    risk: "selective",
    model: "drift_stabilizer",
    width: 21,
    shape: "spot",
    skew: -0.2, // bid-favoring inventory hedge
    oorMinutesWait: 90,
    cooldownHours: 6,
    sizingSol: 0.2,
    minTvl: 15000,
    minVolume: 10000,
    minOrganic: 40,
  },

  // ─── Group B: STANDARD RISK PROFILE (Strategies 7 - 12) ───────────────────
  // Focus: Balanced fee generation, standard filters, moderate sizing, 3h cooldown.
  {
    id: 7,
    name: "Standard - HFL Wide",
    risk: "standard",
    model: "hfl_wide",
    width: 31,
    shape: "flat",
    oorMinutesWait: 60,
    cooldownHours: 3,
    sizingSol: 0.5,
    minTvl: 10000,
    minVolume: 5000,
    minOrganic: 50,
  },
  {
    id: 8,
    name: "Standard - Precision Flip",
    risk: "standard",
    model: "precision_flip",
    width: 11,
    shape: "curve",
    sigma: 2.75, // width / 4
    flipBuffer: 3,
    oorMinutesWait: 30,
    cooldownHours: 3,
    sizingSol: 0.5,
    minTvl: 10000,
    minVolume: 5000,
    minOrganic: 50,
  },
  {
    id: 9,
    name: "Standard - MCU Curve",
    risk: "standard",
    model: "mcu_curve",
    width: 11,
    shape: "curve",
    sigma: 2.75,
    oorMinutesWait: 30,
    cooldownHours: 3,
    sizingSol: 0.5,
    minTvl: 10000,
    minVolume: 5000,
    minOrganic: 50,
  },
  {
    id: 10,
    name: "Standard - Heart Attack",
    risk: "standard",
    model: "heart_attack",
    width: 9,
    shape: "flat",
    oorMinutesWait: 15,
    cooldownHours: 6,
    sizingSol: 0.3,
    minTvl: 5000,
    minVolume: 15000,
    minOrganic: 40,
  },
  {
    id: 11,
    name: "Standard - Bid-Ask Maker",
    risk: "standard",
    model: "spread_maker",
    width: 11,
    shape: "flat",
    oorMinutesWait: 30,
    cooldownHours: 3,
    sizingSol: 0.5,
    minTvl: 10000,
    minVolume: 10000,
    minOrganic: 50,
    dloOffsetBins: 8,
    dloWidthBins: 10,
  },
  {
    id: 12,
    name: "Standard - Drift Stabilizer",
    risk: "standard",
    model: "drift_stabilizer",
    width: 15,
    shape: "spot",
    skew: -0.3,
    oorMinutesWait: 45,
    cooldownHours: 3,
    sizingSol: 0.5,
    minTvl: 10000,
    minVolume: 5000,
    minOrganic: 50,
  },

  // ─── Group C: AGGRESSIVE RISK PROFILE (Strategies 13 - 18) ────────────────
  // Focus: Hyper compounding, loose filters, high sizing, 1h cooldown.
  {
    id: 13,
    name: "Aggressive - HFL Wide",
    risk: "aggressive",
    model: "hfl_wide",
    width: 21,
    shape: "flat",
    oorMinutesWait: 30,
    cooldownHours: 1,
    sizingSol: 1.0,
    minTvl: 5000,
    minVolume: 2500,
    minOrganic: 60,
  },
  {
    id: 14,
    name: "Aggressive - Precision Flip",
    risk: "aggressive",
    model: "precision_flip",
    width: 9,
    shape: "curve",
    sigma: 2.25, // width / 4
    flipBuffer: 2,
    oorMinutesWait: 15,
    cooldownHours: 1,
    sizingSol: 1.0,
    minTvl: 5000,
    minVolume: 2500,
    minOrganic: 60,
  },
  {
    id: 15,
    name: "Aggressive - MCU Curve",
    risk: "aggressive",
    model: "mcu_curve",
    width: 7,
    shape: "curve",
    sigma: 1.75,
    oorMinutesWait: 15,
    cooldownHours: 1,
    sizingSol: 1.0,
    minTvl: 5000,
    minVolume: 2500,
    minOrganic: 60,
  },
  {
    id: 16,
    name: "Aggressive - Heart Attack",
    risk: "aggressive",
    model: "heart_attack",
    width: 5,
    shape: "flat",
    oorMinutesWait: 5,
    cooldownHours: 3,
    sizingSol: 0.5,
    minTvl: 2500,
    minVolume: 10000,
    minOrganic: 40,
  },
  {
    id: 17,
    name: "Aggressive - Bid-Ask Maker",
    risk: "aggressive",
    model: "spread_maker",
    width: 7,
    shape: "flat",
    oorMinutesWait: 15,
    cooldownHours: 1,
    sizingSol: 1.0,
    minTvl: 5000,
    minVolume: 5000,
    minOrganic: 60,
    dloOffsetBins: 5,
    dloWidthBins: 10,
  },
  {
    id: 18,
    name: "Aggressive - Drift Stabilizer",
    risk: "aggressive",
    model: "drift_stabilizer",
    width: 11,
    shape: "spot",
    skew: -0.5,
    oorMinutesWait: 30,
    cooldownHours: 1,
    sizingSol: 1.0,
    minTvl: 5000,
    minVolume: 2500,
    minOrganic: 60,
  },
];
