import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { degenScore } from '../tools/screening.ts';

test('upstream poller consumes the existing nested user-config without undefined gates', () => {
  assert.equal(config.opportunity.enabled, true);
  assert.equal(config.opportunity.pollIntervalSec, 30);
  assert.equal(config.opportunity.limit, 3);
  assert.equal(config.opportunity.minScore, 30);
  assert.equal(config.opportunity.smartWalletScoreBonus, 20);
  assert.equal(config.screening.loneCandidateMinDegen, 50);
  assert.equal(config.pnl.confirmTicks, 2);
  for (const key of ['targetVolRatio', 'targetLpCount', 'targetFeeRatio', 'targetLiquidity']) {
    assert.ok(Number.isFinite(config.opportunity[key]) && config.opportunity[key] > 0, key);
  }
});

test('Degen Score normalizes 5m activity to the same 30m reference as 30m activity', () => {
  const old = config.screening.timeframe;
  const base = {active_tvl: 20_000, volume_active_tvl_ratio: 20, fee_active_tvl_ratio: 0.20, unique_lps: 20, positions_created: 20};
  try {
    config.screening.timeframe = '30m';
    const at30m = degenScore(base, config.opportunity);
    config.screening.timeframe = '5m';
    const at5m = degenScore({...base, volume_active_tvl_ratio: 20/6, fee_active_tvl_ratio: 0.20/6, unique_lps: 20/6, positions_created: 20/6}, config.opportunity);
    assert.ok(at30m > 90, `expected calibrated score, got ${at30m}`);
    assert.ok(Math.abs(at30m - at5m) < 0.001, `30m=${at30m}, 5m=${at5m}`);
  } finally { config.screening.timeframe = old; }
});

test('fresh deploy missing Meteora deposits stays priceable with tracked SOL cost', async () => {
  const { isPnlTickUnpriceable } = await import('../tools/pnl.ts');
  assert.equal(isPnlTickUnpriceable({ priceMissing: false, depositsSol: 0, depositsUsd: 0, trackedSol: 0.25, solUsd: 80 }), false);
});

test('Meteora fallback divergence logs but does not freeze exits', async () => {
  const { isPnlFallbackUnpriceable, usablePnlPct } = await import('../tools/pnl-safety.js');
  assert.equal(isPnlFallbackUnpriceable(4, -3), false);
  assert.equal(isPnlFallbackUnpriceable(NaN, null), true);
  assert.equal(isPnlFallbackUnpriceable(null, -3), false);
  assert.equal(usablePnlPct(null, -3), -3);
  assert.equal(usablePnlPct(NaN, -3), -3);
  assert.equal(usablePnlPct(NaN, null), null);
});

test('missing token price or any cost basis blocks PnL exit rules', async () => {
  const { isPnlTickUnpriceable } = await import('../tools/pnl.ts');
  assert.equal(isPnlTickUnpriceable({ priceMissing: true, depositsSol: 0, depositsUsd: 0, trackedSol: 0.25, solUsd: 80 }), true);
  assert.equal(isPnlTickUnpriceable({ priceMissing: false, depositsSol: 0, depositsUsd: 0, trackedSol: 0, solUsd: 80 }), true);
});
