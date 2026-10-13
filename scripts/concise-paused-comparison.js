'use strict';

// Explicit desktop experiment only. Never imported by the runner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const evaluation = require('./concise-branch-evaluation');

const BASE = 'http://127.0.0.1:8770';
const MAX_PAUSE_MS = 20 * 60 * 1000;
const DRAIN_MS = 5 * 60 * 1000;
const RESTORE_MS = 30000;
const RESTORE_RESERVE_MS = 60000;
const ARM_MARGIN_MS = 90000;
const REQUEST_MS = 1500;
const HEARTBEAT_MS = 2000;
const STALE_MS = 6000;
const RESTORE_GRACE_MS = 1700;
const POLL_MS = 200;
const STABLE_MS = 1000;
const CATEGORIES = ['text-post-483', 'root-471', 'deep-good-471', 'drift-462', 'copy-460'];
const PRODUCTION = 'C:/Users/jodyf/AppData/Local/DabbleLabs/FedditBots/data';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const failure = (code) => Object.assign(new Error(code), { code });
const requireState = (condition, code) => { if (!condition) throw failure(code); };
const safeCode = (error) => /^[A-Z_]{1,80}$/.test(error && error.code || '') ? error.code : 'PAUSE_UNAVAILABLE';

function atomic(file, value, exclusive = false) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (exclusive) {
    // Linking the complete file gives exclusive creation without a partial JSON read.
    try { fs.linkSync(temporary, file); }
    finally { fs.unlinkSync(temporary); }
  } else fs.renameSync(temporary, file);
}

function paths(directory) {
  return Object.fromEntries(['lease', 'heartbeat', 'watchdog', 'abort', 'restore', 'released', 'evidence']
    .map((name) => [name, path.join(directory, 'pause-' + name + '.json')]));
}

function owned(file, nonce) {
  if (!fs.existsSync(file)) return null;
  const value = read(file);
  requireState(value.nonce === nonce, 'PAUSE_OWNERSHIP_CHANGED');
  return value;
}

function createApi(fetchApi = globalThis.fetch) {
  async function request(endpoint, paused, timeoutMs = REQUEST_MS) {
    const response = await fetchApi(BASE + endpoint, {
      method: paused === undefined ? 'GET' : 'PUT', signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error', ...(paused === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused }),
      }),
    });
    requireState(response && response.ok === true, 'PAUSE_API_UNAVAILABLE');
    return response.json();
  }
  async function settings(paused, timeoutMs) {
    const data = await request('/api/settings', paused, timeoutMs);
    requireState(data && data.settings && typeof data.settings.paused === 'boolean', 'PAUSE_SETTINGS_UNKNOWN');
    return data.settings.paused;
  }
  return {
    identity: async (timeoutMs) => {
      const data = await request('/api/runtime', undefined, timeoutMs);
      requireState(data && data.placement === 'desktop' && data.ownerSessionRequired === false,
        'PAUSE_DESKTOP_REQUIRED');
    },
    paused: (timeoutMs) => settings(undefined, timeoutMs),
    setPaused: (value, timeoutMs) => settings(value, timeoutMs),
    state: async () => {
      const [paused, runtime, model] = await Promise.all([
        settings(), request('/api/runtime-state'), request('/api/local-model-activity'),
      ]);
      requireState(runtime && typeof runtime.busy === 'boolean' && model && Object.hasOwn(model, 'active') &&
        (model.active === null || (typeof model.active === 'object' && !Array.isArray(model.active))),
      'PAUSE_STATUS_UNKNOWN');
      return { paused, busy: runtime.busy || model.active !== null };
    },
  };
}

