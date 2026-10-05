'use strict';

const http = require('node:http');
const https = require('node:https');
const { createClient: createSharedOllamaClient } = require('../shared-ollama-lease');
const { createLocalGenerationTelemetry } = require('../local-generation-telemetry');

// Ollama provider for the local instance at 127.0.0.1:11434.
//
// This is the default provider for a desktop/local installation. The same
// provider can also run behind DELL's shared lease arbiter. Local installations
// must coexist safely with other Ollama clients without seizing the service.
//
// SHARED-BOX CONSTRAINTS (read before touching this file):
//  - This 16GB machine also runs Cy, which keeps
//    hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M resident
//    with keep_alive: -1 and generates continuously at ~4 tok/s.
//  - We MUST reuse that exact resident model by default, and we MUST send
//    keep_alive: -1 on EVERY request so we never reset its residency timer and
//    trigger an eviction. Requesting a different model swaps Cy's weights out of
//    memory and stalls the live site - only ever do that if a profile explicitly
//    names a different model, and the UI warns loudly when it does.
//  - SINGLE-FLIGHT: this module allows AT MOST ONE generation from THIS PROCESS.
//    Other local Ollama clients may still have work queued or running. On DELL,
//    the separate loopback-only arbiter extends that boundary across CY and
//    Feddit, enforces fair priority, and supplies one execution profile.
//    DeepSeek is remote and is neither blocked by nor blocks this gate.
//
// Common provider interface:
//   generate({ system, prompt, temperature, numPredict, model, timeoutMs })
//     -> { text, usage: { inputTokens, outputTokens }, provider, model }

