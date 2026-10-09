'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createOwner, snapshotScript, terminateExact } = require('./causal-process-owner');
const root = { pid: 10, parentPid: 1, exe: 'C:/Ollama/ollama.exe', createdAt: '2026-10-09T13:00:00Z', models: 'C:/private/models', url: 'http://127.0.0.1:11436' };
const child = { pid: 11, parentPid: 10, exe: 'C:\\Ollama\\ollama.exe', createdAt: '2026-10-09T13:00:01Z' };
const helper = { pid: 12, parentPid: 11, exe: 'C:\\Windows\\System32\\conhost.exe', createdAt: '2026-10-09T13:00:02Z' };
const sample = (processes, listeners = [{ pid: 10, address: '127.0.0.1' }]) => ({ sampledAt: '2026-10-09T13:00:05Z', processes, listeners });
function fixture(samples, extras = {}) {
  const events = [], stops = []; let index = 0;
  const owner = createOwner(root, { snapshot: async () => samples[Math.min(index++, samples.length - 1)], persist: e => events.push(e),
    terminate: async p => stops.push(p.pid), sleep: async () => {}, portFree: async () => true, ...extras });
  return { owner, events, stops };
}
test('canonical slash paths accept GPU probe and console descendants regardless of row order', async () => {
  const { owner } = fixture([sample([helper, child, root])]);
  const result = await owner.observe(); assert.deepEqual(result.live.map(p => p.pid).sort(), [10, 11, 12]);
  assert.equal(root.childPids, undefined, 'original immutable receipt not modified');
});
test('exact root birth and executable reject PID reuse', async () => {
  for (const changed of [{ ...root, createdAt: '2026-10-09T13:00:03Z' }, { ...root, exe: 'C:/foreign.exe' }]) {
    await assert.rejects(fixture([sample([changed])]).owner.observe(), /ROOT_IDENTITY_CHANGED/);
  }
});
test('same install directory or model path is not proof of ownership', async () => {
  const f = fixture([sample([root, { ...child, parentPid: 99, modelReference: true }])]);
  await assert.rejects(f.owner.observe(), /UNPROVEN_ISOLATED_PROCESS/);
  assert.equal(f.events.filter(e => e.type === 'rejected').length, 3);
  assert.equal(f.events[0].processes[0].pid, 11);
  assert(!JSON.stringify(f.events).includes('CommandLine'));
});
test('transient process exit during CIM sampling is retried, not treated as model failure', async () => {
  const f = fixture([sample([root, { ...child, exe: null }]), sample([root])]);
  assert.equal((await f.owner.observe()).live.length, 1);
  assert.equal(f.events[0].code, 'INCOMPLETE_PROCESS_IDENTITY');
});
test('previously proven orphan remains owned and is cleaned even when daemon has exited', async () => {
  const f = fixture([sample([root, child]), sample([child], []), sample([], [])]);
  await f.owner.observe(); await f.owner.cleanup();
  assert.deepEqual(f.stops, [10, 11]);
  assert.equal(f.events.at(-1).type, 'teardown-verified');
});
test('unknown orphan with no proven ancestry blocks cleanup and release', async () => {
  const f = fixture([sample([{ ...child, modelReference: true }], [])]);
  await assert.rejects(f.owner.cleanup(), /UNPROVEN_ISOLATED_PROCESS/); assert.deepEqual(f.stops, []);
});
test('known child PID reuse blocks exact cleanup', async () => {
  const f = fixture([sample([root, child]), sample([root, { ...child, createdAt: '2026-10-09T13:00:04Z' }])]);
  await f.owner.observe(); await assert.rejects(f.owner.cleanup(), /DESCENDANT_IDENTITY_CHANGED/); assert.deepEqual(f.stops, []);
});
test('foreign listener and residual bound port prevent release', async () => {
  await assert.rejects(fixture([sample([root], [{ pid: 99, address: '127.0.0.1' }])]).owner.observe(), /FOREIGN_ISOLATED_LISTENER/);
  await assert.rejects(fixture([sample([], [])], { portFree: async () => false }).owner.proveGone(), /ISOLATED_PORT_STILL_BOUND/);
});
test('stale PPID from an older parent instance is ignored, never adopted or terminated', async () => {
  const old = { ...child, createdAt: '2026-10-09T12:00:00Z' };
  const f = fixture([sample([root, old]), sample([root, old]), sample([old], [])]);
  const result = await f.owner.observe();
  assert.deepEqual(result.live.map(p => p.pid), [10]);
  assert.equal(result.ignoredPriorParentInstance[0].pid, 11);
  await f.owner.cleanup(); assert.deepEqual(f.stops, [10]);
  await assert.rejects(fixture([sample([root, { ...old, modelReference: true }])]).owner.observe(), /UNPROVEN_ISOLATED_PROCESS/);
});
test('durable observations survive owner restart and retain orphan ownership without raw commands', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-owner-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const evidenceFile = path.join(dir, 'processes.jsonl');
  await createOwner(root, { evidenceFile, snapshot: async () => sample([root, child]) }).observe();
  const restored = createOwner(root, { evidenceFile, snapshot: async () => sample([child], []) });
  assert.equal((await restored.observe({ requireParent: false, requireListener: false })).live[0].pid, 11);
  assert.throws(() => createOwner({ ...root, pid: 20 }, { evidenceFile }), /OWNER_MISMATCH/);
});
test('snapshot emits literal single-backslash matching and metadata-only process projection', () => {
  const script = snapshotScript(root, []);
  assert(script.includes(".Replace('/','\\')")); assert(script.includes("$models+'\\'"));
  assert(script.includes('modelReference=$reference')); assert(!script.includes('CommandLine=$'));
});
test('real model-free Windows process tree is observed and cleaned by exact identities', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  // Check CIM permission BEFORE creating any fixture child. The sandbox may
  // deny CIM; run this same test outside it for real native coverage.
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference='Stop';Get-CimInstance Win32_Process -Filter 'ProcessId=" + process.pid + "'|Out-Null"], { stdio: 'pipe' });
  } catch { t.skip('CIM inspection unavailable in this execution context'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-owner-native-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawned = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(String(c.pid));setInterval(()=>{},1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const childPid = await new Promise((resolve, reject) => { spawned.stdout.once('data', d => resolve(Number(d.toString()))); spawned.once('error', reject); });
  // Retain exact fixture identities for fallback cleanup; never kill a reused PID.
  const script = `$ErrorActionPreference='Stop';$rows=@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -eq ${spawned.pid} -or $_.ProcessId -eq ${childPid}}|ForEach-Object {@{pid=[int]$_.ProcessId;exe=$_.ExecutablePath;createdAt=$_.CreationDate.ToUniversalTime().ToString('o')}});@{rows=$rows}|ConvertTo-Json -Depth 3 -Compress`;
  const records = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64')], { encoding: 'utf8' })).rows;
  t.after(async () => { for (const p of records) await terminateExact(p); });
  const record = records.find(p => p.pid === spawned.pid);
  const owner = createOwner({ ...record, models: path.join(dir, 'models'), url: root.url }, { evidenceFile: path.join(dir, 'identities.jsonl') });
  let observed;
  try { observed = await owner.observe({ requireListener: false }); }
  catch (error) { console.error(JSON.stringify({ fixtureParent: record, fixtureChildPid: childPid, rejected: error.processes })); throw error; }
  assert(observed.live.some(p => p.pid === childPid));
  assert.equal((await owner.cleanup()).gone, true);
});
