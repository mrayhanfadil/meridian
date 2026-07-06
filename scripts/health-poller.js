#!/usr/bin/env node
/**
 * Health poller for the 3-tier LLM chain.
 *
 * Tier topology (mirrors agent.js):
 *   1: OpenCode Go → deepseek-v4-flash
 *   2: OpenCode Go → mimo-v2.5
 *   3: Direct DeepSeek → DEEPSEEK_MODEL
 *
 * Each tick:
 *   1. Ping each tier's chat/completions endpoint with a tiny "ping" prompt.
 *   2. Update state/llm-health.json with per-tier rolling-12-sample window
 *      (ok_count, fail_count, latency_ms, last_ok_at, last_fail_at, status).
 *   3. Auto-promote: if a tier was demoted AND lower tiers are healthy for
 *      ≥2 consecutive polls, write state/auto-promote-{N}.flag so agent.js
 *      flips currentTier up on its next ReAct step.
 *
 * Telegram alerts: DISABLED 2026-07-06 (per Fadil). The poller keeps running
 * silently — auto-promote still happens, just no notifications.
 *
 * Invocation: node scripts/health-poller.js
 *   Typically via: cron job with schedule "every 5m"
 *
 * No external deps — uses Node built-ins + .env loaded inline.
 */

import fs from "fs";
import path from "path";

// ─── Config ───────────────────────────────────────────────────────
const REPO_ROOT = process.cwd();
const STATE_DIR = path.join(REPO_ROOT, "state");
const HEALTH_FILE = path.join(STATE_DIR, "llm-health.json");
const PROMO_FLAG_PREFIX = path.join(STATE_DIR, "auto-promote-");

const PROMOTE_REQUIRED_CONSECUTIVE = 2;
const TIMEOUT_MS = 8000;
const ROLLING_WINDOW = 12;
// ENABLE_TELEGRAM=false — alerts disabled per Fadil (2026-07-06).
const ENABLE_TELEGRAM = false;

// ─── Helpers ───────────────────────────────────────────────────────
function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* no .env — fine in test */ }
}

async function ping(baseUrl, apiKey, model) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with one word: PONG" }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latency_ms: latency, status: res.status, err: `HTTP ${res.status}` };
    }
    const body = await res.json();
    if (!body?.choices?.length) {
      return { ok: false, latency_ms: latency, status: res.status, err: "empty choices[]" };
    }
    return { ok: true, latency_ms: latency, status: res.status };
  } catch (e) {
    const latency = Date.now() - start;
    let err = e?.name === "AbortError" ? `timeout>${TIMEOUT_MS}ms` : e?.code || e?.message || String(e);
    return { ok: false, latency_ms: latency, status: null, err };
  } finally {
    clearTimeout(timer);
  }
}

function tierEndpoints() {
  return [
    {
      tier: 1,
      name: "opencode-v4-flash",
      baseUrl: process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/zen/go/v1",
      apiKey: process.env.OPENCODE_GO_API_KEY || "",
      model: process.env.OPENCODE_GO_PRIMARY_MODEL || "deepseek-v4-flash",
      enabled: !!process.env.OPENCODE_GO_API_KEY,
    },
    {
      tier: 2,
      name: "opencode-mimo-v2.5",
      baseUrl: process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/zen/go/v1",
      apiKey: process.env.OPENCODE_GO_API_KEY || "",
      model: process.env.OPENCODE_GO_FALLBACK_MODEL || "mimo-v2.5",
      enabled: !!process.env.OPENCODE_GO_API_KEY,
    },
    {
      tier: 3,
      name: "direct-deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      enabled: !!process.env.DEEPSEEK_API_KEY,
    },
  ];
}

function emptyTier(name) {
  return {
    name,
    ok_count_12: 0,
    fail_count_12: 0,
    consecutive_ok: 0,
    consecutive_fail: 0,
    last_sample_ok: null,
    last_ok_at: null,
    last_fail_at: null,
    latency_ms_recent: null,
    last_err: null,
    status: "unknown",
  };
}

function loadHealth() {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf8"));
  } catch {
    return { tiers: {}, last_alert_state: "ok", last_run_at: null, runs: 0 };
  }
}

function saveHealth(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(state, null, 2));
}

function classifyTier(t) {
  if (t.ok_count_12 + t.fail_count_12 < 1) return "unknown";
  if (t.consecutive_fail >= 3) return "down";
  if (t.consecutive_fail >= 1) return "degraded";
  if (t.consecutive_ok >= 1 && t.ok_count_12 >= t.fail_count_12) return "healthy";
  return "unknown";
}

