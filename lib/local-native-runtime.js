'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

// This optional boundary supports the installed Windows Ollama native runner.
// It never starts, stops or generates with a model. Unknown status is not idle.
const INSPECT = String.raw`
$ErrorActionPreference = 'Stop'
$rows = @(& netstat.exe -ano -p tcp | ForEach-Object {
  $parts = $_.Trim() -split '\s+'
  if ($parts.Count -eq 5 -and $parts[0] -eq 'TCP') { @{ address = $parts[1]; state = $parts[3]; pid = [int]$parts[4] } }
})
$listeners = @($rows | Where-Object { $_.state -eq 'LISTENING' -and $_.address -match ':11434$' })
if ($listeners.Count -ne 1 -or $listeners[0].address -ne '127.0.0.1:11434') { throw 'listener' }
$processes = @(Get-CimInstance Win32_Process -Filter "Name='ollama.exe' OR Name='llama-server.exe'")
$service = $processes | Where-Object ProcessId -eq $listeners[0].pid
if (-not $service -or $service.Name -ne 'ollama.exe') { throw 'service' }
$children = @($processes | Where-Object { $_.ParentProcessId -eq $service.ProcessId -and $_.Name -eq 'llama-server.exe' })
if ($children.Count -gt 1) { throw 'children' }
$native = $null
if ($children.Count -eq 1) {
  $child = $children[0]
  $hostMatch = [regex]::Match($child.CommandLine, '(?:^|\s)--host\s+([^\s]+)')
  $portMatch = [regex]::Match($child.CommandLine, '(?:^|\s)--port\s+(\d+)')
  if (-not $hostMatch.Success -or $hostMatch.Groups[1].Value -ne '127.0.0.1' -or -not $portMatch.Success) { throw 'endpoint' }
  $port = [int]$portMatch.Groups[1].Value
  $bound = @($rows | Where-Object { $_.state -eq 'LISTENING' -and $_.address -match (':' + $port + '$') })
  if ($bound.Count -ne 1 -or $bound[0].address -ne ('127.0.0.1:' + $port) -or $bound[0].pid -ne $child.ProcessId) { throw 'native-listener' }
  $native = @{ pid = [int]$child.ProcessId; birth = $child.CreationDate.ToUniversalTime().ToString('o'); executable = $child.ExecutablePath; port = $port }
}
$connections = @($rows | Where-Object { $_.state -eq 'ESTABLISHED' -and $_.address -eq '127.0.0.1:11434' })
@{ service = @{ pid = [int]$service.ProcessId; birth = $service.CreationDate.ToUniversalTime().ToString('o'); executable = $service.ExecutablePath }; native = $native; connections = $connections.Count } | ConvertTo-Json -Compress -Depth 4
`;

function inspectWindows() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(INSPECT, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000, maxBuffer: 8192 }, (error, stdout) => {
        if (error) { reject(failure(error.killed ? 'OLLAMA_NATIVE_PROCESS_QUERY_TIMEOUT' : 'OLLAMA_NATIVE_PROCESS_QUERY')); return; }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); }
        catch { reject(new Error('Native process identity is unavailable.')); }
      });
  });
}

function failure(code) {
  const error = new Error('The local native model cannot be verified (' + code + '). No inference was sent.');
  error.code = code;
  return error;
}

function validateIdentity(value) {
  const service = value?.service;
  if (!Number.isSafeInteger(service?.pid) || service.pid <= 0 || !service.birth || !service.executable) throw failure('OLLAMA_NATIVE_IDENTITY');
  if (path.win32.basename(service.executable).toLowerCase() !== 'ollama.exe') throw failure('OLLAMA_NATIVE_IDENTITY');
  if (!Number.isSafeInteger(value.connections) || value.connections < 0) throw failure('OLLAMA_NATIVE_IDENTITY');
  const native = value.native;
  if (native !== null && (!Number.isSafeInteger(native?.pid) || native.pid <= 0 || !native.birth ||
      !Number.isSafeInteger(native.port) || native.port < 1 || native.port > 65535 ||
      String(native.executable).toLowerCase() !== path.win32.join(path.win32.dirname(service.executable), 'lib', 'ollama', 'llama-server.exe').toLowerCase())) {
    throw failure('OLLAMA_NATIVE_IDENTITY');
  }
  return value;
}