const OLLAMA_BASE = String(process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_MODEL = 'hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M';
// Leave CPU capacity for LENO's interactive apps during local generation.
// DELL uses the execution profile supplied by its shared arbiter instead.
const LOCAL_NUM_THREAD = 4;
// CPU-heavy input evaluation and real generation have separate finite bounds.
// The outbound hosted worker explicitly retains its previous timeout policy.
const DEFAULT_GENERATION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 20 * 60 * 1000;
const LEGACY_GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SHARED_OLLAMA_ARBITER_URL = String(process.env.SHARED_OLLAMA_ARBITER_URL || '');
const sharedOllama = createSharedOllamaClient(SHARED_OLLAMA_ARBITER_URL);
const localTelemetry = createLocalGenerationTelemetry();

// ---- single-flight gate (ollama-only) ---------------------------------------

let inFlight = null; // Promise currently generating, or null when idle.
let activitySequence = 0;
const RECENT_GENERATION_LIMIT = 20;
let activeGeneration = null;
const persistedGenerations = localTelemetry.read();
activitySequence = persistedGenerations.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
let recentGenerations = persistedGenerations.slice(0, RECENT_GENERATION_LIMIT);

function isBusy() {
  return inFlight !== null;
}

function cleanActivityText(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function beginGenerationActivity(options) {
  const activity = {
    id: ++activitySequence,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: null,
    profileId: cleanActivityText(options.profileId, 100),
    botName: cleanActivityText(options.botName, 100),
    kind: cleanActivityText(options.kind, 80),
    action: cleanActivityText(options.activityAction, 120) || 'writing bot output',
    trigger: cleanActivityText(options.activityTrigger, 120),
    target: cleanActivityText(options.activityTarget, 160),
    model: cleanActivityText(options.model, 300),
    totalTimeoutMs: Math.max(0, Number(options.totalTimeoutMs) || 0),
    idleTimeoutMs: Math.max(0, Number(options.idleTimeoutMs) || 0),
    firstOutputTimeoutMs: Math.max(0, Number(options.firstOutputTimeoutMs) || 0),
    error: null,
  };
  activeGeneration = activity;
  return activity;
}

function finishGenerationActivity(activity, status, error) {
  const finishedAt = Date.now();
  const failureCode = cleanActivityText(error && error.code, 100);
  const finished = {
    ...activity,
    status,
    finishedAt,
    durationMs: Math.max(0, finishedAt - activity.startedAt),
    error: error ? cleanActivityText(error.message || error, 500) : null,
    outcome: status === 'completed' ? 'completed' : 'failed-before-publication',
    failureClass: status === 'completed' ? '' : cleanActivityText(error && error.failureClass, 80) || 'unknown-failure',
    failureCode,
    transportCode: cleanActivityText(error && error.transportCode, 100),
    httpStatus: error?.httpStatus ?? activity.httpStatus ?? null,
    phase: cleanActivityText(error?.phase || activity.phase, 80),
    responseStarted: (error?.responseStarted ?? activity.responseStarted) === true,
    streamStarted: (error?.streamStarted ?? activity.streamStarted) === true,
    bytesReceived: Math.max(0, Number(error?.bytesReceived ?? activity.bytesReceived) || 0),
    repairAttemptCount: 0,
    published: false,
    schedulingContinues: true,
  };
  if (activeGeneration && activeGeneration.id === activity.id) activeGeneration = null;
  recentGenerations = [finished, ...recentGenerations].slice(0, RECENT_GENERATION_LIMIT);
  try {
    localTelemetry.record(finished);
  } catch {
    // Diagnostics must never turn a completed or safely failed generation into
    // an application failure. The in-memory snapshot remains available.
  }
}

// A prompt-free snapshot for the control panel. It intentionally exposes only
// operational metadata: never the persona, source text, generated text or keys.
function generationActivity() {
  return {
    active: activeGeneration ? { ...activeGeneration } : null,
    recent: recentGenerations.map((item) => ({ ...item })),
  };
}

// ---- low-level HTTP ---------------------------------------------------------

async function ollamaFetch(pathname, { method = 'GET', body, timeoutMs = LEGACY_GENERATION_TIMEOUT_MS, signal = null } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const relayAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', relayAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetch(OLLAMA_BASE + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave json null */ }
    if (!res.ok) {
      const msg = (json && json.error) || text || ('HTTP ' + res.status);
      const err = new Error('ollama ' + pathname + ': ' + msg);
      err.status = res.status;
      throw err;
    }
    return json;
  } catch (error) {
    if (ctrl.signal.aborted && timedOut) {
      const amount = timeoutMs >= 60_000
        ? Math.round(timeoutMs / 60_000) + ' minute(s)'
        : timeoutMs + 'ms';
      const timeoutError = new Error('The local model did not finish within ' + amount + '. It may be too slow for this computer or the reply allowance may be unnecessarily large.');
      timeoutError.code = 'OLLAMA_TIMEOUT';
      throw timeoutError;
    }
    if (ctrl.signal.aborted) {
      const leaseError = new Error('The shared Ollama lease was lost before generation completed.');
      leaseError.code = 'OLLAMA_LEASE_LOST';
      throw leaseError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relayAbort);
  }
}

function timeoutAmount(timeoutMs) {
  if (timeoutMs >= 60_000) return Math.round(timeoutMs / 60_000) + ' minute(s)';
  return timeoutMs + 'ms';
}

function diagnosticError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.failureClass = detail.failureClass || 'unknown-failure';
  error.transportCode = cleanActivityText(detail.transportCode, 100);
  error.httpStatus = Number.isFinite(Number(detail.httpStatus)) ? Number(detail.httpStatus) : null;
  error.phase = cleanActivityText(detail.phase, 80);
  error.responseStarted = detail.responseStarted === true;
  error.streamStarted = detail.streamStarted === true;
  error.bytesReceived = Math.max(0, Number(detail.bytesReceived) || 0);
  if (detail.cause) error.cause = detail.cause;
  return error;
}

function transportCode(error) {
  return cleanActivityText(error && (error.code || (error.cause && error.cause.code)), 100);
}

