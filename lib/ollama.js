'use strict';

// Ollama client for the local instance at 127.0.0.1:11434.
//
// SHARED-BOX CONSTRAINTS (read before touching this file):
//  - This 16GB machine also runs "Cy" (the CY project, a LIVE site) which keeps
//    hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M resident
//    with keep_alive: -1 and generates continuously at ~4 tok/s.
//  - We MUST reuse that exact resident model by default, and we MUST send
//    keep_alive: -1 on EVERY request so we never reset its residency timer and
//    trigger an eviction. Requesting a different model swaps Cy's weights out of
//    memory and stalls the live site - only ever do that if a profile explicitly
//    names a different model, and the UI warns loudly when it does.
//  - SINGLE-FLIGHT: ollama serialises requests into one queue. If we fire a
//    second generation while Cy (or another of our profiles) is mid-generation,
//    we sit in that queue and starve Cy. So this module allows AT MOST ONE
//    in-flight generation from this process at a time.

const OLLAMA_BASE = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M';

// ---- single-flight gate -----------------------------------------------------

let inFlight = null; // Promise currently generating, or null when idle.

function isBusy() {
  return inFlight !== null;
}

// ---- low-level HTTP ---------------------------------------------------------

async function ollamaFetch(pathname, { method = 'GET', body, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
  const out = { up: false, models: [], resident: [], error: null };
  try {
    const t = await tags();
    out.up = true;
    out.models = (t.models || []).map((m) => m.name);
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

// Build the message list from a persona + tone + the post we are reacting to.
function buildMessages({ persona, toneNotes, task }) {
  const sys = [persona || '', toneNotes ? '\nTone/style: ' + toneNotes : '']
    .join('')
    .trim();
  const messages = [];
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: task });
  return messages;
}

// Generate a completion. Enforces single-flight: throws BUSY if a generation is
// already running from this process. keep_alive is FORCED to -1 on every call.
async function generate({
  model = DEFAULT_MODEL,
  persona = '',
  toneNotes = '',
  task = '',
  temperature = 0.8,
  numPredict = 200,
  timeoutMs = 120000,
} = {}) {
  if (inFlight) {
    const err = new Error('A generation is already in flight (single-flight). Try again shortly.');
    err.code = 'BUSY';
    throw err;
  }

  const body = {
    model,
    messages: buildMessages({ persona, toneNotes, task }),
    stream: false,
    keep_alive: -1, // NEVER change: keeps Cy's model resident, never resets its timer
    options: {
      temperature,
      num_predict: numPredict,
    },
  };

  const run = (async () => {
    const started = Date.now();
    const json = await ollamaFetch('/api/chat', { method: 'POST', body, timeoutMs });
    const content = (json && json.message && json.message.content) || '';
    return {
      model,
      content: content.trim(),
      ms: Date.now() - started,
      evalCount: json && json.eval_count,
      promptEvalCount: json && json.prompt_eval_count,
    };
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  OLLAMA_BASE,
  DEFAULT_MODEL,
  isBusy,
  tags,
  ps,
  status,
  generate,
};
