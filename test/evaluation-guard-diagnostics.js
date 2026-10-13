'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const diagnostics = require('../scripts/evaluation-guard-diagnostics');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-guard-diagnostics-test-'));
const at = 1800000000000;
const now = () => at;
let fixtureIndex = 0;

function fixture() {
  const directory = path.join(temporary, String(fixtureIndex++));
  fs.mkdirSync(directory);
  return directory;
}

function failureRecord(phase = 'lease-read') {
  return diagnostics.snapshot(Object.assign(new Error('PRIVATE MESSAGE'), { code: 'ENOENT' }), { phase, now });
}

function writeFailure(operation) {
  assert.throws(operation, (error) => {
    assert.equal(error.code, 'GUARD_DIAGNOSTIC_WRITE_FAILED');
    assert.equal(error.message, 'GUARD_DIAGNOSTIC_WRITE_FAILED');
    assert.equal(error.guardPhase, 'guard-diagnostic-write');
    assert.equal(JSON.stringify(error).includes('PRIVATE'), false);
    return true;
  });
}

function run() {
  const hostile = Object.assign(new Error('PRIVATE MESSAGE'), { code: 'PRIVATE_CODE',
    name: 'PRIVATE_NAME', body: { nonce: 'PRIVATE NONCE', prompts: 'PRIVATE PROMPT' },
    cause: { code: 'PRIVATE_CAUSE', message: 'PRIVATE CAUSE MESSAGE' } });
  hostile.stack = 'PRIVATE STACK';
  const plain = diagnostics.snapshot(hostile, { phase: 'PRIVATE PHASE', endpoint: 'PRIVATE ENDPOINT',
    guardStage: 'PRIVATE STAGE', elapsedMs: 'PRIVATE', httpStatus: {}, now,
    response: 'PRIVATE RESPONSE', lease: 'PRIVATE LEASE', body: hostile.body });
  assert.deepEqual(plain, { version: 1, timestamp: '2027-01-15T08:00:00.000Z', phase: 'unknown',
    safetyCode: 'GUARD_UNKNOWN', transportClass: 'unknown' });
  assert.equal(Object.getPrototypeOf(plain), Object.prototype);
  assert.equal(JSON.stringify(plain).includes('PRIVATE'), false);
  assert.ok(Object.isFrozen(plain));
  for (const error of [null, undefined, 'PRIVATE', 42, hostile,
    new Proxy({}, { get() { throw new Error('PRIVATE GETTER'); } })]) {
    assert.doesNotThrow(() => diagnostics.snapshot(error, { now }));
    assert.equal(JSON.stringify(diagnostics.attach(error, { now })).includes('PRIVATE'), false);
  }
  const forbidden = new Proxy({}, { get() { throw new Error('PRIVATE DETAILS'); } });
  assert.doesNotThrow(() => diagnostics.snapshot(hostile, forbidden));
  const guardedError = {};
  for (const key of ['message', 'stack', 'body']) {
    Object.defineProperty(guardedError, key, { get() { assert.fail('must not read ' + key); } });
  }
  diagnostics.snapshot(guardedError, { now });
  assert.equal(diagnostics.snapshot({}, { now: () => { throw new Error('PRIVATE CLOCK'); } }).timestamp,
    '1970-01-01T00:00:00.000Z');

  for (const [error, expected] of [
    [{ name: 'TimeoutError' }, 'timeout'], [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 'timeout'],
    [{ name: 'AbortError' }, 'abort'], [{ code: 'ABORT_ERR' }, 'abort'],
    [{ code: 'ECONNREFUSED' }, 'connect'], [{ cause: { code: 'EAI_AGAIN' } }, 'connect'],
    [{ code: 'ECONNRESET' }, 'reset'], [{ cause: { code: 'UND_ERR_SOCKET' } }, 'reset'],
    [{ code: 'EACCES' }, 'permission'], [{ code: 'EPERM' }, 'permission'],
    [{ code: 'ENOENT' }, 'missing'], [new SyntaxError('PRIVATE JSON'), 'malformed-json'],
    [{ message: 'ETIMEDOUT', stack: 'SyntaxError', body: 'ECONNRESET' }, 'unknown'],
    [{ name: 'PRIVATE_TimeoutError', code: 'ETIMEDOUT_PRIVATE' }, 'unknown'],
    [{ cause: { name: 'TimeoutError' } }, 'unknown'],
    [{ cause: { cause: { code: 'ECONNREFUSED' } } }, 'unknown'],
  ]) {
    assert.equal(diagnostics.classify(error, { phase: 'runtime-fetch', now }).transportClass, expected);
  }
  const bounded = diagnostics.snapshot(hostile, { phase: 'settings-http',
    endpoint: '/api/settings', guardStage: 'transport-poll', elapsedMs: -1,
    timeoutMs: Number.MAX_VALUE, httpStatus: 999, pollIndex: 10000000, now: () => Number.MAX_VALUE });
  assert.deepEqual(bounded, { version: 1, timestamp: '9999-12-31T23:59:59.999Z',
    phase: 'settings-http', safetyCode: 'GUARD_UNKNOWN', transportClass: 'unknown',
    endpoint: '/api/settings', guardStage: 'transport-poll', elapsedMs: 0,
    timeoutMs: 86400000, httpStatus: 599, pollIndex: 1000000 });
  const nonfinite = diagnostics.snapshot({}, { now, elapsedMs: Infinity, timeoutMs: NaN, pollIndex: '1' });
  assert.equal(Object.hasOwn(nonfinite, 'elapsedMs'), false);
  assert.equal(Object.hasOwn(nonfinite, 'timeoutMs'), false);
  assert.equal(Object.hasOwn(nonfinite, 'pollIndex'), false);
  for (const endpoint of ['http://127.0.0.1:8770/api/settings', '/api/settings?PRIVATE', '/api/secrets']) {
    assert.equal(Object.hasOwn(diagnostics.snapshot({}, { endpoint, now }), 'endpoint'), false);
  }

  const nested = diagnostics.attach(Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' }),
    { phase: 'activity-fetch', endpoint: '/api/local-model-activity', elapsedMs: 12, now });
  const wrapped = diagnostics.attach(nested, { phase: 'transport-poll', guardStage: 'transport-poll',
    elapsedMs: 900, pollIndex: 3, now: () => at + 900 });
  assert.equal(wrapped.guardPhase, 'activity-fetch');
  assert.equal(wrapped.guardDiagnostic.phase, 'activity-fetch');
  assert.equal(wrapped.guardDiagnostic.transportClass, 'reset');
  assert.equal(wrapped.guardDiagnostic.elapsedMs, 12);
  assert.equal(wrapped.guardDiagnostic.timestamp, nested.guardDiagnostic.timestamp);
  assert.equal(wrapped.guardDiagnostic.guardStage, 'transport-poll');
  assert.equal(wrapped.guardDiagnostic.pollIndex, 3);
  assert.deepEqual(diagnostics.snapshot(wrapped, { guardStage: 'admission', pollIndex: 99, now }),
    wrapped.guardDiagnostic);
  const safe = diagnostics.failure('PAUSE_INVALID_LEASE', { phase: 'lease-validate', now });
  assert.equal(safe.code, 'PAUSE_INVALID_LEASE');
  assert.equal(safe.guardDiagnostic.safetyCode, safe.code);
  const ownerPhase = diagnostics.failure('PAUSE_ABORTED', { phase: 'abort-read', ownershipStage: 'post', now });
  assert.equal(diagnostics.snapshot(ownerPhase, { guardStage: 'transport-final', now }).ownershipStage, 'post');
  assert.equal(Object.hasOwn(diagnostics.snapshot({}, { ownershipStage: 'PRIVATE', now }), 'ownershipStage'), false);
  assert.equal(diagnostics.failure('PRIVATE_CODE', { now }).code, 'GUARD_UNKNOWN');
  const fallback = diagnostics.attach({ name: 'TimeoutError', code: 'PRIVATE' },
    { fallbackCode: 'PAUSE_API_UNAVAILABLE', phase: 'settings-fetch', now });
  assert.equal(fallback.code, 'PAUSE_API_UNAVAILABLE');
  assert.equal(fallback.guardDiagnostic.transportClass, 'timeout');
  assert.equal(diagnostics.snapshot({ code: 'PRIVATE' }, { fallbackCode: 'PRIVATE', now }).safetyCode,
    'GUARD_UNKNOWN');
  assert.equal(diagnostics.snapshot(safe, { fallbackCode: 'EVAL_STATUS_UNAVAILABLE', now }).safetyCode,
    'PAUSE_INVALID_LEASE');
  const final = diagnostics.snapshot({}, { phase: 'transport-final', guardStage: 'final', now });
  assert.equal(final.phase, 'transport-final');
  assert.equal(final.guardStage, 'final');
  assert.equal(diagnostics.snapshot({ guardDiagnostic: { ...nested.guardDiagnostic, PRIVATE: 'PRIVATE' } },
    { phase: 'admission', now }).phase, 'admission');
  const invalidDescriptor = { ...nested.guardDiagnostic };
  Object.defineProperty(invalidDescriptor, 'endpoint', { get() { assert.fail('untrusted getter'); } });
  assert.equal(diagnostics.snapshot({ guardDiagnostic: invalidDescriptor }, { now }).phase, 'unknown');

  const directory = fixture();
  const record = failureRecord();
  const save = diagnostics.createRecorder({ directory, now });
  const saved = save(record);
  const file = path.join(directory, diagnostics.FILE_NAME);
  const original = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(original), record);
  assert.ok(Buffer.byteLength(original) <= diagnostics.MAX_BYTES);
  assert.ok(Object.isFrozen(saved));
  assert.equal(save(failureRecord('watchdog-read')), saved);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(diagnostics.createRecorder({ directory, now })(failureRecord('schedule-read')), record);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory), [diagnostics.FILE_NAME]);

  const orderedDirectory = fixture();
  const operations = [];
  const instrumented = ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'linkSync'];
  const originals = Object.fromEntries(instrumented.map((key) => [key, fs[key]]));
  for (const method of instrumented) {
    fs[method] = (...args) => { operations.push(method); return originals[method](...args); };
  }
  try { diagnostics.createRecorder({ directory: orderedDirectory, now })(record); }
  finally { for (const method of instrumented) fs[method] = originals[method]; }
  assert.deepEqual(operations, ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'linkSync']);

  const readSync = fs.readSync;
  let readBytes = 0;
  fs.readSync = (...args) => {
    assert.ok(args[3] <= diagnostics.MAX_BYTES, 'no individual read exceeds the metadata bound');
    const count = readSync(...args);
    readBytes += count;
    return count;
  };
  try { diagnostics.createRecorder({ directory, now })(record); }
  finally { fs.readSync = readSync; }
  assert.ok(readBytes <= diagnostics.MAX_BYTES, 'existing evidence reads are bounded in total');

  const raceDirectory = fixture();
  const link = fs.linkSync;
  const firstWriter = failureRecord('ownership-pre');
  fs.linkSync = (source, destination) => {
    fs.writeFileSync(destination, JSON.stringify(firstWriter), { flag: 'wx' });
    return link(source, destination);
  };
  try {
    assert.deepEqual(diagnostics.createRecorder({ directory: raceDirectory, now })(record), firstWriter);
  } finally { fs.linkSync = link; }
  assert.deepEqual(fs.readdirSync(raceDirectory), [diagnostics.FILE_NAME]);

  for (const value of [
    '{invalid PRIVATE', ' '.repeat(diagnostics.MAX_BYTES + 1),
    JSON.stringify({ ...record, body: 'PRIVATE' }),
    JSON.stringify({ ...record, safetyCode: 'PRIVATE_CODE' }),
    JSON.stringify({ ...record, timestamp: 'PRIVATE' }),
    JSON.stringify({ ...record, elapsedMs: -1 }),
    JSON.stringify({ ...record, endpoint: '/api/settings?PRIVATE' }),
    JSON.stringify({ ...record, guardStage: 'PRIVATE' }),
  ]) {
    const invalidDirectory = fixture();
    const invalidFile = path.join(invalidDirectory, diagnostics.FILE_NAME);
    fs.writeFileSync(invalidFile, value);
    writeFailure(() => diagnostics.createRecorder({ directory: invalidDirectory, now })(record));
    assert.equal(fs.readFileSync(invalidFile, 'utf8'), value, 'invalid existing evidence is preserved');
  }
  writeFailure(() => diagnostics.createRecorder({ directory: 'PRIVATE relative', now }));
  writeFailure(() => diagnostics.createRecorder({ directory: path.join(fixture(), 'missing'), now })(record));
  writeFailure(() => diagnostics.createRecorder({ directory: fixture(), now })({ ...record, body: 'PRIVATE' }));
  const blockedDirectory = fixture();
  fs.mkdirSync(path.join(blockedDirectory, diagnostics.FILE_NAME));
  writeFailure(() => diagnostics.createRecorder({ directory: blockedDirectory, now })(record));

  for (const method of ['writeFileSync', 'fsyncSync', 'linkSync']) {
    const failedDirectory = fixture();
    const originalMethod = fs[method];
    fs[method] = () => { throw Object.assign(new Error('PRIVATE WRITE DETAIL'), { code: 'PRIVATE_CODE' }); };
    try { writeFailure(() => diagnostics.createRecorder({ directory: failedDirectory, now })(record)); }
    finally { fs[method] = originalMethod; }
    assert.equal(fs.existsSync(path.join(failedDirectory, diagnostics.FILE_NAME)), false);
    assert.deepEqual(fs.readdirSync(failedDirectory), []);
  }
  const conflictDirectory = fixture();
  const openSync = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (args[0] === 'wx') {
      fs.writeFileSync(file, 'PRIVATE EXISTING FILE');
      throw Object.assign(new Error('PRIVATE COLLISION'), { code: 'EEXIST' });
    }
    return openSync(file, ...args);
  };
  try { writeFailure(() => diagnostics.createRecorder({ directory: conflictDirectory, now })(record)); }
  finally { fs.openSync = openSync; }
  const conflictFiles = fs.readdirSync(conflictDirectory);
  assert.equal(conflictFiles.length, 1);
  assert.equal(fs.readFileSync(path.join(conflictDirectory, conflictFiles[0]), 'utf8'), 'PRIVATE EXISTING FILE',
    'exclusive-create failure never removes a file this recorder did not create');
  assert.equal(require.cache[require.resolve('../lib/providers/ollama')], undefined,
    'diagnostic tests never import the provider or touch actual runtime state');
  console.log('evaluation-guard-diagnostics: passed (isolated files and mocked failures only)');
}

run();
