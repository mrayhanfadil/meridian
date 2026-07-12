#!/usr/bin/env node
/**
 * DIY HawkFi Harvester (Meridian OS)
 * Phase 1: Auto-Harvest & Auto-Accumulate (AA)
 *
 * Looks up active positions in state.json, checks if unclaimed fees cross
 * the threshold (default $5), claims fees, and auto-swaps the claimed non-SOL
 * tokens back to SOL using Jupiter Swap V2 API.
 *
 * Invocation: node scripts/diy-harvester.js
 */

import "../envcrypt.js"; // Decrypt env variables
import { config } from "../config.js";
import { log } from "../logger.js";
import { computePositions } from "../tools/pnl.js";
import { claimFees } from "../tools/dlmm.js";
import { swapToken, getWalletBalances } from "../tools/wallet.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

let _wallet = null;
function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

async function main() {
  log("harvester", "DIY Harvester cron tick started...");
  console.log("=== DIY HawkFi Harvester (Meridian OS) ===");
  
  try {
    const wallet = getWallet();
    const walletAddress = wallet.publicKey.toString();
    console.log(`Wallet Address: ${walletAddress}`);
    
    // 1. Fetch live active positions
    console.log("Fetching live positions from public RPC/Meteora...");
    const posData = await computePositions(walletAddress);
    const positions = posData.positions || [];
    console.log(`Found ${positions.length} active position(s).`);
    
    const claimMin = config.management?.minClaimAmount ?? 5;
    console.log(`Unclaimed fee threshold: $${claimMin}`);
    
    for (const p of positions) {
      const unclaimedUsd = p.unclaimed_fees_true_usd ?? 0;
      console.log(`Position ${p.position.slice(0, 8)} (${p.pair}): Unclaimed Fees = $${unclaimedUsd.toFixed(2)}`);
      
      if (unclaimedUsd >= claimMin) {
        console.log(`\n🔔 Threshold met! Claiming fees for position ${p.position}...`);
        log("harvester", `🔔 Triggering claim for ${p.position} in pool ${p.pool} (fees: $${unclaimedUsd.toFixed(2)})`);
        
        if (process.env.DRY_RUN === "true") {
          console.log(`[DRY RUN] Would claim fees for position ${p.position} and auto-swap to SOL.`);
          continue;
        }
        
        // 2. Claim fees on-chain
        const claimResult = await claimFees({ position_address: p.position });
        if (claimResult.success) {
          console.log(`✅ Claim successful! TXs: ${claimResult.txs.join(", ")}`);
          log("harvester", `Claim successful for ${p.position}. TX: ${claimResult.txs[0]}`);
          
          // Wait 5 seconds for block confirmation and indexers to catch up
          console.log("Waiting 5s for transaction confirmation and balance update...");
          await new Promise((resolve) => setTimeout(resolve, 5000));
          
          // 3. Fetch fresh wallet balances to detect claimed base token amount
          console.log("Refreshing wallet balances to find claimed tokens...");
          const balanceData = await getWalletBalances();
          const tokens = balanceData.tokens || [];
          
          // We want to swap the base token (Token X) to SOL
          const baseMint = claimResult.base_mint;
          if (!baseMint) {
            console.log("⚠️ base_mint not returned by claimFees, skipping auto-swap.");
            continue;
          }
          
          // Don't swap if base token is already SOL
          if (baseMint === config.tokens.SOL) {
            console.log("ℹ️ Base token is already SOL. No swap needed.");
            continue;
          }
          
          const tokenEntry = tokens.find((t) => t.mint === baseMint);
          if (tokenEntry && tokenEntry.balance > 0) {
            const amountToSwap = tokenEntry.balance;
            console.log(`🔄 Auto-swapping claimed fees: ${amountToSwap} ${tokenEntry.symbol} → SOL...`);
            log("harvester", `Swapping claimed fee balance: ${amountToSwap} ${tokenEntry.symbol} → SOL`);
            
            const swapResult = await swapToken({
              input_mint: baseMint,
              output_mint: config.tokens.SOL,
              amount: amountToSwap
            });
            
            if (swapResult.success) {
              console.log(`✅ Swap complete! TX: ${swapResult.tx}`);
              log("harvester", `Auto-swap complete for ${tokenEntry.symbol} → SOL. TX: ${swapResult.tx}`);
            } else {
              console.log(`❌ Swap failed: ${swapResult.error || "Unknown error"}`);
              log("harvester_error", `Swap failed for ${tokenEntry.symbol} → SOL: ${swapResult.error}`);
            }
          } else {
            console.log(`ℹ️ No wallet balance found for base token ${baseMint.slice(0, 8)} to swap.`);
          }
        } else {
          console.log(`❌ Claim failed: ${claimResult.error || "Unknown error"}`);
          log("harvester_error", `Claim failed for position ${p.position}: ${claimResult.error}`);
        }
      } else {
        console.log(`Staying in position ${p.position.slice(0, 8)} (fees below threshold).`);
      }
    }
    
    console.log("\n=== Harvester Cycle Finished ===");
    log("harvester", "DIY Harvester cycle finished successfully.");
    process.exit(0);
  } catch (error) {
    console.error(`Error in harvester execution: ${error.message}`);
    log("harvester_error", `Fatal error in harvester: ${error.message}`);
    process.exit(1);
  }
}

main();
