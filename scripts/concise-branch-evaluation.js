'use strict';

// Explicit, private frozen-input experiment. Never imported by the runner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MODEL = 'qwen3:4b-instruct';
const CASE_COUNT = 5;
const MAX_CALLS = 10;
const ENTRY_MARGIN_MS = 5 * 60 * 1000;
const DEADLINE_MARGIN_MS = 3000;
const CEILING_MS = 10 * 60 * 1000;
const POLL_MS = 200;
const OUTPUT = path.resolve(__dirname, '..', 'artifacts', 'concise-evaluation');
// The Windows sandbox has a different LOCALAPPDATA. Never infer this path from it.
const PRODUCTION = 'C:/Users/jodyf/AppData/Local/DabbleLabs/FedditBots/data';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function requireState(condition, code) {
  if (!condition) throw failure(code);
}

function caseHash(item) {
  return sha(JSON.stringify([item.id, item.kind, item.bot, item.model, item.temperature,
    item.numPredict, item.hashes.system, item.hashes.control, item.hashes.treatment]));
}

function readCases(directory) {
  const text = fs.readFileSync(path.join(directory, 'cases.json'), 'utf8');
  const data = JSON.parse(text);
  requireState(Array.isArray(data.cases) && data.cases.length === CASE_COUNT, 'EVAL_INVALID_CASES');
  const ids = new Set();
  for (const item of data.cases) {
    requireState(item && typeof item.id === 'string' && item.id.length > 0 && !ids.has(item.id), 'EVAL_INVALID_CASES');
    ids.add(item.id);
    requireState(['post', 'comment'].includes(item.kind) && typeof item.bot === 'string' && item.bot.length > 0 &&
      item.model === MODEL && typeof item.temperature === 'number' && Number.isFinite(item.temperature) &&
      item.temperature >= 0 && Number.isSafeInteger(item.numPredict) && item.numPredict > 0, 'EVAL_INVALID_CASES');
    for (const arm of ['system', 'control', 'treatment']) {
      requireState(typeof item[arm] === 'string' && item[arm].trim().length > 0 && item.hashes &&
        item.hashes[arm] === sha(item[arm]), 'EVAL_CASE_HASH_MISMATCH');
    }
  }
  return { cases: data.cases, casesHash: sha(text) };
}

function order() {
  return Array.from({ length: CASE_COUNT }, (_, index) =>
    (index % 2 ? ['treatment', 'control'] : ['control', 'treatment'])
      .map((arm) => ({ caseIndex: index, arm }))).flat();
}

function readLedger(directory, frozen) {
  const file = path.join(directory, 'results.json');
  const ledger = fs.existsSync(file) ? read(file) : {
    version: 1, model: MODEL, maxCalls: MAX_CALLS, casesHash: frozen.casesHash, calls: [],
  };
  requireState(ledger.version === 1 && ledger.model === MODEL && ledger.maxCalls === MAX_CALLS &&
    ledger.casesHash === frozen.casesHash && Array.isArray(ledger.calls) && ledger.calls.length <= MAX_CALLS,
  'EVAL_LEDGER_MISMATCH');
  const sequence = order();
  for (const [index, record] of ledger.calls.entries()) {
    const expected = sequence[index];
    const item = frozen.cases[expected.caseIndex];
    requireState(record && record.sequence === index && record.caseIndex === expected.caseIndex &&
      record.arm === expected.arm && record.caseId === item.id && record.caseHash === caseHash(item) &&
      record.promptHash === item.hashes[expected.arm] && record.systemHash === item.hashes.system,
    'EVAL_LEDGER_MISMATCH');
    requireState(record.status === 'completed', 'EVAL_PRIOR_CALL_NO_RETRY');
    requireState(record.result && typeof record.result.text === 'string' && record.result.text.trim().length > 0 &&
      Number.isFinite(record.startedAt) && Number.isFinite(record.finishedAt), 'EVAL_LEDGER_MISMATCH');
  }
  return ledger;
}