// Chat generation deliberately uses Node's HTTP client instead of fetch.
// Node 22's fetch implementation has its own response-header watchdog, which
// can pre-empt our explicit generation limits. Ollama's NDJSON stream
// also gives us real progress, so a silent stream can be distinguished from a
// merely long request that is still emitting tokens.
function ollamaChatStream(body, options = {}) {
  const base = String(options.base || OLLAMA_BASE).replace(/\/$/, '');
  const legacyTimeouts = options.legacyTimeouts === true;
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || (legacyTimeouts ? LEGACY_GENERATION_TIMEOUT_MS : DEFAULT_GENERATION_TIMEOUT_MS));
  const firstOutputTimeoutMs = Math.max(1, Number(options.firstOutputTimeoutMs) || DEFAULT_FIRST_OUTPUT_TIMEOUT_MS);
  const idleTimeoutMs = Math.max(1, Number(options.idleTimeoutMs) || DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  const signal = options.signal || null;

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(base + '/api/chat');
    } catch (cause) {
      reject(diagnosticError('OLLAMA_TRANSPORT_ERROR', 'The configured Ollama address is invalid.', {
        failureClass: 'transport-error', phase: 'connecting', cause,
      }));
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({ ...body, stream: true });
    let settled = false;
    let responseStarted = false;
    let streamStarted = false;
    let bytesReceived = 0;
    let idleTimer = null;
    let firstOutputTimer = null;
    let totalTimer = null;
    let request = null;
    let relayAbort = null;
    const requestStartedAt = Date.now();
    let firstOutputAt = null;
    let lastProgressAt = null;
    let progressRecords = 0;
    let outputCharacters = 0;
    let thinkingCharacters = 0;
    let httpStatus = null;
    let pending = '';
    let content = '';
    let thinking = '';
    let finalRecord = null;
    let doneSeen = false;

    const diagnostics = (extra = {}) => ({
      responseStarted,
      streamStarted,
      bytesReceived,
      httpStatus,
      requestStartedAt,
      firstOutputAt,
      lastProgressAt,
      progressRecords,
      outputCharacters,
      thinkingCharacters,
      // Ollama reports token totals only in its final record. Fragment counts
      // and UTF-16 string lengths must never be labelled as generated tokens.
      outputTokens: Number.isFinite(finalRecord?.eval_count) ? finalRecord.eval_count : null,
      inputTokens: Number.isFinite(finalRecord?.prompt_eval_count) ? finalRecord.prompt_eval_count : null,
      phase: streamStarted ? 'streaming' : (responseStarted ? 'waiting-for-first-record' : 'waiting-for-response'),
      ...extra,
    });
    const publishDiagnostics = (extra = {}) => {
      const snapshot = diagnostics(extra);
      if (typeof options.onDiagnostics === 'function') {
        try { options.onDiagnostics(snapshot); } catch { /* telemetry cannot break inference */ }
      }
      return snapshot;
    };
    const cleanup = () => {
      clearTimeout(totalTimer);
      clearTimeout(firstOutputTimer);
      clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', relayAbort);
    };
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      publishDiagnostics({ endedAt: Date.now(), cancelledAt: request?.destroyed ? Date.now() : null });
      reject(error);
    };
    const finishSuccess = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      publishDiagnostics({ endedAt: Date.now(), completedAt: Date.now() });
      resolve(value);
    };
    const resetIdleTimer = () => {
      if (legacyTimeouts ? !streamStarted : firstOutputAt === null) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = diagnosticError(
          'OLLAMA_STALLED',
          'The local model made no ' + (legacyTimeouts ? 'stream' : 'generation') + ' progress for ' + timeoutAmount(idleTimeoutMs) + '. No complete result was accepted.',
          diagnostics({ failureClass: legacyTimeouts ? 'stalled-stream' : 'no-generation-progress-timeout' })
        );
        request.destroy(error);
        finishError(error);
      }, idleTimeoutMs);
    };
    const consumeRecord = (line) => {
      if (!line.trim()) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch (cause) {
        throw diagnosticError('OLLAMA_MALFORMED_RESPONSE', 'Ollama returned an unreadable streaming response. Nothing was generated.', {
          ...diagnostics({ failureClass: 'malformed-response' }), cause,
        });
      }
      streamStarted = true;
      if (legacyTimeouts) resetIdleTimer();
      if (record && record.error) {
        throw diagnosticError('OLLAMA_API_ERROR', 'Ollama stopped the generation: ' + cleanActivityText(record.error, 300), {
          ...diagnostics({ failureClass: 'ollama-api-error' }),
        });
      }
      const message = record && record.message || {};
      // /api/chat uses message.content/thinking; accept the native generated
      // response/thinking aliases as well, without counting both forms twice.
      const output = typeof message.content === 'string' ? message.content : (typeof record?.response === 'string' ? record.response : '');
      const thought = typeof message.thinking === 'string' ? message.thinking : (typeof record?.thinking === 'string' ? record.thinking : '');
      content += output;
      thinking += thought;
      if (output.length || thought.length) {
        const now = Date.now();
        if (firstOutputAt === null) {
          firstOutputAt = now;
          clearTimeout(firstOutputTimer);
        }
        lastProgressAt = now;
        progressRecords++;
        outputCharacters += output.length;
        thinkingCharacters += thought.length;
        if (!legacyTimeouts) resetIdleTimer();
      }
      if (record && record.done === true) {
        doneSeen = true;
        finalRecord = record;
      }
      publishDiagnostics();
    };
    totalTimer = setTimeout(() => {
      const error = diagnosticError(
        'OLLAMA_TIMEOUT',
        'The local model did not finish within ' + timeoutAmount(timeoutMs) + '. No complete result was accepted.',
        diagnostics({ failureClass: legacyTimeouts ? 'total-timeout' : 'emergency-hard-timeout' })
      );
      request.destroy(error);
      finishError(error);
    }, timeoutMs);
    if (!legacyTimeouts) firstOutputTimer = setTimeout(() => {
      const error = diagnosticError('OLLAMA_FIRST_OUTPUT_TIMEOUT',
        'The local model produced no generated output within ' + timeoutAmount(firstOutputTimeoutMs) + '. No complete result was accepted.',
        diagnostics({ failureClass: 'waiting-for-first-output-timeout' }));
      request.destroy(error);
      finishError(error);
    }, firstOutputTimeoutMs);

    try { request = transport.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Connection': 'close',
      },
    }, (incoming) => {
      responseStarted = true;
      httpStatus = incoming.statusCode;
      publishDiagnostics();
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        if (settled) return;
        bytesReceived += Buffer.byteLength(chunk);
        if (legacyTimeouts && streamStarted) resetIdleTimer();
        pending += chunk;
        if (incoming.statusCode >= 200 && incoming.statusCode < 300) {
          try {
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) consumeRecord(line);
          } catch (error) {
            request.destroy(error);
            finishError(error);
          }
        }
      });
      incoming.on('aborted', () => {
        finishError(diagnosticError('OLLAMA_CONNECTION_RESET', 'The Ollama connection was reset before generation completed. Nothing was generated.', {
          ...diagnostics({ failureClass: 'connection-reset' }),
        }));
      });
      incoming.on('error', (cause) => {
        finishError(diagnosticError('OLLAMA_CONNECTION_RESET', 'The Ollama connection was interrupted before generation completed. Nothing was generated.', {
          ...diagnostics({ failureClass: 'connection-reset', transportCode: transportCode(cause) }), cause,
        }));
      });
      incoming.on('end', () => {
        if (settled) return;
        if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
          let detail = pending;
          try {
            const parsed = JSON.parse(pending || '{}');
            detail = parsed.error || pending;
          } catch { /* keep the bounded response text */ }
          finishError(diagnosticError('OLLAMA_HTTP_ERROR', 'Ollama rejected the generation request: ' + cleanActivityText(detail || ('HTTP ' + incoming.statusCode), 300), {
            ...diagnostics({ failureClass: incoming.statusCode === 503 ? 'ollama-unavailable' : 'http-error', httpStatus: incoming.statusCode }),
          }));
          return;
        }
        try {
          if (pending.trim()) consumeRecord(pending);
        } catch (error) {
          finishError(error);
          return;
        }
        if (!doneSeen) {
          finishError(diagnosticError('OLLAMA_INCOMPLETE_STREAM', 'Ollama ended its response before confirming that generation completed. Nothing was generated.', {
            ...diagnostics({ failureClass: 'incomplete-response' }),
          }));
          return;
        }
        finishSuccess({
          ...(finalRecord || {}),
          message: { role: 'assistant', content, thinking },
        });
      });
    }); } catch (cause) {
      finishError(diagnosticError('OLLAMA_TRANSPORT_ERROR', 'The Ollama request could not be opened.',
        diagnostics({ failureClass: 'transport-error', transportCode: transportCode(cause), cause })));
      return;
    }

    request.on('error', (cause) => {
      if (settled) return;
      const code = transportCode(cause);
      if (cause && cause.code && String(cause.code).startsWith('OLLAMA_')) {
        finishError(cause);
      } else if (/ECONNREFUSED/i.test(code + ' ' + (cause && cause.message))) {
        finishError(diagnosticError('OLLAMA_UNREACHABLE', 'Ollama could not be reached, so no reply was generated.', {
          ...diagnostics({ failureClass: 'ollama-unavailable', transportCode: code }), cause,
        }));
      } else if (/ECONNRESET|EPIPE|socket hang up/i.test(code + ' ' + (cause && cause.message))) {
        finishError(diagnosticError('OLLAMA_CONNECTION_RESET', 'The Ollama connection was reset before generation completed. Nothing was generated.', {
          ...diagnostics({ failureClass: 'connection-reset', transportCode: code }), cause,
        }));
      } else {
        finishError(diagnosticError('OLLAMA_TRANSPORT_ERROR', 'The Ollama connection failed before generation completed. Nothing was generated.', {
          ...diagnostics({ failureClass: 'transport-error', transportCode: code }), cause,
        }));
      }
    });
    relayAbort = () => {
      const error = diagnosticError('OLLAMA_LEASE_LOST', 'The shared Ollama lease was lost before generation completed.', {
        ...diagnostics({ failureClass: 'lease-lost' }),
      });
      request.destroy(error);
      finishError(error);
    };
    publishDiagnostics();
    if (signal) {
      if (signal.aborted) relayAbort();
      else signal.addEventListener('abort', relayAbort, { once: true });
    }
    if (!settled) request.end(payload);
  });
}

