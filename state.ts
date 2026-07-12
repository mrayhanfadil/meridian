/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE: string = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text: string | null | undefined, maxLen = MAX_INSTRUCTION_LENGTH): string | null {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

// ─── Interfaces for Strict Typing ──────────────────────────────

export interface StoredPosition {
  position: string;
  pool: string;
  pool_name?: string;
  strategy: string;
  bin_range?: { min?: number | null; max?: number | null; active?: number | null };
  amount_sol: number;
  amount_x: number;
  initial_sol: number;
  active_bin_at_deploy?: number | null;
  bin_step?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  initial_fee_tvl_24h?: number;
  organic_score?: number;
  initial_value_usd?: number;
  entry_mcap?: number | null;
  entry_tvl?: number | null;
  entry_volume?: number | null;
  entry_holders?: number | null;
  entry_sol_usd?: number | null;
  entry_gas_sol?: number | null;
  entry_slippage_pct?: number | null;
  signal_snapshot?: any;
  deployed_at?: string;
  out_of_range_since: string | null;
  last_claim_at: string | null;
  total_fees_claimed_usd: number;
  rebalance_count: number;
  closed: boolean;
  closed_at: string | null;
  notes: string[];
  peak_pnl_pct?: number;
  pending_peak_pnl_pct?: number | null;
  pending_peak_confirm_count?: number;
  pending_peak_started_at?: string | null;
  trough_pnl_pct?: number;
  pending_trough_pnl_pct?: number | null;
  pending_trough_confirm_count?: number;
  pending_trough_started_at?: string | null;
  pending_exit_action?: string | null;
  pending_exit_count?: number;
  pending_exit_started_at?: string | null;
  trailing_active?: boolean;
  instruction?: string | null;
  close_metrics?: any;
  close_metrics_recorded_at?: string;
}

export interface AgentState {
  positions: { [address: string]: StoredPosition };
  recentEvents: any[];
  lastUpdated: string | null;
  _lastBriefingDate?: string;
}

function load(): AgentState {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err: any) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
}

function save(state: AgentState): void {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err: any) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