function saveLedger(directory, ledger) {
  const file = path.join(directory, 'results.json');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

function exclusiveRunLock(directory) {
  const file = path.join(directory, 'run.lock');
  const token = crypto.randomUUID();
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw failure('EVAL_LOCKED'); throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return () => {
    requireState(read(file).token === token, 'EVAL_LOCK_CHANGED');
    fs.unlinkSync(file);
  };
}

function nextNaturalAt(data) {
  requireState(data && data.settings && typeof data.settings.paused === 'boolean' &&
    Array.isArray(data.profiles), 'EVAL_SCHEDULE_UNKNOWN');
  if (data.settings.paused) return Infinity;
  let next = Infinity;
  const rates = {
    nextPostAt: 'postsPerHour', nextArticleAt: 'articlePostsPerHour',
    nextCommentAt: 'commentsPerHour', nextVoteAt: 'votesPerHour',
  };
  for (const profile of data.profiles) {
    requireState(profile && typeof profile.enabled === 'boolean', 'EVAL_SCHEDULE_UNKNOWN');
    if (!profile.enabled) continue;
    requireState(typeof profile.dryRun === 'boolean', 'EVAL_SCHEDULE_UNKNOWN');
    const schedule = profile.dryRun ? profile.simulationState && profile.simulationState.sched : profile.sched;
    requireState(schedule && typeof schedule === 'object' && !Array.isArray(schedule), 'EVAL_SCHEDULE_UNKNOWN');
    let known = false;
    for (const [key, rate] of Object.entries(rates)) {
      const value = schedule[key];
      if (value == null) {
        requireState(typeof profile[rate] === 'number' && profile[rate] === 0, 'EVAL_SCHEDULE_UNKNOWN');
        continue;
      }
      requireState(typeof value === 'number' && Number.isFinite(value) && value > 0, 'EVAL_SCHEDULE_UNKNOWN');
      known = true;
      next = Math.min(next, value);
    }
    requireState(known, 'EVAL_SCHEDULE_UNKNOWN');
  }
  return next;
}

function createStatusReader({ fetch: fetchStatus = globalThis.fetch, profilesFile = path.join(PRODUCTION, 'profiles.json'),
  readProfiles = () => read(profilesFile) } = {}) {
  return async () => {
    const states = await Promise.all(['/api/runtime-state', '/api/local-model-activity'].map(async (endpoint) => {
      const response = await fetchStatus('http://127.0.0.1:8770' + endpoint,
        { method: 'GET', signal: AbortSignal.timeout(1500) });
      requireState(response && response.ok === true, 'EVAL_STATUS_UNAVAILABLE');
      return response.json();
    }));
    const [runtime, model] = states;
    requireState(runtime && typeof runtime.busy === 'boolean' && model && Object.hasOwn(model, 'active') &&
      (model.active === null || (typeof model.active === 'object' && !Array.isArray(model.active))),
    'EVAL_STATUS_UNAVAILABLE');
    return { busy: runtime.busy || model.active !== null, nextAt: nextNaturalAt(readProfiles()) };
  };
}

function checkedStatus(state) {
  requireState(state && typeof state.busy === 'boolean' &&
    (state.nextAt === Infinity || (typeof state.nextAt === 'number' && Number.isFinite(state.nextAt) && state.nextAt > 0)),
  'EVAL_STATUS_UNAVAILABLE');
  return state;
}

async function guardedTransport(transport, body, options, status, { now = Date.now,
  pollMs = POLL_MS, ceilingMs = CEILING_MS } = {}) {
  async function reason() {
    let state;
    try { state = checkedStatus(await status()); }
    catch { return 'EVAL_STATUS_UNAVAILABLE'; }
    if (state.busy) return 'EVAL_YIELD';
    if (state.nextAt <= now() + DEADLINE_MARGIN_MS) return 'EVAL_DEADLINE_DUE';
    return '';
  }
  const initial = await reason();
  if (initial) throw failure(initial);
  if (options.signal && options.signal.aborted) throw failure('EVAL_CANCELLED');
  const abort = new AbortController();
  let code = '';
  let checking = false;
  let stopped = false;
  const cancel = (why) => {
    if (!code) code = why;
    abort.abort();
  };
  const relay = () => cancel('EVAL_CANCELLED');
  if (options.signal) options.signal.addEventListener('abort', relay, { once: true });
  const timer = setInterval(async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      const why = await reason();
      if (why && !stopped) cancel(why);
    } finally { checking = false; }
  }, pollMs);
  const ceiling = setTimeout(() => cancel('EVAL_CEILING'), Math.min(CEILING_MS, ceilingMs));
  try {
    const result = await transport(body, { ...options, signal: abort.signal,
      timeoutMs: Math.min(CEILING_MS, ceilingMs, options.timeoutMs || CEILING_MS) });
    if (code) throw failure(code);
    return result;
  } catch (error) {
    if (code) throw failure(code);
    throw error;
  } finally {
    stopped = true;
    clearInterval(timer);
    clearTimeout(ceiling);
    if (options.signal) options.signal.removeEventListener('abort', relay);
  }
}

function isolatedProvider(directory) {
  const telemetry = path.join(directory, 'telemetry');
  const providerFile = require.resolve('../lib/providers/ollama');
  requireState(!require.cache[providerFile], 'EVAL_PROVIDER_ALREADY_LOADED');
  process.env.FEDDIT_BOT_DATA_DIR = telemetry;
  const provider = require(providerFile);
  requireState(path.resolve(provider._test.telemetryFile) === path.resolve(telemetry, 'local-generation-telemetry.json'),
    'EVAL_TELEMETRY_NOT_ISOLATED');
  return provider;
}