// Download a model while surfacing Ollama's NDJSON progress records. Pulls are
// intentionally outside the generation single-flight gate: Ollama itself owns
// download coordination, while the UI keeps bots paused during first setup.
async function pullModel(model, onProgress, options = {}) {
  const name = String(model || '').trim();
  if (!name) throw new Error('Choose a model to download.');
  const fetchImpl = options.fetchImpl || fetch;
  const base = String(options.base || OLLAMA_BASE).replace(/\/$/, '');
  const ctrl = new AbortController();
  const timeoutMs = Number(options.timeoutMs) || 2 * 60 * 60 * 1000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(base + '/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true }),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error('ollama /api/pull: ' + (text || ('HTTP ' + response.status)));
    }
    let pending = '';
    for await (const chunk of response.body) {
      pending += Buffer.from(chunk).toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const progress = JSON.parse(line);
        if (typeof onProgress === 'function') onProgress(progress);
        if (progress.error) throw new Error(String(progress.error));
      }
    }
    if (pending.trim()) {
      const progress = JSON.parse(pending);
      if (typeof onProgress === 'function') onProgress(progress);
      if (progress.error) throw new Error(String(progress.error));
    }
    return { ok: true, model: name };
  } finally {
    clearTimeout(timer);
  }
}

// ---- status -----------------------------------------------------------------

