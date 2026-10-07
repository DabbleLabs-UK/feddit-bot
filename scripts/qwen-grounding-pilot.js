'use strict';

// Private, opt-in two-pair lab harness. Never imported by the application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'qwen-two-pair');
const production = path.join(process.env.LOCALAPPDATA || '', 'DabbleLabs', 'FedditBots', 'data');
const model = 'qwen3:4b-instruct';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function save(name, value) {
  fs.mkdirSync(output, { recursive: true });
  const file = path.join(output, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Set BEFORE loading the provider: even its content-free telemetry is isolated.
process.env.FEDDIT_BOT_DATA_DIR = path.join(output, 'telemetry');
const actions = require('../lib/action-candidates');
const voting = require('../lib/voting');

function prompts(snapshot, at) {
  const options = { voteCandidates: snapshot.voteCandidates, voteAllowance: snapshot.voteAllowance };
  const control = actions.prompt(snapshot.candidates, at, options);
  let treatment = control;
  // Locate blocks in the real builder output, not a parallel prompt template.
  const section = voting.promptSection(snapshot.voteCandidates, snapshot.voteAllowance);
  const begin = section.indexOf('\n\n[') + 2;
  const end = section.lastIndexOf('\n\nInclude the votes beside');
  assert(begin > 1 && end > begin);
  const blocks = section.slice(begin, end).split('\n\n');
  assert.equal(blocks.length, snapshot.voteCandidates.length);
  const wrapped = blocks.map((block, i) => {
    const id = snapshot.voteCandidates[i].id;
    assert(block.startsWith('[' + id + '] '));
    assert(!/BEGIN TARGET|END TARGET/.test(block));
    return 'BEGIN TARGET ' + id + '\n' + block + '\nEND TARGET ' + id;
  }).join('\n\n');
  treatment = control.replace(section, section.slice(0, begin) + wrapped + section.slice(end));
  assert.equal(treatment.replace(/^BEGIN TARGET V\d+\n|\nEND TARGET V\d+$/gm, ''), control);
  return { control, treatment };
}

// Instrument an in-memory COPY only to expose the existing pure gathering seam.
// No scheduler starts; all store writes/providers/publication methods are absent.
function snapshotScheduler(data, at) {
  const file = path.join(root, 'lib', 'scheduler.js');
  let source = fs.readFileSync(file, 'utf8');
  const marker = '  const api = {';
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, marker + '\n    inspectFrozen: gatherOpportunityCandidates,');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(source, file);
  const find = id => data.profiles.find(p => p.id === id);
  const store = {
    getSettings: () => data.settings,
    getProfile: find,
    hasReplied: (id, key) => (find(id).repliedTo || []).includes(key),
    getThreadReplyCount: postId => Number((data.settings.threadReplies || {})[String(postId)]) || 0,
    getVoteState: id => find(id).voteState,
    getAttentionState: id => find(id).attentionState,
    getActiveThreadState: id => find(id).activeThreadState,
    getSocialState: id => find(id).socialState,
    getMemoryState: id => find(id).memoryState,
  };
  const real = require('../lib/feddit');
  const reads = ['attention', 'activeThreads', 'feddit', 'comments', 'feddits', 'voteAllowance'];
  const feddit = Object.fromEntries(reads.map(key => [key, real[key]]));
  const forbidden = () => { throw new Error('Pilot cannot generate through scheduler or publish.'); };
  return { api: mod.exports.createScheduler({ store, feddit, providers: { generate: forbidden }, now: () => at }), buildSystem: mod.exports.buildSystem };
}

async function prepare() {
  assert(!fs.existsSync(path.join(output, 'cases.json')), 'Frozen cases already exist; never overwrite.');
  const data = freeze(read(path.join(production, 'profiles.json')));
  const secrets = read(path.join(production, 'secrets.json'));
  const at = Date.now();
  const { api, buildSystem } = snapshotScheduler(data, at);
  const cases = [];
  for (const [bot, choices] of [
    ['reaction_ferret_bot', [{ key: 'vote' }]],
    ['Sir_Ponsalot', [{ key: 'reply' }, { key: 'vote' }]],
  ]) {
    const p = data.profiles.find(p => p.fedditUsername === bot);
    assert(p && p.provider === 'ollama' && p.model === model && p.canVote);
    const profile = freeze({ ...p, token: secrets.fedditTokens[p.id] });
    const snapshot = await api.inspectFrozen(profile, { ...data.settings, dryRun: false }, choices);
    assert(snapshot.voteCandidates.length >= 2, 'Need a multi-target slate.');
    const paired = prompts(snapshot, at);
    const system = buildSystem(p.persona, p.toneNotes);
    cases.push({ bot, frozenAt: at, model, temperature: Number(p.temperature) || 0.8,
      numPredict: 640, system, candidates: snapshot.candidates,
      voteCandidates: snapshot.voteCandidates, voteAllowance: snapshot.voteAllowance,
      ...paired, hashes: { system: sha(system), control: sha(paired.control), treatment: sha(paired.treatment) } });
  }
  const encoded = JSON.stringify(cases);
  for (const token of Object.values(secrets.fedditTokens || {})) if (token) assert(!encoded.includes(token));
  save('cases.json', { source: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), cases });
  console.log(JSON.stringify(cases.map(c => ({ bot: c.bot, targets: c.voteCandidates.length, promptCharacters: c.control.length, hashes: c.hashes }))));
}

