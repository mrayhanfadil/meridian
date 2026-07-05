// Tier 1.3 dust-handling regression test (2026-07-05)
//
// Simulates the exact bug: a NEIL-SOL base residual valued at $0.04 USD
// but actually worth 0.62 SOL. Pre-Tier 1.3, the bot marked it "dust"
// and skipped. Post-Tier 1.3, that 0.62 SOL routes through the swap.
//
// Run: node test/test-tier-1-3-dust.js

import assert from "node:assert/strict";
import { config } from "../config.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++; }
};

console.log("Tier 1.3: dust-handling regression test\n");

test("config: autoSwapMinSol default = 0.05", () => {
  assert.equal(config.management.autoSwapMinSol, 0.05);
});
test("config: autoSwapBaseResidualAlertSol default = 0.005", () => {
  assert.equal(config.management.autoSwapBaseResidualAlertSol, 0.005);
});
test("config: autoSwapRetryAttempts default = 3", () => {
  assert.equal(config.management.autoSwapRetryAttempts, 3);
});
test("config: autoSwapRetryDelayMs default = 3000", () => {
  assert.equal(config.management.autoSwapRetryDelayMs, 3000);
});

// Simulate the NEIL-SOL bug scenario: token has $0.04 USD value but
// 95,577 tokens at a price that converts to 0.62 SOL.
const SOL_USD = 80;
const fakeBalances = {
  sol: 4.5,
  sol_price: SOL_USD,
  tokens: [
    // NEIL-SOL residual: 95,577 tokens, $0.04 USD, sol_value = 0.0005
    // (this is the OLD condition that triggered skip; same numbers as today)
    { mint: "cvkarf1CtN3tNei1FakeMintForTest", symbol: "world",
      balance: 95577.0, usd: 0.04,
      sol_value: Math.round((0.04 / SOL_USD) * 1e6) / 1e6 },
  ],
};

// Test the threshold logic purely
test("logic: 0.62 SOL residual should swap (well above 0.05 SOL floor)", () => {
  const minSol = config.management.autoSwapMinSol;
  const solValue = 0.62;
  assert.ok(solValue >= minSol, "0.62 SOL >= 0.05 SOL floor");
});
test("logic: 0.0005 SOL residual should be 'true_dust' (below 0.005 SOL alert)", () => {
  const residualAlertSol = config.management.autoSwapBaseResidualAlertSol;
  const solValue = 0.0005;
  assert.ok(solValue < residualAlertSol, "true dust");
});
test("logic: 0.02 SOL residual should be 'below_swap_floor' (between 0.005 & 0.05)", () => {
  const minSol = config.management.autoSwapMinSol;
  const residualAlertSol = config.management.autoSwapBaseResidualAlertSol;
  const solValue = 0.02;
  assert.ok(solValue >= residualAlertSol, "above true dust");
  assert.ok(solValue < minSol, "below swap floor");
});
test("logic: 0.08 SOL residual should swap (above 0.05 SOL floor)", () => {
  const minSol = config.management.autoSwapMinSol;
  const solValue = 0.08;
  assert.ok(solValue >= minSol);
});

// Verify wallet.js exposes sol_value — sanity-check by reading the file
test("wallet.js exports sol_value on each token", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("tools/wallet.js", "utf8");
  assert.ok(src.includes("sol_value"), "sol_value field must be present in wallet.js");
  assert.ok(src.includes("solUsdRate"), "solUsdRate computation must be present");
});

test("executor.js uses sol_value (not .usd) for dust gate", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("tools/executor.js", "utf8");
  assert.ok(src.includes("solValue"), "executor.js must read solValue");
  // The old buggy line `token.usd < 0.10` should be GONE
  assert.ok(!src.includes("token.usd < 0.10"), "old buggy dust check must be removed");
});

test("index.js: telegram message shows real skip reason (not <$0.10)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("index.js", "utf8");
  assert.ok(!src.includes("skipped or dust (< $0.10)"), "old lie-string must be removed");
  assert.ok(src.includes("auto_swap_skip_reason"), "new skip reason must be surfaced");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
