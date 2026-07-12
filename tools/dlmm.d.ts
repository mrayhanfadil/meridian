import { Connection, PublicKey, Keypair } from "@solana/web3.js";

export interface ActiveBinResult {
  binId: number;
  price: number;
  timestamp: string;
}

export interface DeployPositionParams {
  pool_address: string;
  amount_sol: number;
  strategy: string;
  bins_below?: number;
  bins_above?: number;
  custom_weights?: number[];
  silent?: boolean;
}

export interface DeployPositionResult {
  success: boolean;
  position_address?: string;
  txs?: string[];
  deployed_at?: string;
  amount_sol_deployed?: number;
  error?: string;
}

export interface GetPositionPnlParams {
  pool_address: string;
  position_address: string;
}

export interface GetPositionPnlResult {
  pnl_usd: number;
  pnl_sol: number;
  pnl_pct: number;
  unclaimed_fees_usd: number;
  total_value_usd: number;
  in_range: boolean;
}

export interface GetMyPositionsParams {
  force?: boolean;
  silent?: boolean;
  wallet_address?: string | null;
}

export interface GetMyPositionsResult {
  wallet: string;
  total_positions: number;
  positions: any[];
  source: string;
}

export interface GetWalletPositionsParams {
  wallet_address: string;
}

export interface SearchPoolsParams {
  query: string;
  limit?: number;
}

export interface ClaimFeesParams {
  position_address: string;
}

export interface ClaimFeesResult {
  success: boolean;
  position: string;
  txs: string[];
  base_mint?: string;
  error?: string;
}

export interface ClosePositionParams {
  position_address: string;
  reason: string;
}

export interface ClosePositionResult {
  success: boolean;
  position_address: string;
  txs?: string[];
  pnl_sol?: number;
  pnl_pct?: number;
  error?: string;
}

export function getActiveBin(params: { pool_address: string }): Promise<ActiveBinResult>;

export function deployPosition(params: DeployPositionParams): Promise<DeployPositionResult>;

export function getPositionPnl(params: GetPositionPnlParams): Promise<GetPositionPnlResult>;

export function getMyPositions(params?: GetMyPositionsParams): Promise<GetMyPositionsResult>;

export function getWalletPositions(params: GetWalletPositionsParams): Promise<any>;

export function searchPools(params: SearchPoolsParams): Promise<any[]>;

export function claimFees(params: ClaimFeesParams): Promise<ClaimFeesResult>;

export function closePosition(params: ClosePositionParams): Promise<ClosePositionResult>;
