/**
 * DIY HawkFi WebSocket Stream Client (Meridian OS)
 * Phase 4: Free Helius/Solana WebSocket stream integration
 *
 * Listens to real-time DLMM pool state transitions on-chain using
 * Solana's native WebSocket protocol (`onAccountChange`), which is
 * 100% FREE and compatible with Fadil's Free Helius API keys.
 *
 * Achieves active bin change detection within milliseconds of slot confirmation.
 */

import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../wallet.js";
import { getActiveBin } from "../dlmm.js";
import { log } from "../../logger.js";

let _subscriptionId: number | null = null;
let _isFetching = false;
let _lastBinId: number | null = null;

/**
 * Subscribes to pool account changes on-chain.
 * Whenever a swap/price-shift occurs, triggers a throttled activeBin lookup.
 */
export function startPoolStream(
  poolAddress: string,
  onActiveBinChange: (binId: number) => void
): void {
  const connection = getConnection();
  const poolPubKey = new PublicKey(poolAddress);

  log("stream", `Starting real-time free WebSocket stream for pool: ${poolAddress.slice(0, 8)}`);
  console.log(`\n=== Starting Real-Time WebSocket Stream [Helius Free Tier] ===`);
  console.log(`Listening to pool: ${poolAddress}`);

  _subscriptionId = connection.onAccountChange(
    poolPubKey,
    async () => {
      // Throttle fetches to avoid overlapping RPC queries on back-to-back blocks
      if (_isFetching) return;
      _isFetching = true;

      try {
        const binData = await getActiveBin({ pool_address: poolAddress });
        if (_lastBinId === null || binData.binId !== _lastBinId) {
          _lastBinId = binData.binId;
          log("stream", `Stream active bin update: ${_lastBinId}`);
          onActiveBinChange(binData.binId);
        }
      } catch (error: any) {
        log("stream_error", `Failed to fetch active bin in stream: ${error.message}`);
      } finally {
        _isFetching = false;
      }
    },
    "confirmed"
  );
}

/**
 * Unsubscribes from on-chain pool updates.
 */
export function stopPoolStream(): void {
  if (_subscriptionId !== null) {
    const connection = getConnection();
    connection.removeAccountChangeListener(_subscriptionId)
      .then(() => {
        log("stream", `Stopped pool stream subscription.`);
        _subscriptionId = null;
      })
      .catch((err: any) => {
        log("stream_error", `Failed to remove account listener: ${err.message}`);
      });
  }
}
