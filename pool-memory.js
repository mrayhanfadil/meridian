/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

import { repoPath } from "./repo-root.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");
const MAX_NOTE_LENGTH = 280;

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

function isFeeGeneratingDeploy(deploy) {
  const minFeeEarnedPct = Number(config.management.repeatDeployCooldownMinFeeEarnedPct ?? 0);
  const feeEarnedPct = Number(deploy.fee_earned_pct ?? 0);
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = (Number.isFinite(feesUsd) && feesUsd > 0) || (Number.isFinite(feesSol) && feesSol > 0);
  if (!hasFees) return false;
  return Number.isFinite(feeEarnedPct) && feeEarnedPct >= minFeeEarnedPct;
}

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const newUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const newDate = new Date(newUntil);
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      // Take the MAX of existing and new cooldown — never shorten an active ban.
      // This prevents a short "repeat deploys (2x)" cooldown from overwriting a
      // longer "chronic underperformance" cooldown that was set for the same mint.
      const existing = entry.base_mint_cooldown_until;
      const existingDate = existing ? new Date(existing) : null;
      if (!existingDate || newDate > existingDate) {
        entry.base_mint_cooldown_until = newUntil;
        entry.base_mint_cooldown_reason = reason;
      }
    }
  }
  return newUntil;
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    fees_earned_usd: deployData.fees_earned_usd ?? null,
    fees_earned_sol: deployData.fees_earned_sol ?? null,
    fee_earned_pct: deployData.fee_earned_pct ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
    entry_mcap: deployData.entry_mcap ?? null,
    entry_tvl: deployData.entry_tvl ?? null,
    entry_volume: deployData.entry_volume ?? null,
    exit_mcap: deployData.exit_mcap ?? null,
    exit_tvl: deployData.exit_tvl ?? null,
    exit_volume: deployData.exit_volume ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
    : 0;

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // Chronic-failure blacklist: block tokens with severe historical underperformance.
  // Replaces ad-hoc cooldowns that never fire on tokens like Goblin (11 deploys, 36% WR).
  // Triggers when total_deploys >= minSamples AND (win_rate < 40% OR avg_pnl < -1%).
  //
  // Aggregation note (added 2026-07-05): the same base_mint can have multiple pool
  // entries (different fee tiers / bin_steps), and per-pool deploys were undercounting
  // (e.g. BABYANSEM-SOL: 3+4 deploys, neither crosses the 5-deploy threshold alone).
  // Aggregate deploy count + win rate + avg PnL across all pool entries sharing this
  // base_mint before evaluating the criteria.
  const chronicBlacklistConfig = config.management.chronicBlacklist ?? {};
  const chronicEnabled = chronicBlacklistConfig.enabled !== false; // default on
  const chronicMinSamples = chronicBlacklistConfig.minSamples ?? 5;
  const chronicMaxWinRate = chronicBlacklistConfig.maxWinRate ?? 40;        // percentage
  const chronicMaxAvgPnl = chronicBlacklistConfig.maxAvgPnlPct ?? -1;      // percentage
  // NEW (2026-07-05): cumulative USD loss threshold — catches high-volume losers
  // whose WR/avgPnl hide small per-trade losses (e.g. world-SOL: 61% WR, avg +0.x%,
  // but -0.091 SOL cumulative = ~-$7.50 across 31 deploys).
  const chronicMaxCumulativePnlUsd = chronicBlacklistConfig.maxCumulativePnlUsd ?? -5;
  const chronicMinCumulativePnlSamples = chronicBlacklistConfig.minCumulativePnlSamples ?? 8;
  const chronicCooldownHours = chronicBlacklistConfig.cooldownHours ?? 168; // 7 days
  if (chronicEnabled && entry.base_mint) {
    // Aggregate across all pool entries sharing this base_mint
    let aggDeploys = 0;
    let aggWins = 0;
    let aggPnlSum = 0;
    let aggPnlCount = 0;
    let aggPnlUsdSum = 0;       // NEW: aggregate USD PnL across all deploys
    let aggPnlUsdCount = 0;     // NEW: count of deploys with pnl_usd data
    for (const e of Object.values(db)) {
      if (!e?.base_mint || e.base_mint !== entry.base_mint) continue;
      // Each pool entry has its own `deploys[]` array; count from those
      // (more reliable than per-pool `total_deploys` which can be stale across duplicates)
      const ds = Array.isArray(e.deploys) ? e.deploys : [];
      for (const d of ds) {
        if (d.pnl_pct == null) continue;
        aggDeploys += 1;
        if (d.pnl_pct >= 0) aggWins += 1;
        aggPnlSum += d.pnl_pct;
        aggPnlCount += 1;
        // NEW: also tally pnl_usd when available (always stored from recordPerformance)
        if (d.pnl_usd != null) {
          aggPnlUsdSum += d.pnl_usd;
          aggPnlUsdCount += 1;
        }
      }
    }
    if (aggDeploys >= chronicMinSamples && aggPnlCount > 0) {
      const wrPct = (aggWins / aggDeploys) * 100;
      const avgPnl = aggPnlSum / aggPnlCount;
      // NEW: cumulative USD check — fires when total USD damage exceeds threshold
      const cumUsdOk = aggPnlUsdCount >= chronicMinCumulativePnlSamples &&
                       aggPnlUsdSum <= chronicMaxCumulativePnlUsd;
      const wrOrAvgFailure = wrPct < chronicMaxWinRate || avgPnl <= chronicMaxAvgPnl;
      const chronicFailure = wrOrAvgFailure || cumUsdOk;
      if (chronicFailure) {
        const triggers = [];
        if (wrPct < chronicMaxWinRate) triggers.push(`${wrPct.toFixed(1)}% WR`);
        if (avgPnl <= chronicMaxAvgPnl) triggers.push(`${avgPnl.toFixed(2)}% avg PnL`);
        if (cumUsdOk) triggers.push(`$${aggPnlUsdSum.toFixed(2)} cumulative (${aggPnlUsdCount} deploys)`);
        const reason = `chronic underperformance (${triggers.join(" / ")} over ${aggDeploys} aggregated deploys across ${entry.name})`;
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, chronicCooldownHours, reason);
        log("pool-memory", `Chronic-failure blacklist set for ${entry.name} (${entry.base_mint.slice(0, 8)}) until ${mintCooldownUntil} (${reason})`);
      }
    }
  }

  // Set cooldown for low yield closes — pool wasn't profitable enough, don't redeploy soon
  if (deploy.close_reason === "low yield") {
    const cooldownHours = 4;
    const cooldownUntil = setPoolCooldown(entry, cooldownHours, "low yield");
    log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (low yield close)`);
  }

  const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = config.management.oorCooldownHours ?? 12;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorCloseReason(d.close_reason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = setPoolCooldown(entry, oorCooldownHours, reason);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, oorCooldownHours, reason);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }

  if (config.management.repeatDeployCooldownEnabled) {
    const triggerCount = Math.max(1, Number(config.management.repeatDeployCooldownTriggerCount ?? 3));
    const cooldownHours = Math.max(0, Number(config.management.repeatDeployCooldownHours ?? 12));
    const rawScope = String(config.management.repeatDeployCooldownScope || "token").toLowerCase();
    const scope = ["pool", "token", "both"].includes(rawScope) ? rawScope : "token";
    const recentRepeatDeploys = entry.deploys.slice(-triggerCount);
    // Trigger cooldown after N consecutive deploys regardless of fee generation.
    // The goal is to prevent recycling through the same failing pools.
    const repeatedDeploys =
      cooldownHours > 0 &&
      recentRepeatDeploys.length >= triggerCount;

    if (repeatedDeploys) {
      const reason = `repeat deploys (${triggerCount}x)`;
      if (scope === "pool" || scope === "both" || !entry.base_mint) {
        const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
        log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
        if (mintCooldownUntil) {
          log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
        }
      }
    }
  }

  // ── Tier 1.5: loss-triggered re-deploy cooldowns ──────────────────────────
  // Rationale (Jul 5 2026 audit): the chronic blacklist only fires after
  // 5+ samples. But the same token can be re-deployed within hours of a
  // losing trade before any aggregate threshold trips (e.g. NEIL-SOL was
  // deployed 5× today despite chronic blacklist being inert at that point).
  // These rules block the immediate re-deploy window after a known loss,
  // isolated by base_mint so they work across multiple pool entries.
  //
  //   rule-1:  every close below `-lossPnlPct` triggers a `lossCooldownHours`
  //            base_mint cooldown. Same-mint re-deply within that window is
  //            blocked. (Threshold below is the only tunable.)
  //   rule-2:  2+ same-mint losses within the last `lossWindowHours` escalate
  //            to an extended `escalatedCooldownHours` base_mint cooldown.
  //
  // Empirical FP table (Jul 5 2026 onchain SOL deltas):
  //   rule-1 alone:        blocks 2 deploys, 0 wins missed, saves +0.88 SOL
  //   rule-2 alone:        blocks 2 deploys, 0 wins missed, saves +0.14 SOL
  //   both together:       blocks the NEIL+0x+yep repeat-offender cluster
  //                        without harming profitable repeat plays.
  const tier15Cfg = config.management.tier15LossCooldown ?? {};
  const tier15Enabled = tier15Cfg.enabled !== false;
  if (tier15Enabled && entry.base_mint && deploy.pnl_pct != null) {
    const lossPnlPct = Number(tier15Cfg.lossPnlPct ?? -1.0);     //  -1% pnl counts as a "loss"
    const lossCooldownHours = Number(tier15Cfg.lossCooldownHours ?? 6);
    const lossWindowHours = Number(tier15Cfg.lossWindowHours ?? 12);
    const escalatedCooldownHours = Number(tier15Cfg.escalatedCooldownHours ?? 24);
    const lossWindowMs = lossWindowHours * 3600 * 1000;
    const pnlPctValue = Number(deploy.pnl_pct);

    if (Number.isFinite(pnlPctValue) && pnlPctValue <= lossPnlPct) {
      // rule-1: 6h base-mint cooldown on the just-recorded loss
      if (lossCooldownHours > 0) {
        const reason1 = `tier1.5 loss (${pnlPctValue.toFixed(2)}% ≤ ${lossPnlPct}% → ${lossCooldownHours}h re-deploy block)`;
        const cd1 = setBaseMintCooldown(db, entry.base_mint, lossCooldownHours, reason1);
        if (cd1) {
          log(
            "pool-memory",
            `tier1.5 rule-1: ${lossCooldownHours}h base_mint cooldown for ${entry.base_mint.slice(0, 8)} until ${cd1} (${reason1})`,
          );
        }
      }
      // rule-2: count losses for this mint inside the rolling window
      let lossesInWindow = 0;
      const nowMs = Date.now();
      for (const e of Object.values(db)) {
        if (e?.base_mint !== entry.base_mint) continue;
        for (const d of (e.deploys || [])) {
          if (d.pnl_pct == null) continue;
          if (Number(d.pnl_pct) > lossPnlPct) continue;
          const t = new Date(d.closed_at || d.deployed_at || 0).getTime();
          if (Number.isFinite(t) && nowMs - t <= lossWindowMs) {
            lossesInWindow += 1;
          }
        }
      }
      if (lossesInWindow >= 2 && escalatedCooldownHours > lossCooldownHours) {
        const reason2 = `tier1.5 escalation (${lossesInWindow} losses in ${lossWindowHours}h → ${escalatedCooldownHours}h ban)`;
        const cd2 = setBaseMintCooldown(db, entry.base_mint, escalatedCooldownHours, reason2);
        if (cd2) {
          log(
            "pool-memory",
            `tier1.5 rule-2: ${escalatedCooldownHours}h escalated base_mint cooldown for ${entry.base_mint.slice(0, 8)} until ${cd2} (${reason2})`,
          );
        }
      }
    }
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  return new Date(entry.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}
