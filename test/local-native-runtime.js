'use strict';

const assert = require('node:assert/strict');
const { createLocalNativeRuntime, validateIdentity } = require('../lib/local-native-runtime');
let checks = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
const source = { service: { pid: 11, birth: 'one', executable: 'C:\\runtime\\ollama.exe' },
  native: { pid: 12, birth: 'two', executable: 'C:\\runtime\\lib\\ollama\\llama-server.exe', port: 49152 }, connections: 0 };
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
  let reads = 0;
  const calls = [];
  return { calls, runtime: createLocalNativeRuntime({ inspect: async () => options.identity ? options.identity(++reads) : copy(source),
    sleep: options.sleep || (async () => {}),
    fetchImpl: async (url, request) => {
      const route = new URL(url).pathname;
      calls.push({ route, body: request.body ? JSON.parse(request.body) : null });
      if (options.fail) throw new Error('PRIVATE SECRET');
      let result;
      if (route === '/api/version') result = { version: typeof options.version === 'function' ? options.version() : (options.version || '0.32.15') };
      else if (route === '/slots') result = options.slots || [{ is_processing: false }];
      else if (route === '/api/ps') result = { models: [{ name: 'qwen3:4b-instruct', digest: 'frozen' }] };
      else if (route === '/apply-template') result = { prompt: 'PRIVATE RENDERED' };
      else if (route === '/tokenize') result = { tokens: [1, 2, 3] };
      else throw new Error('Unexpected endpoint');
      return { ok: true, json: async () => result };
    } }) };
}

async function run() {
  eq((await fixture().runtime.probe()).state, 'idle');
  eq((await fixture({ slots: [{ is_processing: true }] }).runtime.probe()).state, 'busy');
  for (const slots of [[], [{}], [{ is_processing: 'false' }], [{ is_processing: false }, {}]]) {
    eq((await fixture({ slots }).runtime.probe()).state, 'unknown');
  }
  eq(await fixture({ fail: true }).runtime.probe(), { state: 'unknown', code: 'OLLAMA_NATIVE_STATUS' });
  eq((await fixture({ version: 'other' }).runtime.probe()).state, 'unsupported');
  let version = '0.32.15';
  const changedVersion = fixture({ version: () => version });
  eq((await changedVersion.runtime.probe()).state, 'idle');
  version = 'other';
  eq(await changedVersion.runtime.probe(), { state: 'unknown', code: 'OLLAMA_NATIVE_VERSION_CHANGED' });
  eq((await fixture({ identity: () => ({ ...source, connections: 1 }) }).runtime.probe()).state, 'idle');
  eq((await fixture({ identity: () => ({ ...source, connections: 3 }), slots: [{ is_processing: true }] }).runtime.probe()).state, 'busy');
  eq((await fixture({ identity: () => ({ ...source, native: null }) }).runtime.probe()).state, 'idle');
  eq((await fixture({ identity: () => ({ ...source, native: null, connections: 1 }) }).runtime.probe()).state, 'busy');
  eq((await fixture({ identity: n => ({ ...source, service: { ...source.service, birth: String(n) } }) }).runtime.probe()).code, 'OLLAMA_NATIVE_CHANGED');
  for (const bad of [null, {}, { ...source, connections: -1 }, { ...source, native: {} },
    { ...source, native: { ...source.native, executable: 'C:\\other\\llama-server.exe' } }]) {
    assert.throws(() => validateIdentity(bad)); checks++;
  }
  const exact = fixture();
  eq(await exact.runtime.measure({ system: 'PRIVATE SYSTEM', prompt: 'PRIVATE PROMPT', model: 'qwen3:4b-instruct' }),
    { inputTokens: 3, renderedCharacters: 16 });
  eq(exact.calls.find(call => call.route === '/apply-template').body,
    { messages: [{ role: 'system', content: 'PRIVATE SYSTEM' }, { role: 'user', content: 'PRIVATE PROMPT' }], add_generation_prompt: true });
  eq(exact.calls.find(call => call.route === '/tokenize').body,
    { content: 'PRIVATE RENDERED', add_special: false, parse_special: true });
  assert.ok(exact.calls.every(call => !/chat|completion|generate/.test(call.route))); checks++;
  await assert.rejects(fixture().runtime.measure({ model: 'wrong' }), { code: 'OLLAMA_NATIVE_MODEL' }); checks++;
  await assert.rejects(fixture({ identity: () => ({ ...source, native: null }) }).runtime.measure({ model: 'qwen3:4b-instruct' }), { code: 'OLLAMA_NATIVE_UNLOADED' }); checks++;
  let count = 0;
  const drain = createLocalNativeRuntime({ inspect: async () => copy(source),
    sleep: async () => { count++; }, fetchImpl: async url => ({ ok: true, json: async () => new URL(url).pathname === '/api/version'
      ? { version: '0.32.15' } : [{ is_processing: count < 2 }] }) });
  eq((await drain.waitUntilIdle()).state, 'idle');
  eq(count, 2);
  console.log('local-native-runtime: ' + checks + ' checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