function freshDirectory(directory) {
  requireState(typeof directory === 'string' && path.isAbsolute(directory), 'PAUSE_ABSOLUTE_DIRECTORY_REQUIRED');
  const resolved = fs.realpathSync(directory);
  requireState(fs.statSync(resolved).isDirectory(), 'PAUSE_DIRECTORY_REQUIRED');
  const names = fs.readdirSync(resolved);
  requireState(!names.some((name) => name === 'results.json' || name === 'run.lock' || name === 'telemetry' ||
    name.startsWith('pause-')), 'PAUSE_FRESH_DIRECTORY_REQUIRED');
  const frozen = evaluation.readCases(resolved);
  const data = read(path.join(resolved, 'cases.json'));
  requireState(typeof data.protocolId === 'string' && data.protocolId.length > 0 &&
    ((typeof data.preparedAt === 'number' && Number.isFinite(data.preparedAt) && data.preparedAt > 0) ||
      (typeof data.preparedAt === 'string' && Number.isFinite(Date.parse(data.preparedAt)))) &&
    data.maxCalls === evaluation.MAX_CALLS && data.model === evaluation.MODEL &&
    frozen.cases.every((item, index) => item.id === CATEGORIES[index] &&
      item.kind === (index === 0 ? 'post' : 'comment')), 'PAUSE_CASE_METADATA_INVALID');
  return { directory: resolved, frozen, protocolId: data.protocolId };
}

function stateSnapshot(directory = PRODUCTION) {
  return Object.fromEntries(['profiles.json', 'secrets.json', 'population.json', 'turns.json',
    'jobs.json', 'culture-import-workspaces.json'].map((name) => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return [name, null];
    let value = fs.readFileSync(file);
    if (name === 'profiles.json') {
      const profiles = JSON.parse(value.toString('utf8'));
      requireState(profiles && profiles.settings && typeof profiles.settings.paused === 'boolean',
        'PAUSE_SNAPSHOT_UNKNOWN');
      delete profiles.settings.paused;
      value = JSON.stringify(profiles);
    }
    return [name, evaluation.sha(value)];
  }));
}

function validFingerprint(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.createdTicks === 'string' && /^[0-9]{12,24}$/.test(value.createdTicks) &&
    typeof value.commandHash === 'string' && /^[a-f0-9]{64}$/.test(value.commandHash);
}

async function processIdentity(pid, expected = null) {
  requireState(process.platform === 'win32' && Number.isSafeInteger(pid) && pid > 0 &&
    (!expected || (validFingerprint(expected) && expected.pid === pid)), 'PAUSE_OWNER_IDENTITY_UNVERIFIED');
  // Only the experiment controller's recorded PID is eligible. Hold its OS
  // handle while comparing creation time and command hash to prevent PID reuse.
  const script = "$ErrorActionPreference='Stop'; " +
    "$p=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; " +
    "if ($null -eq $p) { Write-Output '{\"state\":\"dead\"}'; exit 0 }; " +
    "$handle=$p.Handle; $ticks=$p.StartTime.ToUniversalTime().Ticks.ToString(); " +
    "$c=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "'; " +
    "if ($null -eq $c -or [string]::IsNullOrEmpty($c.CommandLine)) { throw 'identity unavailable' }; " +
    "$sha=[System.Security.Cryptography.SHA256]::Create(); " +
    "try { $hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($c.CommandLine)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }; " +
    (expected ? "if ($ticks -ne '" + expected.createdTicks + "' -or $hash -ne '" + expected.commandHash +
      "') { Write-Output '{\"state\":\"mismatch\"}'; exit 0 }; " +
      "$p.Kill(); if (!$p.WaitForExit(1500)) { throw 'controller still alive' }; " +
      "Write-Output '{\"state\":\"dead\"}';" :
      "@{pid=" + pid + ";createdTicks=$ticks;commandHash=$hash} | ConvertTo-Json -Compress;");
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000, maxBuffer: 8192 }, (error, stdout) => {
        if (error) return reject(failure('PAUSE_OWNER_IDENTITY_UNVERIFIED'));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(failure('PAUSE_OWNER_IDENTITY_UNVERIFIED')); }
      });
  });
}

async function captureOwner() {
  const value = await processIdentity(process.pid);
  requireState(validFingerprint(value) && value.pid === process.pid, 'PAUSE_OWNER_IDENTITY_UNVERIFIED');
  return value;
}

