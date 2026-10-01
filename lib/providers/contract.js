'use strict';

const PROVIDER_STATES = Object.freeze({
  READY: 'ready',
  CONNECTING: 'connecting',
  AUTH_REQUIRED: 'auth-required',
  UNAVAILABLE: 'unavailable',
  BUSY: 'busy',
  LIMIT_REACHED: 'limit-reached',
  FAILED: 'failed',
});

class ProviderError extends Error {
  constructor(message, code = 'PROVIDER_FAILED', options = {}) {
    super(String(message || 'The AI provider request failed.'));
    this.name = 'ProviderError';
    this.code = String(code || 'PROVIDER_FAILED');
    if (options.status != null) this.status = Number(options.status);
    if (options.provider) this.provider = String(options.provider);
    if (options.retryable != null) this.retryable = options.retryable === true;
    if (options.cause) this.cause = options.cause;
  }
}

function classifyFailure(error, provider = '') {
  const code = String(error && error.code || 'PROVIDER_FAILED');
  const status = Number(error && error.status) || 0;
  let state = PROVIDER_STATES.FAILED;
  if (['NO_KEY', 'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'BAD_KEY'].includes(code) || status === 401) {
    state = PROVIDER_STATES.AUTH_REQUIRED;
  } else if (['RATE_LIMITED', 'ALLOWANCE_EXHAUSTED', 'INSUFFICIENT_BALANCE'].includes(code) || status === 429) {
    state = PROVIDER_STATES.LIMIT_REACHED;
  } else if (['UNAVAILABLE', 'NOT_CONFIGURED', 'UNSUPPORTED'].includes(code)) {
    state = PROVIDER_STATES.UNAVAILABLE;
  } else if (code === 'BUSY') {
    state = PROVIDER_STATES.BUSY;
  }
  return {
    provider: String(provider || error && error.provider || ''),
    state,
    code,
    status: status || null,
    retryable: Boolean(error && error.retryable) || ['NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'BUSY'].includes(code),
    message: String(error && error.message || 'The AI provider request failed.'),
  };
}

function normalizeUsage(usage) {
  const value = usage && typeof usage === 'object' ? usage : {};
  return {
    inputTokens: Math.max(0, Number(value.inputTokens) || 0),
    outputTokens: Math.max(0, Number(value.outputTokens) || 0),
    cachedInputTokens: Math.max(0, Number(value.cachedInputTokens) || 0),
  };
}

function normalizeGeneration(result, request, descriptor) {
  const raw = result && typeof result === 'object' ? result : {};
  const text = String(raw.text == null ? '' : raw.text).trim();
  if (!text) {
    throw new ProviderError('The AI provider returned an empty generation.', 'EMPTY_RESPONSE', {
      provider: descriptor.id,
    });
  }
  const normalized = {
    ...raw,
    provider: descriptor.id,
    model: String(raw.model || request.model || ''),
    text,
    ms: Math.max(0, Number(raw.ms) || 0),
    usage: normalizeUsage(raw.usage),
  };
  if (request.structuredOutput) {
    if (raw.structured && typeof raw.structured === 'object') {
      normalized.structured = raw.structured;
    } else {
      try {
        normalized.structured = JSON.parse(text);
      } catch (error) {
        throw new ProviderError('The provider returned text that was not valid structured JSON.', 'BAD_STRUCTURED_OUTPUT', {
          provider: descriptor.id,
          cause: error,
        });
      }
    }
  }
  return normalized;
}

function validateAdapter(adapter) {
  if (!adapter || !adapter.descriptor || !adapter.descriptor.id) {
    throw new TypeError('A provider adapter needs a descriptor with an id.');
  }
  if (typeof adapter.generate !== 'function') {
    throw new TypeError('Provider "' + adapter.descriptor.id + '" needs a generate function.');
  }
  return adapter;
}

module.exports = {
  PROVIDER_STATES,
  ProviderError,
  classifyFailure,
  normalizeUsage,
  normalizeGeneration,
  validateAdapter,
};
