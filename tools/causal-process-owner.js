'use strict';
// Experiment-only Windows process ownership. Never imported by a runtime provider.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');
const canonical = value => path.win32.resolve(String(value)).toLowerCase();
const quote = value => String(value).replace(/'/g, "''");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = p => ({ pid: p.pid, parentPid: p.parentPid, exe: p.exe, createdAt: p.createdAt });
const validIdentity = p => p && Number.isInteger(p.pid) && p.pid > 0 && typeof p.exe === 'string' && path.win32.isAbsolute(p.exe) && Number.isFinite(Date.parse(p.createdAt));
const matches = (a, b) => a.pid === b.pid && a.createdAt === b.createdAt && canonical(a.exe) === canonical(b.exe);
function fault(code, processes = []) { const error = new Error(code); error.code = code; error.processes = processes.map(identity); return error; }
function powershell(script) {
  if (process.platform !== 'win32') return Promise.reject(fault('WINDOWS_REQUIRED'));
  const preamble = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';";
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(preamble + script, 'utf16le').toString('base64')],
  { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
    if (error) return reject(fault('PROCESS_QUERY_FAILED'));
    try { resolve(JSON.parse(stdout.trim())); } catch { reject(fault('PROCESS_QUERY_INVALID')); }
  }));
}
function snapshotScript(owner, known) {
  const ids = [...new Set([owner.pid, ...known.map(p => p.pid)])];
  return `$ids=@(${ids.join(',')});$all=@(Get-CimInstance Win32_Process);$models='${quote(canonical(owner.models))}';` +
    `$selected=@{};foreach($p in $all){if($ids -contains [int]$p.ProcessId){$selected[[int]$p.ProcessId]=$true}};` +
    `do{$changed=$false;foreach($p in $all){if(($ids -contains [int]$p.ParentProcessId -or $selected.ContainsKey([int]$p.ParentProcessId)) -and !$selected.ContainsKey([int]$p.ProcessId)){$selected[[int]$p.ProcessId]=$true;$changed=$true}}}while($changed);` +
    `$rows=@(foreach($p in $all){$cmd=([string]$p.CommandLine).Replace('/','\\').ToLowerInvariant();$reference=$cmd.Contains($models+'\\') -or $cmd.Contains($models+'"') -or $cmd.EndsWith($models);if($selected.ContainsKey([int]$p.ProcessId) -or $reference){@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;exe=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');modelReference=$reference}}});` +
    `$listeners=@(Get-NetTCPConnection -LocalPort ${new URL(owner.url).port} -State Listen -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess;address=$_.LocalAddress}});` +
    `@{sampledAt=[DateTime]::UtcNow.ToString('o');processes=$rows;listeners=$listeners}|ConvertTo-Json -Depth 5 -Compress`;
}
async function terminateExact(p) {
  if (!validIdentity(p)) throw fault('INVALID_TERMINATION_IDENTITY');
  return powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${p.pid}';if($p){` +
    `if($p.CreationDate.ToUniversalTime().ToString('o') -cne '${quote(p.createdAt)}' -or [IO.Path]::GetFullPath($p.ExecutablePath) -ine '${quote(path.win32.resolve(p.exe))}'){throw 'IDENTITY_CHANGED'};` +
    `Stop-Process -Id ${p.pid} -Force};@{checked=$true}|ConvertTo-Json -Compress`);
}
function createOwner(record, options = {}) {
  const owner = { ...record };
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.exe || !path.win32.isAbsolute(owner.exe) ||
      !Number.isFinite(Date.parse(owner.createdAt)) || !owner.models || !path.win32.isAbsolute(owner.models) ||
      owner.url !== 'http://127.0.0.1:11436') throw fault('INVALID_OWNER_RECORD');
  const ownerKey = crypto.createHash('sha256').update(JSON.stringify([owner.pid, owner.createdAt, canonical(owner.exe), canonical(owner.models)])).digest('hex');
  const known = new Map([[owner.pid, { ...identity(owner), lastSeenAt: null }]]);
  const snapshot = options.snapshot || (() => powershell(snapshotScript(owner, [...known.values()])));
  const terminate = options.terminate || terminateExact;
  const wait = options.sleep || sleep;
  const portFree = options.portFree || (() => new Promise(resolve => {
    const server = net.createServer(); server.once('error', () => resolve(false));
    server.listen(11436, '127.0.0.1', () => server.close(() => resolve(true)));
  }));
  const attempts = options.attempts || 3;
  const persist = options.persist || (event => {
    if (!options.evidenceFile) throw fault('PROCESS_EVIDENCE_FILE_REQUIRED');
    fs.appendFileSync(options.evidenceFile, JSON.stringify(event) + '\n', { mode: 0o600 });
  });
  const emit = event => persist({ version: 1, ownerKey, at: new Date().toISOString(), ...event });
  // Resume only our own separately recorded identities, never modify the call's
  // immutable ownership receipt. A partial final journal line is not trusted.
  if (options.evidenceFile && fs.existsSync(options.evidenceFile)) {
    const text = fs.readFileSync(options.evidenceFile, 'utf8');
    for (const line of text.split('\n').slice(0, -1)) {
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch { throw fault('INVALID_PROCESS_EVIDENCE'); }
      if (event.ownerKey !== ownerKey) throw fault('PROCESS_EVIDENCE_OWNER_MISMATCH');
      if (event.type === 'accepted') {
        if (!Array.isArray(event.known)) throw fault('INVALID_PROCESS_EVIDENCE');
        for (const p of event.known) {
          if (!validIdentity(p) || !Number.isFinite(Date.parse(p.lastSeenAt))) throw fault('INVALID_PROCESS_EVIDENCE');
          if (known.has(p.pid) && !matches(known.get(p.pid), p)) throw fault('PROCESS_EVIDENCE_IDENTITY_CHANGED');
          if (p.pid !== owner.pid && !known.has(p.parentPid)) throw fault('PROCESS_EVIDENCE_ANCESTRY_MISSING');
          known.set(p.pid, p);
        }
      }
    }
  }
  function classify(sample, { requireParent = true, requireListener = true } = {}) {
    if (!sample || !Array.isArray(sample.processes) || !Array.isArray(sample.listeners) || !Number.isFinite(Date.parse(sample.sampledAt))) throw fault('INVALID_PROCESS_SNAPSHOT');
    const rows = new Map();
    for (const p of sample.processes) {
      if (!Number.isInteger(p.pid) || !Number.isInteger(p.parentPid) || !p.exe || !path.win32.isAbsolute(p.exe) || !Number.isFinite(Date.parse(p.createdAt)) || rows.has(p.pid)) throw fault('INCOMPLETE_PROCESS_IDENTITY', [p]);
      rows.set(p.pid, p);
    }
    const root = rows.get(owner.pid), accepted = new Map();
    if (root && !matches(root, owner)) throw fault('ROOT_IDENTITY_CHANGED', [root]);
    if (root) accepted.set(root.pid, root);
    else if (requireParent) throw fault('ROOT_NOT_PRESENT');
    for (const p of rows.values()) {
      const prior = known.get(p.pid);
      if (prior && !matches(prior, p)) throw fault('DESCENDANT_IDENTITY_CHANGED', [p]);
      if (prior) accepted.set(p.pid, p);
    }
    // Resolve ancestry independent of CIM enumeration order. Exact ancestry,
    // not a process-name whitelist, safely includes GPU probes/console helpers.
    let changed;
    do {
      changed = false;
      for (const p of rows.values()) {
        if (accepted.has(p.pid)) continue;
        const parent = accepted.get(p.parentPid);
        // A previously observed child may outlive its parent. An UNSEEN orphan
        // cannot acquire ownership merely by quoting a historical/reused PPID.
        if (parent && Date.parse(p.createdAt) >= Date.parse(parent.createdAt)) { accepted.set(p.pid, p); changed = true; }
      }
    } while (changed);
    // Windows retains ParentProcessId after parent exit. An older process whose
    // PPID now names our younger daemon belongs to a prior PID incarnation.
    // It is not ours to terminate. A model-path reference still blocks release.
    const unrelated = new Map();
    do {
      changed = false;
      for (const p of rows.values()) {
        if (accepted.has(p.pid) || unrelated.has(p.pid) || p.modelReference) continue;
        const parent = accepted.get(p.parentPid) || known.get(p.parentPid);
        if (unrelated.has(p.parentPid) || (parent && Date.parse(p.createdAt) < Date.parse(parent.createdAt))) {
          unrelated.set(p.pid, p); changed = true;
        }
      }
    } while (changed);
    const unknown = [...rows.values()].filter(p => !accepted.has(p.pid) && !unrelated.has(p.pid));
    if (unknown.length) throw fault('UNPROVEN_ISOLATED_PROCESS', unknown);
    for (const listener of sample.listeners) {
      if (!root || listener.pid !== owner.pid || listener.address !== '127.0.0.1') throw fault('FOREIGN_ISOLATED_LISTENER');
    }
    if (requireListener && sample.listeners.length !== 1) throw fault('ISOLATED_LISTENER_MISSING');
    for (const p of accepted.values()) known.set(p.pid, { ...identity(p), lastSeenAt: sample.sampledAt });
    return { sampledAt: sample.sampledAt, live: [...accepted.values()].map(identity), ignoredPriorParentInstance: [...unrelated.values()].map(identity), listeners: sample.listeners, known: [...known.values()] };
  }
  async function observe(settings) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let sample;
      try {
        sample = await snapshot(owner, [...known.values()]);
        const result = classify(sample, settings);
        emit({ type: 'accepted', ...result });
        return result;
      } catch (error) {
        emit({ type: 'rejected', attempt, code: error.code || 'PROCESS_GUARD_FAILURE', processes: error.processes || [] });
        if (attempt === attempts) throw error;
        await wait(100);
      }
    }
  }
  async function proveGone() {
    for (let i = 0; i < 2; i++) {
      const result = await observe({ requireParent: false, requireListener: false });
      if (result.live.length || result.listeners.length) throw fault('ISOLATED_PROCESSES_REMAIN', result.live);
      if (i === 0) await wait(100);
    }
    if (!await portFree()) throw fault('ISOLATED_PORT_STILL_BOUND');
    const result = { version: 1, ownerKey, verifiedAt: new Date().toISOString(), parent: identity(owner), known: [...known.values()], gone: true };
    emit({ type: 'teardown-verified', ...result });
    return result;
  }
  async function cleanup() {
    await observe({ requireParent: false, requireListener: false });
    // Exact-identity checks occur again in the native termination operation.
    // Parent first prevents it spawning another runner while children drain.
    await terminate(owner);
    for (const p of [...known.values()].reverse()) if (p.pid !== owner.pid) await terminate(p);
    return proveGone();
  }
  return { observe, cleanup, proveGone, ownerKey };
}
module.exports = { createOwner, snapshotScript, terminateExact };
