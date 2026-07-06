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
 *   3. Compute alert_state = ok | degraded | all_down.
 *   4. Auto-promote: if a lower tier than active has been healthy for
 *      `PROMOTE_REQUIRED_CONSECUTIVE` consecutive polls AND the active tier
 *      is currently above it, write state/auto-promote-{N}.flag for the
 *      lower tier. agent.js consumes the flag on its next ReAct step.
 *   5. Telegram alert: only send on STATE TRANSITIONS
 *      (ok→degraded, degraded→all_down, all_down→recovered).
 *      Poller is fire-and-forget — never blocks the cron.
 *
 * Invocation: node scripts/health-poller.js
 *   Typically via: cron job with schedule "every 5m"
 *
 * No external deps — uses Node built-ins + Hermes env (.env loaded via --env-file).
 */

import fs from "fs";
import path from "path";
import { setTimeout as wait } from "timers/promises";

// ─── Config ───────────────────────────────────────────────────────
const REPO_ROOT = process.cwd();
const STATE_DIR = path.join(REPO_ROOT, "state");
const HEALTH_FILE = path.join(STATE_DIR, "llm-health.json");
const PROMO_FLAG_PREFIX = path.join(STATE_DIR, "auto-promote-");
const ACTIVE_TIER_FILE = path.join(STATE_DIR, "active-tier.txt");

const PROMOTE_REQUIRED_CONSECUTIVE = 2;     // 2 healthy polls in a row
const ALERT_REQUIRED_CONSECUTIVE = 2;        // 2 failing polls before alert
const TIMEOUT_MS = 8000;
const ROLLING_WINDOW = 12;                   // last N samples per tier

// ─── Helpers ───────────────────────────────────────────────────────
function loadEnv() {
  // Read .env manually — keys with no shell-expansion guarantee.
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
    // Body sanity: must have choices[] with a message
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
    status: "unknown", // unknown | healthy | degraded | down
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
    const v = parseInt(fs.readFileSync(ACTIVE_TIER_FILE, "utf8").trim(), 10);
    if ([1, 2, 3].includes(v)) return v;
  } catch { /* default */ }
  if (process.env.OPENCODE_GO_API_KEY) return 1;
  if (process.env.DEEPSEEK_API_KEY) return 3;
  return 0;
}

function maybeWritePromoteFlag(lowerTier, state) {
  // Promote to lowerTier only if it's currently healthy and active tier is demoted.
  if (lowerTier < 1 || lowerTier > 3) return false;
  // Map tier-number → tier-name (key in state.tiers). The order matches
  // tierEndpoints() in main().
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

// ─── Telegram alerts via Hermes API (best-effort, never blocks) ───
async function telegramAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch { /* best-effort */ }
}

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

  // Probe each tier in parallel — independent endpoints, parallelism saves wall time.
  const results = await Promise.all(endpoints.map(async (e) => {
    if (!e.enabled) {
      return { tier: e.tier, name: e.name, sample: { ok: false, latency_ms: 0, status: null, err: "tier disabled (missing key)" } };
    }
    const sample = await ping(e.baseUrl, e.apiKey, e.model);
    return { tier: e.tier, name: e.name, sample, endpoint: e };
  }));

  // Update health per tier
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
    // Trim rolling window
    if (t.ok_count_12 + t.fail_count_12 > ROLLING_WINDOW) {
      const total = t.ok_count_12 + t.fail_count_12;
      const overflow = total - ROLLING_WINDOW;
      // Reduce ok first, then fail (rough trim — exact preservation isn't required)
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

  // Compute overall alert_state
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

  // Telegram: only on state transitions (not every run)
  const prevAlert = state.last_alert_state || "ok";
  if (alertState !== prevAlert) {
    const lines = [
      `🔁 <b>LLM tier health: ${prevAlert} → ${alertState}</b>`,
      "",
      ...Object.entries(state.tiers).map(([name, t]) => {
        const flag = t.last_err ? ` err=${t.last_err}` : "";
        return `  • <b>${name}</b>: ${t.status} (consec_ok=${t.consecutive_ok}, consec_fail=${t.consecutive_fail}, ${t.latency_ms_recent || "—"}ms${flag})`;
      }),
    ];
    if (promotedFlags.length) {
      lines.push("", `🔄 Auto-promote flag(s) written: tier ${promotedFlags.join(", ")}`);
    }
    await telegramAlert(lines.join("\n"));
    state.last_alert_state = alertState;
    saveHealth(state);
  }

  // Compact stdout for cron logs
  const summary = Object.entries(state.tiers)
    .map(([name, t]) => `${name}=${t.status}/lat=${t.latency_ms_recent || "—"}ms`)
    .join(" ");
  console.log(`[health-poller run #${state.runs}] tier=${activeTier} alert=${alertState} ${summary}${promotedFlags.length ? ` promoted=[${promotedFlags.join(",")}]` : ""}`);
}

main().catch((e) => {
  console.error("[health-poller] FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
