'use strict';
const assert = require('assert/strict');
const { coordinate, WINDOW_MS, DRAIN_MS } = require('./causal-full-context-window');
let checks = 0;
async function scenario(failAt, failCleanup = false) {
  const calls = []; let held = false;
  const invoke = async name => { calls.push(name); if (name === failAt || (failCleanup && name === 'cleanup')) throw Error(name); };
  const ops = Object.fromEntries(['preflight', 'drain', 'guard', 'unloadProduction', 'startIsolated', 'verify', 'ensureTime', 'cleanup'].map(name => [name, () => invoke(name)]));
  ops.requestHold = async () => { held = true; await invoke('requestHold'); };
  ops.ownsHold = async () => held;
  ops.releaseHold = async () => { await invoke('releaseHold'); held = false; };
  ops.runCell = cell => invoke(cell);
  let error; try { await coordinate(ops); } catch (caught) { error = caught; }
  return { calls, held, error };
}
(async () => {
  const normal = await scenario();
  assert.deepEqual(normal.calls, ['preflight', 'requestHold', 'drain', 'guard', 'unloadProduction', 'startIsolated', 'verify', 'guard', 'ensureTime', 'B', 'guard', 'ensureTime', 'D', 'cleanup', 'releaseHold']); checks++;
  assert.equal(normal.held, false); checks++;
  assert.equal(WINDOW_MS, 2400000); assert.equal(DRAIN_MS, 480000); checks += 2;
  for (const failAt of ['requestHold', 'drain', 'unloadProduction', 'startIsolated', 'verify', 'ensureTime', 'B', 'D']) {
    const failed = await scenario(failAt);
    assert.ok(failed.error); assert.equal(failed.held, false); checks += 2;
    assert.deepEqual(failed.calls.slice(-2), ['cleanup', 'releaseHold']); checks++;
    if (failAt !== 'D') { assert.equal(failed.calls.includes('D'), false); checks++; }
    if (['requestHold', 'drain'].includes(failAt)) { assert.equal(failed.calls.includes('unloadProduction'), false); checks++; }
  }
  const dirty = await scenario('B', true);
  assert.equal(dirty.held, true); assert.equal(dirty.calls.includes('releaseHold'), false); checks += 2;
  const preflight = await scenario('preflight');
  assert.deepEqual(preflight.calls, ['preflight']); assert.equal(preflight.held, false); checks += 2;
  console.log(checks + ' experiment-window ordering checks passed; no network or model calls.');
})().catch(error => { console.error(error); process.exitCode = 1; });