// Is ollama up, and which models are installed?
async function tags() {
  return ollamaFetch('/api/tags', { timeoutMs: 5000 });
}

// Which model(s) are currently resident in memory (what Cy is holding)?
async function ps() {
  return ollamaFetch('/api/ps', { timeoutMs: 5000 });
}

// Combined health snapshot for the UI status panel. Never throws.
async function status() {
  const out = { up: false, models: [], modelDetails: [], resident: [], error: null };
  try {
    const t = await tags();
    out.up = true;
    out.models = (t.models || []).map((m) => m.name);
    out.modelDetails = (t.models || []).map((m) => ({
      name: String(m.name || ''),
      size: Math.max(0, Number(m.size) || 0),
      family: String((m.details && m.details.family) || ''),
      parameterSize: String((m.details && m.details.parameter_size) || ''),
      quantization: String((m.details && m.details.quantization_level) || ''),
      format: String((m.details && m.details.format) || ''),
    }));
  } catch (err) {
    out.error = err.message;
    return out;
  }
  try {
    const p = await ps();
    out.resident = (p.models || []).map((m) => ({
      name: m.name,
      sizeVram: m.size_vram,
      expiresAt: m.expires_at,
    }));
  } catch {
    // resident info is best-effort
  }
  out.busy = isBusy();
  return out;
}

