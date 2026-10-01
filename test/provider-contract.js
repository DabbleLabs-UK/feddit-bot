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
}

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
