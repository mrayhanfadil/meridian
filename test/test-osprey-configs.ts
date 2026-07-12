import { ospreyStrategies } from "../config/osprey-strategies.js";

console.log("=== Testing Osprey V2 18-Strategies Configurations ===");

console.log(`\nTotal configurations loaded: ${ospreyStrategies.length} (Expected: 18)`);

if (ospreyStrategies.length === 18) {
  console.log("✅ All 18 strategies loaded successfully!");
} else {
  console.log("❌ Incorrect number of strategies loaded.");
}

// Query all selective strategies
const selective = ospreyStrategies.filter(s => s.risk === "selective");
console.log(`\nSelective Strategies count: ${selective.length}`);
console.log(selective.map(s => ` - ${s.name} (width: ${s.width}, shape: ${s.shape})`).join("\n"));

// Query all aggressive strategies
const aggressive = ospreyStrategies.filter(s => s.risk === "aggressive");
console.log(`\nAggressive Strategies count: ${aggressive.length}`);
console.log(aggressive.map(s => ` - ${s.name} (width: ${s.width}, shape: ${s.shape})`).join("\n"));

process.exit(0);
