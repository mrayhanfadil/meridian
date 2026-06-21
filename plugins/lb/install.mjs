#!/usr/bin/env node
/**
 * Meridian Load-Balancer Plugin — Re-installer
 *
 * Patches tools/wallet.js + tools/dlmm.js + config.js with round-robin RPC/Helius
 * load balancing. Idempotent — safe to run multiple times.
 *
 * Source of truth: plugins/lb/patch.diff (generated from the original
 * upstream commit 600aac6 baseline).
 *
 * Usage:
 *   node plugins/lb/install.mjs           # check + apply if missing
 *   node plugins/lb/install.mjs --check   # check only, exit non-zero if LB missing
 *   node plugins/lb/install.mjs --force   # re-apply even if LB present (resets to upstream first)
 *   node plugins/lb/install.mjs --revert  # remove all LB code, restore upstream files
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PATCH_PATH = path.join(__dirname, "patch.diff");

const MARKER_WALLET = /nextRpcUrl\(\)/;          // injected by LB in wallet.js
const MARKER_DLMM   = /config\.nextRpcUrl/;      // injected by LB in dlmm.js
const MARKER_CONFIG = /export function nextRpcUrl/; // injected by LB in config.js
const MARKER_PROMPT = /bins_above = max\(8/;       // spot strategy fix in prompt.js

const WALLET_PATH = path.join(REPO_ROOT, "tools/wallet.js");
const DLMM_PATH   = path.join(REPO_ROOT, "tools/dlmm.js");
const CONFIG_PATH = path.join(REPO_ROOT, "config.js");
const PROMPT_PATH = path.join(REPO_ROOT, "prompt.js");

function read(p) { return fs.readFileSync(p, "utf8"); }

function lbInstalled() {
  if (!fs.existsSync(WALLET_PATH) || !fs.existsSync(DLMM_PATH) || !fs.existsSync(CONFIG_PATH) || !fs.existsSync(PROMPT_PATH)) {
    return false;
  }
  const wallet = read(WALLET_PATH);
  const dlmm   = read(DLMM_PATH);
  const config = read(CONFIG_PATH);
  const prompt = read(PROMPT_PATH);
  return MARKER_WALLET.test(wallet) && MARKER_DLMM.test(dlmm) && MARKER_CONFIG.test(config) && MARKER_PROMPT.test(prompt);
}

function shell(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString() };
  } catch (e) {
    return { ok: false, out: (e.stdout?.toString() || "") + (e.stderr?.toString() || ""), err: e };
  }
}

function applyPatch() {
  if (!fs.existsSync(PATCH_PATH)) {
    console.error(`✗ Patch file missing: ${PATCH_PATH}`);
    console.error(`  Regenerate with: cd ${REPO_ROOT} && git format-patch -1 HEAD --stdout > plugins/lb/patch.diff`);
    process.exit(2);
  }
  // First try a 3-way apply (works if upstream kept the original lines)
  const r = shell(`git apply --check --3way ${JSON.stringify(PATCH_PATH)}`);
  if (r.ok) {
    shell(`git apply --3way ${JSON.stringify(PATCH_PATH)}`);
    console.log("✓ LB patch applied (3-way)");
    return true;
  }
  // Fallback: straight apply
  const r2 = shell(`git apply --check ${JSON.stringify(PATCH_PATH)}`);
  if (r2.ok) {
    shell(`git apply ${JSON.stringify(PATCH_PATH)}`);
    console.log("✓ LB patch applied (straight)");
    return true;
  }
  console.error("✗ Patch does not apply cleanly. Conflicts:");
  console.error(r2.out || r.out);
  console.error("\nManual recovery:");
  console.error(`  1. cd ${REPO_ROOT}`);
  console.error(`  2. Inspect conflicts: git apply --check plugins/lb/patch.diff`);
  console.error(`  3. Resolve by hand or with: git apply --3way plugins/lb/patch.diff`);
  console.error(`  4. After resolving, run this script again to verify markers.`);
  process.exit(3);
}

function revert() {
  // Revert the three files to upstream (HEAD) — destructive, requires clean tree
  const r = shell(`git checkout HEAD -- tools/wallet.js tools/dlmm.js config.js prompt.js`);
  if (!r.ok) {
    console.error("✗ Could not revert. Is your working tree dirty?");
    console.error(r.out);
    process.exit(4);
  }
  console.log("✓ Reverted wallet.js, dlmm.js, config.js, prompt.js to upstream HEAD");
}

const args = process.argv.slice(2);
const mode = args[0];

if (mode === "--revert") {
  revert();
  process.exit(0);
}

if (mode === "--check") {
  if (lbInstalled()) {
    console.log("✓ LB installed (all 4 files patched)");
    process.exit(0);
  } else {
    console.log("✗ LB missing — run: node plugins/lb/install.mjs");
    process.exit(1);
  }
}

if (mode === "--force") {
  revert();
  applyPatch();
  process.exit(0);
}

// Default: idempotent install
if (lbInstalled()) {
  console.log("✓ LB already installed — no-op");
  process.exit(0);
}
applyPatch();
