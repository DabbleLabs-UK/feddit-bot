'use strict';

// Standalone, opt-in experiment tooling. Never import a scheduler or API client.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseDecision } = require('../lib/action-candidates');
const { parseObject } = require('../lib/decision-contract');

const PRODUCTION_DIGEST = 'c6ec899cdf5f8e3f55350f7fc28735be2f77556c011f71a5bf6402556aba1cc8';
const VERSION = '0.34.1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function check(value, message) { if (!value) throw new Error(message); }

function validate(config, frozen) {
  check(config.url === 'http://127.0.0.1:11436', 'Only the isolated loopback port 11436 is allowed.');
  check(config.productionDigest === PRODUCTION_DIGEST, 'Production manifest provenance mismatch.');
  check(config.productionManifestFile, 'Frozen production manifest bytes are required.');
  check(config.maintenanceId && config.maintenanceDirectory, 'Maintenance identity is required.');
  check(frozen.version === 1 && frozen.turnId && frozen.request, 'Invalid frozen case.');
  check(typeof frozen.request.prompt === 'string' && typeof frozen.request.system === 'string', 'Frozen messages are required.');
  check(frozen.request.temperature === 0.8 && frozen.request.numPredict === 640, 'Frozen production sampler/budget mismatch.');
  check(Array.isArray(frozen.candidates) && Array.isArray(frozen.voteCandidates), 'Frozen slate is required.');
  check(Number.isInteger(config.fullContext) && config.fullContext > 3072 && config.fullContext <= 16384, 'Invalid bounded full context.');
  check(/^[a-f0-9]{64}$/.test(config.weightSha256 || ''), 'Exact weight hash is required.');
  for (const name of ['control', 'corrected']) {
    const model = config.models && config.models[name];
    check(model && /^causal-maintenance-[a-z0-9-]+(?::latest)?$/.test(model.name), 'Only isolated experiment aliases are allowed.');
    check(/^[a-f0-9]{64}$/.test(model.templateSha256 || '') && /^[a-f0-9]{64}$/.test(model.parametersSha256 || ''), 'Template and stop-framing provenance required.');
    check(Number.isInteger(model.fullInputTokens) && model.fullInputTokens > 0, 'Exact tokenized input count required.');
    check(Number.isInteger(model.effectiveFullContext) && model.effectiveFullContext <= config.fullContext && model.effectiveFullContext >= model.fullInputTokens + 640, 'Full input and output must fit verified effective runner context.');
    check(/^[a-f0-9]{64}$/.test(model.fullRenderedSha256 || ''), 'Verified rendered-input hash required.');
    check(model.manifestFile, 'Isolated alias manifest path required.');
  }
  check(config.models.control.name !== config.models.corrected.name, 'Template aliases must differ.');
}

function plan(config, frozen) {
  validate(config, frozen);
  return [
    ['A', 'control', 3072], ['B', 'control', config.fullContext],
    ['C', 'corrected', 3072], ['D', 'corrected', config.fullContext],
  ].map(([cell, template, context]) => ({ cell, template, context, body: {
    model: config.models[template].name,
    messages: [{ role: 'system', content: frozen.request.system }, { role: 'user', content: frozen.request.prompt }],
    stream: false, keep_alive: -1,
    // Seed is intentionally not added: preserve the production request options.
    options: { temperature: frozen.request.temperature, num_predict: frozen.request.numPredict, num_ctx: context, num_thread: 4 },
  } }));
}

function score(text, frozen) {
  let strictJson = false;
  try { const parsed = JSON.parse(text); strictJson = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !!parseObject(text); } catch {}
  const parsed = parseDecision(text, frozen.candidates, { voteCandidates: frozen.voteCandidates, decisionContractVersion: 2 });
  const explicit = parsed.votes.filter(vote => vote.decisionKind === 'explicit').length;
  return {
    strictJson, primaryValid: parsed.valid, choice: parsed.valid ? (parsed.waited ? 'WAIT' : parsed.candidate.id) : null,
    offeredVotes: frozen.voteCandidates.length, explicitVotes: explicit,
    missingVotes: parsed.votes.filter(vote => vote.decisionKind === 'missing').length,
    invalidVotes: parsed.votes.filter(vote => vote.decisionKind === 'invalid').length,
    completeContract: strictJson && parsed.valid && explicit === frozen.voteCandidates.length,
    markerLeak: /\|(?:im_start|im_end|start_header_id|end_header_id|eot_id|end_of_text)\|/.test(text),
    responseCharacters: text.length,
  };
}

function heldSnapshot(directory, id, now = Date.now(), alive = pid => { process.kill(pid, 0); return true; }) {
  const request = read(path.join(directory, 'request.json'));
  check(request.version === 1 && request.id === id, 'Maintenance request changed or is absent.');
  for (const client of ['cy', 'feddit']) {
    const status = read(path.join(directory, client + '-status.json'));
    const age = now - Date.parse(status.updatedAt);
    check(status.version === 1 && status.requestId === id && status.state === 'held' && status.active === 0,
      client + ' has not acknowledged quiescence.');
    check(Number.isInteger(status.pid) && status.pid > 0 && Number.isFinite(age) && age >= 0 && age <= 15000,
      client + ' maintenance acknowledgement is stale.');
    check(alive(status.pid), client + ' maintenance process is not alive.');
  }
}

function checkArbiter(state) {
  check(state && state.active === null && state.queued && typeof state.queued === 'object', 'Arbiter quiescence is not established.');
  check(Object.values(state.queued).every(value => value === 0), 'Natural inference is queued.');
}

async function jsonRequest(url, body, signal, fetchImpl = fetch) {
  const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  check(response.ok, 'Isolated request failed: HTTP ' + response.status + '.');
  const data = await response.json();
  check(!data.error, 'Isolated provider returned an error envelope.');
  return data;
}