// ---- generation -------------------------------------------------------------

function buildMessages(system, prompt) {
  const messages = [];
  const sys = String(system || '').trim();
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: String(prompt || '') });
  return messages;
}

function friendlyGenerationFailure(error) {
  if (!error) return error;
  if (String(error.code || '').startsWith('OLLAMA_')) return error;
  if (error.code === 'BUSY') {
    error.failureClass = 'local-slot-busy';
    return error;
  }
  if (error.code === 'THINKING_EXHAUSTED' || error.code === 'EMPTY_RESPONSE') {
    error.failureClass = 'empty-model-response';
    return error;
  }

  const detail = [
    error.name,
    error.code,
    error.message,
    error.cause && error.cause.code,
    error.cause && error.cause.message,
  ].filter(Boolean).join(' ');

  if (/ECONNREFUSED|connection refused/i.test(detail)) {
    const friendly = new Error('Ollama could not be reached, so no reply was generated. Wait until the top of this page says "ollama up", then try again.');
    friendly.code = 'OLLAMA_UNREACHABLE';
    friendly.failureClass = 'ollama-unavailable';
    friendly.transportCode = transportCode(error);
    friendly.cause = error;
    return friendly;
  }

  if (/AbortError|operation was aborted|fetch failed|ECONNRESET|socket|forcibly closed|connection.*closed|runner.*(stopped|terminated|exited)|unexpected EOF/i.test(detail)) {
    const friendly = new Error('The local Ollama model lost its connection before it produced a reply. Nothing was generated. Wait until Ollama is shown as up and the local-model activity bar is idle, then try again. If another local AI app is using Ollama, let it finish first.');
    friendly.code = 'OLLAMA_CONNECTION_LOST';
    friendly.failureClass = 'connection-lost';
    friendly.transportCode = transportCode(error);
    friendly.cause = error;
    return friendly;
  }

  error.failureClass = error.failureClass || 'unknown-failure';
  error.transportCode = error.transportCode || transportCode(error);
  return error;
}

