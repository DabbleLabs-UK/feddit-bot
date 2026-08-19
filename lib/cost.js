'use strict';

// Cost model for provider generations. Prices are a CONFIG table (seeded here,
// overridable via settings.pricing) NOT hardcoded constants at the call site -
// DeepSeek has announced an unpublished price rise, so the numbers must be
// editable without a code change.
//
// All prices are USD per MILLION tokens.

// Seed prices (USD / 1e6 tokens). cachedInput is the discounted rate for
// prompt tokens DeepSeek served from its context cache.
function defaultPricing() {
  return {
    'deepseek-v4-flash': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
    'deepseek-v4-pro': { input: 0.435, cachedInput: 0.003625, output: 0.87 },
  };
}

// Estimate the USD cost of one generation. Ollama (and any model without a
// price row) costs 0 in money - it runs on local electricity, not an API bill.
// Cached input tokens are billed at the cheaper cachedInput rate; the remaining
// (uncached) input tokens at the full input rate.
function estimateCost(model, usage, pricing) {
  const table = pricing && typeof pricing === 'object' ? pricing : defaultPricing();
  const price = table[model];
  if (!price) return 0; // ollama / unknown model => free of API cost
  const u = usage || {};
  const input = Number(u.inputTokens) || 0;
  const cached = Math.min(Math.max(0, Number(u.cachedInputTokens) || 0), input);
  const uncached = Math.max(0, input - cached);
  const output = Number(u.outputTokens) || 0;
  const perMillion =
    uncached * (Number(price.input) || 0) +
    cached * (Number(price.cachedInput) || 0) +
    output * (Number(price.output) || 0);
  return perMillion / 1e6;
}

// Calendar keys (UTC, so they're deterministic under a faked clock in tests).
function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}
function monthKey(ts) {
  return new Date(ts).toISOString().slice(0, 7); // YYYY-MM
}

module.exports = { defaultPricing, estimateCost, dayKey, monthKey };