function summary(ledger) {
  return { model: MODEL, maxCalls: MAX_CALLS, calls: ledger.calls.map((record) => {
    const text = record.result && record.result.text || '';
    const words = (value) => (value.match(/\S+/g) || []).length;
    return {
      sequence: record.sequence, caseId: record.caseId, arm: record.arm, status: record.status,
      ...(record.result ? { ms: record.result.ms, words: words(text),
        ...(record.kind === 'post' ? { bodyWords: words(text.slice(text.indexOf('\n') + 1)) } : {}) } : {}),
      ...(record.code ? { code: record.code } : {}),
    };
  }) };
}

async function runOne({ directory = OUTPUT, status = createStatusReader(), now = Date.now,
  loadProvider = isolatedProvider, log = (value) => console.log(JSON.stringify(value)) } = {}) {
  const relative = path.relative(path.resolve(PRODUCTION).toLowerCase(), path.resolve(directory).toLowerCase());
  requireState(relative && (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)), 'EVAL_OUTPUT_NOT_ISOLATED');
  const frozen = readCases(directory);
  const release = exclusiveRunLock(directory);
  try {
    const ledger = readLedger(directory, frozen);
    if (ledger.calls.length === MAX_CALLS) {
      const result = { status: 'complete', ...summary(ledger) };
      log(result);
      return result;
    }
    let state;
    try { state = checkedStatus(await status()); }
    catch {
      const result = { status: 'deferred', reason: 'status-unavailable', calls: ledger.calls.length };
      log(result);
      return result;
    }
    if (state.busy || state.nextAt <= now() + ENTRY_MARGIN_MS) {
      const result = { status: 'deferred', reason: state.busy ? 'natural-work-busy' : 'natural-deadline-too-near',
        calls: ledger.calls.length };
      log(result);
      return result;
    }
    const provider = loadProvider(directory);
    requireState(provider && provider.OLLAMA_BASE === 'http://127.0.0.1:11434' && !provider.SHARED_OLLAMA_ARBITER_URL &&
      typeof provider.generate === 'function' && provider._test && typeof provider._test.ollamaChatStream === 'function' &&
      typeof provider.isBusy === 'function' && provider.isBusy() === false, 'EVAL_PROVIDER_UNSAFE');
    const next = order()[ledger.calls.length];
    const item = frozen.cases[next.caseIndex];
    const record = { sequence: ledger.calls.length, ...next, caseId: item.id, bot: item.bot, kind: item.kind,
      caseHash: caseHash(item), promptHash: item.hashes[next.arm], systemHash: item.hashes.system,
      status: 'started', startedAt: now() };
    requireState(readCases(directory).casesHash === frozen.casesHash, 'EVAL_CASE_HASH_MISMATCH');
    ledger.calls.push(record);
    // Durable intent precedes the provider invocation, including admission in its transport.
    saveLedger(directory, ledger);
    let guardCode = '';
    try {
      const generated = await provider.generate({ model: MODEL, system: item.system, prompt: item[next.arm],
        temperature: item.temperature, numPredict: item.numPredict, timeoutMs: CEILING_MS,
        botName: item.bot, kind: 'isolated-concise-branch-evaluation', leaseClient: null,
        chatTransport: async (body, options) => {
          try { return await guardedTransport(provider._test.ollamaChatStream, body, options, status, { now }); }
          catch (error) { guardCode = error.code || ''; throw error; }
        } });
      requireState(generated && generated.provider === 'ollama' && generated.model === MODEL &&
        typeof generated.text === 'string' && generated.text.trim().length > 0, 'EVAL_INVALID_RESULT');
      record.status = 'completed';
      record.finishedAt = now();
      record.result = { text: generated.text, ms: generated.ms, usage: generated.usage };
      saveLedger(directory, ledger);
      const result = { status: 'completed-one', ...summary(ledger) };
      log(result);
      return result;
    } catch (error) {
      record.status = 'failed-no-retry';
      record.finishedAt = now();
      const code = guardCode || error.code || 'EVAL_UNKNOWN_FAILURE';
      record.code = /^[A-Z_]{1,80}$/.test(code) ? code : 'EVAL_UNKNOWN_FAILURE';
      saveLedger(directory, ledger);
      log({ status: 'stopped-no-retry', ...summary(ledger) });
      throw failure(record.code);
    }
  } finally {
    release();
  }
}

module.exports = { MODEL, CASE_COUNT, MAX_CALLS, ENTRY_MARGIN_MS, CEILING_MS, POLL_MS,
  sha, caseHash, readCases, readLedger, saveLedger, order, exclusiveRunLock, nextNaturalAt,
  createStatusReader, guardedTransport, isolatedProvider, summary, runOne };

if (require.main === module) {
  Promise.resolve().then(() => {
    requireState(process.argv.length === 3 && process.argv[2] === 'run-one', 'EVAL_EXPLICIT_RUN_ONE_REQUIRED');
    return runOne();
  }).catch((error) => {
    console.error(JSON.stringify({ status: 'blocked', code: /^[A-Z_]{1,80}$/.test(error.code || '')
      ? error.code : 'EVAL_UNAVAILABLE' }));
    process.exitCode = 1;
  });
}
