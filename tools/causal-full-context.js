'use strict';
// Experiment-only B/D follow-up. No scheduler, publication or provider imports.
const fs = require('fs');
const path = require('path');
const http = require('http');
const base = require('./causal-maintenance-run');
const { loadOriginal } = require('./causal-maintenance-continue');
const TIMEOUT_MS = 900000;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => base.sha(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
function classified(code, telemetry = {}) { const error = new Error(code); error.code = code; error.telemetry = telemetry; return error; }
const cancellation = signal => classified(['operator-cancelled', 'maintenance-guard-lost', 'maintenance-window-expired'].includes(signal?.reason?.code) ? signal.reason.code : 'cancelled');
function originalEvidence(original) {
  const files = [original.configFile, original.config.frozenFile, original.config.productionManifestFile,
    ...Object.values(original.config.models).map(model => model.manifestFile),
    path.join(original.config.outputDirectory, 'experiment-reserved.json')];
  const controls = {};
  for (const cell of original.plan) {
    const startFile = path.join(original.config.outputDirectory, cell.cell + '-started.json');
    const start = read(startFile);
    check(start.status === 'started' && start.requestHash === base.sha(JSON.stringify(cell.body)), 'Original request differs from frozen plan.');
    const outcomes = ['completed', 'failed-no-retry'].map(status => path.join(original.config.outputDirectory, cell.cell + '-' + status + '.json')).filter(file => fs.existsSync(file));
    if (cell.cell === 'D' && outcomes.length === 0) {
      // Original operator interruption was reconciled separately. Pin that exact
      // attestation, never manufacture a terminal record in the old ledger.
      const attestationFile = path.join(path.dirname(original.config.outputDirectory), 'D-operator-interrupted.json');
      const attestation = read(attestationFile);
      check(attestation.cell === 'D' && attestation.status === 'interrupted-no-retry' && attestation.providerResultAvailable === false &&
        attestation.startedAt === start.startedAt && Number.isFinite(Date.parse(attestation.cleanupCompletedAt)) &&
        Date.parse(attestation.cleanupCompletedAt) >= Date.parse(start.startedAt) && attestation.remainingCallBudget === 0,
      'Original D interruption attestation is inconsistent.');
      files.push(startFile, attestationFile);
      continue;
    }
    check(outcomes.length === 1, 'Original cell lacks unique terminal evidence.');
    const outcome = read(outcomes[0]);
    check(outcome.cell === cell.cell, 'Original outcome cell mismatch.');
    if (['A', 'C'].includes(cell.cell)) {
      check(outcome.status === 'completed' && outcome.response && outcome.response.done === true, 'A/C control evidence must be completed.');
      controls[cell.cell] = { elapsedMs: outcome.elapsedMs, promptEvalCount: outcome.response.prompt_eval_count,
        score: base.score(outcome.response.message.content, original.frozen) };
    }
    files.push(startFile, outcomes[0]);
  }
  return { files: Object.fromEntries(files.map(file => [path.resolve(file), hash(file)])), controls };
}
function prepare(configFile, directory) {
  check(path.isAbsolute(directory), 'New private evidence directory must be absolute.');
  const original = loadOriginal(configFile), evidence = originalEvidence(original);
  check(path.resolve(directory) !== path.resolve(original.config.outputDirectory), 'Original evidence is immutable.');
  fs.mkdirSync(directory); // Exclusive directory: never overwrite or resume another experiment.
  const receipt = { version: 1, kind: 'authorized-full-context-followup', createdAt: new Date().toISOString(),
    originalConfigFile: path.resolve(configFile), configHash: original.configHash, timeoutMs: TIMEOUT_MS,
    cells: ['B', 'D'], ...evidence,
    requestHashes: Object.fromEntries(original.plan.filter(cell => ['B', 'D'].includes(cell.cell)).map(cell => [cell.cell, base.sha(JSON.stringify(cell.body))])) };
  write(path.join(directory, 'followup-reserved.json'), receipt);
  return receipt;
}
function loadPrepared(directory) {
  const reservationFile = path.join(directory, 'followup-reserved.json'), receipt = read(reservationFile);
  check(receipt.version === 1 && receipt.kind === 'authorized-full-context-followup' && receipt.timeoutMs === TIMEOUT_MS && JSON.stringify(receipt.cells) === '["B","D"]', 'Invalid follow-up reservation.');
  for (const [file, expected] of Object.entries(receipt.files)) check(hash(file) === expected, 'Pinned original evidence changed.');
  const original = loadOriginal(receipt.originalConfigFile), evidence = originalEvidence(original);
  check(original.configHash === receipt.configHash && JSON.stringify(evidence.files) === JSON.stringify(receipt.files), 'Original provenance changed.');
  for (const cell of original.plan.filter(item => ['B', 'D'].includes(item.cell))) check(receipt.requestHashes[cell.cell] === base.sha(JSON.stringify(cell.body)), 'Frozen request changed.');
  return { original, receipt, reservationHash: hash(reservationFile), directory };
}
// Native node:http intentionally avoids fetch/undici's independent 300s headers ceiling.
// Response remains non-streaming JSON; chunks are diagnostic bytes, never model progress.
function nativeJsonRequest(url, body, timeoutMs = TIMEOUT_MS, signal, deps = {}) {
  const target = new URL(url);
  check(target.protocol === 'http:' && target.hostname === '127.0.0.1' && ['11435', '11436'].includes(target.port), 'Only isolated/arbiter loopback is allowed.');
  check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TIMEOUT_MS, 'Invalid experiment request deadline.');
  const requestImpl = deps.request || http.request, now = deps.now || Date.now;
  const schedule = deps.setTimeout || setTimeout, cancel = deps.clearTimeout || clearTimeout;
  return new Promise((resolve, reject) => {
    const started = now(), telemetry = { headersAfterMs: null, responseBytes: 0, ended: false };
    let req, response, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; cancel(timer); signal?.removeEventListener('abort', onAbort);
      if (error) { error.telemetry = { ...telemetry, elapsedMs: now() - started }; response?.destroy(); req?.destroy(); reject(error); }
      else resolve(value);
    };
    const onAbort = () => finish(cancellation(signal));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = schedule(() => finish(classified('experiment-deadline')), timeoutMs);
    const bytes = body == null ? null : Buffer.from(JSON.stringify(body));
    try {
      req = requestImpl(target, { method: bytes ? 'POST' : 'GET', agent: false,
        headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {} }, incoming => {
        if (settled) { incoming.destroy(); return; }
        response = incoming; telemetry.headersAfterMs = now() - started;
        if (incoming.statusCode < 200 || incoming.statusCode >= 300) { telemetry.httpStatus = incoming.statusCode; finish(classified('http-error')); return; }
        const chunks = [];
        incoming.on('data', chunk => {
          telemetry.responseBytes += chunk.length;
          if (telemetry.responseBytes > 8 * 1024 * 1024) { finish(classified('response-too-large')); return; }
          chunks.push(Buffer.from(chunk));
        });
        incoming.on('aborted', () => finish(classified('response-aborted')));
        incoming.on('error', () => finish(classified('transport-error')));
        incoming.on('end', () => {
          telemetry.ended = true;
          try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (value.error) finish(classified('api-error')); else finish(null, value); }
          catch { finish(classified('invalid-response-envelope')); }
        });
      });
      req.on('error', () => finish(classified('transport-error')));
      req.end(bytes);
    } catch { finish(classified('transport-error')); }
  });
}
async function runCell(directory, cellId, { guard, request = nativeJsonRequest, now = Date.now, currentOwnedRecordFile, signal } = {}) {
  check(['B', 'D'].includes(cellId), 'Only the two newly authorized B/D cells may run.');
  check(typeof guard === 'function' && currentOwnedRecordFile, 'Verified maintenance/ownership guard and record are required.');
  const prepared = loadPrepared(directory), { original, receipt } = prepared;
  const cell = original.plan.find(item => item.cell === cellId), ownedHash = hash(currentOwnedRecordFile);
  if (cellId === 'D') {
    check(fs.existsSync(path.join(directory, 'B-completed.json')) && !fs.existsSync(path.join(directory, 'B-failed-no-retry.json')), 'D requires successful complete B, not timeout/cancellation.');
    const previous = read(path.join(directory, 'B-started.json')), complete = read(path.join(directory, 'B-completed.json'));
    check(previous.currentOwnedRecordHash === ownedHash && previous.reservationHash === prepared.reservationHash && complete.response?.done === true, 'D must use the same verified daemon after complete B.');
  }
  await guard();
  if (signal?.aborted) throw cancellation(signal);
  loadPrepared(directory); // Recheck provenance after asynchronous preflight.
  check(hash(currentOwnedRecordFile) === ownedHash, 'Current ownership evidence changed during preflight.');
  const started = now();
  write(path.join(directory, cellId + '-started.json'), { cell: cellId, status: 'started', startedAt: new Date(started).toISOString(),
    requestHash: receipt.requestHashes[cellId], timeoutMs: TIMEOUT_MS, reservationHash: prepared.reservationHash,
    currentOwnedRecordFile: path.resolve(currentOwnedRecordFile), currentOwnedRecordHash: ownedHash });
  let response;
  try {
    response = await request(original.config.url + '/api/chat', cell.body, TIMEOUT_MS, signal);
    if (signal?.aborted) throw cancellation(signal);
    if (response.done !== true || typeof response.message?.content !== 'string') throw classified('incomplete-response');
    try { await guard(); } catch { throw classified('maintenance-guard-lost'); }
    if (signal?.aborted) throw cancellation(signal);
    if (response.prompt_eval_count !== original.config.models[cell.template].fullInputTokens) throw classified('context-token-mismatch');
    const result = { cell: cellId, template: cell.template, context: cell.context, status: 'completed', elapsedMs: now() - started,
      response, score: base.score(response.message.content, original.frozen) };
    write(path.join(directory, cellId + '-completed.json'), result);
    return result;
  } catch (error) {
    const allowed = ['experiment-deadline', 'operator-cancelled', 'maintenance-guard-lost', 'maintenance-window-expired', 'cancelled', 'http-error', 'api-error', 'transport-error', 'response-aborted', 'response-too-large', 'invalid-response-envelope', 'incomplete-response', 'context-token-mismatch'];
    write(path.join(directory, cellId + '-failed-no-retry.json'), { cell: cellId, status: 'failed-no-retry', elapsedMs: now() - started,
      errorClass: allowed.includes(error.code) ? error.code : 'request-or-contract-failure',
      ...(response ? { response, usable: false, expectedPromptEvalCount: original.config.models[cell.template].fullInputTokens } : {}),
      telemetry: error.telemetry ? { headersAfterMs: error.telemetry.headersAfterMs, responseBytes: error.telemetry.responseBytes,
        ended: error.telemetry.ended, httpStatus: error.telemetry.httpStatus } : undefined });
    throw error;
  }
}
module.exports = { TIMEOUT_MS, prepare, loadPrepared, runCell, nativeJsonRequest, classified };
if (require.main === module) {
  try {
    const [mode, config, directory] = process.argv.slice(2);
    check(mode === 'prepare', 'Use prepare ORIGINAL_CONFIG NEW_EVIDENCE_DIRECTORY; execution requires the guarded window controller.');
    const result = prepare(config, directory);
    console.log(JSON.stringify({ prepared: true, cells: result.cells, timeoutMs: result.timeoutMs, configHash: result.configHash }));
  } catch { console.error('Follow-up preparation failed; no inference was attempted.'); process.exitCode = 1; }
}
