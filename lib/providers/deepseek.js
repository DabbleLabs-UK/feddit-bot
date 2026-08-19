'use strict';

// DeepSeek provider - OpenAI-compatible chat-completions at api.deepseek.com.
//
// Unlike ollama this is a REMOTE call: it does not touch the DELL box, does not
// share Cy's VRAM, and is not subject to the ollama single-flight gate. Several
// DeepSeek generations may run concurrently (the concurrency cap lives in
// providers/index.js).
//
// MODEL IDS ARE EXACT: 'deepseek-v4-flash' (cheap) and 'deepseek-v4-pro'
// (premium). The old 'deepseek-chat' / 'deepseek-reasoner' aliases were RETIRED
// on 24 July 2026 and now fail - never use them anywhere.
//
// Auth is a Bearer API key (one key shared by all DeepSeek profiles, stored in
// data/secrets.json). It is NEVER logged and NEVER echoed back in full.
//
// Common provider interface:
//   generate({ system, prompt, temperature, numPredict, model, apiKey, timeoutMs })
//     -> { text, usage: { inputTokens, outputTokens, cachedInputTokens }, provider, model }

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];
const DEFAULT_MODEL = 'deepseek-v4-flash';

// Distinct, UI-friendly errors. `code` lets callers/scheduler react; `message`
// is safe to surface (never contains the key).
function apiError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  if (status != null) err.status = status;
  return err;
}

function buildMessages(system, prompt) {
  const messages = [];
  const sys = String(system || '').trim();
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: String(prompt || '') });
  return messages;
}

// Pull the cached-input token count out of whichever shape the API reports it
// in. DeepSeek's native fields are prompt_cache_hit_tokens / _miss_tokens; the
// OpenAI-compatible shape nests it under prompt_tokens_details.cached_tokens.
function cachedInputTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  if (typeof usage.prompt_cache_hit_tokens === 'number') return usage.prompt_cache_hit_tokens;
  const d = usage.prompt_tokens_details;
  if (d && typeof d.cached_tokens === 'number') return d.cached_tokens;
  return 0;
}

async function generate({
  system = '',
  prompt = '',
  temperature = 0.8,
  numPredict = 200,
  model = DEFAULT_MODEL,
  apiKey = '',
  timeoutMs = 120000,
} = {}) {
  if (!apiKey) throw apiError('No DeepSeek API key set. Add one in the control panel.', 'NO_KEY');
  if (!MODELS.includes(model)) {
    // Guard against a stale profile pointing at a retired alias.
    throw apiError('Unknown DeepSeek model "' + model + '". Use one of: ' + MODELS.join(', '), 'BAD_MODEL');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let res;
  try {
    res = await fetch(DEEPSEEK_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,        // never logged
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(system, prompt),
        temperature,
        max_tokens: numPredict,                    // num_predict maps to max_tokens
        stream: false,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw apiError('DeepSeek network error: ' + err.message, 'NETWORK');
  }
  clearTimeout(timer);

  const raw = await res.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
  const apiMsg = (json && json.error && (json.error.message || json.error.code)) || null;

  if (!res.ok) {
    if (res.status === 401) {
      throw apiError('DeepSeek rejected the API key (401). Check the key in the control panel.', 'BAD_KEY', 401);
    }
    if (res.status === 402) {
      throw apiError('DeepSeek reports insufficient balance (402). Top up the account or switch these profiles to ollama.', 'INSUFFICIENT_BALANCE', 402);
    }
    if (res.status === 429) {
      throw apiError('DeepSeek rate limited (429)' + (apiMsg ? ': ' + apiMsg : '') + '.', 'RATE_LIMITED', 429);
    }
    throw apiError('DeepSeek error (HTTP ' + res.status + ')' + (apiMsg ? ': ' + apiMsg : '') + '.', 'HTTP_' + res.status, res.status);
  }

  const choice = json && json.choices && json.choices[0];
  const text = (choice && choice.message && choice.message.content) || '';
  const usage = (json && json.usage) || {};
  return {
    provider: 'deepseek',
    model,
    text: String(text).trim(),
    ms: Date.now() - started,
    usage: {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      cachedInputTokens: cachedInputTokens(usage),
    },
  };
}

// Best-effort reachability + key check for the status panel. Never throws.
// A cheap models list call: 200 => reachable + key good; 401 => key bad.
async function reachable(apiKey) {
  const out = { up: false, hasKey: Boolean(apiKey), keyOk: false, error: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(DEEPSEEK_BASE + '/models', {
      headers: apiKey ? { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' } : { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    out.up = true; // the endpoint answered, so DeepSeek is reachable
    if (res.status === 401) { out.error = 'API key rejected (401)'; }
    else if (res.ok) { out.keyOk = true; }
    else { out.error = 'HTTP ' + res.status; }
  } catch (err) {
    out.error = 'unreachable: ' + err.message;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

module.exports = {
  DEEPSEEK_BASE,
  MODELS,
  DEFAULT_MODEL,
  generate,
  reachable,
};
