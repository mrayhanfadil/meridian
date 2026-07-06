import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

// Meridian LLM topology (2026-07-06 refactor):
//   tier 1: OpenCode Go → ${OPENCODE_GO_PRIMARY_MODEL}    (default deepseek-v4-flash)
//   tier 2: OpenCode Go → ${OPENCODE_GO_FALLBACK_MODEL}   (default mimo-v2.5)
//   tier 3: DEEPSEEK_BASE_URL direct (api.deepseek.com or self-hosted gateway)
//   tier 0 (legacy fallback only): LLM_BASE_URL gateway (openrouter/etc.)
// Auto-promote: scripts/health-poller.js observes tier health and writes
// state/auto-promote-N.flag when a lower tier recovers; consumeAutoPromoteFlag()
// reads and deletes the flag once per ReAct step to flip currentTier back to a
// higher tier without restart. Active tier is persisted in state/active-tier.txt.

import fs from "fs";
import path from "path";
import { repoPath } from "./repo-root.js";

// Direct DeepSeek client (always tier 3).
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const hasDeepSeek = !!DEEPSEEK_KEY;

// Legacy gateway (used only when opencode is disabled AND direct deepseek has no key).
const legacyClient = hasDeepSeek
  ? null
  : new OpenAI({
      baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "",
      timeout: 20 * 1000,
    });

const directDeepseekClient = hasDeepSeek
  ? new OpenAI({ baseURL: DEEPSEEK_BASE, apiKey: DEEPSEEK_KEY, timeout: 20 * 1000 })
  : null;

// OpenCode Go clients (tiers 1 & 2). Both share the OPENCODE_GO_API_KEY but route
// to different models through the same gateway. Built lazily so an unset key
// doesn't add an unused client.
const opencodeCfg = {
  baseUrl:      process.env.OPENCODE_GO_BASE_URL    || "https://opencode.ai/zen/go/v1",
  primaryModel: process.env.OPENCODE_GO_PRIMARY_MODEL  || "deepseek-v4-flash",
  fallbackModel:process.env.OPENCODE_GO_FALLBACK_MODEL || "mimo-v2.5",
  apiKey:       process.env.OPENCODE_GO_API_KEY     || "",
};
const opencodeEnabled = !!opencodeCfg.apiKey;
const opencodePrimaryClient  = opencodeEnabled
  ? new OpenAI({ baseURL: opencodeCfg.baseUrl, apiKey: opencodeCfg.apiKey, timeout: 20 * 1000 })
  : null;
const opencodeFallbackClient = opencodeEnabled
  ? new OpenAI({ baseURL: opencodeCfg.baseUrl, apiKey: opencodeCfg.apiKey, timeout: 20 * 1000 })
  : null;

// Default model — OpenCode primary if enabled, direct DeepSeek, then legacy gateway.
const DEFAULT_MODEL = opencodeEnabled
  ? opencodeCfg.primaryModel
  : (hasDeepSeek ? DEEPSEEK_MODEL : (process.env.LLM_MODEL || "openrouter/healer-alpha"));

// Active tier state. Settable at runtime via consumeAutoPromoteFlag().
// Default: 1 if opencode enabled, else 3 (direct deepseek), else 0 (legacy).
function initialTier() {
  if (opencodeEnabled) return 1;
  if (hasDeepSeek) return 3;
  return 0;
}
let currentTier = initialTier();

const ACTIVE_TIER_FILE = repoPath("state/active-tier.txt");
const PROMOTE_FLAG_PREFIX = repoPath("state/auto-promote-");
function loadActiveTier() {
  try {
    if (fs.existsSync(ACTIVE_TIER_FILE)) {
      const v = parseInt(fs.readFileSync(ACTIVE_TIER_FILE, "utf8").trim(), 10);
      if (!Number.isNaN(v) && v >= 0 && v <= 3) {
        currentTier = v;
        return;
      }
    }
  } catch { /* ignore — fall through to set */ }
  setActiveTier(initialTier());
}
function setActiveTier(n) {
  currentTier = n;
  try {
    fs.mkdirSync(path.dirname(ACTIVE_TIER_FILE), { recursive: true });
    fs.writeFileSync(ACTIVE_TIER_FILE, String(n));
  } catch { /* non-fatal */ }
}
// consumeAutoPromoteFlag(): if health-poller wrote state/auto-promote-N.flag
// for a tier lower than currentTier, demote to that tier (the LLM is healthy
// again, agent should use it). One-shot — flag deleted on consume.
function consumeAutoPromoteFlag() {
  if (!fs.existsSync(path.dirname(PROMOTE_FLAG_PREFIX))) return;
  for (const candidate of [1, 2, 3]) {
    const flag = `${PROMOTE_FLAG_PREFIX}${candidate}.flag`;
    if (fs.existsSync(flag)) {
      try { fs.unlinkSync(flag); } catch { /* best-effort */ }
      if (candidate <= currentTier) {
        log("agent", `Auto-promote: tier ${currentTier} → tier ${candidate} (health-poller recovered)`);
        setActiveTier(candidate);
      }
      return; // process one flag per call
    }
  }
}
loadActiveTier();

