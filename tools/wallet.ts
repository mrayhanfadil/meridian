import {
  Connection,
  PublicKey,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config, nextRpcUrl, getHeliusKeyPool } from "../config.js";

let _connection: Connection | null = null;
let _wallet: Keypair | null = null;

// Round-robin: cache by URL so we don't reconstruct on every web3 call within a tick.
const _connCache = new Map<string, Connection>(); // url → Connection

export function getConnection(): Connection {
  const url = nextRpcUrl();
  if (!url) throw new Error("RPC_URL (or RPC_URLS) not set");
  let conn = _connCache.get(url);
  if (!conn) {
    conn = new Connection(url, "confirmed");
    _connCache.set(url, conn);
  }
  return conn;
}

export function getWallet(): Keypair {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey(): string {
  return (config.jupiter as any)?.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

interface ReferralParams {
  referralAccount: string;
  referralFee: number;
}

function getJupiterReferralParams(): ReferralParams | null {
  const referralAccount = String((config.jupiter as any)?.referralAccount || "").trim();
  const referralFee = Number((config.jupiter as any)?.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

export interface EnrichedToken {
  mint: string;
  symbol: string;
  balance: number;
  usd: number | null;
  sol_value: number | null;
}

export interface WalletBalancesResult {
  wallet: string | null;
  sol: number;
  sol_price: number;
  sol_usd: number;
  usdc: number;
  tokens: EnrichedToken[];
  total_usd: number;
  error?: string;
}

interface HeliusBalance {
  mint: string;
  symbol?: string;
  balance: number;
  pricePerToken?: number;
  usdValue?: number;
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances(): Promise<WalletBalancesResult> {
  let walletAddress: string | null = null;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = getHeliusKeyPool?.().length ? getHeliusKeyPool()[0] : process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY (or HELIUS_API_KEYS) not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const pool = getHeliusKeyPool?.() || [HELIUS_KEY];
    const maxAttempts = Math.max(1, pool.length);
    let res: Response | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = pool[attempt % pool.length];
      const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${key}`;
      try {
        res = await fetch(url);
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Helius ${res.status} on key ${key.slice(0, 6)}…`);
        continue;
      }
      if (!res.ok) throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
      break;
    }
    if (!res) throw lastErr || new Error("All Helius keys exhausted");
    
    // Success: bump the shared cursor so next cycle starts at a different key.
    (config as any).advanceHeliusCursor?.();

    const data: any = await res.json();
    const balances: HeliusBalance[] = data.balances || [];

    // ─── Find SOL and USDC ───────────────────────────────────
    const solEntry = balances.find(b => b.mint === (config.tokens as any).SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === (config.tokens as any).USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;
    
    const solUsdRate = solPrice > 0
      ? solPrice
      : (Number((config.management as any)?.solUsdFallback) || 0);

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens: EnrichedToken[] = balances.map(b => {
      const usd = b.usdValue != null ? Math.round(b.usdValue * 100) / 100 : null;
      const sol_value = (usd != null && solUsdRate > 0 && b.usdValue != null)
        ? Math.round((b.usdValue / solUsdRate) * 1e6) / 1e6
        : null;
      return {
        mint: b.mint,
        symbol: b.symbol || b.mint.slice(0, 8),
        balance: b.balance,
        usd,
        sol_value,
      };
    });

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error: any) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint: string): string {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export interface SwapTokenParams {
  input_mint: string;
  output_mint: string;
  amount: number;
}

export interface SwapResult {
  success: boolean;
  tx?: string;
  input_mint?: string;
  output_mint?: string;
  amount_in?: number;
  amount_out?: number;
  referral_account?: string | null;
  referral_fee_bps_requested?: number;
  fee_bps_applied?: number | null;
  fee_mint?: string | null;
  error?: string;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}: SwapTokenParams): Promise<SwapResult> {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      success: true,
      tx: "DRY_RUN_SIGNATURE",
      input_mint,
      output_mint,
      amount_in: amount,
      amount_out: amount,
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== (config.tokens as any).SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
      dynamicSlippage: "true",
      priorityLevel: "medium",
    });
    
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order: any = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result: any = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error: any) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