async function stopOwnedController(lease, { inspect = (pid) => processIdentity(pid),
  terminate = (expected) => processIdentity(expected.pid, expected) } = {}) {
  requireState(validFingerprint(lease.owner) && lease.owner.pid === lease.pid, 'PAUSE_OWNER_IDENTITY_UNVERIFIED');
  const actual = await inspect(lease.pid);
  if (actual && actual.state === 'dead') return;
  requireState(validFingerprint(actual) && actual.pid === lease.owner.pid &&
    actual.createdTicks === lease.owner.createdTicks && actual.commandHash === lease.owner.commandHash,
  'PAUSE_OWNER_IDENTITY_UNVERIFIED');
  const result = await terminate(lease.owner);
  requireState(result && result.state === 'dead', 'PAUSE_OWNER_IDENTITY_UNVERIFIED');
}

function validateLease(file, nonce) {
  requireState(path.isAbsolute(file) && path.basename(file) === 'pause-lease.json', 'PAUSE_INVALID_LEASE');
  const lease = owned(file, nonce);
  requireState(lease && lease.version === 1 && /^[a-f0-9-]{36}$/.test(nonce) &&
    Number.isSafeInteger(lease.pid) && lease.pid > 0 && Number.isFinite(lease.startedAt) &&
    validFingerprint(lease.owner) && lease.owner.pid === lease.pid &&
    Number.isFinite(lease.deadlineAt) && lease.deadlineAt === lease.startedAt + MAX_PAUSE_MS &&
    lease.inferenceDeadlineAt === lease.deadlineAt - RESTORE_RESERVE_MS &&
    typeof lease.originalPaused === 'boolean' && lease.restorePaused === false &&
    (!lease.originalPaused || lease.resumeOnExit === true), 'PAUSE_INVALID_LEASE');
  return lease;
}

function markAbort(files, nonce, code, now) {
  if (owned(files.released, nonce) || owned(files.abort, nonce)) return;
  try { atomic(files.abort, { nonce, code, at: now() }, true); }
  catch (error) { if (error.code !== 'EEXIST') throw error; owned(files.abort, nonce); }
}

function parentAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function restoreOwner(files, lease, actor, now, alive) {
  if (owned(files.released, lease.nonce)) return false;
  const current = owned(files.restore, lease.nonce);
  if (!current) {
    try {
      atomic(files.restore, { nonce: lease.nonce, actor, at: now() }, true);
      return true;
    } catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
  }
  if (current.actor === actor) return true;
  const heartbeat = owned(files.heartbeat, lease.nonce);
  if (actor === 'watchdog' && current.actor === 'main' &&
    (!alive(lease.pid) || !heartbeat || now() - heartbeat.at > STALE_MS) &&
    now() - current.at > REQUEST_MS + RESTORE_GRACE_MS) {
    atomic(files.restore, { nonce: lease.nonce, actor, at: now() });
    return true;
  }
  return false;
}

