/**
 * DIY HawkFi DLO Engine (Meridian OS)
 * Phase 5: Dynamic Limit Order (DLO) Bid-Accumulator Loop
 *
 * Implements a sovereign on-chain Bid-Accumulator Grid Bot using Meteora DLMM
 * single-sided SOL positions.
 *
 * Compliance: Fully respects Meridian's core safety invariant ("this agent only
 * supports single-side SOL deploys") by buying Token X cheap below the price,
 * and upon being filled, auto-swapping 100% of Token X back to SOL via Jupiter Swap V2,
 * and redeploying a larger SOL Bid order below the new active price!
 */

import { PublicKey } from "@solana/web3.js";
import { getWallet, swapToken } from "../wallet.js";
import { log } from "../../logger.js";
import { config } from "../../config.js";
import {
  deployPosition,
  closePosition,
  getActiveBin,
  getMyPositions,
} from "../dlmm.js";
import { getTrackedPositions, StoredPosition } from "../../state.js";

export interface DloDeployParams {
  poolAddress: string;
  amount: number; // SOL amount for bids
  offsetBins: number; // how many bins away from active bin to place the order
  widthBins: number; // width of the limit order range
  silent?: boolean;
}

export interface DloResult {
  success: boolean;
  position_address?: string;
  txs?: string[];
  error?: string;
}

/**
 * Deploys a single-sided Bid Limit Order (deposited as SOL, below price).
 * Only fills when the active price drops into/below our bins, converting SOL into Token X.
 */
export async function deployDloBid({
  poolAddress,
  amount,
  offsetBins,
  widthBins,
  silent = false,
}: DloDeployParams): Promise<DloResult> {
  const activeBin = await getActiveBin({ pool_address: poolAddress });
  
  // Calculate bin boundaries below the active bin
  const binsBelow = offsetBins + widthBins;
  const binsAbove = 0; // single-sided bid has zero bins above

  log("dlo", `Deploying DLO Bid order: ${amount} SOL, offset ${offsetBins} bins, width ${widthBins} bins below active bin ${activeBin.binId}`);
  if (!silent) console.log(`[DLO] Deploying Bid: ${amount} SOL centered below bin ${activeBin.binId}...`);

  const result = await deployPosition({
    pool_address: poolAddress,
    amount_sol: amount,
    strategy: "spot", // flat uniform single-sided spot
    bins_below: binsBelow,
    bins_above: binsAbove,
    silent,
  });

  if (result.success && result.position_address) {
    log("dlo", `DLO Bid order deployed successfully! Position: ${result.position_address.slice(0, 8)}`);
  }

  return {
    success: result.success,
    position_address: result.position_address,
    txs: result.txs,
    error: result.error,
  };
}

/**
 * Scans all active DLO Bid positions and checks if they are 100% filled (completely converted).
 * If filled, closes them, auto-swaps 100% of the claimed Token X back to SOL via Jupiter,
 * and redeploys a new Bid order below the current price to compound SOL!
 */
export async function checkAndCompoundDloOrders(silent = false): Promise<void> {
  try {
    const activePositions = getTrackedPositions(true); // open-only
    const { positions: onChainPositions } = await getMyPositions({ force: true, silent: true });

    for (const tracked of activePositions) {
      // Find matching on-chain data to check actual token ratios (X vs Y)
      const onChain = onChainPositions.find((p: any) => p.position === tracked.position);
      if (!onChain) continue;

      const label = tracked.position.slice(0, 8);
      const poolName = tracked.pool_name || tracked.pool;

      // Detect if Bid order is 100% filled (fully turned into Token X / base tokens)
      const isBidOrder = tracked.bin_range?.max && tracked.bin_range.max < (tracked.active_bin_at_deploy ?? 0);

      if (isBidOrder) {
        // A Bid order initially has 100% Token Y (SOL).
        // It is filled when Token Y = 0 and Token X > 0.
        const totalSol = Number(onChain.amount_y ?? onChain.amount_sol ?? 0);
        const totalX = Number(onChain.amount_x ?? 0);

        if (totalSol === 0 && totalX > 0) {
          log("dlo", `🔔 Bid Order ${label} in pool ${poolName.slice(0, 8)} is 100% FILLED (converted to ${totalX.toFixed(2)} Token X)!`);
          if (!silent) console.log(`\n🔔 [DLO] Bid Order ${label} is 100% FILLED! Preparing to claim and compound back to SOL...`);

          // 1. Close and claim Token X
          const closeResult = await closePosition({ position_address: tracked.position, reason: "DLO Bid Order Filled" });
          if (!closeResult.success) {
            log("dlo_error", `Failed to close filled Bid order ${label}: ${closeResult.error}`);
            continue;
          }

          // 2. Wait for transaction finality
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // 3. Swap 100% of claimed Token X back to SOL via Jupiter
          log("dlo", `Swapping ${totalX.toFixed(2)} Token X back to SOL...`);
          if (!silent) console.log(`[DLO] Swapping Token X back to SOL via Jupiter Swap...`);
          
          const swapResult = await swapToken({
            input_mint: tracked.base_mint || (onChain.base_mint as string),
            output_mint: (config.tokens as any).SOL,
            amount: totalX,
          });

          if (!swapResult.success || !swapResult.amount_out) {
            log("dlo_error", `Failed to swap claimed Token X back to SOL: ${swapResult.error}`);
            continue;
          }

          const receivedSol = swapResult.amount_out;
          log("dlo", `Successfully swapped! Received ${receivedSol.toFixed(4)} SOL`);
          if (!silent) console.log(`✅ Swapped successfully! Gained ${receivedSol.toFixed(4)} SOL`);

          // 4. Redeploy new Bid Order below the current price to compound our SOL
          const offset = Number((config as any).strategy?.dloOffsetBins ?? 10);
          const width = Number((config as any).strategy?.dloWidthBins ?? 10);

          log("dlo", `Redeploying compounded Bid order with ${receivedSol.toFixed(4)} SOL...`);
          await deployDloBid({
            poolAddress: tracked.pool,
            amount: receivedSol,
            offsetBins: offset,
            widthBins: width,
            silent,
          });
        }
      }
    }
  } catch (error: any) {
    log("dlo_error", `Failed in DLO scan cycle: ${error.message}`);
  }
}
