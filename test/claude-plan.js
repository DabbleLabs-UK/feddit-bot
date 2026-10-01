'use strict';

const assert = require('node:assert/strict');
const {
  BLOCKED_ENVIRONMENT,
  createClaudePlanProvider,
  subscriptionEnvironment,
} = require('../lib/providers/claude-plan');

const cleaned = subscriptionEnvironment({
  SAFE_VALUE: 'kept',
  ANTHROPIC_API_KEY: 'must-not-pass',
  CLAUDE_CODE_USE_BEDROCK: 'must-not-pass',
});
assert.equal(cleaned.SAFE_VALUE, 'kept');
for (const key of BLOCKED_ENVIRONMENT) assert.equal(cleaned[key], undefined, key + ' is removed');

(async () => {
  const calls = [];
  let launched = false;
  const provider = createClaudePlanProvider({
    placement: 'desktop',
    env: { SAFE_VALUE: 'kept', ANTHROPIC_API_KEY: 'must-not-pass' },
    launchLogin(command, env) {
      launched = command === 'claude' && env.ANTHROPIC_API_KEY === undefined;
    },
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args.join(' ') === 'auth status') {
        return {
          code: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            apiProvider: 'firstParty',
            subscriptionType: 'pro',
            email: 'local@example.test',
          }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'auth logout') return { code: 0, stdout: '', stderr: '' };
      return {
        code: 0,
        stdout: JSON.stringify({ result: '{"choice":"WAIT"}', duration_ms: 25, usage: { input_tokens: 4, output_tokens: 3 } }),
        stderr: '',
      };
    },
  });

  const state = await provider.status();
  assert.equal(state.state, 'ready');
  assert.equal(state.account.plan, 'pro');
  assert.deepEqual(state.models.map((model) => model.id), ['sonnet', 'opus', 'haiku']);

  const result = await provider.generate({ system: 'persona', prompt: 'choose', model: 'opus' });
  assert.equal(result.text, '{"choice":"WAIT"}');
  assert.equal(result.model, 'opus');
  assert.equal(result.ms, 25);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3, cachedInputTokens: 0 });
  const generation = calls.find((call) => call.args[0] === '-p');
  assert.ok(generation, 'generation uses Claude Code print mode');
  assert.ok(generation.args.includes('--no-session-persistence'));
  assert.ok(generation.args.includes('--safe-mode'));
  assert.ok(generation.args.includes('--restricted'));
  assert.ok(generation.args.includes('--strict-mcp-config'));
  assert.equal(generation.args.includes('persona'), false, 'persona is not exposed in process arguments');
  assert.equal(generation.options.input, 'SYSTEM INSTRUCTION:\npersona\n\nTASK:\nchoose');
  assert.equal(generation.options.env.ANTHROPIC_API_KEY, undefined, 'paid API fallback is unavailable');

  await provider.beginConnect();
  assert.equal(launched, true, 'connect opens the official Claude Code login command');
  await provider.disconnect();
  assert.ok(calls.some((call) => call.args.join(' ') === 'auth logout'));

  const apiLogin = createClaudePlanProvider({
    async run(command, args) {
      if (args.join(' ') === 'auth status') {
        return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }), stderr: '' };
      }
      throw new Error('generation must not run');
    },
  });
  assert.equal((await apiLogin.status()).state, 'auth-required');
  await assert.rejects(() => apiLogin.generate({ prompt: 'no paid fallback' }), (error) => error.code === 'AUTH_REQUIRED');

  const hosted = createClaudePlanProvider({ placement: 'hosted' });
  assert.equal((await hosted.status()).state, 'unavailable');
  await assert.rejects(() => hosted.generate({ prompt: 'no' }), (error) => error.code === 'UNAVAILABLE');

  console.log('claude-plan: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