export interface TrackPositionParams {
  position: string;
  pool: string;
  pool_name?: string;
  strategy: string;
  bin_range?: { min?: number | null; max?: number | null; active?: number | null };
  amount_sol: number;
  amount_x?: number;
  active_bin?: number | null;
  bin_step?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
  initial_value_usd?: number;
  signal_snapshot?: any;
  entry_mcap?: number | null;
  entry_tvl?: number | null;
  entry_volume?: number | null;
  entry_holders?: number | null;
  entry_sol_usd?: number | null;
  entry_gas_sol?: number | null;
  entry_slippage_pct?: number | null;
}

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  entry_sol_usd = null,
  entry_gas_sol = null,
  entry_slippage_pct = null,
}: TrackPositionParams): void {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    initial_sol: amount_sol,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    entry_sol_usd,
    entry_gas_sol,
    entry_slippage_pct,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    trough_pnl_pct: 0,
    pending_trough_pnl_pct: null,
    pending_trough_confirm_count: 0,
    pending_trough_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}` + (entry_gas_sol != null ? ` (gas=${entry_gas_sol.toFixed(6)} SOL)` : ""));
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address: string): number {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address: string, fees_usd?: number): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state: AgentState, event: any): void {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address: string, reason: string, metrics?: any): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();

  if (metrics && typeof metrics === "object") {
    const clean: any = {};
    for (const k of [
      "pnl_sol",
      "pnl_usd",
      "pnl_pct",
      "initial_value_usd",
      "final_value_usd",
      "fees_usd",
      "slippage_pct",
      "wallet_sol_after",
      "wallet_usd_after",
      "trough_pnl_pct",
      "peak_pnl_pct",
      "source",
    ]) {
      if (metrics[k] !== undefined && metrics[k] !== null && Number.isFinite(metrics[k])) {
        clean[k] = metrics[k];
      } else if (k === "source" && typeof metrics[k] === "string") {
        clean[k] = metrics[k];
      }
    }
    if (Object.keys(clean).length > 0) {
      pos.close_metrics = clean;
      pos.close_metrics_recorded_at = new Date().toISOString();
    }
  }

  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, {
    action: "close",
    position: position_address,
    pool_name: pos.pool_name || pos.pool,
    reason,
    metrics: pos.close_metrics || null,
  });
  save(state);
  log(
    "state",
    `Position ${position_address} marked closed: ${reason}` +
      (pos.close_metrics?.pnl_sol != null
        ? ` | pnl_sol=${pos.close_metrics.pnl_sol.toFixed(4)} pnl_pct=${
            pos.close_metrics.pnl_pct != null ? pos.close_metrics.pnl_pct.toFixed(2) : "n/a"
          }% source=${pos.close_metrics.source || "unknown"}`
        : "")
  );
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address: string, instruction: string | null): boolean {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls.
 */
export function confirmPeak(position_address: string, candidatePnlPct: number | null | undefined, confirmTicks = 2): boolean {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Trough (lowest PnL ever seen) tracking with consecutive-tick confirmation.
 */
export function confirmTrough(position_address: string, candidatePnlPct: number | null | undefined, confirmTicks = 2): boolean {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  if (candidatePnlPct >= 0) return false;

  const currentTrough = pos.trough_pnl_pct ?? 0;
  if (candidatePnlPct >= currentTrough) {
    if (pos.pending_trough_pnl_pct != null) {
      pos.pending_trough_pnl_pct = null;
      pos.pending_trough_confirm_count = 0;
      save(state);
    }
    return false;
  }

  if (pos.pending_trough_pnl_pct != null && candidatePnlPct <= pos.pending_trough_pnl_pct) {
    pos.pending_trough_confirm_count = (pos.pending_trough_confirm_count ?? 1) + 1;
    pos.pending_trough_pnl_pct = candidatePnlPct;
  } else {
    pos.pending_trough_pnl_pct = candidatePnlPct;
    pos.pending_trough_confirm_count = 1;
    pos.pending_trough_started_at = new Date().toISOString();
  }

  if (pos.pending_trough_confirm_count >= confirmTicks) {
    pos.trough_pnl_pct = Math.min(currentTrough, pos.pending_trough_pnl_pct);
    pos.pending_trough_pnl_pct = null;
    pos.pending_trough_confirm_count = 0;
    pos.pending_trough_started_at = null;
    save(state);
    log("state", `Position ${position_address} trough PnL confirmed at ${pos.trough_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

export interface ExitSignalResult {
  fire: boolean;
  action: string | null;
  count: number;
}

export function registerExitSignal(position_address: string, signal: string | null | undefined, confirmTicks = 2): ExitSignalResult {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false): StoredPosition[] {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address: string): StoredPosition | null {
  const state = load();
  return state.positions[position_address] || null;
}

export interface StateSummary {
  open_positions: number;
  closed_positions: number;
  total_fees_claimed_usd: number;
  positions: any[];
  last_updated: string | null;
  recent_events: any[];
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary(): StateSummary {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

export interface CheckExitResult {
  action: string;
  reason: string;
  needs_confirmation?: boolean;
  pnl_usd?: number;
  target_usd?: number;
  current_pnl_pct?: number | null;
  peak_pnl_pct?: number;
  drop_from_peak_pct?: number;
  effective_drop_pct?: number;
  final_close_pct?: number;
  floor_clamped?: boolean;
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 */
export function updatePnlAndCheckExits(
  position_address: string,
  positionData: any,
  mgmtConfig: any
): CheckExitResult | null {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Absolute USD profit close ──────────────────────────────────
  if (
    !pnl_pct_suspicious &&
    mgmtConfig.profitCloseEnabled &&
    mgmtConfig.profitCloseUsd != null &&
    positionData?.pnl_usd != null
  ) {
    const solPrice = mgmtConfig._liveSolPrice || mgmtConfig.solUsdFallback || 150;
    const pnlUsdForRule = mgmtConfig.solMode
      ? positionData.pnl_usd * solPrice
      : positionData.pnl_usd;
    if (pnlUsdForRule >= mgmtConfig.profitCloseUsd) {
      return {
        action: "PROFIT_TARGET",
        reason: `Profit target hit: $${pnlUsdForRule.toFixed(2)} >= $${mgmtConfig.profitCloseUsd} (PnL ${currentPnlPct?.toFixed(2) ?? "?"}%)`,
        needs_confirmation: true,
        pnl_usd: pnlUsdForRule,
        target_usd: mgmtConfig.profitCloseUsd,
        current_pnl_pct: currentPnlPct,
      };
    }
  }

  // ── Trailing TP (time-decay, breakeven-clamped) ──────────────────
  if (!pnl_pct_suspicious && pos.trailing_active && currentPnlPct != null && pos.peak_pnl_pct != null) {
    let effectiveDropPct = mgmtConfig.trailingDropPct;
    if (positionData?.age_minutes != null) {
      if (positionData.age_minutes < 60) {
        effectiveDropPct = mgmtConfig.trailingDropPct * 0.5; // 1.25% if base=2.5%
      } else if (positionData.age_minutes < 240) {
        effectiveDropPct = mgmtConfig.trailingDropPct * 0.75; // 1.875% if base=2.5%
      } else {
        effectiveDropPct = mgmtConfig.trailingDropPct; // 2.5% (base)
      }
    }
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= effectiveDropPct) {
      const rawClosePct = pos.peak_pnl_pct - effectiveDropPct;
      const breakevenFloorPct = 0;
      const finalClosePct = Math.max(rawClosePct, breakevenFloorPct);
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${effectiveDropPct.toFixed(2)}% [base ${mgmtConfig.trailingDropPct}%]; close clamped to breakeven floor ${breakevenFloorPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
        effective_drop_pct: effectiveDropPct,
        final_close_pct: finalClosePct,
        floor_clamped: finalClosePct > rawClosePct,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield ──────────────────────────────────────────────────
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

/**
 * Check if a position's yield has decayed significantly from deploy.
 */
export function checkYieldDecay(
  position_address: string,
  positionData: any,
  mgmtConfig: any
): CheckExitResult | null {
  const decayConfig = mgmtConfig.yieldDecayCheck;
  if (!decayConfig?.enabled) return null;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  const deployYield = pos.signal_snapshot?.fee_tvl_ratio ?? pos.initial_fee_tvl_24h;
  const currentYield = positionData.fee_per_tvl_24h;
  const ageMinutes = positionData.age_minutes ?? 0;

  if (deployYield == null || currentYield == null) return null;
  if (ageMinutes < (decayConfig.minAgeMinutes ?? 20)) return null;

  const minDeployYield = decayConfig.maxYieldPct ?? 40;
  if (deployYield < minDeployYield) return null;  // skip low-yield deploys

  const dropPct = ((deployYield - currentYield) / deployYield) * 100;
  const minDrop = decayConfig.minDropPct ?? 35;

  if (dropPct >= minDrop) {
    return {
      action: "YIELD_DECAY",
      reason: `Yield decay: ${currentYield.toFixed(2)}% (dropped ${dropPct.toFixed(1)}% from deploy ${deployYield.toFixed(2)}%, age: ${ageMinutes}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate(): string | null {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate(): void {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

// ─── State Sync ────────────────────────────────────────────────

const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses: string[]): void {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
