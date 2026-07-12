import "../envcrypt.js";
import { deployDloBid, checkAndCompoundDloOrders } from "../tools/dlmm/dlo.js";

console.log("=== Testing DIY HawkFi DLO Engine (Meridian OS) ===");

const poolAddress = "51bq8gcfTcWJMYiuvnMh41RJY8sqW3czQQQPhsCDRM1o"; // ANSEM-SOL

console.log("\n1. Testing Simulated DLO Bid Deployment (DRY_RUN=true)...");
const bidResult = await deployDloBid({
  poolAddress,
  amount: 0.5, // 0.5 SOL
  offsetBins: 5,
  widthBins: 10, // width 10 + offset 5 = 15 total bins, satisfying the safety checks!
  silent: false,
});
console.log(`Bid Result: ${JSON.stringify(bidResult, null, 2)}`);

console.log("\n2. Testing Automated Scan & Compound Loop...");
await checkAndCompoundDloOrders(false);

console.log("\n✅ DLO Engine dry-run tests completed successfully!");
process.exit(0);
