import {
  generateFlatWeights,
  generateGaussianWeights,
  generateSpotSkewedWeights,
} from "../tools/allocator-math.js";

console.log("=== Testing DIY HawkFi Allocator Math ===");

const width = 11;

console.log(`\n1. Flat Weights (Width: ${width}):`);
const flat = generateFlatWeights(width);
console.log(JSON.stringify(flat));
console.log(`Sum: ${flat.reduce((s, w) => s + w, 0)}`);

console.log(`\n2. Symmetrical Gaussian Weights (Width: ${width}):`);
const gaussian = generateGaussianWeights(width);
console.log(JSON.stringify(gaussian));
console.log(`Sum: ${gaussian.reduce((s, w) => s + w, 0)}`);

console.log(`\n3. Left-Skewed Bids (Width: ${width}, Skew: -0.5):`);
const leftSkew = generateSpotSkewedWeights(width, -0.5);
console.log(JSON.stringify(leftSkew));
console.log(`Sum: ${leftSkew.reduce((s, w) => s + w, 0)}`);

console.log(`\n4. Right-Skewed Asks (Width: ${width}, Skew: +0.5):`);
const rightSkew = generateSpotSkewedWeights(width, 0.5);
console.log(JSON.stringify(rightSkew));
console.log(`Sum: ${rightSkew.reduce((s, w) => s + w, 0)}`);
