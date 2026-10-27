'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-native-drain-'));
process.env.FEDDIT_BOT_DATA_DIR = dir;
const ollama = require('../lib/providers/ollama');
let checks = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function run() {
  let release;
  let state = 'busy';
  let holdCount = 0;
  let requests = 0;
  const runtime = { probe: async () => ({ state, code: 'fixture' }),
    waitUntilIdle: async notify => {
      holdCount++;
      notify({ state, code: 'fixture' });
      if (state !== 'idle') await new Promise(resolve => { release = resolve; });
      return { state: 'idle' };
    }, measure: async () => ({ inputTokens: 12 }) };
  ollama.configureRuntime({ placement: 'desktop', nativeRuntime: runtime });
  eq(ollama.isBusy(), true);
  eq(ollama.generationActivity().active, null);
  await assert.rejects(ollama.generate({ leaseClient: null }), { code: 'BUSY' }); checks++;
  state = 'idle'; release(); await tick();
  eq(ollama.isBusy(), false);
  eq(await ollama.measureDecision({}), { inputTokens: 12 });
  const failed = Object.assign(new Error('Original failure'), { code: 'OLLAMA_FIRST_OUTPUT_TIMEOUT' });
  await assert.rejects(ollama.generate({ leaseClient: null, chatTransport: async () => { requests++; state = 'busy'; throw failed; } }), error => error === failed); checks++;
  eq(ollama.isBusy(), true);
  eq(ollama.generationActivity().active, null);
  await assert.rejects(ollama.generate({ leaseClient: null, chatTransport: async () => { requests++; } }), { code: 'BUSY' }); checks++;
  eq(requests, 1);
  state = 'idle'; release(); await tick();
  eq(ollama.isBusy(), false);
  eq(holdCount, 2);
  await assert.rejects(ollama.generate({ leaseClient: null, chatTransport: async () => ({ done: true, message: { content: '' } }) }), { code: 'EMPTY_RESPONSE' }); checks++;
  eq(ollama.isBusy(), false);
  eq(holdCount, 2);
  state = 'unknown';
  await assert.rejects(ollama.generate({ leaseClient: null, chatTransport: async () => { requests++; } }), { code: 'OLLAMA_NATIVE_DRAINING' }); checks++;
  eq(requests, 1);
  eq(ollama.isBusy(), true);
  state = 'idle'; release(); await tick();
  eq(ollama.isBusy(), false);
  ollama.configureRuntime({ placement: 'advanced' });
  eq((await ollama.generate({ leaseClient: null, chatTransport: async () => ({ done: true, message: { content: 'Valid' } }) })).text, 'Valid');
  eq(ollama.isBusy(), false);
  const tokenizer = require('../lib/desktop-tokenizer');
  const originalVerify = tokenizer.verifyModel;
  let metadataReads = 0;
  let verificationCalls = 0;
  let inferenceCalls = 0;
  const system = 'A careful participant.';
  const prompt = 'Choose WAIT or the offered action.';
  const numPredict = 640;
  const descriptor = { version: 2, inputLimit: 2400, inputTokens: tokenizer.countRequest(system, prompt),
    requestHash: require('node:crypto').createHash('sha256').update(JSON.stringify([system, prompt, numPredict])).digest('hex') };
  const options = { system, prompt, numPredict, model: tokenizer.MODEL, leaseClient: null,
    desktopDecisionBudget: descriptor, metadataTransport: async () => { metadataReads++; return { fixture: true }; },
    chatTransport: async () => { inferenceCalls++; return { done: true, message: { content: 'WAIT' } }; } };
  tokenizer.verifyModel = (show, tags) => { assert.equal(show.fixture, true); assert.equal(tags.fixture, true); verificationCalls++; };
  try {
    eq((await ollama.generate(options)).text, 'WAIT');
    eq(metadataReads, 2);
    eq(verificationCalls, 1);
    eq(inferenceCalls, 1);
    for (const changed of [{ inputLimit: 3000 }, { inputTokens: descriptor.inputTokens + 1 }, { version: 1 }, { requestHash: 'wrong' }]) {
      await assert.rejects(ollama.generate({ ...options, desktopDecisionBudget: { ...descriptor, ...changed } }), { code: 'DESKTOP_DECISION_BUDGET_INVALID' }); checks++;
    }
    await assert.rejects(ollama.generate({ ...options, prompt: prompt + ' changed' }), { code: 'DESKTOP_DECISION_BUDGET_INVALID' }); checks++;
    await assert.rejects(ollama.generate({ ...options, model: 'another' }), { code: 'DESKTOP_DECISION_BUDGET_INVALID' }); checks++;
    tokenizer.verifyModel = () => { throw new Error('PRIVATE METADATA'); };
    await assert.rejects(ollama.generate(options), error => error.code === 'DESKTOP_DECISION_BUDGET_INVALID' && !error.message.includes('PRIVATE')); checks++;
    eq(inferenceCalls, 1);
    eq(ollama.isBusy(), false);
  } finally { tokenizer.verifyModel = originalVerify; }
  console.log('ollama-native-drain: ' + checks + ' checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