async function restore({ files, lease, actor, api, now = Date.now, wait = sleep, alive = parentAlive }) {
  const end = Math.min(now() + RESTORE_MS, lease.deadlineAt);
  const remaining = () => {
    requireState(end > now(), 'PAUSE_RESTORE_FAILED');
    return Math.max(1, Math.min(REQUEST_MS, Math.floor(end - now())));
  };
  let attempts = 0;
  while (now() + 3 * REQUEST_MS + POLL_MS <= end) {
    const released = owned(files.released, lease.nonce);
    if (released) return released;
    if (!restoreOwner(files, lease, actor, now, alive)) { await wait(POLL_MS); continue; }
    try {
      validateLease(files.lease, lease.nonce);
      await api.identity(remaining());
      if (owned(files.released, lease.nonce)) return owned(files.released, lease.nonce);
      if (owned(files.restore, lease.nonce).actor !== actor) continue;
      attempts++;
      await api.setPaused(false, remaining());
      requireState(await api.paused(remaining()) === false, 'PAUSE_RESUME_NOT_VERIFIED');
      const result = { nonce: lease.nonce, actor, resumedAt: now(), attempts, paused: false };
      try { atomic(files.released, result, true); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      return owned(files.released, lease.nonce);
    } catch {
      await wait(Math.min(1000, Math.max(0, end - now())));
    }
  }
  throw failure('PAUSE_RESTORE_FAILED');
}

function createPausedStatus({ files, lease, api, now = Date.now, alive = parentAlive }) {
  function checkOwner() {
    validateLease(files.lease, lease.nonce);
    requireState(!owned(files.released, lease.nonce) && !owned(files.abort, lease.nonce), 'PAUSE_ABORTED');
    const watcher = owned(files.watchdog, lease.nonce);
    requireState(watcher && watcher.status === 'armed' && Number.isSafeInteger(watcher.pid) &&
      watcher.pid > 0 && alive(watcher.pid), 'PAUSE_WATCHDOG_UNAVAILABLE');
    requireState(now() < lease.inferenceDeadlineAt, 'PAUSE_DEADLINE');
  }
  return async () => {
    checkOwner();
    const state = await api.state();
    requireState(state.paused === true, 'PAUSE_RESUMED_EXTERNALLY');
    checkOwner();
    // Ordinary due times cannot admit work during this explicitly authorized
    // pause. This guard owns the separate experiment deadline instead.
    return { busy: state.busy, nextAt: Infinity };
  };
}

async function drain({ status, now = Date.now, wait = sleep }) {
  const end = now() + DRAIN_MS;
  let idleSince = null;
  while (now() < end) {
    const state = await status();
    if (state.busy) idleSince = null;
    else if (idleSince === null) idleSince = now();
    else if (now() - idleSince >= STABLE_MS) return;
    await wait(POLL_MS);
  }
  throw failure('PAUSE_DRAIN_TIMEOUT');
}

async function watchdog({ file, nonce, api = createApi(), now = Date.now, wait = sleep, alive = parentAlive,
  stopOwner = stopOwnedController }) {
  const lease = validateLease(file, nonce);
  const files = paths(path.dirname(file));
  await api.identity();
  atomic(files.watchdog, { nonce, status: 'armed', pid: process.pid, at: now() });
  while (!owned(files.released, nonce)) {
    const heartbeat = owned(files.heartbeat, nonce);
    const reason = !alive(lease.pid) ? 'PAUSE_PARENT_EXITED' : !heartbeat || now() - heartbeat.at > STALE_MS
      ? 'PAUSE_HEARTBEAT_STALE' : now() >= lease.inferenceDeadlineAt ? 'PAUSE_DEADLINE' : '';
    if (reason) markAbort(files, nonce, reason, now);
    const abort = owned(files.abort, nonce);
    if (abort) {
      await wait(Math.max(0, abort.at + RESTORE_GRACE_MS - now()));
      try {
        const latestHeartbeat = owned(files.heartbeat, nonce);
        if (!owned(files.released, nonce) && (!alive(lease.pid) ||
          !latestHeartbeat || now() - latestHeartbeat.at > STALE_MS || now() >= lease.inferenceDeadlineAt)) {
          await stopOwner(lease);
        }
        await restore({ files, lease, actor: 'watchdog', api, now, wait, alive });
      } catch (error) {
        atomic(files.watchdog, { nonce, status: 'restore-failed', code: safeCode(error), at: now() });
        throw error;
      }
      break;
    }
    await wait(POLL_MS);
  }
  atomic(files.watchdog, { nonce, status: 'released', at: now() });
}

async function armWatchdog({ files, lease, now = Date.now, wait = sleep }) {
  const child = spawn(process.execPath, [__filename, 'watchdog', '--lease', files.lease, '--nonce', lease.nonce], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  let failed = false;
  let finish;
  const exit = new Promise((resolve) => { finish = resolve; });
  child.on('error', () => { failed = true; });
  child.on('exit', (code) => { failed = true; finish(code); });
  child.unref();
  const end = now() + 5000;
  while (now() < end) {
    requireState(!failed, 'PAUSE_WATCHDOG_UNAVAILABLE');
    const state = owned(files.watchdog, lease.nonce);
    if (state && state.status === 'armed' && state.pid === child.pid) return {
      waitForExit: async () => {
        let timer;
        try {
          const code = await Promise.race([exit, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(failure('PAUSE_WATCHDOG_EXIT_UNVERIFIED')), 5000);
          })]);
          requireState(code === 0, 'PAUSE_WATCHDOG_FAILED');
        } finally { clearTimeout(timer); }
      },
    };
    await wait(POLL_MS);
  }
  throw failure('PAUSE_WATCHDOG_UNAVAILABLE');
}

