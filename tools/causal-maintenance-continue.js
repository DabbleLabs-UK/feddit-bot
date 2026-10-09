'use strict';
// Experiment-only continuation. No production provider, scheduler or effect API.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const base = require('./causal-maintenance-run');
const TIMEOUT_MS = 300000;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = file => base.sha(fs.readFileSync(file));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function loadOriginal(configFile) {
  const configHash = digest(configFile), config = read(configFile);
  const frozen = read(config.frozenFile);
  check(digest(config.frozenFile) === config.frozenSha256, 'Frozen bytes changed.');
  const plan = base.plan(config, frozen);
  const reservation = read(path.join(config.outputDirectory, 'experiment-reserved.json'));
  check(reservation.configHash === configHash, 'Original immutable config changed.');
  return { configFile, configHash, config, frozen, plan };
}
function inspectLedger(original, cell) {
  check(cell === 'C' || cell === 'D', 'Only C or D may continue.');
  const directory = original.config.outputDirectory;
  check(!fs.existsSync(path.join(directory, cell + '-started.json')), 'This cell is already reserved; no retry.');
  check(!fs.existsSync(path.join(directory, cell + '-completed.json')) && !fs.existsSync(path.join(directory, cell + '-failed-no-retry.json')), 'This cell already has an outcome.');
  const history = {};
  for (const prior of cell === 'C' ? ['A', 'B'] : ['A', 'B', 'C']) {
    const startedFile = path.join(directory, prior + '-started.json');
    const started = read(startedFile);
    const planned = original.plan.find(item => item.cell === prior);
    check(started.status === 'started' && started.requestHash === base.sha(JSON.stringify(planned.body)), 'Prior request reservation does not match frozen plan.');
    history[prior + '-started.json'] = digest(startedFile);
    const outcomes = ['completed', 'failed-no-retry'].map(status => path.join(directory, prior + '-' + status + '.json')).filter(file => fs.existsSync(file));
    check(outcomes.length === 1, 'Prior cell has no unique terminal evidence.');
    history[path.basename(outcomes[0])] = digest(outcomes[0]);
  }
  return { history, historyHash: base.sha(JSON.stringify(history)) };
}
function ps(script) {
  check(process.platform === 'win32', 'Live continuation requires DELL Windows.');
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
}
function ownedRecord(file) {
  const record = read(file);
  check(Number.isInteger(record.pid) && record.pid > 0 && record.url === 'http://127.0.0.1:11436', 'Invalid isolated ownership record.');
  check(record.exe && /^[a-f0-9]{64}$/.test(record.exeSha256 || '') && record.models, 'Incomplete isolated ownership provenance.');
  return record;
}
async function proveTornDown(previous) {
  const ids = [previous.pid, ...(previous.childPids || [])];
  check(ids.every(id => Number.isInteger(id) && id > 0), 'Invalid prior child identity.');
  const result = ps(`$ids=@(${ids.join(',')});$alive=@(Get-CimInstance Win32_Process|Where-Object {$ids -contains $_.ProcessId -or $_.ParentProcessId -eq ${previous.pid}}|Select-Object -ExpandProperty ProcessId);$listen=@(Get-NetTCPConnection -LocalPort 11436 -State Listen -ErrorAction SilentlyContinue);@{alive=$alive;listeners=$listen.Count}|ConvertTo-Json`);
  check(result.alive.length === 0 && result.listeners === 0, 'Previous isolated process or listener still exists.');
  await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(11436, '127.0.0.1', () => server.close(resolve)); });
}
function proveCurrent(record) {
  const result = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}';$listeners=@(Get-NetTCPConnection -LocalPort 11436 -State Listen -ErrorAction SilentlyContinue|Select-Object LocalAddress,OwningProcess);@{pid=$p.ProcessId;exe=$p.ExecutablePath;createdAt=if($p){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null};listeners=$listeners}|ConvertTo-Json -Depth 4`);
  check(result.pid === record.pid && samePath(result.exe, record.exe), 'Current isolated process identity mismatch.');
  check(result.listeners.length > 0 && result.listeners.every(item => item.OwningProcess === record.pid && item.LocalAddress === '127.0.0.1'), 'Current isolated listener ownership mismatch.');
  if (record.createdAt) check(record.createdAt === result.createdAt, 'Current isolated process birth changed.');
  return result.createdAt;
}
async function attest(configFile, cell, previousFile, receiptFile, deps = {}) {
  const original = loadOriginal(configFile), ledger = inspectLedger(original, cell), previous = ownedRecord(previousFile);
  if (cell === 'D') {
    const prior = read(path.join(original.config.outputDirectory, 'C-started.json'));
    check(prior.currentOwnedRecordHash === digest(previousFile), 'D must follow the exact C isolated process record.');
  } else {
    const initial = path.join(path.dirname(original.config.outputDirectory), 'owned-process.json');
    check(digest(initial) === digest(previousFile), 'C must follow the original isolated process record.');
  }
  await (deps.proveTornDown || proveTornDown)(previous);
  const receipt = { version: 1, cell, configHash: original.configHash, frozenSha256: original.config.frozenSha256,
    ...ledger, previousOwnedRecordFile: path.resolve(previousFile), previousOwnedRecordHash: digest(previousFile),
    previousPid: previous.pid, previousExeSha256: previous.exeSha256, previousModels: previous.models,
    tornDownAt: new Date().toISOString(), timeoutMs: TIMEOUT_MS };
  const bytes = JSON.stringify(receipt, null, 2);
  const reservation = path.join(original.config.outputDirectory, cell + '-continuation-reserved.json');
  fs.writeFileSync(reservation, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(receiptFile, bytes, { flag: 'wx', mode: 0o600 });
  return receipt;
}
function verifyReceipt(original, receiptFile) {
  const receipt = read(receiptFile), ledger = inspectLedger(original, receipt.cell);
  check(receipt.version === 1 && receipt.timeoutMs === TIMEOUT_MS && receipt.configHash === original.configHash && receipt.frozenSha256 === original.config.frozenSha256, 'Continuation receipt provenance mismatch.');
  check(receipt.historyHash === ledger.historyHash, 'Original history changed after teardown attestation.');
  check(digest(receiptFile) === digest(path.join(original.config.outputDirectory, receipt.cell + '-continuation-reserved.json')), 'Continuation reservation does not match receipt.');
  check(digest(receipt.previousOwnedRecordFile) === receipt.previousOwnedRecordHash, 'Previous ownership evidence changed.');
  return receipt;
}
async function runOne(original, receipt, currentRecordFile, { guard, request, now = Date.now } = {}) {
  const cell = original.plan.find(item => item.cell === receipt.cell);
  check(cell && ['C', 'D'].includes(cell.cell), 'Invalid continuation cell.');
  await guard();
  const started = now(), directory = original.config.outputDirectory;
  // Exclusive file in ORIGINAL ledger is the global call-budget fence.
  fs.writeFileSync(path.join(directory, cell.cell + '-started.json'), JSON.stringify({ status: 'started',
    startedAt: new Date(started).toISOString(), requestHash: base.sha(JSON.stringify(cell.body)),
    currentOwnedRecordFile: path.resolve(currentRecordFile), currentOwnedRecordHash: digest(currentRecordFile),
    continuationReceiptHash: base.sha(JSON.stringify(receipt)) }, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    const response = await request(original.config.url + '/api/chat', cell.body, TIMEOUT_MS);
    check(response.done === true && response.message && typeof response.message.content === 'string', 'Incomplete isolated response.');
    const result = { cell: cell.cell, template: cell.template, context: cell.context, status: 'completed', elapsedMs: now() - started,
      response, score: base.score(response.message.content, original.frozen) };
    fs.writeFileSync(path.join(directory, cell.cell + '-completed.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) {
    fs.writeFileSync(path.join(directory, cell.cell + '-failed-no-retry.json'), JSON.stringify({ cell: cell.cell, status: 'failed-no-retry', elapsedMs: now() - started,
      errorClass: ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout-or-cancelled' : 'request-or-contract-failure' }), { flag: 'wx', mode: 0o600 });
    throw error;
  }
}
async function jsonRequest(url, body, signal) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  check(response.ok, 'Isolated HTTP failure.'); const result = await response.json(); check(!result.error, 'Isolated API error.'); return result;
}
async function run(configFile, receiptFile, maintenanceId, currentFile) {
  const original = loadOriginal(configFile), receipt = verifyReceipt(original, receiptFile), current = ownedRecord(currentFile);
  check(current.pid !== receipt.previousPid && current.exeSha256 === receipt.previousExeSha256 && samePath(current.models, receipt.previousModels), 'Replacement isolated process provenance differs.');
  check(Date.parse(current.createdAt || '') > Date.parse(receipt.tornDownAt), 'Replacement process must be born after teardown proof.');
  const actualBirth = proveCurrent(current); check(actualBirth === current.createdAt, 'Replacement process birth mismatch.');
  const guard = async () => { base.heldSnapshot(original.config.maintenanceDirectory, maintenanceId); proveCurrent(current);
    base.checkArbiter(await jsonRequest('http://127.0.0.1:11435/v1/state', null, AbortSignal.timeout(3000))); };
  await guard();
  await base.verifyModels(original.config, (url, body) => jsonRequest(url, body, AbortSignal.timeout(10000)));
  const request = async (url, body, timeout) => {
    const abort = new AbortController(); const deadline = setTimeout(() => abort.abort(), timeout); let busy = false;
    const monitor = setInterval(async () => { if (busy) return; busy = true; try { await guard(); } catch { abort.abort(); } finally { busy = false; } }, 3000);
    try { return await jsonRequest(url, body, abort.signal); } finally { clearTimeout(deadline); clearInterval(monitor); }
  };
  return runOne(original, receipt, currentFile, { guard, request });
}
module.exports = { TIMEOUT_MS, loadOriginal, inspectLedger, attest, verifyReceipt, runOne };
if (require.main === module) (async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'attest') { const receipt = await attest(...args); console.log(JSON.stringify({ attested: receipt.cell, tornDownAt: receipt.tornDownAt, next: 'Start replacement isolated daemon, then run this receipt.' })); }
  else if (mode === 'run') { const result = await run(...args); console.log(JSON.stringify({ cell: result.cell, elapsedMs: result.elapsedMs, ...result.score, promptEvalCount: result.response.prompt_eval_count, evalCount: result.response.eval_count, doneReason: result.response.done_reason })); }
  else throw new Error('Use attest or run.');
})().catch(() => { console.error('Continuation stopped without retry. Preserve its ledger and tear down only the owned isolated process before releasing maintenance.'); process.exitCode = 1; });
