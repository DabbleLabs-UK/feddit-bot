'use strict';

// Private experiment guard metadata only. Never imported by the runner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'guard-diagnostic.json';
const MAX_BYTES = 4096;
const MAX_TIME = 253402300799999;
const PHASES = new Set([
  'unknown', 'admission', 'transport-initial', 'transport-poll', 'transport-final', 'final', 'status-schema',
  'schedule-read', 'schedule-schema', 'lease-read', 'lease-validate', 'ownership-pre',
  'ownership-post', 'released-read', 'abort-read', 'watchdog-read', 'watchdog-liveness',
  'pause-check', 'experiment-deadline', 'settings-fetch', 'settings-http', 'settings-json',
  'settings-schema', 'runtime-fetch', 'runtime-http', 'runtime-json', 'runtime-schema',
  'activity-fetch', 'activity-http', 'activity-json', 'activity-schema', 'identity-fetch',
  'identity-http', 'identity-json', 'identity-schema', 'guard-diagnostic-write',
]);
const SAFETY_CODES = new Set([
  'GUARD_UNKNOWN', 'GUARD_DIAGNOSTIC_WRITE_FAILED', 'EVAL_STATUS_UNAVAILABLE',
  'EVAL_SCHEDULE_UNKNOWN', 'EVAL_YIELD', 'EVAL_DEADLINE_DUE', 'EVAL_CANCELLED',
  'EVAL_CEILING', 'EVAL_CASE_HASH_MISMATCH', 'EVAL_EXPLICIT_RUN_ONE_REQUIRED',
  'EVAL_INVALID_CASES', 'EVAL_INVALID_RESULT', 'EVAL_LEDGER_MISMATCH', 'EVAL_LOCKED',
  'EVAL_LOCK_CHANGED', 'EVAL_OUTPUT_NOT_ISOLATED', 'EVAL_PRIOR_CALL_NO_RETRY',
  'EVAL_PROVIDER_ALREADY_LOADED', 'EVAL_PROVIDER_UNSAFE', 'EVAL_TELEMETRY_NOT_ISOLATED',
  'EVAL_UNAVAILABLE', 'EVAL_UNKNOWN_FAILURE', 'PAUSE_ABORTED',
  'PAUSE_ABSOLUTE_DIRECTORY_REQUIRED', 'PAUSE_API_UNAVAILABLE', 'PAUSE_CASE_METADATA_INVALID',
  'PAUSE_DEADLINE', 'PAUSE_DESKTOP_REQUIRED', 'PAUSE_DIRECTORY_REQUIRED',
  'PAUSE_DRAIN_TIMEOUT', 'PAUSE_ENTRY_MARGIN', 'PAUSE_EVALUATION_DEFERRED',
  'PAUSE_EXISTING_PAUSE_REQUIRES_RESUME_ON_EXIT', 'PAUSE_EXPLICIT_COMMAND_REQUIRED',
  'PAUSE_FINISHED', 'PAUSE_FRESH_DIRECTORY_REQUIRED', 'PAUSE_HEARTBEAT_STALE',
  'PAUSE_INTERRUPTED', 'PAUSE_INVALID_LEASE', 'PAUSE_NORMAL_WORK_BUSY',
  'PAUSE_NOT_VERIFIED', 'PAUSE_OWNERSHIP_CHANGED', 'PAUSE_OWNER_IDENTITY_UNVERIFIED',
  'PAUSE_PARENT_EXITED', 'PAUSE_RESTORE_FAILED', 'PAUSE_RESUMED_EXTERNALLY',
  'PAUSE_RESUME_NOT_VERIFIED', 'PAUSE_SETTINGS_UNKNOWN', 'PAUSE_SNAPSHOT_UNKNOWN',
  'PAUSE_STATE_CHANGED', 'PAUSE_STATUS_UNKNOWN', 'PAUSE_UNAVAILABLE',
  'PAUSE_WATCHDOG_EXIT_UNVERIFIED', 'PAUSE_WATCHDOG_FAILED', 'PAUSE_WATCHDOG_UNAVAILABLE',
]);
const ENDPOINTS = new Set([
  '/api/settings', '/api/runtime', '/api/runtime-state', '/api/local-model-activity',
]);
const TRANSPORT_CLASSES = new Set([
  'timeout', 'abort', 'connect', 'reset', 'permission', 'missing', 'malformed-json', 'unknown',
]);
const NAMES = new Map([
  ['TimeoutError', 'timeout'], ['AbortError', 'abort'], ['SyntaxError', 'malformed-json'],
]);
const CODES = new Map([
  ['ETIMEDOUT', 'timeout'], ['ESOCKETTIMEDOUT', 'timeout'],
  ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
  ['UND_ERR_BODY_TIMEOUT', 'timeout'], ['ABORT_ERR', 'abort'],
  ['ECONNREFUSED', 'connect'], ['ENOTFOUND', 'connect'], ['EAI_AGAIN', 'connect'],
  ['ENETUNREACH', 'connect'], ['EHOSTUNREACH', 'connect'],
  ['ECONNRESET', 'reset'], ['EPIPE', 'reset'], ['UND_ERR_SOCKET', 'reset'],
  ['EACCES', 'permission'], ['EPERM', 'permission'], ['ENOENT', 'missing'],
]);
const NUMBERS = { elapsedMs: [0, 86400000], timeoutMs: [0, 86400000],
  httpStatus: [100, 599], pollIndex: [0, 1000000] };
