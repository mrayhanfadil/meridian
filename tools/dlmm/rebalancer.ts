/**
 * DIY HawkFi Rebalancer (Meridian OS)
 * Phase 3: In-Position Swapped/Swapless Rebalancer (AR Engine)
 *
 * Automatically monitors active bin, withdraws 100% of liquidity,
 * closes the old range, auto-calculates new custom curve weights,
 * and redeploys a new position centered on the fresh active bin.
 */

import { getWallet } from "../wallet.js";
import { getTrackedPosition, StoredPosition } from "../../state.js";
import { log } from "../../logger.js";
import { config } from "../../config.js";
import { closePosition, deployPosition, getActiveBin } from "../dlmm.js";
import { generateGaussianWeights, generateFlatWeights } from "../allocator-math.js";

export interface RebalanceParams {
  position_address: string;
  new_active_bin?: number | null;
  shape?: "curve" | "flat" | "spot";
  width?: number;
  silent?: boolean;
}

export interface RebalanceResult {
  success: boolean;
  old_position: string;
  new_position?: string;
  txs?: string[];
  error?: string;
}

/**
 * Executes a full atomic-style rebalance cycle:
 * Withdraw & Close old position ➔ Generate new shape weights ➔ Redeploy centered range
 */
export async function rebalancePosition({
  position_address,
  new_active_bin,
  shape = "curve",
  width,
  silent = false,
}: RebalanceParams): Promise<RebalanceResult> {
  const label = position_address.slice(0, 8);
  log("rebalancer", `🔄 Starting rebalance cycle for position ${label}...`);
  if (!silent) console.log(`=== Rebalancing Position ${label} ===`);

  try {
    const wallet = getWallet();
    const walletAddress = wallet.publicKey.toString();

    // 1. Fetch tracked metadata from state.json
    const tracked: StoredPosition | null = getTrackedPosition(position_address);
    if (!tracked) {
      throw new Error(`Position ${position_address} not found in local state tracker.`);
    }

    const poolAddress = tracked.pool;
    const poolName = tracked.pool_name || poolAddress;
    const currentSolAmount = tracked.amount_sol;

    // 2. Fetch fresh active bin of the pool
    let activeBinId = new_active_bin;
    if (activeBinId == null) {
      if (!silent) console.log("Fetching live active bin of the pool...");
      const binData = await getActiveBin({ pool_address: poolAddress });
      activeBinId = binData.binId;
    }
    
    log("rebalancer", `Live active bin for ${poolName.slice(0, 8)}: ${activeBinId}`);
    if (!silent) console.log(`Active Bin: ${activeBinId}`);

    // 3. Close the old position (Withdraws 100% of liquidity + auto-swaps fees to SOL)
    log("rebalancer", `Step 1: Closing old position ${label}...`);
    if (!silent) console.log(`Step 1: Closing old position to withdraw 100% capital...`);
    
    if (process.env.DRY_RUN === "true") {
      log("rebalancer", `[DRY RUN] Would close position ${label} and redeploy centered range.`);
      return { success: true, old_position: position_address, new_position: "DRY_RUN_NEW_POSITION" };
    }

    const closeResult = await closePosition({
      position_address,
      reason: `Auto-Rebalance: price moved from centered range. New active bin: ${activeBinId}`,
    });

    if (!closeResult.success) {
      throw new Error(`Failed to close old position ${label}: ${closeResult.error}`);
    }
    
    log("rebalancer", `Old position closed successfully!`);
    if (!silent) console.log(`✅ Old position closed! Waiting for RPC to reflect balances...`);

    // Wait 5 seconds for SOL/token balances to index in wallet
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 4. Generate custom shape weights
    const activeWidth = width ?? (tracked.bin_range?.max && tracked.bin_range?.min 
      ? tracked.bin_range.max - tracked.bin_range.min + 1 
      : 15); // default width 15
      
    const binsHalf = Math.floor(activeWidth / 2);
    const binsBelow = binsHalf;
    const binsAbove = binsHalf;

    let weights: number[] = [];
    if (shape === "curve") {
      weights = generateGaussianWeights(activeWidth);
    } else {
      weights = generateFlatWeights(activeWidth);
    }

    log("rebalancer", `Generated custom ${shape} weights for width ${activeWidth}: [${weights.slice(0, 3).join(",")}...]`);

    // 5. Deploy New Position centered on the new active bin
    log("rebalancer", `Step 2: Deploying new position centered at bin ${activeBinId}...`);
    if (!silent) console.log(`Step 2: Deploying new centered position...`);

    const deployResult = await deployPosition({
      pool_address: poolAddress,
      amount_sol: currentSolAmount, // redeploy with original SOL capital amount
      strategy: shape,
      bins_below: binsBelow,
      bins_above: binsAbove,
      custom_weights: weights,
      silent,
    });

    if (!deployResult.success || !deployResult.position_address) {
      throw new Error(`Failed to deploy new position: ${deployResult.error}`);
    }

    const newLabel = deployResult.position_address.slice(0, 8);
    log("rebalancer", `🎉 SUCCESS! Redeployed new position ${newLabel} centered at bin ${activeBinId}`);
    if (!silent) {
      console.log(`🎉 SUCCESS! Rebalanced from ${label} ➔ ${newLabel}`);
      console.log(`New centered bin range: ${activeBinId - binsBelow} to ${activeBinId + binsAbove}`);
    }

    return {
      success: true,
      old_position: position_address,
      new_position: deployResult.position_address,
      txs: [...(closeResult.txs || []), ...(deployResult.txs || [])],
    };
  } catch (error: any) {
    log("rebalancer_error", `Rebalance failed for ${position_address}: ${error.message}`);
    console.error(`❌ Rebalance failed: ${error.message}`);
    return { success: false, old_position: position_address, error: error.message };
  }
}
