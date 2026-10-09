'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const { EventEmitter } = require('events');
const base = require('./causal-maintenance-run'), full = require('./causal-full-context');
let checks = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
async function rejects(fn, pattern) { await assert.rejects(fn, pattern); checks++; }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-full-context-')), old = path.join(root, 'old'), next = path.join(root, 'new'); fs.mkdirSync(old);
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const frozenFile = path.join(root, 'frozen.json'), configFile = path.join(root, 'config.json');
  const frozen = { version: 1, turnId: 'fixture', request: { system: 'System', prompt: 'Frozen private prompt', temperature: 0.8, numPredict: 640 }, candidates: [], voteCandidates: [] };
  write(frozenFile, frozen);
  const config = { url: 'http://127.0.0.1:11436', productionDigest: base.PRODUCTION_DIGEST, productionManifestFile: path.join(root, 'production.json'),
    maintenanceId: 'original', maintenanceDirectory: root, fullContext: 4096, frozenFile, frozenSha256: base.sha(fs.readFileSync(frozenFile)),
    outputDirectory: old, weightSha256: 'a'.repeat(64), models: Object.fromEntries(['control', 'corrected'].map(key => [key, {
      name: 'causal-maintenance-' + key, templateSha256: 'b'.repeat(64), parametersSha256: 'c'.repeat(64), fullInputTokens: 3420,
      effectiveFullContext: 4096, fullRenderedSha256: 'd'.repeat(64), manifestFile: path.join(root, key + '.json') }])) };
  write(configFile, config); write(config.productionManifestFile, { fixture: true });
  for (const model of Object.values(config.models)) write(model.manifestFile, { model: model.name });
  write(path.join(old, 'experiment-reserved.json'), { configHash: base.sha(fs.readFileSync(configFile)) });
  for (const cell of base.plan(config, frozen)) {
    write(path.join(old, cell.cell + '-started.json'), { status: 'started', startedAt: '2026-10-09T14:04:23.920Z', requestHash: base.sha(JSON.stringify(cell.body)) });
    const complete = ['A', 'C'].includes(cell.cell), status = complete ? 'completed' : 'failed-no-retry';
    write(path.join(old, cell.cell + '-' + status + '.json'), { cell: cell.cell, status, elapsedMs: complete ? 188000 : 300000,
      ...(complete ? { response: { done: true, message: { content: 'not JSON' }, prompt_eval_count: 1538 } } : { errorClass: 'timeout-or-cancelled' }) });
  }
  const owned = path.join(root, 'owned.json'); write(owned, { pid: 123, createdAt: 'fixture', models: 'isolated' });
  return { root, old, next, config, configFile, owned, write, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function transport() {
  let now = 0, deadline, callback, options, sent, destroyed = 0;
  const req = new EventEmitter(); req.end = bytes => { sent = bytes; }; req.destroy = () => { destroyed++; };
  const response = new EventEmitter(); response.statusCode = 200; response.destroy = () => { destroyed++; };
  const deps = { now: () => now, setTimeout: (fn, ms) => { deadline = { fn, ms }; return 1; }, clearTimeout: () => {},
    request: (url, opts, cb) => { options = opts; callback = cb; return req; } };
  return { deps, req, response, advance: value => { now = value; }, headers: () => callback(response), fire: () => deadline.fn(),
    get deadline() { return deadline; }, get options() { return options; }, get sent() { return sent; }, get destroyed() { return destroyed; } };
}
async function main() {
  eq(full.TIMEOUT_MS, 900000);
  const one = fixture();
  try {
    const oldBytes = fs.readdirSync(one.old).map(file => fs.readFileSync(path.join(one.old, file), 'utf8'));
    const receipt = full.prepare(one.configFile, one.next); eq(receipt.cells, ['B', 'D']); eq(receipt.controls.A.score.strictJson, false);
    assert.throws(() => full.prepare(one.configFile, one.next), /EEXIST/); checks++;
    const options = { guard: async () => {}, currentOwnedRecordFile: one.owned };
    await rejects(() => full.runCell(one.next, 'A', options), /Only/);
    await rejects(() => full.runCell(one.next, 'C', options), /Only/);
    await rejects(() => full.runCell(one.next, 'D', options), /complete B/);
    let calls = 0;
    options.request = async (url, body, timeout) => {
      calls++; eq(timeout, 900000); eq(body, base.plan(one.config, JSON.parse(fs.readFileSync(one.config.frozenFile))).find(cell => cell.cell === (calls === 1 ? 'B' : 'D')).body);
      eq(body.stream, false); eq(body.options.num_ctx, 4096);
      return { done: true, message: { content: '{"choice":"WAIT"}' }, prompt_eval_count: 3420 };
    };
    await full.runCell(one.next, 'B', options);
    await rejects(() => full.runCell(one.next, 'B', options), /EEXIST/);
    await full.runCell(one.next, 'D', options);
    await rejects(() => full.runCell(one.next, 'D', options), /EEXIST/);
    eq(calls, 2);
    eq(fs.readdirSync(one.old).map(file => fs.readFileSync(path.join(one.old, file), 'utf8')), oldBytes);
    one.write(path.join(one.old, 'A-completed.json'), { changed: true });
    assert.throws(() => full.loadPrepared(one.next), /evidence changed/); checks++;
  } finally { one.dispose(); }
  for (const code of ['experiment-deadline', 'operator-cancelled', 'maintenance-guard-lost', 'maintenance-window-expired']) {
    const f = fixture();
    try {
      full.prepare(f.configFile, f.next); let calls = 0;
      const options = { guard: async () => {}, currentOwnedRecordFile: f.owned, request: async () => { calls++; throw full.classified(code); } };
      await rejects(() => full.runCell(f.next, 'B', options), new RegExp(code));
      eq(JSON.parse(fs.readFileSync(path.join(f.next, 'B-failed-no-retry.json'))).errorClass, code);
      await rejects(() => full.runCell(f.next, 'D', options), /complete B/);
      await rejects(() => full.runCell(f.next, 'B', options), /EEXIST/); eq(calls, 1);
    } finally { f.dispose(); }
  }
  const denied = fixture();
  try {
    full.prepare(denied.configFile, denied.next); let calls = 0;
    await rejects(() => full.runCell(denied.next, 'B', { currentOwnedRecordFile: denied.owned,
      guard: async () => { throw new Error('not held'); }, request: async () => { calls++; } }), /not held/);
    eq(calls, 0); eq(fs.existsSync(path.join(denied.next, 'B-started.json')), false);
  } finally { denied.dispose(); }
  const parallel = fixture();
  try {
    full.prepare(parallel.configFile, parallel.next); let calls = 0, complete;
    const options = { currentOwnedRecordFile: parallel.owned, guard: async () => {}, request: async () => {
      calls++; return new Promise(resolve => { complete = resolve; });
    } };
    const first = full.runCell(parallel.next, 'B', options);
    await rejects(() => full.runCell(parallel.next, 'B', options), /EEXIST/);
    eq(calls, 1); complete({ done: true, prompt_eval_count: 3420, message: { content: 'invalid model JSON is still a completed experimental response' } });
    eq((await first).score.strictJson, false);
    const different = path.join(parallel.root, 'different.json'); parallel.write(different, { pid: 789 });
    await rejects(() => full.runCell(parallel.next, 'D', { ...options, currentOwnedRecordFile: different }), /same verified daemon/);
  } finally { parallel.dispose(); }
  const incomplete = fixture();
  try {
    full.prepare(incomplete.configFile, incomplete.next);
    const options = { currentOwnedRecordFile: incomplete.owned, guard: async () => {}, request: async () => ({ done: false, message: { content: 'partial' } }) };
    await rejects(() => full.runCell(incomplete.next, 'B', options), /incomplete-response/);
    await rejects(() => full.runCell(incomplete.next, 'D', options), /complete B/);
  } finally { incomplete.dispose(); }
  const interrupted = fixture();
  try {
    fs.unlinkSync(path.join(interrupted.old, 'D-failed-no-retry.json'));
    const attestationFile = path.join(interrupted.root, 'D-operator-interrupted.json');
    interrupted.write(attestationFile, { cell: 'D', status: 'interrupted-no-retry', startedAt: '2026-10-09T14:04:23.920Z',
      cleanupCompletedAt: '2026-10-09T14:04:26.969Z', providerResultAvailable: false, remainingCallBudget: 0 });
    const receipt = full.prepare(interrupted.configFile, interrupted.next);
    eq(receipt.files[attestationFile], base.sha(fs.readFileSync(attestationFile)));
    eq(fs.existsSync(path.join(interrupted.old, 'D-failed-no-retry.json')), false);
    full.loadPrepared(interrupted.next);
    interrupted.write(attestationFile, { changed: true });
    assert.throws(() => full.loadPrepared(interrupted.next), /evidence changed/); checks++;
  } finally { interrupted.dispose(); }
  for (const failure of ['context-token-mismatch', 'maintenance-guard-lost']) {
    const f = fixture();
    try {
      full.prepare(f.configFile, f.next); let guards = 0;
      const options = { currentOwnedRecordFile: f.owned, guard: async () => { if (++guards === 2 && failure === 'maintenance-guard-lost') throw new Error('held gate lost'); },
        request: async () => ({ done: true, prompt_eval_count: failure === 'context-token-mismatch' ? 1538 : 3420, message: { content: 'private completed result' } }) };
      await rejects(() => full.runCell(f.next, 'B', options), new RegExp(failure));
      const evidence = JSON.parse(fs.readFileSync(path.join(f.next, 'B-failed-no-retry.json')));
      eq(evidence.errorClass, failure); eq(evidence.usable, false); eq(evidence.response.message.content, 'private completed result'); eq(guards, 2);
      await rejects(() => full.runCell(f.next, 'D', options), /complete B/);
    } finally { f.dispose(); }
  }
  // Transport tests are EventEmitter/fake-clock only. No listening sockets/model calls.
  const slow = transport(), body = { stream: false, messages: [{ role: 'user', content: 'fixture' }] };
  const success = full.nativeJsonRequest('http://127.0.0.1:11436/api/chat', body, 900000, undefined, slow.deps);
  eq(slow.deadline.ms, 900000); eq(slow.options.agent, false); eq(JSON.parse(slow.sent), body);
  slow.advance(400000); slow.headers(); slow.response.emit('data', Buffer.from('{"done":true}')); slow.response.emit('end');
  eq(await success, { done: true }); eq(slow.destroyed, 0);
  const timed = transport(), timedResult = full.nativeJsonRequest('http://127.0.0.1:11436/api/chat', body, 900000, undefined, timed.deps);
  timed.advance(900000); timed.fire(); await rejects(() => timedResult, /experiment-deadline/); eq(timed.destroyed, 1);
  const cancelled = transport(), controller = new AbortController();
  const partial = full.nativeJsonRequest('http://127.0.0.1:11436/api/chat', body, 900000, controller.signal, cancelled.deps);
  cancelled.headers(); cancelled.response.emit('data', Buffer.from('{"private":"partial'));
  controller.abort(full.classified('operator-cancelled'));
  try { await partial; assert.fail('partial result accepted'); } catch (error) { eq(error.code, 'operator-cancelled'); eq(error.telemetry.ended, false); eq(error.telemetry.responseBytes, 19); }
  eq(cancelled.destroyed, 2);
  const broken = transport(), brokenResult = full.nativeJsonRequest('http://127.0.0.1:11436/api/chat', body, 900000, undefined, broken.deps);
  broken.headers(); broken.response.emit('aborted'); await rejects(() => brokenResult, /response-aborted/);
  const invalid = transport(), invalidResult = full.nativeJsonRequest('http://127.0.0.1:11436/api/chat', body, 900000, undefined, invalid.deps);
  invalid.headers(); invalid.response.emit('data', Buffer.from('private upstream error body')); invalid.response.emit('end');
  await rejects(() => invalidResult, /invalid-response-envelope/);
  const rejected = transport(), rejectedResult = full.nativeJsonRequest('http://127.0.0.1:11436/api/chat', body, 900000, undefined, rejected.deps);
  rejected.response.statusCode = 503; rejected.headers(); await rejects(() => rejectedResult, /http-error/);
  assert.throws(() => full.nativeJsonRequest('http://127.0.0.1:11434/api/chat', body), /Only isolated/); checks++;
  console.log('causal-full-context: ' + checks + ' checks passed; zero network/model calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