// Resolve the active tier → { client, model, baseUrl, name }. Pure lookup.
function resolveActiveClients() {
  switch (currentTier) {
    case 1:
      return { client: opencodePrimaryClient, model: opencodeCfg.primaryModel,
               baseUrl: opencodeCfg.baseUrl, name: `opencode-prim(${opencodeCfg.primaryModel})` };
    case 2:
      return { client: opencodeFallbackClient, model: opencodeCfg.fallbackModel,
               baseUrl: opencodeCfg.baseUrl, name: `opencode-fb(${opencodeCfg.fallbackModel})` };
    case 3:
      return { client: directDeepseekClient, model: DEEPSEEK_MODEL,
               baseUrl: DEEPSEEK_BASE, name: `direct-deepseek(${DEEPSEEK_MODEL})` };
    case 0:
    default:
      return { client: legacyClient, model: process.env.LLM_MODEL || "openrouter/healer-alpha",
               baseUrl: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
               name: `legacy-gateway(${process.env.LLM_MODEL || "openrouter/healer-alpha"})` };
  }
}

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

function isThinkingModeToolChoiceError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /thinking mode does not support/i.test(message) && /tool_choice/i.test(message);
}

// Some gateways (e.g. opencode-zen "Console Go") wrap tool_choice rejection as
// "Upstream request failed" without echoing "tool_choice"/"required" in the body.
// Detect the 400 + tool_choice=required combination as a soft signal.
function isGatewayToolChoiceReject(error) {
  const status = error?.status ?? error?.error?.status ?? null;
  if (status !== 400 && status !== 422) return false;
  const message = String(error?.message || error?.error?.message || error || "");
  return /upstream|provider|invalid_request/i.test(message);
}

// opencode-zen rejects tool_choice=required outright (400 "Upstream request failed").
// The /go/v1 endpoint routes reasoning models (deepseek-v4-flash) that return
// `reasoning_content` tokens and never produce a tool_call within max_tokens.
// Pre-detect by base URL and force tool_choice=auto + extra headroom.
function gatewayRequiresToolChoiceAuto() {
  const base = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
  return /opencode\.ai\/zen/i.test(base);
}