function createLocalNativeRuntime(options = {}) {
  const inspect = options.inspect || inspectWindows;
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); }));
  const base = String(options.base || 'http://127.0.0.1:11434');
  let verifiedRuntime = false;
  async function request(url, body) {
    const response = await fetchImpl(url, { method: body ? 'POST' : 'GET',
      headers: { Connection: 'close', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw failure('OLLAMA_NATIVE_STATUS');
    return response.json();
  }
  async function identity() { return validateIdentity(await inspect()); }
  async function same(before) {
    const after = await identity();
    if (JSON.stringify([after.service, after.native]) !== JSON.stringify([before.service, before.native])) throw failure('OLLAMA_NATIVE_CHANGED');
  }
  async function probe() {
    try {
      const version = await request(base + '/api/version');
      // Other Ollama distributions keep their previous provider behaviour.
      if (typeof version?.version !== 'string' || !version.version) throw failure('OLLAMA_NATIVE_VERSION');
      if (version.version !== '0.32.15') return verifiedRuntime
        ? { state: 'unknown', code: 'OLLAMA_NATIVE_VERSION_CHANGED' }
        : { state: 'unsupported', code: 'OLLAMA_NATIVE_UNSUPPORTED' };
      verifiedRuntime = true;
      const found = await identity();
      if (!found.native) {
        await same(found);
        return { state: found.connections === 0 ? 'idle' : 'busy', code: 'OLLAMA_NATIVE_UNLOADED' };
      }
      const slots = await request('http://127.0.0.1:' + found.native.port + '/slots');
      if (!Array.isArray(slots) || slots.length === 0 || slots.some(slot => typeof slot?.is_processing !== 'boolean')) throw failure('OLLAMA_NATIVE_SLOTS');
      await same(found);
      // An established Ollama socket can be an idle metadata keep-alive, not
      // inference. For a verified loaded runner, its strict slot state is the
      // authority; generic TCP connection presence must not fabricate work.
      return { state: slots.every(slot => slot.is_processing === false) ? 'idle' : 'busy', code: 'OLLAMA_NATIVE_DRAIN' };
    } catch (error) {
      const code = typeof error.code === 'string' && /^OLLAMA_NATIVE_[A-Z_]+$/.test(error.code) ? error.code : 'OLLAMA_NATIVE_STATUS';
      return { state: 'unknown', code };
    }
  }
  async function waitUntilIdle(onStatus) {
    for (;;) {
      const result = await probe();
      if (onStatus) onStatus(result);
      if (result.state === 'idle' || result.state === 'unsupported') return result;
      await sleep(5000);
    }
  }
  async function measure({ system = '', prompt = '', model } = {}) {
    const found = await identity();
    if (!found.native) throw failure('OLLAMA_NATIVE_UNLOADED');
    const running = await request(base + '/api/ps');
    if (!Array.isArray(running?.models) || running.models.length !== 1 ||
        ![running.models[0].name, running.models[0].model].includes(model)) throw failure('OLLAMA_NATIVE_MODEL');
    const messages = [];
    const sys = String(system || '').trim();
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: String(prompt || '') });
    const nativeBase = 'http://127.0.0.1:' + found.native.port;
    const rendered = await request(nativeBase + '/apply-template', { messages, add_generation_prompt: true });
    if (typeof rendered?.prompt !== 'string') throw failure('OLLAMA_NATIVE_TEMPLATE');
    const tokenized = await request(nativeBase + '/tokenize', { content: rendered.prompt, add_special: false, parse_special: true });
    if (!Array.isArray(tokenized?.tokens) || !tokenized.tokens.every(Number.isSafeInteger)) throw failure('OLLAMA_NATIVE_TOKENIZER');
    await same(found);
    const after = await request(base + '/api/ps');
    if (JSON.stringify(after.models) !== JSON.stringify(running.models)) throw failure('OLLAMA_NATIVE_MODEL_CHANGED');
    return { inputTokens: tokenized.tokens.length, renderedCharacters: rendered.prompt.length };
  }
  return { probe, waitUntilIdle, measure };
}

module.exports = { createLocalNativeRuntime, validateIdentity };
