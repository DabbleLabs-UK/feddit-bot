'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPauseResources } = require('../lib/desktop-pause-resources');
const { createLocalNativeRuntime } = require('../lib/local-native-runtime');
const { createModelUseStore } = require('../lib/local-model-use');
let checks = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
const immediate = () => new Promise(resolve => setImmediate(resolve));
const id = { service: { pid: 11, birth: 'one', executable: 'C:\\runtime\\ollama.exe' },
  native: { pid: 12, birth: 'two', executable: 'C:\\runtime\\lib\\ollama\\llama-server.exe', port: 49152 }, connections: 0 };
const used = { service: id.service, native: id.native, model: 'qwen3:4b-instruct', digest: 'a'.repeat(64) };
function native(options = {}) {
  let unloaded = false, reads = 0;
  const calls = [];
  const runtime = createLocalNativeRuntime({ inspect: async () => {
    reads++;
    return structuredClone(options.identity ? options.identity(reads) : id);
  }, fetchImpl: async (url, request) => {
    const route = new URL(url).pathname;
    calls.push({ route, body: request.body ? JSON.parse(request.body) : null });
    if (route === '/api/generate') { unloaded = true; if (options.onUnload) options.onUnload(); }
    if (options.onRead) options.onRead(route);
    if (options.fail) throw new Error('PRIVATE SECRET');
    return { ok: true, json: async () => route === '/api/version' ? { version: options.version || '0.32.15' }
      : route === '/slots' ? (options.slots || [{ is_processing: false }])
      : route === '/api/ps' ? { models: unloaded ? [] : (options.models || [{ name: used.model, digest: used.digest }]) }
      : { done: true } };
  } });
  return { runtime, calls, releases: () => calls.filter(call => call.route === '/api/generate').length };
}
async function run() {
  let paused = false, busy = false, calls = 0, complete;
  const resources = createPauseResources({ enabled: true, paused: () => paused, busy: () => busy,
    release: async allowed => { calls++; await new Promise(resolve => { complete = resolve; }); return { state: allowed() ? 'unloaded' : 'cancelled' }; } });
  await resources.tick(); eq(calls, 0);
  paused = true; busy = true; resources.changed(); await resources.tick();
  eq(resources.view().state, 'draining'); eq(calls, 0);
  busy = false; const pending = resources.tick(); await immediate(); eq(calls, 1);
  const repeated = resources.tick(); eq(calls, 1);
  paused = false; resources.changed(); complete(); await pending; await repeated;
  eq(resources.view().state, 'running');
  paused = true; const next = resources.tick(); await immediate(); complete(); await next;
  eq(resources.view().state, 'unloaded'); resources.close();
  const errors = createPauseResources({ enabled: true, paused: () => true, busy: () => false, release: async () => { throw new Error('SECRET'); } });
  await errors.tick(); eq(errors.view(), { state: 'held', code: 'MODEL_RELEASE_UNAVAILABLE' }); errors.close();
  const hosted = createPauseResources({ enabled: false, paused: () => true, busy: () => false, release: () => { throw Error('must not run'); } });
  await hosted.tick(); eq(hosted.view().state, 'unsupported'); hosted.close();
  const clean = native(); eq(await clean.runtime.usedModel(used.model), used);
  eq(await clean.runtime.usedModel(used.model, { before: { ...used, native: { ...used.native, birth: 'old' } } }), null);
  const born = { ...id, native: { ...id.native, birth: '2026-11-01T10:00:01Z' } };
  const cold = native({ identity: () => born });
  eq((await cold.runtime.usedModel(used.model, { startedAt: Date.parse('2026-11-01T10:00:00Z'), firstOutputAt: Date.parse('2026-11-01T10:00:02Z') })).native.birth, born.native.birth);
  eq(await cold.runtime.usedModel(used.model, { startedAt: 0, firstOutputAt: Date.parse('2026-11-01T10:00:00Z') }), null);
  eq(await cold.runtime.usedModel(used.model, { startedAt: 0 }), null);
  eq(await clean.runtime.releaseModel(used, () => true), { state: 'unloaded', retired: true }); eq(clean.releases(), 1);
  eq(clean.calls.find(call => call.route === '/api/generate').body, { model: used.model, keep_alive: 0, stream: false });
  for (const options of [
    { version: 'other' }, { slots: [{ is_processing: true }] }, { slots: [] }, { slots: [{}] },
    { models: [{ name: 'unrelated', digest: 'b'.repeat(64) }] },
    { models: [{ name: used.model, digest: used.digest }, { name: 'other', digest: 'b'.repeat(64) }] },
    { identity: () => ({ ...id, connections: 1 }) },
    { identity: () => ({ ...id, native: { ...id.native, birth: 'replaced' } }) },
    { identity: n => n < 2 ? id : ({ ...id, connections: 1 }) },
    { identity: n => n < 2 ? id : ({ ...id, service: { ...id.service, birth: 'new' } }) },
  ]) {
    const item = native(options); const outcome = await item.runtime.releaseModel(used, () => true);
    eq(item.releases(), 0); assert.notEqual(outcome.state, 'unloaded'); checks++;
  }
  const absent = native({ identity: () => ({ ...id, native: null }) });
  eq((await absent.runtime.releaseModel(used, () => true)).state, 'unloaded'); eq(absent.releases(), 0);
  let allowed = true;
  const resumed = native({ onRead: route => { if (route === '/slots') allowed = false; } });
  eq((await resumed.runtime.releaseModel(used, () => allowed)).state, 'cancelled'); eq(resumed.releases(), 0);
  const unknown = native({ fail: true }); await assert.rejects(unknown.runtime.releaseModel(used, () => true)); checks++;
  eq(unknown.releases(), 0);
  const notPersisted = native();
  eq((await notPersisted.runtime.releaseModel(used, () => true, () => false)).code, 'MODEL_USE_STORE_UNAVAILABLE'); eq(notPersisted.releases(), 0);
  const pendingIdentity = { ...id };
  let waiting = 0;
  const pendingRuntime = createLocalNativeRuntime({ inspect: async () => pendingIdentity,
    sleep: async () => { waiting++; pendingIdentity.native = null; },
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ digest: used.digest }] }) }) });
  await pendingRuntime.waitUntilReleased(used); eq(waiting, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-model-use-'));
  const file = path.join(dir, 'use.json'); let store = createModelUseStore(file);
  eq(store.list(), []); eq(store.record(used), true);
  store = createModelUseStore(file); eq(store.list(), [used]);
  for (let i = 0; i < 12; i++) store.record({ ...used, model: 'model-' + i });
  eq(store.list().length, 8);
  eq(store.record({ ...used, digest: 'bad' }), false);
  const record = store.list()[0]; store.remove(record); eq(store.list().length, 7);
  fs.writeFileSync(file, 'corrupt'); store = createModelUseStore(file);
  eq(store.list(), null); eq(store.record(used), false); eq(fs.readFileSync(file, 'utf8'), 'corrupt');
  const faulty = createModelUseStore(path.join(dir, 'missing'), { statSync() { throw Object.assign(new Error(), { code: 'ENOENT' }); }, mkdirSync() { throw new Error(); } });
  eq(faulty.record(used), false); eq(faulty.list(), null);
  // Restart and sleep/resume do not change saved pause or infer. Only currently
  // verified process birth/digest can authorize an unload after restoration.
  const stale = native({ identity: () => ({ ...id, service: { ...id.service, birth: 'after-restart' } }) });
  eq((await stale.runtime.releaseModel(used, () => true)).code, 'MODEL_INSTANCE_CHANGED'); eq(stale.releases(), 0);
  eq(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').includes("enabled: PLACEMENT === 'desktop'"), true);
  console.log('desktop-pause-resources: ' + checks + ' checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
