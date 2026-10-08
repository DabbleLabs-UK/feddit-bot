'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, score, heldSnapshot, checkArbiter, verifyModels, execute, sha, PRODUCTION_DIGEST } = require('./causal-maintenance-run');

async function main() {
  let checks = 0;
  const ok = (value, label) => { assert.ok(value, label); checks++; };
  const throws = (fn, pattern) => { assert.throws(fn, pattern); checks++; };
  const config = {
    url: 'http://127.0.0.1:11436', productionDigest: PRODUCTION_DIGEST,
    productionManifestFile: 'fixture-production-manifest.json',
    maintenanceId: 'fixture-only', maintenanceDirectory: 'fixture', fullContext: 8192,
    weightSha256: 'a'.repeat(64), models: Object.fromEntries(['control', 'corrected'].map(name => [name, {
      name: 'causal-maintenance-' + name, templateSha256: 'b'.repeat(64), parametersSha256: 'c'.repeat(64),
      fullInputTokens: 3500, effectiveFullContext: 8192, fullRenderedSha256: 'd'.repeat(64), manifestFile: name + '.json',
    }])),
  };
  const frozen = { version: 1, turnId: 'fixture', request: { system: 'Frozen system.', prompt: 'Frozen prompt.', temperature: 0.8, numPredict: 640 },
    candidates: [{ id: 'C1', candidateType: 'ordinary_post' }], voteCandidates: [{ id: 'V1', targetType: 'post', targetId: 'p1' }] };
  const original = JSON.stringify(frozen);
  const cells = plan(config, frozen);
  ok(cells.length === 4 && cells.map(c => c.cell).join('') === 'ABCD', 'Exactly four factorial cells');
  ok(cells.map(c => c.context).join(',') === '3072,8192,3072,8192', 'Context contrast');
  ok(cells.map(c => c.template).join(',') === 'control,control,corrected,corrected', 'Template contrast');
  ok(cells.every(c => c.body.stream === false && c.body.options.num_predict === 640 && c.body.options.temperature === 0.8 && c.body.options.num_thread === 4), 'Production request shape');
  ok(cells.every(c => !('format' in c.body) && !('seed' in c.body.options) && !('raw' in c.body)), 'No extra treatment');
  ok(cells.every(c => JSON.stringify(c.body.messages) === JSON.stringify(cells[0].body.messages)), 'Identical frozen messages');
  throws(() => plan({ ...config, url: 'http://127.0.0.1:11434' }, frozen), /isolated/);
  throws(() => plan({ ...config, url: 'https://external.example' }, frozen), /isolated/);
  throws(() => plan({ ...config, fullContext: 32768 }, frozen), /bounded/);
  throws(() => plan({ ...config, models: { ...config.models, control: { ...config.models.control, effectiveFullContext: 4000 } } }, frozen), /fit/);
  throws(() => plan(config, { ...frozen, request: { ...frozen.request, temperature: 0 } }), /sampler/);
  throws(() => plan({ ...config, productionDigest: 'wrong' }, frozen), /provenance/);

  const validText = JSON.stringify({ choice: 'C1', reason: 'A specific reason.', votes: [{ id: 'V1', direction: 'up', reason: 'This is useful and grounded.' }] });
  ok(score(validText, frozen).completeContract, 'Full contract validity');
  ok(!score(validText + '<|im_end|>', frozen).strictJson && score(validText + '<|im_end|>', frozen).markerLeak, 'No marker salvage');
  ok(score('{"choice":"WAIT"}', frozen).missingVotes === 1 && !score('{"choice":"WAIT"}', frozen).completeContract, 'Missing is not abstention');
  ok(score('{"choice":"WAIT","votes":[{"id":"V1","direction":"nil"}]}', frozen).completeContract, 'Explicit abstention valid');
  ok(!score('{"choice":"WAIT","choice":"C1"}', frozen).strictJson, 'Ambiguous JSON rejected');
  ok(score('{"choice":"C999","votes":[]}', frozen).primaryValid === false, 'Unknown choice rejected');
  ok(score('{"choice":"C1","votes":[{"id":"V1","direction":"up","reason":"ok"}]}', frozen).invalidVotes === 1, 'Invalid reason not accepted');
  ok(!score('```json\n' + validText + '\n```', frozen).strictJson, 'Strict raw JSON separately scored');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-maintenance-fixture-'));
  try {
    const weightFile = path.join(directory, 'weights.bin');
    fs.writeFileSync(weightFile, 'fixture weight bytes - not a model');
    const weightSha256 = sha(fs.readFileSync(weightFile));
    const manifestBytes = JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:' + weightSha256 }] });
    const manifestFile = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifestFile, manifestBytes);
    const verifiedConfig = { ...config, weightFile, weightSha256, productionManifestFile: manifestFile,
      productionDigest: sha(manifestBytes), models: Object.fromEntries(Object.entries(config.models).map(([key, model]) => [key,
        { ...model, manifestFile, templateSha256: sha(key + '-template'), parametersSha256: sha(key + '-stops') }])) };
    let tagDigest = sha(manifestBytes);
    const modelProbe = async (url, body) => {
      if (url.endsWith('/api/version')) return { version: '0.34.1' };
      if (url.endsWith('/api/tags')) return { models: Object.values(verifiedConfig.models).map(model => ({ name: model.name + ':latest', digest: tagDigest })) };
      assert.ok(url.endsWith('/api/show'));
      const key = body.model.endsWith('control') ? 'control' : 'corrected';
      return { template: key + '-template', parameters: key + '-stops' };
    };
    await verifyModels(verifiedConfig, modelProbe); checks++;
    tagDigest = '0'.repeat(64);
    await assert.rejects(verifyModels(verifiedConfig, modelProbe), /Served alias/); checks++;
    tagDigest = sha(manifestBytes);
    await assert.rejects(verifyModels({ ...verifiedConfig, productionDigest: '0'.repeat(64) }, modelProbe), /production manifest hash/); checks++;
    await assert.rejects(verifyModels({ ...verifiedConfig, weightSha256: '0'.repeat(64) }, modelProbe), /does not reference/); checks++;
    await assert.rejects(verifyModels(verifiedConfig, async (url, body) => url.endsWith('/api/tags') ? { models: [] } : modelProbe(url, body)), /Served alias/); checks++;
    await assert.rejects(verifyModels(verifiedConfig, async (url, body) => url.endsWith('/api/show') ? { template: 'wrong', parameters: 'wrong' } : modelProbe(url, body)), /framing changed/); checks++;
    const current = Date.now();
    const write = (file, value) => fs.writeFileSync(path.join(directory, file + '.json'), JSON.stringify(value));
    write('request', { version: 1, id: config.maintenanceId });
    const status = { version: 1, pid: 123, requestId: config.maintenanceId, state: 'held', active: 0, updatedAt: new Date(current).toISOString() };
    write('cy-status', status); write('feddit-status', status);
    heldSnapshot(directory, config.maintenanceId, current, () => true); checks++;
    throws(() => heldSnapshot(directory, 'other', current, () => true), /changed/);
    throws(() => heldSnapshot(directory, config.maintenanceId, current + 15001, () => true), /stale/);
    throws(() => heldSnapshot(directory, config.maintenanceId, current, () => false), /alive/);
    write('cy-status', { ...status, active: 1 });
    throws(() => heldSnapshot(directory, config.maintenanceId, current, () => true), /quiescence/);
    checkArbiter({ active: null, queued: { cy: 0, interactive: 0 } }); checks++;
    throws(() => checkArbiter({ active: { client: 'cy' }, queued: {} }), /quiescence/);
    throws(() => checkArbiter({ active: null, queued: { cy: 1 } }), /queued/);
  } finally { fs.rmSync(directory, { recursive: true }); }

  let calls = 0; let guards = 0; const records = [];
  const results = await execute(config, frozen, {
    guard: async () => { guards++; }, save: async (cell, result) => { records.push({ cell, ...result }); },
    request: async (url, body) => { calls++; assert.equal(url, config.url + '/api/chat'); assert.equal(records.at(-1).status, 'started'); return { done: true, message: { content: validText }, prompt_eval_count: 3500, eval_count: 70 }; },
  });
  ok(calls === 4 && guards === 4 && results.length === 4, 'Four sequential guarded requests');
  ok(records.filter(item => item.status === 'started').length === 4 && records.filter(item => item.status === 'completed').length === 4, 'Before/after durable evidence');
  calls = 0; const failures = [];
  await assert.rejects(execute(config, frozen, { guard: async () => {}, save: async (cell, result) => failures.push(result),
    request: async () => { calls++; throw new Error('fixture network failure'); } }), /fixture/); checks++;
  ok(calls === 1 && failures.at(-1).status === 'failed-no-retry', 'No retry or next cell after transport failure');
  calls = 0;
  await assert.rejects(execute(config, frozen, { guard: async () => { throw new Error('not held'); }, save: async () => {}, request: async () => { calls++; } }), /not held/); checks++;
  ok(calls === 0, 'No call without safe gate');
  ok(JSON.stringify(frozen) === original, 'Frozen evidence never modified');
  console.log('causal-maintenance: ' + checks + ' checks passed; zero network/model calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
