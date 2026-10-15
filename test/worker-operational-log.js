'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createLogger, classify, MAX_FILE_BYTES, MAX_RECORD_BYTES } = require('../lib/worker-operational-log');

let checks = 0;
function eq(actual, expected) { assert.deepEqual(actual, expected); checks++; }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-operational-log-'));
const file = path.join(directory, 'worker.jsonl');
const jobId = 'j_' + 'a'.repeat(32);
const secret = 'private-worker-key';
try {
  eq(createLogger(), console);
  const cases = [
    ['DELL worker private-owner is polling https://private.example/', 'started', 'unknown'],
    ['Completed inference job ' + jobId + '.', 'completed', 'unknown'],
    ['Inference job ' + jobId + ' failed: Hosted decision Ollama rendering version has not been verified.', 'inference_failed', 'render_version'],
    ['Worker poll failed: model metadata could not be verified.', 'poll_failed', 'metadata'],
    ['Worker poll failed: decision budget exceeded', 'poll_failed', 'budget'],
    ['Worker poll failed: timed out', 'poll_failed', 'timeout'],
    ['Worker poll failed: operation was aborted', 'poll_failed', 'aborted'],
    ['Worker poll failed: shared lease lost', 'poll_failed', 'lease'],
    ['Worker poll failed: HTTP 401 private-response', 'poll_failed', 'auth'],
    ['Worker poll failed: HTTP 429 private-response', 'poll_failed', 'http429'],
    ['Worker poll failed: HTTP 503 private-response', 'poll_failed', 'http5xx'],
    ['Could not renew job ' + jobId + ': fetch failed', 'renew_failed', 'connection'],
    ['Could not report failed job ' + jobId + ': private-response', 'report_failed', 'unknown'],
    ['Worker maintenance gate: MAINTENANCE_REQUEST_UNREADABLE. New claims are blocked.', 'maintenance', 'unknown'],
    ['private unknown message', 'unknown', 'unknown'],
  ];
  const logger = createLogger(file, secret);
  for (const [message, event, reason] of cases) {
    const record = classify(message, secret);
    eq(record.event, event);
    eq(record.reason, reason);
    logger.error(message + (event === 'completed' ? '' : ' private-prompt ' + secret));
  }
  eq(classify('Completed inference job ' + jobId + '.', secret).jobId, jobId);
  eq(classify('Completed inference job ' + jobId + '.', jobId).jobId, undefined);
  eq(classify('Completed inference job ' + jobId + '.', 'a'.repeat(32)).jobId, undefined);
  eq(classify('Completed inference job j_123.', secret).jobId, undefined);
  eq(classify('Worker poll failed: private-prompt ' + jobId, secret).jobId, undefined);
  let content = fs.readFileSync(file, 'utf8');
  eq(/private|https:|WORKER_KEY|private-response/.test(content), false);
  for (const line of content.trim().split('\n')) {
    const record = JSON.parse(line);
    eq(record.severity, 'error');
    eq(Number.isFinite(Date.parse(record.timestamp)), true);
    eq(Buffer.byteLength(line) <= MAX_RECORD_BYTES, true);
    eq(Object.keys(record).every((key) => ['timestamp', 'severity', 'event', 'reason', 'jobId'].includes(key)), true);
  }
  for (let index = 0; index < 5000; index++) logger.log('Completed inference job ' + jobId + '.');
  eq(fs.readdirSync(directory).sort(), ['worker.jsonl', 'worker.jsonl.previous']);
  for (const name of fs.readdirSync(directory)) {
    eq(fs.statSync(path.join(directory, name)).size <= MAX_FILE_BYTES, true);
    content = fs.readFileSync(path.join(directory, name), 'utf8');
    eq(content.endsWith('\n'), true);
    for (const line of content.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  }
  const env = { ...process.env, FEDDIT_RUNNER_URL: '', FEDDIT_WORKER_KEY: secret, FEDDIT_WORKER_LOG_FILE: file };
  const logged = spawnSync(process.execPath, ['worker.js'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  eq(logged.status, 1);
  eq(logged.stderr, '');
  eq(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)).event, 'unknown');
  delete env.FEDDIT_WORKER_LOG_FILE;
  const normal = spawnSync(process.execPath, ['worker.js'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  eq(normal.status, 1);
  eq(normal.stderr.includes('FEDDIT_RUNNER_URL is required.'), true);
  console.log('worker-operational-log: ' + checks + ' checks passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