const REQUIRED_FIELDS = ['version', 'timestamp', 'phase', 'safetyCode', 'transportClass'];
const OWNERSHIP_STAGES = new Set(['pre', 'post']);
const FIELDS = new Set([...REQUIRED_FIELDS, 'endpoint', 'guardStage', 'ownershipStage', ...Object.keys(NUMBERS)]);

function get(value, key) {
  try { return value == null ? undefined : value[key]; }
  catch { return undefined; }
}

function clamp(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : undefined;
}

function timestamp(now) {
  let value;
  try { value = (typeof now === 'function' ? now : Date.now)(); }
  catch { value = 0; }
  return new Date(clamp(value, 0, MAX_TIME) || 0).toISOString();
}

function transportClass(error) {
  return NAMES.get(get(error, 'name')) || CODES.get(get(error, 'code')) ||
    CODES.get(get(get(error, 'cause'), 'code')) || 'unknown';
}

function classify(error, details = {}) {
  const code = get(error, 'code');
  const fallbackCode = get(details, 'fallbackCode');
  const phase = get(details, 'phase');
  const record = { version: 1, timestamp: timestamp(get(details, 'now')),
    phase: PHASES.has(phase) ? phase : 'unknown',
    safetyCode: SAFETY_CODES.has(code) ? code
      : SAFETY_CODES.has(fallbackCode) ? fallbackCode : 'GUARD_UNKNOWN',
    transportClass: transportClass(error) };
  const endpoint = get(details, 'endpoint');
  const guardStage = get(details, 'guardStage');
  if (ENDPOINTS.has(endpoint)) record.endpoint = endpoint;
  if (PHASES.has(guardStage)) record.guardStage = guardStage;
  if (OWNERSHIP_STAGES.has(get(details, 'ownershipStage'))) record.ownershipStage = get(details, 'ownershipStage');
  for (const [key, limits] of Object.entries(NUMBERS)) {
    const value = clamp(get(details, key), ...limits);
    if (value !== undefined) record[key] = value;
  }
  return Object.freeze(record);
}

function validRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > FIELDS.size || keys.some((key) => !FIELDS.has(key))) return null;
    const fields = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      fields[key] = descriptor.value;
    }
    if (REQUIRED_FIELDS.some((key) => !Object.hasOwn(fields, key)) || fields.version !== 1 ||
      typeof fields.timestamp !== 'string' || fields.timestamp.length !== 24 ||
      !PHASES.has(fields.phase) || !SAFETY_CODES.has(fields.safetyCode) ||
      !TRANSPORT_CLASSES.has(fields.transportClass)) return null;
    const at = Date.parse(fields.timestamp);
    if (!Number.isFinite(at) || at < 0 || at > MAX_TIME ||
      new Date(at).toISOString() !== fields.timestamp) return null;
    if (Object.hasOwn(fields, 'endpoint') && !ENDPOINTS.has(fields.endpoint)) return null;
    if (Object.hasOwn(fields, 'guardStage') && !PHASES.has(fields.guardStage)) return null;
    if (Object.hasOwn(fields, 'ownershipStage') && !OWNERSHIP_STAGES.has(fields.ownershipStage)) return null;
    for (const [key, limits] of Object.entries(NUMBERS)) {
      if (Object.hasOwn(fields, key) &&
        (!Number.isSafeInteger(fields[key]) || clamp(fields[key], ...limits) !== fields[key])) return null;
    }
    return Object.freeze(fields);
  } catch { return null; }
}

function snapshot(error, details = {}) {
  const existing = validRecord(get(error, 'guardDiagnostic'));
  if (!existing) return classify(error, details);
  const context = classify(undefined, details);
  return Object.freeze({ ...existing,
    ...(!Object.hasOwn(existing, 'guardStage') && context.guardStage ? { guardStage: context.guardStage } : {}),
    ...(!Object.hasOwn(existing, 'ownershipStage') && context.ownershipStage ? { ownershipStage: context.ownershipStage } : {}),
    ...(!Object.hasOwn(existing, 'pollIndex') && Object.hasOwn(context, 'pollIndex')
      ? { pollIndex: context.pollIndex } : {}) });
}

function attach(error, details = {}) {
  const record = snapshot(error, details);
  return Object.assign(new Error(record.safetyCode), { code: record.safetyCode,
    guardPhase: record.phase, guardDiagnostic: record });
}

function failure(code, details = {}) {
  return attach({ code: SAFETY_CODES.has(code) ? code : 'GUARD_UNKNOWN' }, details);
}

function createRecorder({ directory, now = Date.now } = {}) {
  let first;
  const writeFailed = () => failure('GUARD_DIAGNOSTIC_WRITE_FAILED', {
    phase: 'guard-diagnostic-write', now,
  });
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw writeFailed();
  const file = path.join(directory, FILE_NAME);

  function existing() {
    let fd;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw writeFailed();
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_BYTES) throw writeFailed();
      const buffer = Buffer.alloc(MAX_BYTES);
      let size = 0;
      while (size < MAX_BYTES) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size !== opened.size || fs.fstatSync(fd).size !== size) throw writeFailed();
      const record = validRecord(JSON.parse(buffer.subarray(0, size).toString('utf8')));
      if (!record) throw writeFailed();
      return record;
    } catch (error) {
      if (get(error, 'code') === 'ENOENT' && fd === undefined) return null;
      throw writeFailed();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return (record) => {
    if (first) return first;
    let temporary;
    let ownedTemporary = false;
    let fd;
    try {
      first = existing();
      if (first) return first;
      const safe = validRecord(record);
      if (!safe) throw writeFailed();
      const text = JSON.stringify(safe, null, 2) + '\n';
      if (Buffer.byteLength(text) > MAX_BYTES) throw writeFailed();
      temporary = file + '.' + crypto.randomUUID() + '.tmp';
      fd = fs.openSync(temporary, 'wx', 0o600);
      ownedTemporary = true;
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try { fs.linkSync(temporary, file); }
      catch (error) {
        if (get(error, 'code') !== 'EEXIST') throw error;
        first = existing();
        if (!first) throw writeFailed();
      }
      first = first || safe;
      return first;
    } catch { throw writeFailed(); }
    finally {
      let cleanupFailed = false;
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { cleanupFailed = true; }
      }
      if (ownedTemporary) {
        try { fs.unlinkSync(temporary); }
        catch (error) { if (get(error, 'code') !== 'ENOENT') cleanupFailed = true; }
      }
      if (cleanupFailed) throw writeFailed();
    }
  };
}

module.exports = { FILE_NAME, MAX_BYTES, classify, snapshot, attach, failure, createRecorder };
