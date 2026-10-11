'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { plans, missingPlans, MISSING_KEYS, TRAIT_REVISIONS, TARGETS, hash } = require('../bin/compare-botbaffler-persona');
const { checkHeld, checkState, createWindow } = require('../bin/botbaffler-experiment-window');
const { cleanPayload } = require('../worker');
const tokenizer = { MODEL: 'fixture-model', countRequest: () => 700 };
const packet = { version: 1, cases: TARGETS.map(target => {
  const request = { model: tokenizer.MODEL, numPredict: 200, temperature: 0.8,
    system: TRAIT_REVISIONS.map(([before]) => before).join(' '), prompt: 'Exact frozen context' };
  return { target, request, requestHash: hash(JSON.stringify(request)), turnId: 'fixture' };
}) };
const calls = plans(packet, tokenizer, 'revised');
const prior = { treatment: 'revised', calls, packetHash: hash(JSON.stringify(packet)), traitRevisions: TRAIT_REVISIONS };
const summary = { results: calls.map(call => {
  const missing = MISSING_KEYS.includes(call.label + '-' + call.variant);
  return { label: call.label, variant: call.variant, expectedInput: call.inputTokens, promptHash: call.promptHash,
    status: missing ? 'failed' : 'completed', ...(missing ? { partialAccepted: false }
      : { text: 'Previously completed, never invoke again', usage: { inputTokens: call.inputTokens } }) };
}) };
const before = JSON.stringify({ prior, summary });
const selected = missingPlans(calls, prior, summary, prior.packetHash);
assert.deepEqual(selected.map(c => c.label + '-' + c.variant), MISSING_KEYS);
assert.equal(selected.length, 5); assert(!selected.some(c => c.label === 'collaborative-tree-tax'));
assert.equal(JSON.stringify({ prior, summary }), before);
for (const mutate of [s => { s.results[0].status = 'claimed'; }, s => { s.results[0].partialAccepted = true; },
  s => { s.results[5].usage.inputTokens++; }, s => { s.results[7] = s.results[6]; },
  s => { s.results[7].status = 'failed'; s.results[7].partialAccepted = false; }]) {
  const altered = structuredClone(summary); mutate(altered);
  assert.throws(() => missingPlans(calls, prior, altered, prior.packetHash));
}
const changed = structuredClone(prior); changed.calls[0].request.temperature = 1;
assert.throws(() => missingPlans(calls, changed, summary, prior.packetHash));
assert.throws(() => missingPlans(calls, prior, summary, 'different-packet'));
const payload = cleanPayload({ ...calls[0].request, timeoutMs: 900000 }, new Set([tokenizer.MODEL]));
assert.equal(payload.timeoutMs, 900000); assert.equal(payload.temperature, 0.8); assert.equal(payload.numPredict, 200);
assert.equal(cleanPayload(calls[0].request, new Set([tokenizer.MODEL])).timeoutMs, 300000);
const empty = { active: null, queued: { cy: 0, synthetic: 0 }, profile: { num_ctx: 3072, num_thread: 4 } };
checkState(empty);
checkState({ ...empty, active: { client: 'feddit', purpose: 'owned', priorityClass: 'synthetic' } }, 'owned');
assert.throws(() => checkState({ ...empty, active: { client: 'cy', purpose: 'dream', priorityClass: 'cy' } }, 'owned'));
assert.throws(() => checkState({ ...empty, queued: { cy: 1 } }));
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botbaffler-window-test-'));
  assert.equal(path.dirname(directory), os.tmpdir());
  let clock = Date.now(), state = empty, busy = false;
  const now = () => clock, save = () => {}, alive = pid => pid === 101 || pid === 102;
  const writeStatus = (name, requestId, mode = 'held', active = 0) => fs.writeFileSync(path.join(directory, name + '-status.json'),
    JSON.stringify({ version: 1, pid: name === 'cy' ? 101 : 102, requestId, state: mode, active, updatedAt: new Date(clock).toISOString() }));
  const initial = () => { writeStatus('cy', null, 'running'); writeStatus('feddit', null, 'running'); };
  const held = id => { writeStatus('cy', id); writeStatus('feddit', id); };
  const options = id => ({ directory, id, save, now, alive, isBusy: () => busy, state: async () => state,
    sleep: async ms => { clock += ms; held(id); } });
  try {
    initial(); const window = createWindow(options('owned'));
    await window.enter(); checkHeld(directory, 'owned', { now, alive });
    const client = window.wrapLeaseClient({ async acquire(options) {
      assert.equal(options.purpose, 'owned');
      state = { ...empty, active: { client: 'feddit', purpose: 'owned', priorityClass: 'synthetic' } };
      return { id: 'lease-fixture', profile: empty.profile, waitMs: 0, async release() { state = empty; } };
    } });
    const lease = await client.acquire({ priorityClass: 'synthetic', onLost() {} });
    await window.guard();
    await assert.rejects(window.close(), /must stop/);
    assert(fs.existsSync(path.join(directory, 'request.json')));
    await lease.release(); busy = true; await assert.rejects(window.close(), /must stop/);
    busy = false; await window.close(); assert(!fs.existsSync(path.join(directory, 'request.json')));
    initial(); fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ version: 1, id: 'other' }));
    const other = createWindow(options('new')); await assert.rejects(other.enter()); await other.close();
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'request.json'))).id, 'other');
    fs.unlinkSync(path.join(directory, 'request.json'));
    initial(); const draining = createWindow({ ...options('slow'), sleep: async () => { clock += 20 * 60 * 1000; } });
    await assert.rejects(draining.enter(), /Safe drain/); await draining.close();
    assert(!fs.existsSync(path.join(directory, 'request.json')));
    fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ version: 1, id: 'fixture' })); held('fixture');
    clock += 15001; assert.throws(() => checkHeld(directory, 'fixture', { now, alive }));
    held('fixture'); assert.throws(() => checkHeld(directory, 'fixture', { now, alive, pins: { cy: 999, feddit: 102 } }));
    writeStatus('cy', 'fixture', 'draining', 1); assert.throws(() => checkHeld(directory, 'fixture', { now, alive }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('PASS: five authorized missing cells only; completed outputs pinned; immutable personas/settings; experiment-only timeout; fresh pinned drain/hold; owned lease; safe cleanup; no competing-hold removal.');
})().catch(error => { console.error(error); process.exitCode = 1; });