async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyModels(config, request) {
  check((await request(config.url + '/api/version')).version === VERSION, 'Isolated Ollama version mismatch.');
  const productionBytes = fs.readFileSync(config.productionManifestFile);
  check(sha(productionBytes) === config.productionDigest, 'Frozen production manifest hash mismatch.');
  const production = JSON.parse(productionBytes.toString('utf8'));
  const productionWeights = production.layers.filter(layer => layer.mediaType === 'application/vnd.ollama.image.model');
  check(productionWeights.length === 1 && productionWeights[0].digest === 'sha256:' + config.weightSha256,
    'Frozen production manifest does not reference the verified weights.');
  check(await fileHash(config.weightFile) === config.weightSha256, 'GGUF bytes mismatch.');
  const tags = await request(config.url + '/api/tags');
  check(Array.isArray(tags.models), 'Isolated model inventory is invalid.');
  for (const model of Object.values(config.models)) {
    const manifestBytes = fs.readFileSync(model.manifestFile);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const normalizedName = model.name.includes(':') ? model.name : model.name + ':latest';
    const served = tags.models.find(item => item.name === normalizedName || item.model === normalizedName);
    check(served && served.digest === sha(manifestBytes), 'Served alias does not match verified manifest bytes.');
    const weights = manifest.layers.filter(layer => layer.mediaType === 'application/vnd.ollama.image.model');
    check(weights.length === 1 && weights[0].digest === 'sha256:' + config.weightSha256, 'Alias does not use exact production weights.');
    const show = await request(config.url + '/api/show', { model: model.name });
    check(sha(show.template || '') === model.templateSha256 && sha(show.parameters || '') === model.parametersSha256,
      'Isolated template or stop framing changed.');
  }
}

// Injected transport/guard/output supports zero-inference deterministic tests.
async function execute(config, frozen, { request, guard, save, onStart = () => {}, now = Date.now } = {}) {
  const cells = plan(config, frozen);
  const results = [];
  for (const cell of cells) {
    await guard();
    const started = now();
    // Durably reserve BEFORE invocation. An interrupted/ambiguous run cannot be replayed.
    await save(cell.cell, { status: 'started', startedAt: new Date(started).toISOString(), requestHash: sha(JSON.stringify(cell.body)) });
    onStart(cell.cell);
    try {
      const response = await request(config.url + '/api/chat', cell.body);
      check(response.done === true && response.message && typeof response.message.content === 'string', 'Incomplete provider result.');
      const result = { cell: cell.cell, template: cell.template, context: cell.context, status: 'completed',
        elapsedMs: now() - started, response, score: score(response.message.content, frozen) };
      await save(cell.cell, result);
      results.push(result);
    } catch (error) {
      await save(cell.cell, { cell: cell.cell, status: 'failed-no-retry', elapsedMs: now() - started,
        errorClass: error.name === 'AbortError' || error.name === 'TimeoutError' ? 'timeout-or-cancelled' : 'request-or-contract-failure' });
      throw error;
    }
  }
  return results;
}

async function main(configFile) {
  const config = read(configFile);
  const frozenBytes = fs.readFileSync(config.frozenFile);
  check(sha(frozenBytes) === config.frozenSha256, 'Frozen case file changed.');
  const frozen = JSON.parse(frozenBytes.toString('utf8').replace(/^\uFEFF/, ''));
  validate(config, frozen);
  check(path.isAbsolute(config.outputDirectory), 'Absolute private evidence directory required.');
  fs.mkdirSync(config.outputDirectory, { recursive: true });
  const lock = path.join(config.outputDirectory, 'experiment-reserved.json');
  fs.writeFileSync(lock, JSON.stringify({ at: new Date().toISOString(), configHash: sha(fs.readFileSync(configFile)) }), { flag: 'wx', mode: 0o600 });
  const guard = async () => {
    heldSnapshot(config.maintenanceDirectory, config.maintenanceId);
    checkArbiter(await jsonRequest('http://127.0.0.1:11435/v1/state', null, AbortSignal.timeout(3000)));
  };
  await guard();
  await verifyModels(config, (url, body) => jsonRequest(url, body, AbortSignal.timeout(10000)));
  const request = async (url, body) => {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 300000);
    let checking = false;
    const poll = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { await guard(); } catch { abort.abort(); } finally { checking = false; }
    }, 3000);
    try { return await jsonRequest(url, body, abort.signal); }
    finally { clearTimeout(deadline); clearInterval(poll); }
  };
  const save = (cell, result) => {
    const file = path.join(config.outputDirectory, cell + '-' + result.status + '.json');
    fs.writeFileSync(file, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  };
  const results = await execute(config, frozen, { request, guard, save,
    onStart: cell => process.stdout.write('Starting frozen cell ' + cell + '; maximum 300 seconds, no retry.\n') });
  await guard();
  const summary = results.map(({ cell, elapsedMs, score: scored, response }) => ({ cell, elapsedMs, ...scored,
    promptEvalCount: response.prompt_eval_count, evalCount: response.eval_count, doneReason: response.done_reason }));
  fs.writeFileSync(path.join(config.outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

module.exports = { validate, plan, score, heldSnapshot, checkArbiter, verifyModels, execute, sha, PRODUCTION_DIGEST };
if (require.main === module) main(process.argv[2]).catch(error => {
  // Never print raw upstream bodies, prompts or credentials.
  process.stderr.write('Experiment stopped without retry: ' + (/^[A-Za-z0-9 .:;-]+$/.test(error.message) ? error.message.slice(0, 240) : error.name) + '\n');
  process.exitCode = 1;
});
