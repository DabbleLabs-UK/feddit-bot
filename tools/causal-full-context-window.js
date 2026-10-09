'use strict';
// Explicitly invoked experiment coordinator. Never used by a production worker.
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const base = require('./causal-maintenance-run');
const full = require('./causal-full-context');
const { createOwner } = require('./causal-process-owner');
const WINDOW_MS = 40 * 60 * 1000;
const DRAIN_MS = 8 * 60 * 1000;
const check = (v, message) => { if (!v) throw Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => String(value).replace(/'/g, "''");
function ps(script) {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64')],
  { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim());
}
async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function portFree() {
  return new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false));
    server.listen(11436, '127.0.0.1', () => server.close(() => resolve(true))); });
}

// Testable ordering: no unload/spawn/call before held; no resume before cleanup.
async function coordinate(ops) {
  await ops.preflight();
  let requested = false;
  try {
    await ops.requestHold(); requested = true;
    await ops.drain();
    await ops.guard(); await ops.unloadProduction();
    await ops.startIsolated();
    await ops.verify();
    for (const cell of ['B', 'D']) {
      await ops.guard();
      await ops.ensureTime();
      await ops.runCell(cell);
    }
  } finally {
    if (requested || await ops.ownsHold()) {
      // Failure to establish cleanup deliberately retains the hold.
      await ops.cleanup();
      await ops.releaseHold();
    }
  }
}

