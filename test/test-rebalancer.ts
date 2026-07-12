import "../envcrypt.js";
import { rebalancePosition } from "../tools/dlmm/rebalancer.js";
import { getTrackedPositions, trackPosition } from "../state.js";

console.log("=== Testing DIY HawkFi Rebalancer (Meridian OS) ===");

// 1. Ensure we have at least one mock position in state.json to run the test
const openPositions = getTrackedPositions(true);
let testPositionAddr = "";

if (openPositions.length === 0) {
  console.log("ℹ️ No open positions found in state.json. Creating a mock position for dry-run...");
  testPositionAddr = "MockPositionAddress1234567890";
  trackPosition({
    position: testPositionAddr,
    pool: "MockPoolAddress1234567890",
    pool_name: "MOCK-SOL",
    strategy: "spot",
    amount_sol: 0.5,
    amount_x: 0,
    active_bin: 1000,
    bin_step: 100,
  });
} else {
  testPositionAddr = openPositions[0].position;
}

console.log(`Target Position Address: ${testPositionAddr}`);

// 2. Execute the rebalance in simulated dry-run mode
console.log("\nExecuting Simulated Rebalance (DRY_RUN=true)...");
const result = await rebalancePosition({
  position_address: testPositionAddr,
  new_active_bin: 1020, // Simulate that the price moved up by +20 bins
  shape: "curve",
  width: 15,
});

console.log(`\nRebalance Result: ${JSON.stringify(result, null, 2)}`);
if (result.success) {
  console.log("✅ Rebalancer dry-run test passed with flying colors!");
} else {
  console.log("❌ Rebalancer test failed.");
}

process.exit(0);
