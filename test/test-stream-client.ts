import "../envcrypt.js";
import { startPoolStream, stopPoolStream } from "../tools/dlmm/stream-client.js";

console.log("=== Testing Real-Time Free WebSocket Stream ===");

// We use the real pool address of ANSEM-SOL from config
const poolAddress = "51bq8gcfTcWJMYiuvnMh41RJY8sqW3czQQQPhsCDRM1o";

console.log("Subscribing to pool changes... (listening for 10 seconds)");

startPoolStream(poolAddress, (binId) => {
  console.log(`\n🔔 STREAM EVENT: Active Bin Changed ➔ ${binId}`);
});

setTimeout(() => {
  console.log("\nStopping stream subscription...");
  stopPoolStream();
  console.log("✅ Test complete!");
  process.exit(0);
}, 10000);
