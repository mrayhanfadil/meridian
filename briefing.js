import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { repoPath } from "./repo-root.js";
import { getWalletBalances } from "./tools/wallet.js";

const STATE_FILE = repoPath("state.json");
const LESSONS_FILE = repoPath("lessons.json");

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 5. Wallet Balance
  let walletLine = "Wallet: N/A";
  try {
    const balances = await getWalletBalances();
    if (balances?.sol != null) {
      walletLine = `Wallet: ◎${balances.sol.toFixed(4)} SOL ($${(balances.sol * 150).toFixed(2)})`;
    }
  } catch (e) { /* skip if RPC fails */ }

  // 6. Best/Worst pools (by PnL)
  const poolPerf = {};
  for (const p of perfLast24h) {
    const name = p.pool_name || p.pool || "unknown";
    if (!poolPerf[name]) poolPerf[name] = { pnl: 0, count: 0, fees: 0 };
    poolPerf[name].pnl += p.pnl_usd || 0;
    poolPerf[name].fees += p.fees_earned_usd || 0;
    poolPerf[name].count += 1;
  }
  const poolList = Object.entries(poolPerf).sort((a, b) => b[1].pnl - a[1].pnl);
  const bestPool = poolList[0];
  const worstPool = poolList[poolList.length - 1];

  // 7. Open position details
  const openDetails = openPositions.map(p => {
    const pair = p.pool_name || "?";
    const pnl = p.peak_pnl_pct ?? 0;
    const yield24h = p.signal_snapshot?.fee_tvl_ratio ?? p.initial_fee_tvl_24h ?? "?";
    const age = p.deployed_at ? Math.round((now - new Date(p.deployed_at)) / 60000) : "?";
    return `• ${pair}: ${age}m old | peak ${pnl}% | yield ${yield24h}%`;
  });

  // 8. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Pool Performance:</b>`,
    bestPool ? `🏆 Best: ${bestPool[0]} ($${bestPool[1].pnl.toFixed(2)}, ${bestPool[1].count}x)` : "🏆 Best: N/A",
    worstPool ? `💀 Worst: ${worstPool[0]} ($${worstPool[1].pnl.toFixed(2)}, ${worstPool[1].count}x)` : "💀 Worst: N/A",
    "",
    `<b>Wallet:</b>`,
    walletLine,
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    ...(openDetails.length > 0 ? openDetails : ["• No open positions"]),
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.filter(Boolean).join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
