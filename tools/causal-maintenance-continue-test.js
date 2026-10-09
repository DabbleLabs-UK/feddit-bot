'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const base = require('./causal-maintenance-run');
const continuation = require('./causal-maintenance-continue');
let checks = 0;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-continuation-'));
  const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
  const frozenFile = path.join(root, 'frozen.json');
  write(frozenFile, { version: 1, turnId: 'fixture', request: { system: 'System', prompt: 'Frozen', temperature: 0.8, numPredict: 640 }, candidates: [], voteCandidates: [] });
  const config = { url: 'http://127.0.0.1:11436', productionDigest: base.PRODUCTION_DIGEST, productionManifestFile: path.join(root, 'production-manifest.json'),
    maintenanceId: 'old-maintenance', maintenanceDirectory: root, fullContext: 4096, frozenFile,
    frozenSha256: base.sha(fs.readFileSync(frozenFile)), outputDirectory: evidence, weightSha256: 'a'.repeat(64),
    models: Object.fromEntries(['control', 'corrected'].map(key => [key, { name: 'causal-maintenance-' + key, templateSha256: 'b'.repeat(64), parametersSha256: 'c'.repeat(64),
      fullInputTokens: 3400, effectiveFullContext: 4096, fullRenderedSha256: 'd'.repeat(64), manifestFile: path.join(root, key + '.json') }])) };
  const configFile = path.join(root, 'config.json'); write(configFile, config);
  write(path.join(evidence, 'experiment-reserved.json'), { configHash: base.sha(fs.readFileSync(configFile)) });
  const frozen = JSON.parse(fs.readFileSync(frozenFile));
  for (const cell of base.plan(config, frozen).slice(0, 2)) {
    write(path.join(evidence, cell.cell + '-started.json'), { status: 'started', requestHash: base.sha(JSON.stringify(cell.body)) });
    write(path.join(evidence, cell.cell + (cell.cell === 'A' ? '-completed.json' : '-failed-no-retry.json')), { cell: cell.cell, status: cell.cell === 'A' ? 'completed' : 'failed-no-retry' });
  }
  const owned = { pid: 111, url: config.url, exe: 'C:/fixture/ollama.exe', exeSha256: 'e'.repeat(64), models: path.join(root, 'models') };
  const previousFile = path.join(root, 'owned-process.json'); write(previousFile, owned);
  const currentFile = path.join(root, 'C-owned.json'); write(currentFile, { ...owned, pid: 222, createdAt: new Date().toISOString() });
  return { root, evidence, configFile, previousFile, currentFile, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function reject(promise, pattern) { await assert.rejects(promise, pattern); checks++; }
async function main() {
  assert.equal(continuation.TIMEOUT_MS, 300000); checks++;
  const one = fixture();
  try {
    const original = continuation.loadOriginal(one.configFile);
    assert.throws(() => continuation.inspectLedger(original, 'A'), /Only C or D/); checks++;
    assert.throws(() => continuation.inspectLedger(original, 'B'), /Only C or D/); checks++;
    const receiptFile = path.join(one.root, 'C-receipt.json'); let teardownChecks = 0;
    const receipt = await continuation.attest(one.configFile, 'C', one.previousFile, receiptFile, { proveTornDown: async previous => { assert.equal(previous.pid, 111); teardownChecks++; } });
    assert.equal(teardownChecks, 1); checks++;
    assert.equal(continuation.verifyReceipt(original, receiptFile).cell, 'C'); checks++;
    await reject(continuation.attest(one.configFile, 'C', one.previousFile, path.join(one.root, 'duplicate.json'), { proveTornDown: async () => {} }), /EEXIST/);
    const previousEvidence = ['A-started.json', 'A-completed.json', 'B-started.json', 'B-failed-no-retry.json'].map(name => fs.readFileSync(path.join(one.evidence, name), 'utf8'));
    let calls = 0, guards = 0;
    const result = await continuation.runOne(original, receipt, one.currentFile, { guard: async () => { guards++; }, request: async (url, body, deadline) => {
      calls++; assert.equal(deadline, 300000); assert.equal(body.options.num_ctx, 3072); assert.equal(body.options.num_predict, 640);
      assert.equal(body.options.temperature, 0.8); assert.equal(body.stream, false); assert.equal(body.model, 'causal-maintenance-corrected');
      assert.ok(fs.existsSync(path.join(one.evidence, 'C-started.json'))); return { done: true, message: { content: '{"choice":"WAIT"}' } };
    } });
    assert.equal(result.cell, 'C'); assert.equal(calls, 1); assert.equal(guards, 1); checks += 3;
    assert.deepEqual(['A-started.json', 'A-completed.json', 'B-started.json', 'B-failed-no-retry.json'].map(name => fs.readFileSync(path.join(one.evidence, name), 'utf8')), previousEvidence); checks++;
    await reject(continuation.runOne(original, receipt, one.currentFile, { guard: async () => {}, request: async () => { calls++; } }), /EEXIST/);
    assert.equal(calls, 1); checks++;
    assert.throws(() => continuation.verifyReceipt(original, receiptFile), /already reserved/); checks++;
    const nextFile = path.join(one.root, 'D-receipt.json');
    await reject(continuation.attest(one.configFile, 'D', one.previousFile, nextFile, { proveTornDown: async () => {} }), /exact C/);
    const next = await continuation.attest(one.configFile, 'D', one.currentFile, nextFile, { proveTornDown: async previous => assert.equal(previous.pid, 222) });
    assert.equal(next.cell, 'D'); checks++;
    const lastFile = path.join(one.root, 'D-owned.json'); one.write(lastFile, { ...JSON.parse(fs.readFileSync(one.currentFile)), pid: 333 });
    const timeout = new Error('fixture timeout'); timeout.name = 'AbortError';
    await reject(continuation.runOne(original, next, lastFile, { guard: async () => {}, request: async (url, body, deadline) => { calls++; assert.equal(body.options.num_ctx, 4096); assert.equal(deadline, 300000); throw timeout; } }), /fixture timeout/);
    assert.equal(calls, 2); checks++;
    assert.equal(JSON.parse(fs.readFileSync(path.join(one.evidence, 'D-failed-no-retry.json'))).errorClass, 'timeout-or-cancelled'); checks++;
    await reject(continuation.runOne(original, next, lastFile, { guard: async () => {}, request: async () => { calls++; } }), /EEXIST/);
    assert.equal(calls, 2); checks++;
    assert.equal(fs.readdirSync(one.evidence).filter(name => /^[ABCD]-started.json$/.test(name)).length, 4); checks++;
  } finally { one.cleanup(); }
  const two = fixture();
  try {
    const receiptFile = path.join(two.root, 'receipt.json');
    await reject(continuation.attest(two.configFile, 'C', two.previousFile, receiptFile, { proveTornDown: async () => { throw new Error('old runner alive'); } }), /old runner alive/);
    assert.ok(!fs.existsSync(path.join(two.evidence, 'C-continuation-reserved.json'))); checks++;
    fs.unlinkSync(path.join(two.evidence, 'B-started.json'));
    await reject(continuation.attest(two.configFile, 'C', two.previousFile, receiptFile, { proveTornDown: async () => {} }), /ENOENT/);
  } finally { two.cleanup(); }
  const three = fixture();
  try {
    const receiptFile = path.join(three.root, 'receipt.json');
    await continuation.attest(three.configFile, 'C', three.previousFile, receiptFile, { proveTornDown: async () => {} });
    three.write(path.join(three.evidence, 'B-failed-no-retry.json'), { changed: true });
    assert.throws(() => continuation.verifyReceipt(continuation.loadOriginal(three.configFile), receiptFile), /history changed/); checks++;
    const changed = JSON.parse(fs.readFileSync(three.configFile)); changed.fullContext = 8192; three.write(three.configFile, changed);
    assert.throws(() => continuation.loadOriginal(three.configFile), /immutable config changed/); checks++;
  } finally { three.cleanup(); }
  console.log('causal-maintenance-continuation: ' + checks + ' checks passed; zero network or model calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
