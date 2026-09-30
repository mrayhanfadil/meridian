// The Meteora fallback may report a different PnL than the derived value on
// volatile pools. Only the absence of both usable values blocks PnL exits.
export function usablePnlPct(reportedPct, derivedPct) {
  if (Number.isFinite(reportedPct)) return reportedPct;
  return Number.isFinite(derivedPct) ? derivedPct : null;
}

export function isPnlFallbackUnpriceable(reportedPct, derivedPct) {
  return usablePnlPct(reportedPct, derivedPct) == null;
}
