'use strict';

const assert = require('node:assert/strict');
const providers = require('../lib/providers');
const contract = require('../lib/providers/contract');

const saved = { provider: 'ollama', model: 'local-model' };
const request = { ...saved, providerOverride: 'chatgpt-plan' };
assert.equal(providers.requestProvider(request), 'chatgpt-plan');
assert.deepEqual(saved, { provider: 'ollama', model: 'local-model' });
assert.equal(request.provider, 'ollama', 'temporary routing does not mutate the saved provider');

for (const id of providers.PROVIDERS) {
  const descriptor = providers.providerDescriptor(id);
  assert.equal(descriptor.id, id);
  assert.equal(typeof descriptor.capabilities.efficientBatch, 'boolean');
  assert.equal(typeof descriptor.capabilities.longLivedSession, 'boolean');
  assert.ok(Number(descriptor.capabilities.maxConcurrency) >= 0);
  assert.ok(Number(descriptor.capabilities.maxConcurrency) >= 1);
  assert.equal(descriptor.creator.eligible, true, 'all generation providers declare creator eligibility explicitly');
  assert.equal(typeof descriptor.creator.autoPreferred, 'boolean',
    'creator auto-selection permission is provider capability metadata');
}
assert.equal(providers.providerDescriptor('chatgpt-plan').creator.autoPreferred, true,
  'an already-connected ChatGPT plan may be preferred without PAYG fallback');
assert.equal(providers.providerDescriptor('claude-plan').creator.autoPreferred, true,
  'an already-connected Claude subscription may be preferred without PAYG fallback');
assert.equal(providers.providerDescriptor('deepseek').creator.autoPreferred, false,
  'a configured API key alone never authorises automatic PAYG creator use');

const structured = contract.normalizeGeneration(
  { text: '{"choice":"WAIT"}', usage: { inputTokens: 2, outputTokens: 3 } },
  { structuredOutput: true, model: 'test-model' },
  { id: 'test-provider' },
);
assert.deepEqual(structured.structured, { choice: 'WAIT' });
assert.equal(structured.usage.inputTokens, 2);
assert.throws(
  () => contract.normalizeGeneration({ text: 'not json' }, { structuredOutput: true }, { id: 'test-provider' }),
  (error) => error.code === 'BAD_STRUCTURED_OUTPUT' && error.provider === 'test-provider',
);

assert.equal(contract.classifyFailure({ code: 'NO_KEY' }).state, contract.PROVIDER_STATES.AUTH_REQUIRED);
assert.equal(contract.classifyFailure({ code: 'ALLOWANCE_EXHAUSTED' }).state, contract.PROVIDER_STATES.LIMIT_REACHED);
assert.equal(contract.classifyFailure({ code: 'BUSY' }).state, contract.PROVIDER_STATES.BUSY);

(async () => {
  await assert.rejects(
    () => providers.generate({ provider: 'made-up-provider', prompt: 'test' }),
    (error) => error.code === 'UNAVAILABLE' && error.provider === 'made-up-provider',
    'an unknown provider fails rather than falling back to a paid or local route',
  );
  console.log('provider-contract: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