async function desktopStatus() {
  const response = await fetch('http://127.0.0.1:8770/api/runtime-state', { signal: AbortSignal.timeout(1500) });
  assert(response.ok, 'Desktop status unavailable: fail closed.');
  const state = await response.json();
  assert.equal(typeof state.busy, 'boolean');
  return state;
}
async function modelStatus() {
  const response = await fetch('http://127.0.0.1:8770/api/local-model-activity', { signal: AbortSignal.timeout(1500) });
  assert(response.ok, 'Desktop model status unavailable: fail closed.');
  const state = await response.json();
  assert(Object.hasOwn(state, 'active'));
  return { busy: !!state.active || nextNaturalAt(read(path.join(production, 'profiles.json'))) <= Date.now() + 3000 };
}
function nextNaturalAt(data) {
  if (data.settings.paused) return Infinity;
  return Math.min(Infinity, ...data.profiles.filter(p => p.enabled).flatMap(p => {
    const s = p.dryRun ? (p.simulationState || {}).sched : p.sched;
    return Object.entries(s || {}).filter(([k, v]) => k.startsWith('next') && Number(v) > 0).map(([,v]) => Number(v));
  }));
}
async function idleWindow() {
  if ((await desktopStatus()).busy) return false;
  // Recent natural decisions typically take 4-9 minutes. Use a 12-minute idle
  // window, then abort OUR request before any natural deadline, never delay it.
  return nextNaturalAt(read(path.join(production, 'profiles.json'))) - Date.now() > 12 * 60000;
}
async function guardedTransport(transport, body, options, status = modelStatus, pollMs = 200) {
  if ((await status()).busy) throw Object.assign(new Error('Natural work has priority.'), { code: 'PILOT_YIELD' });
  const abort = new AbortController();
  let checking = false;
  let yielded = false;
  const cancel = () => abort.abort();
  options.signal.addEventListener('abort', cancel, { once: true });
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { if ((await status()).busy) { yielded = true; abort.abort(); } }
    catch { yielded = true; abort.abort(); }
    finally { checking = false; }
  }, pollMs);
  try { return await transport(body, { ...options, signal: abort.signal }); }
  catch (error) { if (yielded) error.code = 'PILOT_YIELD'; throw error; }
  finally { clearInterval(timer); options.signal.removeEventListener('abort', cancel); }
}
async function run() {
  const { cases } = read(path.join(output, 'cases.json'));
  assert.equal(cases.length, 2);
  const ledgerFile = path.join(output, 'results.json');
  const ledger = fs.existsSync(ledgerFile) ? read(ledgerFile) : { calls: [], model, maxCalls: 4 };
  // Counterbalanced order; no seeded sampling is supported by this adapter.
  const order = [[0, 'control'], [0, 'treatment'], [1, 'treatment'], [1, 'control']];
  const ollama = require('../lib/providers/ollama');
  assert.equal(ollama.OLLAMA_BASE, 'http://127.0.0.1:11434');
  assert(!ollama.SHARED_OLLAMA_ARBITER_URL, 'Unexpected host configuration.');
  for (const [caseIndex, arm] of order) {
    const prior = ledger.calls.find(c => c.caseIndex === caseIndex && c.arm === arm);
    if (prior) { assert.equal(prior.status, 'completed', 'Prior ambiguous/failed call: stop, never retry.'); continue; }
    assert(ledger.calls.length < 4);
    while (!await idleWindow()) {
      console.log(new Date().toISOString() + ' waiting: natural work/deadlines take priority');
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
    const c = freeze(cases[caseIndex]);
    const record = { caseIndex, bot: c.bot, arm, status: 'started', startedAt: Date.now(), promptHash: sha(c[arm]) };
    ledger.calls.push(record); save('results.json', ledger);
    console.log('START ' + JSON.stringify(record));
    try {
      const result = await ollama.generate({ model, system: c.system, prompt: c[arm], temperature: c.temperature,
        numPredict: c.numPredict, kind: 'isolated-grounding-pilot', leaseClient: null,
        chatTransport: (body, opts) => guardedTransport(ollama._test.ollamaChatStream, body, opts) });
      // Only public answer text; Ollama thinking is never retained.
      Object.assign(record, { status: 'completed', finishedAt: Date.now(), result,
        parsed: actions.parseDecision(result.text, c.candidates, { voteCandidates: c.voteCandidates }) });
      save('results.json', ledger);
      console.log('COMPLETE ' + JSON.stringify({ caseIndex, arm, ms: result.ms, text: result.text }));
    } catch (error) {
      Object.assign(record, { status: 'failed-no-retry', finishedAt: Date.now(), code: error.code || 'UNKNOWN' });
      save('results.json', ledger); throw new Error('Pilot stopped without retry: ' + record.code);
    }
  }
}

module.exports = { prompts, snapshotScheduler, nextNaturalAt, guardedTransport, freeze };
if (require.main === module) {
  const command = process.argv[2];
  Promise.resolve().then(() => {
    if (command === 'prepare') return prepare();
    if (command === 'run') return run();
    throw new Error('Explicit prepare or run required.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