// Some opencode-zen models are "thinking" variants that emit reasoning_content
// tokens and never produce a tool_call within max_tokens. Skip tool_choice
// for them — let the model decide naturally.
function modelUsesThinkingMode(model) {
  // OpenCode Go routes v4-flash and mimo-v2.5 in thinking mode by default — they
  // emit reasoning_content tokens and never produce a tool_call within max_tokens.
  // Skip tool_choice for them — let the model decide naturally.
  return /mimo-v2\.5|mimo-v2-pro|mimo-v2-omni|kimi-k2\.7-code|deepseek-v4-flash|deepseek-v4-pro/i.test(model || "");
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;
  // Stays true for the whole run once a thinking-mode provider rejects tool_choice
  let omitToolChoice = false;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;
      // Check auto-promote flag at start of each ReAct step. Poller writes the
      // flag when a lower tier recovered; we consume it once and demote currentTier.
      consumeAutoPromoteFlag();

      // Multi-tier provider chain (2026-07-06):
      //   Tier 1 (active by default) → OpenCode Go → deepseek-v4-flash
      //   Tier 2 → OpenCode Go → mimo-v2.5 (model-specific fallback)
      //   Tier 3 → direct DeepSeek (different blast radius / rate pool)
      //   Tier 0 → legacy LLM_BASE_URL gateway (only if opencode disabled & no DEEPSEEK_API_KEY)
      // On transient error: demote to next tier. Health-poller may later
      // auto-promote back via state/auto-promote-N.flag.
      let response;
      let usedModel = activeModel;
      let active = resolveActiveClients();
      let usedClient = active.client;
      let usedBaseURL = active.baseUrl;
      log("agent", `Active LLM tier ${currentTier} → ${active.name}`);

      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const reqParams = {
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          };
          // OpenCode Go / thinking-mode models reject tool_choice=required outright
          // and emit reasoning_content tokens that eat the budget. For those we
          // never send tool_choice — let the model decide naturally.
          const sendToolChoice = (usedBaseURL && /opencode\.ai\/zen/i.test(usedBaseURL)) || modelUsesThinkingMode(usedModel)
            ? false
            : (!omitToolChoice);
          if (sendToolChoice) reqParams.tool_choice = toolChoice;
          response = await usedClient.chat.completions.create(reqParams);
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && (isToolChoiceRequiredError(error) || isGatewayToolChoiceReject(error))) {
            toolChoice = "auto";
            log("agent", `Provider rejected tool_choice=required (${isGatewayToolChoiceReject(error) ? "gateway-wrapped 400" : "explicit"}) — retrying with tool_choice=auto`);
            attempt -= 1;
            continue;
          }
          if (!omitToolChoice && isThinkingModeToolChoiceError(error)) {
            omitToolChoice = true;
            log("agent", "Provider thinking mode does not support tool_choice — retrying without it");
            attempt -= 1;
            continue;
          }
          // opencode-zen returns 400 "Upstream request failed" without surfacing
          // the underlying cause. As a last resort, retry with tool_choice stripped.
          if (!omitToolChoice && !gatewayRequiresToolChoiceAuto() && isGatewayToolChoiceReject(error)) {
            omitToolChoice = true;
            log("agent", "Gateway wrapped tool_choice rejection — retrying without tool_choice");
            attempt -= 1;
            continue;
          }
          // Transient provider outage (502/503/529) → demote to next tier.
          const status = error?.status ?? error?.error?.status ?? error?.code ?? null;
          const errMsg = String(error?.message || error?.error?.message || error || "");
          // 500 from opencode-zen/DeepSeek v4 returns "Internal server error" with no status
          // code on the OpenAI client side. Treat any 5xx-shaped status OR generic 500
          // message as transient so the tier chain engages.
          const is5xx = status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
          const isRecoverable4xx = status === 408 || status === 425 || status === 429;
          // "Model not supported" / "Model does not exist" → recoverable. The OpenCode
          // gateway returns 401 with this message for unknown model IDs; the next tier
          // (different model on same gateway, or different blast radius) may work.
          const isUnsupportedModel = (status === 400 || status === 401 || status === 404 || status === 422)
            && /model .{0,40} not supported|model .{0,40} does not exist|invalid model|unknown model|model not found|model .{0,40} not exist/i.test(errMsg);
          const isTransient = is5xx
            || isRecoverable4xx
            || isUnsupportedModel
            || /temporarily unavailable|failover_exhausted|server_error|internal server error|bad gateway|service unavailable|connection error|ECONNRESET|ETIMEDOUT|timed out|request timeout|upstream|aborted|hang up|socket hang up|fetch failed|getaddrinfo|network is unreachable/i.test(errMsg)
            || error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT" || error?.code === "ENOTFOUND" || error?.code === "ECONNREFUSED";
          if (isTransient) {
            // Demote tier: try next-higher number (3 is final). Persists to disk so
            // a freshly-restarted process boots into the demoted state.
            const nextTierByDemotion = currentTier >= 3 ? 3 : Math.min(3, currentTier + 1);
            // Pick the actual tier to try by jumping straight to "next" if same-tier retry
            // would be hammering a dead upstream. attempt 0 always demotes immediately;
            // attempt 1 retries the new tier once; attempt 2 gives up.
            if (attempt === 0 && nextTierByDemotion !== currentTier) {
              setActiveTier(nextTierByDemotion);
              const demoted = resolveActiveClients();
              usedClient = demoted.client;
              usedBaseURL = demoted.baseUrl;
              usedModel = demoted.model;
              omitToolChoice = true;
              log("agent", `Provider transient error ${status || errMsg} on tier ${currentTier} (${active.name}) — demoting to tier ${nextTierByDemotion} (${demoted.name}) (attempt 1/3)`);
              continue;
            }
            if (attempt === 1 && nextTierByDemotion === currentTier) {
              // Already on the lowest tier; just retry once after a backoff.
              const wait = 5000;
              log("agent", `Provider transient error ${status || errMsg} on tier ${currentTier} (${active.name}) — retrying in ${wait / 1000}s (attempt 2/3)`);
              await new Promise((r) => setTimeout(r, wait));
              continue;
            }
            if (attempt < 2) {
              const wait = (attempt + 1) * 5000;
              log("agent", `Provider transient error ${status || errMsg} on tier ${currentTier} (${active.name}) — retrying in ${wait / 1000}s (attempt ${attempt + 2}/3)`);
              await new Promise((r) => setTimeout(r, wait));
              continue;
            }
          }
          // Rate limit (429) — back off and let the active tier recover. Don't
          // burn all 3 attempts on the same limit. We do NOT demote on rate-limit
          // because downgrading mid-rate-limit doesn't help and may just hit
          // another rate pool.
          const isRateLimit = status === 429
            || /rate limit exceeded|too many requests/i.test(errMsg)
            || error?.code === "rate_limit_exceeded";
          if (isRateLimit && attempt < 2) {
            const wait = 30 * 1000;
            log("agent", `Rate limited on ${usedModel} (${status || errMsg}) — backing off ${wait / 1000}s (attempt ${attempt + 2}/3)`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && currentTier > 1) {
            const demoted = Math.max(1, currentTier - 1);
            setActiveTier(demoted);
            const next = resolveActiveClients();
            usedClient = next.client;
            usedBaseURL = next.baseUrl;
            usedModel = next.model;
            log("agent", `Switching down to tier ${demoted} (${next.name}) after ${errCode}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      const invalidToolArgErrors = new Map();
      // Keep tool-call history API-valid, but never execute unrecoverable args.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        if (invalidToolArgErrors.has(toolCall.id)) {
          const result = {
            success: false,
            error: invalidToolArgErrors.get(toolCall.id),
            blocked: true,
          };
          await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            const result = {
              success: false,
              error: `Invalid tool arguments for ${functionName}`,
              blocked: true,
            };
            await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
