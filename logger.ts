import fs from "fs";
import path from "path";
import { repoPath } from "./repo-root.js";

const LOG_DIR: string = repoPath("logs");
const LOG_LEVEL: string = process.env.LOG_LEVEL || "info";

interface LogLevels {
  [key: string]: number;
}

const LEVELS: LogLevels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: number = LEVELS[LOG_LEVEL] ?? 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * General log function.
 */
export function log(category: string, message: string): void {
  const level: string = category.includes("error") ? "error"
    : category.includes("warn") ? "warn"
    : "info";

  if ((LEVELS[level] ?? 1) < currentLevel) return;

  const timestamp: string = new Date().toISOString();
  const line: string = `[${timestamp}] [${category.toUpperCase()}] ${message}`;

  // Console output
  console.log(line);

  // File output (daily rotation)
  const dateStr: string = timestamp.split("T")[0];
  const logFile: string = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");
}

interface Action {
  tool: string;
  success: boolean;
  args?: any;
  result?: any;
  duration_ms?: number;
  [key: string]: any;
}

/**
 * Log a tool action with full details (for audit trail).
 */
function actionHint(action: Action): string {
  const a = action.args || {};
  const r = action.result || {};
  switch (action.tool) {
    case "deploy_position":   return ` ${a.pool_name || a.pool_address?.slice(0, 8) || ""} ${a.amount_sol || ""} SOL`;
    case "close_position":    return ` ${a.position_address?.slice(0, 8) || ""}${r.pnl_usd != null ? ` | PnL $${r.pnl_usd >= 0 ? "+" : ""}${r.pnl_usd} (${r.pnl_pct}%)` : ""}`;
    case "claim_fees":        return ` ${a.position_address?.slice(0, 8) || ""}`;
    case "get_active_bin":    return ` bin ${r.binId ?? ""}`;
    case "get_pool_detail":   return ` ${r.name || a.pool_address?.slice(0, 8) || ""}`;
    case "get_my_positions":  return ` ${r.total_positions ?? ""} positions`;
    case "get_wallet_balance":return ` ${r.sol ?? ""} SOL`;
    case "get_top_candidates":return ` ${r?.candidates?.length ?? ""} pools`;
    case "swap_token":        return ` ${a.amount || ""} ${a.input_mint?.slice(0, 6) || ""}→SOL`;
    case "update_config":     return ` ${Object.keys(r.applied || {}).join(", ")}`;
    case "add_lesson":        return ` saved`;
    case "clear_lessons":     return ` cleared ${r.cleared ?? ""}`;
    default:                  return "";
  }
}

export function logAction(action: Action): void {
  const timestamp: string = new Date().toISOString();

  const entry = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status: string = action.success ? "✓" : "✗";
  const dur: string = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint: string = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail
  const dateStr: string = timestamp.split("T")[0];
  const actionsFile: string = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFileSync(actionsFile, JSON.stringify(entry) + "\n");
}