async function run({ directory, resumeOnExit = false, api = createApi(), now = Date.now, wait = sleep,
  arm = armWatchdog, runOne = evaluation.runOne, loadProvider = evaluation.isolatedProvider,
  snapshot = stateSnapshot, alive = parentAlive, capture = captureOwner,
  log = (value) => console.log(JSON.stringify(value)) } = {}) {
  const fresh = freshDirectory(directory);
  directory = fresh.directory;
  const files = paths(directory);
  await api.identity();
  const originalPaused = await api.paused();
  requireState(!originalPaused || resumeOnExit === true, 'PAUSE_EXISTING_PAUSE_REQUIRES_RESUME_ON_EXIT');
  const startedAt = now();
  const lease = { version: 1, nonce: crypto.randomUUID(), pid: process.pid, startedAt,
    deadlineAt: startedAt + MAX_PAUSE_MS, inferenceDeadlineAt: startedAt + MAX_PAUSE_MS - RESTORE_RESERVE_MS,
    originalPaused, resumeOnExit, restorePaused: false, protocolId: fresh.protocolId,
    casesHash: fresh.frozen.casesHash, owner: await capture() };
  atomic(files.lease, lease, true);
  const pulse = () => atomic(files.heartbeat, { nonce: lease.nonce, at: now() });
  pulse();
  let heartbeatError = false;
  const timer = setInterval(() => { try { pulse(); } catch { heartbeatError = true; } }, HEARTBEAT_MS);
  let interrupted = false;
  const interrupt = () => { interrupted = true; markAbort(files, lease.nonce, 'PAUSE_INTERRUPTED', now); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let pausedAt = null;
  let attempts = 0;
  let result;
  let error;
  let armed = false;
  let provider;
  let watchdogHandle;
  let before = null;
  let after = null;
  const status = createPausedStatus({ files, lease, api, now, alive });
  try {
    watchdogHandle = await arm({ files, lease, now, wait });
    armed = true;
    requireState(!interrupted && !heartbeatError && !owned(files.abort, lease.nonce), 'PAUSE_ABORTED');
    // Record intent first: a lost PUT response must still restore scheduling.
    pausedAt = now();
    atomic(files.evidence, { nonce: lease.nonce, status: 'pausing', originalPaused, pausedAt, attempts });
    if (!originalPaused) requireState(await api.setPaused(true) === true, 'PAUSE_NOT_VERIFIED');
    requireState(await api.paused() === true, 'PAUSE_NOT_VERIFIED');
    await drain({ status, now, wait });
    before = snapshot();
    atomic(files.evidence, { nonce: lease.nonce, status: 'drained', originalPaused, pausedAt,
      drainedAt: now(), attempts, before });
    for (let index = 0; index < evaluation.MAX_CALLS; index++) {
      pulse();
      requireState(!heartbeatError && !interrupted, 'PAUSE_ABORTED');
      requireState(evaluation.readCases(directory).casesHash === fresh.frozen.casesHash, 'EVAL_CASE_HASH_MISMATCH');
      const state = await status();
      requireState(!state.busy, 'PAUSE_NORMAL_WORK_BUSY');
      requireState(lease.inferenceDeadlineAt > now() + ARM_MARGIN_MS, 'PAUSE_ENTRY_MARGIN');
      const next = await runOne({ directory, status, now, log: () => {},
        loadProvider: () => provider || (provider = loadProvider(directory)) });
      attempts = fs.existsSync(path.join(directory, 'results.json'))
        ? read(path.join(directory, 'results.json')).calls.length : attempts;
      requireState(next.status === 'completed-one', 'PAUSE_EVALUATION_DEFERRED');
      const completed = next.calls.at(-1);
      log({ status: 'completed-one', attempts, caseId: completed.caseId, arm: completed.arm,
        words: completed.words, ms: completed.ms });
    }
    result = { status: 'completed', attempts };
  } catch (caught) {
    error = caught;
  } finally {
    try {
      if (before !== null) {
        try {
          after = snapshot();
          requireState(JSON.stringify(after) === JSON.stringify(before), 'PAUSE_STATE_CHANGED');
        } catch (snapshotError) { error = snapshotError; }
      }
      if (armed || pausedAt !== null || (originalPaused && resumeOnExit)) {
        markAbort(files, lease.nonce, error ? safeCode(error) : 'PAUSE_FINISHED', now);
        const resumed = await restore({ files, lease, actor: 'main', api, now, wait });
        if (watchdogHandle) await watchdogHandle.waitForExit();
        attempts = fs.existsSync(path.join(directory, 'results.json'))
          ? read(path.join(directory, 'results.json')).calls.length : attempts;
        const evidence = { nonce: lease.nonce, status: error ? 'stopped' : 'completed',
          ...(error ? { code: safeCode(error) } : {}), originalPaused, pausedAt,
          resumedAt: resumed.resumedAt, attempts, restoreAttempts: resumed.attempts, paused: false };
        if (before !== null) Object.assign(evidence, { before, after,
          statePreserved: JSON.stringify(before) === JSON.stringify(after) });
        atomic(files.evidence, evidence);
        log(evidence);
      } else {
        atomic(files.released, { nonce: lease.nonce, actor: 'main', untouched: true, at: now() }, true);
      }
    } catch (restoreError) {
      atomic(files.evidence, { nonce: lease.nonce, status: 'restore-failed', code: safeCode(restoreError),
        originalPaused, pausedAt, attempts, at: now() });
      error = restoreError;
    } finally {
      clearInterval(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
  if (error) throw error;
  return result;
}

function parseArgs(args) {
  if (args[0] === 'run' && (args.length === 3 || args.length === 4) && args[1] === '--directory' &&
    path.isAbsolute(args[2]) && (args.length === 3 || args[3] === '--resume-on-exit')) {
    return { command: 'run', directory: args[2], resumeOnExit: args.length === 4 };
  }
  if (args.length === 5 && args[0] === 'watchdog' && args[1] === '--lease' &&
    path.isAbsolute(args[2]) && args[3] === '--nonce') {
    return { command: 'watchdog', file: args[2], nonce: args[4] };
  }
  throw failure('PAUSE_EXPLICIT_COMMAND_REQUIRED');
}

module.exports = { BASE, MAX_PAUSE_MS, DRAIN_MS, RESTORE_MS, RESTORE_RESERVE_MS, ARM_MARGIN_MS,
  REQUEST_MS, HEARTBEAT_MS, STALE_MS,
  RESTORE_GRACE_MS, POLL_MS, STABLE_MS, CATEGORIES, atomic, paths, owned, createApi, freshDirectory,
  stateSnapshot, validFingerprint, processIdentity, captureOwner, stopOwnedController, validateLease,
  markAbort, restore, createPausedStatus, drain, watchdog, armWatchdog, run, parseArgs };

if (require.main === module) {
  Promise.resolve().then(() => {
    const options = parseArgs(process.argv.slice(2));
    return options.command === 'run' ? run(options) : watchdog(options);
  }).catch((error) => {
    console.error(JSON.stringify({ status: 'blocked', code: safeCode(error) }));
    process.exitCode = 1;
  });
}
