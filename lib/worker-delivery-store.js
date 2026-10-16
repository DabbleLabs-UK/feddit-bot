'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_BYTES = 1024 * 1024;

function failure() {
  const error = new Error('Worker delivery state is unavailable or invalid. New claims are blocked.');
  error.code = 'WORKER_DELIVERY_STATE';
  return error;
}

function validate(value) {
  if (!value || value.version !== VERSION || !Object.hasOwn(value, 'pending')
      || !Object.hasOwn(value, 'claimRequestId')
      || Object.keys(value).some((key) => !['version', 'claimRequestId', 'pending'].includes(key))
      || (value.claimRequestId !== null && !/^c_[a-f0-9]{32}$/.test(value.claimRequestId))) throw failure();
  const pending = value.pending;
  if (pending !== null) {
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)
        || Object.keys(pending).some((key) => !['jobId', 'leaseToken', 'operation', 'body', 'blocked'].includes(key))
        || !/^[A-Za-z0-9_-]{1,128}$/.test(pending.jobId || '')
        || (pending.leaseToken !== null && !/^l_[a-f0-9]{32}$/.test(pending.leaseToken))
        || !['complete', 'fail'].includes(pending.operation)
        || !pending.body || typeof pending.body !== 'object' || Array.isArray(pending.body)
        || (pending.blocked !== null && !['auth', 'conflict', 'protocol'].includes(pending.blocked))) throw failure();
    if (pending.operation === 'complete') {
      const result = pending.body.result;
      if (Object.keys(pending.body).length !== 1 || !result || typeof result !== 'object' || Array.isArray(result)
          || typeof result.text !== 'string'
          || Object.keys(result).some((key) => !['text', 'provider', 'model', 'ms', 'queueMs', 'usage', 'finishReason'].includes(key))) throw failure();
      for (const key of ['provider', 'model', 'finishReason']) {
        if (result[key] !== undefined && (typeof result[key] !== 'string' || result[key].length > 512)) throw failure();
      }
      for (const key of ['ms', 'queueMs']) {
        if (result[key] !== undefined && (!Number.isFinite(result[key]) || result[key] < 0)) throw failure();
      }
      if (result.usage !== undefined && (!result.usage || typeof result.usage !== 'object' || Array.isArray(result.usage)
          || Object.keys(result.usage).some((key) => !['inputTokens', 'outputTokens', 'cachedInputTokens'].includes(key)
            || !Number.isFinite(result.usage[key]) || result.usage[key] < 0))) throw failure();
    } else if (Object.keys(pending.body).some((key) => !['error', 'retryable'].includes(key))
        || typeof pending.body.error !== 'string' || pending.body.error.length > 160
        || typeof pending.body.retryable !== 'boolean') throw failure();
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw failure();
  return value;
}

function createDeliveryStore(options) {
  const directory = path.resolve(options.directory);
  const scope = crypto.createHash('sha256').update(options.runnerUrl + '\n' + options.workerId).digest('hex');
  const file = path.join(directory, scope + '.json');
  const files = options.fsImpl || fs;
  function read() {
    try {
      if (files.statSync(file).size > MAX_BYTES) throw failure();
      return validate(JSON.parse(files.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: VERSION, claimRequestId: null, pending: null };
      throw failure();
    }
  }
  function write(value) {
    validate(value);
    let temporary;
    try {
      files.mkdirSync(directory, { recursive: true, mode: 0o700 });
      temporary = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      const descriptor = files.openSync(temporary, 'wx', 0o600);
      try { files.writeFileSync(descriptor, JSON.stringify(value) + '\n', 'utf8'); files.fsyncSync(descriptor); }
      finally { files.closeSync(descriptor); }
      files.renameSync(temporary, file);
      return value;
    } catch { throw failure(); }
  }
  return { file, read, write };
}

module.exports = { VERSION, MAX_BYTES, validate, createDeliveryStore };