// Generate a completion. Enforces single-flight: throws BUSY if a generation is
// already running from this process. keep_alive is FORCED to -1 on every call.
async function generate({
  system = '',
  prompt = '',
  temperature = 0.8,
  numPredict = 200,
  model = DEFAULT_MODEL,
  legacyTimeouts = false,
  timeoutMs = legacyTimeouts ? LEGACY_GENERATION_TIMEOUT_MS : DEFAULT_GENERATION_TIMEOUT_MS,
  firstOutputTimeoutMs = DEFAULT_FIRST_OUTPUT_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  profileId = '',
  botName = '',
  kind = '',
  activityAction = '',
  activityTrigger = '',
  activityTarget = '',
  priorityClass = 'user',
  leaseClient = sharedOllama,
  chatTransport = ollamaChatStream,
} = {}) {
  if (inFlight) {
    const err = new Error('A generation is already in flight (single-flight). Try again shortly.');
    err.code = 'BUSY';
    throw err;
  }

  const activity = beginGenerationActivity({
    profileId,
    botName,
    kind,
    activityAction,
    activityTrigger,
    activityTarget,
    model,
    totalTimeoutMs: timeoutMs,
    idleTimeoutMs,
    firstOutputTimeoutMs: legacyTimeouts ? 0 : firstOutputTimeoutMs,
  });

  const run = (async () => {
    const inferenceAbort = new AbortController();
    let hostLease = null;
    if (leaseClient) {
      hostLease = await leaseClient.acquire({
        priorityClass,
        purpose: kind || 'feddit',
        onLost: () => inferenceAbort.abort(),
      });
    }
    const profile = hostLease ? hostLease.profile : { num_thread: LOCAL_NUM_THREAD };
    const body = {
      model,
      messages: buildMessages(system, prompt),
      stream: true,
      keep_alive: -1,
      options: {
        temperature,
        num_predict: numPredict,
        ...profile,
      },
    };
    const started = Date.now();
    try {
      const json = await chatTransport(body, {
        timeoutMs, firstOutputTimeoutMs, idleTimeoutMs, legacyTimeouts, signal: inferenceAbort.signal,
        onDiagnostics: (snapshot) => Object.assign(activity, snapshot),
      });
      const message = (json && json.message) || {};
      const content = String(message.content || '').trim();
      if (!content) {
        const thinking = String(message.thinking || '').trim();
        const exhausted = json && json.done_reason === 'length';
        const err = new Error(thinking
          ? 'This local model used its reply allowance thinking before it wrote an answer. Choose one of the direct-answer models under Local model.'
          : (exhausted
            ? 'This local model reached its reply limit without producing an answer. Choose another model or raise num_predict in technical settings.'
            : 'The local model returned no answer. Try again or choose another model under Local model.'));
        err.code = thinking ? 'THINKING_EXHAUSTED' : 'EMPTY_RESPONSE';
        throw err;
      }
      return {
        provider: 'ollama',
        model,
        text: content,
        ms: Date.now() - started,
        queueMs: hostLease ? hostLease.waitMs : 0,
        usage: {
          inputTokens: (json && json.prompt_eval_count) || 0,
          outputTokens: (json && json.eval_count) || 0,
          cachedInputTokens: 0,
        },
      };
    } finally {
      if (hostLease) await hostLease.release();
    }
  })();

  inFlight = run;
  try {
    const result = await run;
    finishGenerationActivity(activity, 'completed');
    return result;
  } catch (error) {
    const visibleError = friendlyGenerationFailure(error);
    finishGenerationActivity(activity, 'failed', visibleError);
    throw visibleError;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  OLLAMA_BASE,
  DEFAULT_MODEL,
  DEFAULT_GENERATION_TIMEOUT_MS,
  DEFAULT_FIRST_OUTPUT_TIMEOUT_MS,
  LEGACY_GENERATION_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  SHARED_OLLAMA_ARBITER_URL,
  isBusy,
  generationActivity,
  tags,
  ps,
  status,
  pullModel,
  generate,
  _test: {
    ollamaChatStream,
    diagnosticError,
    friendlyGenerationFailure,
    telemetryFile: localTelemetry.file,
  },
};
