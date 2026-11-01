'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.FEDDIT_BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-pause-provider-'));
const provider = require('../lib/providers/ollama');
const immediate = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
async function run() {
  let uses = [], releaseCount = 0, finish, drain, releaseFinish;
  const nativeRuntime = { probe: async () => ({ state: 'idle' }),
    waitUntilIdle: async () => { if (drain) await new Promise(resolve => { drain.resolve = resolve; }); return { state: 'idle' }; },
    usedModel: async model => ({ model }),
    releaseModel: async (record, allowed) => { releaseCount++; eq(allowed(), true); if (releaseFinish) await new Promise(resolve => { releaseFinish.resolve = resolve; }); return { state: 'unloaded', retired: true }; } };
  const modelUseStore = { list: () => uses, record: value => { uses = [value]; return true; }, remove: () => { uses = []; return true; } };
  provider.configureRuntime({ placement: 'desktop', nativeRuntime, modelUseStore }); await immediate();
  const generation = provider.generate({ leaseClient: null, model: 'owned', chatTransport: async () => { await new Promise(resolve => { finish = resolve; }); return { message: { content: 'READY' } }; } });
  await immediate(); eq((await provider.releasePausedModels(() => true)).state, 'draining'); eq(releaseCount, 0);
  finish(); eq((await generation).text, 'READY'); eq(uses, [{ model: 'owned' }]);
  eq((await provider.releasePausedModels(() => false)).state, 'cancelled'); eq(releaseCount, 0);
  releaseFinish = {};
  const releasing = provider.releasePausedModels(() => true); await immediate(); eq(provider.isBusy(), true);
  await assert.rejects(provider.generate({ leaseClient: null }), { code: 'BUSY' }); checks++;
  releaseFinish.resolve(); eq((await releasing).state, 'unloaded'); await immediate();
  eq(provider.isBusy(), false); eq(uses, []);
  eq((await provider.releasePausedModels(() => true)).state, 'unloaded'); eq(releaseCount, 1);
  // Cancellation's delayed native computation is the same gate as before.
  releaseFinish = null; drain = {};
  await assert.rejects(provider.generate({ leaseClient: null, model: 'owned', chatTransport: async () => { throw Error('fixture timeout'); } })); checks++;
  eq(provider.isBusy(), true); eq((await provider.releasePausedModels(() => true)).state, 'draining'); eq(releaseCount, 1);
  drain.resolve(); drain = null; await immediate();
  eq((await provider.releasePausedModels(() => true)).state, 'unloaded'); await immediate(); eq(releaseCount, 2);
  let heldRelease;
  uses = [{ model: 'owned' }];
  const ambiguous = { ...nativeRuntime,
    releaseModel: async (record, allowed, markPending) => { eq(allowed(), true); eq(markPending(), true); throw Error('lost unload response'); },
    waitUntilReleased: async () => new Promise(resolve => { heldRelease = resolve; }),
  };
  provider.configureRuntime({ placement: 'desktop', nativeRuntime: ambiguous, modelUseStore }); await immediate();
  await assert.rejects(provider.releasePausedModels(() => true)); checks++;
  eq(uses[0].releasePending, true); eq(provider.isBusy(), true);
  await assert.rejects(provider.generate({ leaseClient: null }), { code: 'BUSY' }); checks++;
  eq((await provider.releasePausedModels(() => true)).state, 'releasing');
  // A fresh process restores the pending unload fence, even though slots would
  // report idle. Never resend an ambiguous unload or start inference on top.
  delete require.cache[require.resolve('../lib/providers/ollama')];
  const restarted = require('../lib/providers/ollama');
  let restartRelease;
  restarted.configureRuntime({ placement: 'desktop', nativeRuntime: { ...ambiguous,
    waitUntilReleased: async () => new Promise(resolve => { restartRelease = resolve; }) }, modelUseStore });
  eq(restarted.isBusy(), true);
  heldRelease(); restartRelease(); await immediate();
  eq(provider.isBusy(), false); eq(restarted.isBusy(), false); eq(uses, []);
  provider.configureRuntime({ placement: 'hosted' });
  eq((await provider.releasePausedModels(() => true)).state, 'unsupported'); eq(releaseCount, 2);
  console.log('ollama-pause-release: ' + checks + ' checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
