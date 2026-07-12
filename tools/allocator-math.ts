/**
 * DIY HawkFi Allocator Math (Meridian OS)
 * Phase 2: Math-Generated Custom Shapes
 *
 * Generates custom liquidity weight distributions for Meteora DLMM.
 * Enforces that the total sum of any generated weight array is exactly
 * 100,000 (Meteora SDK precision).
 */

/**
 * Normalizes any array of raw numeric weights to sum up to EXACTLY 100,000.
 * Distributes rounding remainders to the center/maximum bin to prevent
 * integer precision errors in the on-chain DLMM SDK.
 */
export function normalizeWeights(rawWeights: number[]): number[] {
  if (rawWeights.length === 0) return [];
  
  const totalRawSum = rawWeights.reduce((sum, w) => sum + w, 0);
  if (totalRawSum <= 0) {
    // If all weights are zero, return a flat/uniform distribution
    return generateFlatWeights(rawWeights.length);
  }

  // 1. Scale weights to sum to 100,000 using integer rounding
  const scaledWeights = rawWeights.map((w) => Math.round((w * 100000) / totalRawSum));

  // 2. Re-calculate scaled sum and detect rounding remainders
  const currentSum = scaledWeights.reduce((sum, w) => sum + w, 0);
  const remainder = 100000 - currentSum;

  if (remainder !== 0) {
    // Distribute remainder to the element with the highest weight (the center peak)
    let maxIdx = 0;
    let maxWeight = scaledWeights[0];
    for (let i = 1; i < scaledWeights.length; i++) {
      if (scaledWeights[i] > maxWeight) {
        maxWeight = scaledWeights[i];
        maxIdx = i;
      }
    }
    scaledWeights[maxIdx] += remainder;
  }

  return scaledWeights;
}

/**
 * Flat / Uniform Distribution
 * Generates equal weight distribution across all bins.
 */
export function generateFlatWeights(width: number): number[] {
  if (width <= 0) return [];
  const baseWeight = 100000 / width;
  const raw = Array(width).fill(baseWeight);
  return normalizeWeights(raw);
}

/**
 * Gaussian / Curve Distribution (Symmetrical Normal Distribution)
 * Centers liquidity around the active bin using a standard normal distribution.
 * - sigma: Standard deviation. Smaller sigma = more concentrated center; larger sigma = flatter.
 *          Defaults to width / 4.
 */
export function generateGaussianWeights(width: number, sigma?: number): number[] {
  if (width <= 0) return [];
  const s = sigma ?? width / 4;
  const center = (width - 1) / 2;

  const raw: number[] = [];
  for (let i = 0; i < width; i++) {
    // Gaussian formula: f(x) = exp(-((x - center)^2) / (2 * sigma^2))
    const exponent = -Math.pow(i - center, 2) / (2 * Math.pow(s, 2));
    const weight = Math.exp(exponent);
    raw.push(weight);
  }

  return normalizeWeights(raw);
}

/**
 * Spot-Skewed Distribution (Asymmetrical Bias)
 * Centers peak liquidity around the active bin, but skews volume heavier to
 * the left (bids/buying) or right (asks/selling).
 * - skew: Float between -1.0 (heavy left/bid skew) and +1.0 (heavy right/ask skew).
 */
export function generateSpotSkewedWeights(width: number, skew: number, sigma?: number): number[] {
  if (width <= 0) return [];
  const s = sigma ?? width / 4;
  const center = (width - 1) / 2;
  const clampedSkew = Math.max(-1, Math.min(1, skew));

  const raw: number[] = [];
  for (let i = 0; i < width; i++) {
    // Base Gaussian curve
    const exponent = -Math.pow(i - center, 2) / (2 * Math.pow(s, 2));
    const baseWeight = Math.exp(exponent);

    // Apply linear skew factor: multiplier = 1 + skew * (relative_distance_from_center)
    // Relative distance: -1 at far left, 0 at center, +1 at far right
    const relDistance = center !== 0 ? (i - center) / center : 0;
    const skewFactor = 1 + clampedSkew * relDistance;

    raw.push(baseWeight * skewFactor);
  }

  return normalizeWeights(raw);
}