async function main(inputFile) {
  check(process.platform === 'win32', 'Run the live coordinator on DELL Windows only.');
  const input = read(inputFile), setup = read(input.setupFile), original = read(input.originalConfig);
  check(input.version === 1 && /^[A-Za-z0-9_.-]{1,128}$/.test(input.maintenanceId || ''), 'Invalid experiment identity.');
  check(path.isAbsolute(input.outputDirectory) && path.isAbsolute(input.originalConfig), 'Absolute evidence paths required.');
  const out = input.outputDirectory, requestFile = path.join(setup.maintenanceDirectory, 'request.json');
  const models = path.dirname(path.dirname(original.weightFile));
  const started = Date.now(), deadline = started + WINDOW_MS;
  let daemon = null, owner = null, ownedFile = null, guardMonitor = null, monitorBusy = false;
  const abort = new AbortController();
  const cancel = () => abort.abort(full.classified('operator-cancelled'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const notCancelled = () => { if (abort.signal.aborted) throw abort.signal.reason; };
  const log = message => process.stdout.write(new Date().toISOString() + ' ' + message + '\n');
  const save = (name, value) => fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx' });
  const timeLeft = () => { const left = deadline - Date.now(); check(left > 0, 'Experiment window deadline reached.'); return left; };
  const json = (url, body, limit = 15000) => full.nativeJsonRequest(url, body, Math.min(limit, timeLeft()), abort.signal);
  const held = async () => {
    base.heldSnapshot(setup.maintenanceDirectory, input.maintenanceId);
    base.checkArbiter(await json('http://127.0.0.1:11435/v1/state', null, 5000));
  };
  const guard = async () => {
    timeLeft(); if (abort.signal.aborted) throw abort.signal.reason || Error('Experiment cancelled.');
    await held();
    if (owner) await owner.observe({ requireParent: true, requireListener: true });
  };
  const overallTimer = setTimeout(() => abort.abort(full.classified('maintenance-window-expired')), WINDOW_MS);
  // Production is used only for read-only residency and non-generating unload.
  // Never broaden the inference transport's isolated-port allowlist.
  const production = (body) => new Promise((resolve, reject) => {
    check(body == null || (Object.keys(body).sort().join(',') === 'keep_alive,model' && body.keep_alive === 0), 'Only production unload is allowed.');
    const bytes = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request('http://127.0.0.1:11434/api/' + (bytes ? 'generate' : 'ps'), {
      method: bytes ? 'POST' : 'GET', agent: false,
      headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {},
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; if (text.length > 1048576) req.destroy(Error('Residency response too large.')); });
      response.on('error', reject);
      response.on('end', () => { try { check(response.statusCode === 200, 'Production residency operation failed.'); const value = JSON.parse(text); check(!value.error, 'Production residency error.'); resolve(value); } catch (error) { reject(error); } });
    });
    const timer = setTimeout(() => req.destroy(Error('Production residency deadline.')), 15000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(bytes);
  });
  try {
    await coordinate({
      preflight: async () => {
        check(!fs.existsSync(requestFile), 'A maintenance request already exists.');
        check(await portFree(), 'Isolated port is already occupied.');
        const orphanCount = ps(`$root='${quote(path.win32.resolve(models).toLowerCase())}';@((Get-CimInstance Win32_Process)|Where-Object {(([string]$_.CommandLine).Replace('/','\\').ToLowerInvariant()).Contains($root)}).Count|ConvertTo-Json`);
        check(orphanCount === 0, 'Existing isolated-model process must be reconciled before another window.');
        check(await fileHash(setup.ollamaExe) === setup.ollamaExeSha256, 'Installed Ollama executable changed.');
        check(setup.environmentVerified === true, 'Production environment provenance missing.');
        await full.prepare(input.originalConfig, out);
        if (input.previousWindowDirectory) {
          const previous = input.previousWindowDirectory;
          check(path.isAbsolute(previous) && path.resolve(previous) !== path.resolve(out), 'Separate prior-window evidence required.');
          check(read(path.join(previous, 'manual-cleanup-verified.json')).gone === true, 'Prior owned processes were not proven stopped.');
          check(read(path.join(previous, 'B-failed-no-retry.json')).errorClass === 'maintenance-guard-lost', 'Prior interruption was not an ownership guard failure.');
          check(!fs.existsSync(path.join(previous, 'B-completed.json')) && !fs.existsSync(path.join(previous, 'D-started.json')), 'Prior window already produced a result or attempted D.');
          const pins = {};
          for (const name of ['followup-reserved.json', 'B-started.json', 'B-failed-no-retry.json', 'guard-failure.json', 'manual-cleanup-verified.json', 'restored.json']) {
            const file = path.join(previous, name); pins[file] = await fileHash(file);
          }
          save('preceding-window', { directory: previous, files: pins, reason: 'Manual continuation after diagnosed PID reuse; no automatic retry.' });
        }
        save('window-started', { at: new Date(started).toISOString(), deadline: new Date(deadline).toISOString(), maintenanceId: input.maintenanceId });
      },
      requestHold: async () => {
        const temporary = path.join(setup.maintenanceDirectory, input.maintenanceId + '.prepared');
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, id: input.maintenanceId }), { flag: 'wx' });
        // Hard-link creation is atomic and refuses to replace another request.
        fs.linkSync(temporary, requestFile); fs.unlinkSync(temporary);
        log('Maintenance requested; admitted natural work drains normally.');
        save('hold-requested', { at: new Date().toISOString() });
      },
      ownsHold: async () => fs.existsSync(requestFile) && read(requestFile).id === input.maintenanceId,
      drain: async () => {
        const until = Date.now() + DRAIN_MS;
        while (Date.now() < until) {
          notCancelled(); timeLeft(); check(read(requestFile).id === input.maintenanceId, 'Maintenance request identity changed.');
          try { await held(); save('quiescent', { at: new Date().toISOString() }); log('Both clients held; shared inference idle.'); return; }
          catch { notCancelled(); await delay(2000); }
        }
        throw Error('Safe drain did not finish within its bound.');
      },
      guard,
      unloadProduction: async () => {
        const residency = await production(); save('production-residency', residency);
        const allowed = new Set(['hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M', 'gemma3:12b-it-q4_K_M']);
        check((residency.models || []).every(model => allowed.has(model.name)), 'Unexpected production resident model.');
        for (const model of residency.models || []) { await held(); await production({ model: model.name, keep_alive: 0 }); }
        check((await production()).models.length === 0, 'Production model did not unload.');
        const free = ps('[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory*1024/1GB,3)');
        check(free >= 8, 'Insufficient physical RAM for isolated load.'); save('memory-before-load', { freeGiB: free });
      },
      startIsolated: async () => {
        await held(); check(await portFree(), 'Isolated port became occupied.');
        const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('OLLAMA_')) delete env[key];
        Object.assign(env, setup.ollamaEnvironment, { OLLAMA_HOST: '127.0.0.1:11436', OLLAMA_MODELS: models });
        const stdout = fs.openSync(path.join(out, 'ollama.stdout.log'), 'wx'), stderr = fs.openSync(path.join(out, 'ollama.stderr.log'), 'wx');
        daemon = spawn(setup.ollamaExe, ['serve'], { env, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] });
        daemon.on('error', error => abort.abort(error)); fs.closeSync(stdout); fs.closeSync(stderr);
        check(Number.isInteger(daemon.pid), 'Isolated process did not start.');
        const identity = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${daemon.pid}';if(!$p){throw 'Owned process absent'};@{pid=$p.ProcessId;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');exe=$p.ExecutablePath}|ConvertTo-Json -Compress`);
        check(path.win32.resolve(identity.exe).toLowerCase() === path.win32.resolve(setup.ollamaExe).toLowerCase(), 'Spawned executable differs.');
        const record = { ...identity, exeSha256: setup.ollamaExeSha256, url: original.url, models, maintenanceId: input.maintenanceId };
        ownedFile = path.join(out, 'owned-process.json'); fs.writeFileSync(ownedFile, JSON.stringify(record, null, 2), { flag: 'wx' });
        owner = createOwner(record, { evidenceFile: path.join(out, 'process-evidence.jsonl') });
        const until = Date.now() + 90000;
        while (Date.now() < until) {
          notCancelled(); timeLeft(); await held(); await owner.observe({ requireParent: true, requireListener: false });
          try { check((await json(original.url + '/api/version', null, 2000)).version === '0.34.1', 'Ollama version changed.'); return; }
          catch { notCancelled(); await delay(500); }
        }
        throw Error('Isolated daemon did not become ready.');
      },
      verify: async () => {
        await guard(); await base.verifyModels(original, (url, body) => json(url, body));
        full.loadPrepared(out);
        // Observe ownership and quiescence throughout both requests without a
        // duplicate tracker or a high-frequency synchronous process scan.
        guardMonitor = setInterval(async () => {
          if (monitorBusy || abort.signal.aborted) return; monitorBusy = true;
          try { await guard(); } catch (error) { try { save('guard-failure', { code: error.code || 'guard-failed', at: new Date().toISOString() }); } catch { /* Cleanup must survive diagnostic disk failure. */ } abort.abort(full.classified('maintenance-guard-lost')); }
          finally { monitorBusy = false; }
        }, 10000);
      },
      ensureTime: async () => check(timeLeft() > full.TIMEOUT_MS + 60000, 'Insufficient window remaining for a bounded full-context call.'),
      runCell: async cell => {
        log('Starting full-context cell ' + cell + '; 15-minute experiment-only bound, no retry.');
        const result = await full.runCell(out, cell, { guard, request: full.nativeJsonRequest, currentOwnedRecordFile: ownedFile, signal: abort.signal });
        log(JSON.stringify({ cell, elapsedMs: result.elapsedMs, score: result.score, promptEvalCount: result.response.prompt_eval_count, evalCount: result.response.eval_count }));
      },
      cleanup: async () => {
        clearInterval(guardMonitor); guardMonitor = null;
        while (monitorBusy) await delay(100);
        if (owner) { await owner.cleanup(); await owner.proveGone(); }
        else if (daemon) {
          // No model API was reachable from this controller before identity
          // capture. Retained child-process handle avoids a recycled PID kill.
          daemon.kill(); await delay(1000);
          throw Error('Process identity capture incomplete; keep hold for explicit cleanup verification.');
        }
        check(await portFree(), 'Isolated port remains active; keep hold.');
        save('isolated-stopped', { at: new Date().toISOString() });
      },
      releaseHold: async () => {
        check(read(requestFile).id === input.maintenanceId, 'Hold identity changed; do not remove.');
        fs.unlinkSync(requestFile); save('restored', { at: new Date().toISOString(), maintenanceId: input.maintenanceId });
        log('Isolated work stopped; Cy/Feddit natural admission restored.');
      },
    });
  } finally { clearTimeout(overallTimer); if (guardMonitor) clearInterval(guardMonitor); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
module.exports = { coordinate, WINDOW_MS, DRAIN_MS };
if (require.main === module) main(process.argv[2]).catch(error => {
  // Rejected process metadata lives in the private evidence file, never a prompt.
  process.stderr.write('Full-context window stopped: ' + String(error.code || error.name || 'Error') + '\n');
  process.exitCode = 1;
});