function getActiveTier() {
  try {
    const v = parseInt(fs.readFileSync(path.join(STATE_DIR, "active-tier.txt"), "utf8").trim(), 10);
    if ([1, 2, 3].includes(v)) return v;
  } catch { /* default */ }
  if (process.env.OPENCODE_GO_API_KEY) return 1;
  if (process.env.DEEPSEEK_API_KEY) return 3;
  return 0;
}

function maybeWritePromoteFlag(lowerTier, state) {
  if (lowerTier < 1 || lowerTier > 3) return false;
  const nameByTier = { 1: "opencode-v4-flash", 2: "opencode-mimo-v2.5", 3: "direct-deepseek" };
  const t = state.tiers[nameByTier[lowerTier]];
  if (!t || t.status !== "healthy") return false;
  if (t.consecutive_ok < PROMOTE_REQUIRED_CONSECUTIVE) return false;
  const flag = `${PROMO_FLAG_PREFIX}${lowerTier}.flag`;
  if (fs.existsSync(flag)) return false;
  try {
    fs.writeFileSync(flag, `promote=${lowerTier} at=${new Date().toISOString()}\n`);
    return true;
  } catch { return false; }
}

// Telegram helper kept for future opt-in (Fadil can flip ENABLE_TELEGRAM=true).
async function telegramAlert(_text) { /* no-op — disabled 2026-07-06 per Fadil */ }

// ─── Main tick ───────────────────────────────────────────────────
async function main() {
  loadEnv();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const state = loadHealth();
  state.runs = (state.runs || 0) + 1;
  state.last_run_at = new Date().toISOString();

  const endpoints = tierEndpoints();
  const activeTier = getActiveTier();
  state.active_tier_last_seen = activeTier;

  const results = await Promise.all(endpoints.map(async (e) => {
    if (!e.enabled) {
      return { tier: e.tier, name: e.name, sample: { ok: false, latency_ms: 0, status: null, err: "tier disabled (missing key)" } };
    }
    const sample = await ping(e.baseUrl, e.apiKey, e.model);
    return { tier: e.tier, name: e.name, sample, endpoint: e };
  }));

  for (const r of results) {
    const t = state.tiers[r.name] || emptyTier(r.name);
    const ok = r.sample.ok;
    if (ok) {
      t.ok_count_12++;
      t.consecutive_ok++;
      t.consecutive_fail = 0;
      t.last_ok_at = new Date().toISOString();
      t.latency_ms_recent = r.sample.latency_ms;
      t.last_err = null;
    } else {
      t.fail_count_12++;
      t.consecutive_fail++;
      t.consecutive_ok = 0;
      t.last_fail_at = new Date().toISOString();
      t.last_err = r.sample.err || r.sample.status || "unknown";
    }
    t.last_sample_ok = ok;
    if (t.ok_count_12 + t.fail_count_12 > ROLLING_WINDOW) {
      const total = t.ok_count_12 + t.fail_count_12;
      const overflow = total - ROLLING_WINDOW;
      if (t.fail_count_12 >= overflow) t.fail_count_12 -= overflow;
      else { overflow -= t.fail_count_12; t.fail_count_12 = 0; t.ok_count_12 = Math.max(0, t.ok_count_12 - overflow); }
    }
    t.status = classifyTier(t);
    state.tiers[r.name] = t;
  }

  // Auto-promote lower healthy tiers (when active is higher)
  let promotedFlags = [];
  for (const candidate of [1, 2, 3]) {
    if (candidate < activeTier && maybeWritePromoteFlag(candidate, state)) {
      promotedFlags.push(candidate);
    }
  }

  // Compute overall state (kept for telemetry — no longer drives Telegram)
  const statuses = Object.values(state.tiers).map(t => t.status);
  let alertState = "ok";
  if (statuses.length > 0 && statuses.every(s => s === "down" || s === "unknown")) {
    alertState = "all_down";
  } else if (statuses.some(s => s === "down")) {
    alertState = "down_some";
  } else if (statuses.every(s => s === "degraded")) {
    alertState = "all_degraded";
  } else if (statuses.some(s => s === "degraded")) {
    alertState = "degraded";
  }
  state.alert_state = alertState;
  saveHealth(state);

  // Telegram path retained as no-op. To re-enable: set ENABLE_TELEGRAM=true and
  // (optionally) wire the transition detector that existed in earlier commits.
  void telegramAlert;
  void ENABLE_TELEGRAM;

  const summary = Object.entries(state.tiers)
    .map(([name, t]) => `${name}=${t.status}/lat=${t.latency_ms_recent || "—"}ms`)
    .join(" ");
  console.log(`[health-poller run #${state.runs}] tier=${activeTier} alert=${alertState} ${summary}${promotedFlags.length ? ` promoted=[${promotedFlags.join(",")}]` : ""}`);
}

main().catch((e) => {
  console.error("[health-poller] FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
