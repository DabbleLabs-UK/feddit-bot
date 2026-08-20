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

// ---- reasoning-model token budget -------------------------------------------
//
// DeepSeek V4 models are REASONING models. The `max_tokens` we send is NOT an
// output cap - it is a TOTAL budget the model spends on INVISIBLE chain-of-
// thought reasoning FIRST, and only what is left over on the visible answer.
//
// Measured against the LIVE API (not theory): a trivial title task sent with
// max_tokens 200 came back with completion_tokens 200, reasoning_tokens 200,
// finish_reason "length" and message.content = "" (an EMPTY string). The model
// burned the entire budget thinking and had nothing left to answer with - and it
// is STILL BILLED IN FULL. The SAME prompt with max_tokens 2000 returned
// reasoning_tokens 255, finish_reason "stop" and a correct answer. So a small
// max_tokens does not shorten the answer, it STARVES the whole generation.
//
// The floor guarantees a small num_predict can never starve the answer. Reasoning
// ran 200-255 tokens on a trivial task and is LARGER for longer prompts, so the
// floor leaves real headroom over that PLUS room for the visible answer. Raising
// the ceiling does not raise cost on its own: billing is on the tokens actually
// produced (reasoning + answer), not on max_tokens.
const MIN_REASONING_BUDGET = 1024;    // never send max_tokens below this
const RETRY_REASONING_BUDGET = 4096;  // on a detected starve, retry once this large
const SAFE_DEFAULT_MAX_TOKENS = 1024; // recommended default for a new deepseek profile

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

// Interpret a successful OpenAI-compatible chat-completion body, INCLUDING the
// reasoning-model signals, given the max_tokens budget we sent. Pure + exported
// so the starve detection is unit-testable without a live call.
//
// COST: completion_tokens ALREADY includes reasoning_tokens (measured: an empty
// answer still reported completion_tokens 200 == reasoning_tokens 200). So
// mapping outputTokens from completion_tokens makes the recorded cost cover the
// invisible reasoning too - reasoning bills as output, and we charge for it.
//
// reasoning_content is captured ONLY as a diagnostic token COUNT. Its text is
// NEVER returned as the answer and must never leak into a post, comment or title.
//
// `starved` is the distinct, diagnosable failure: the model spent its whole
// budget reasoning and produced NO visible answer. It is empty visible content
// together with finish_reason 'length' OR the reasoning tokens having eaten
// (nearly) the whole budget. This is NOT a generic empty response and must not be
// reported as one.
function interpret(json, maxTokens) {
  const choice = json && json.choices && json.choices[0];
  const msg = (choice && choice.message) || {};
  const content = String(msg.content == null ? '' : msg.content).trim();
  const finishReason = choice && choice.finish_reason != null ? String(choice.finish_reason) : null;
  const usage = (json && json.usage) || {};
  const details = usage.completion_tokens_details || {};
  const reasoningTokens = Number(details.reasoning_tokens) || 0;
  // reasoning_content presence is a diagnostic hint only; we keep the count, not the text.
  const hasReasoning = reasoningTokens > 0 || (msg.reasoning_content != null && String(msg.reasoning_content) !== '');
  const budget = Number(maxTokens) || 0;
  const budgetEaten = budget > 0 && reasoningTokens >= budget * 0.9;
  const starved = !content && (finishReason === 'length' || budgetEaten);
  return { content, finishReason, reasoningTokens, hasReasoning, starved, usage };
}

async function generate({
  system = '',
  prompt = '',
  temperature = 0.8,
  numPredict = 200,
  model = DEFAULT_MODEL,
  apiKey = '',
  timeoutMs = 120000,
  fetchImpl = null, // injectable for tests; defaults to the global fetch
} = {}) {
  if (!apiKey) throw apiError('No DeepSeek API key set. Add one in the control panel.', 'NO_KEY');
  if (!MODELS.includes(model)) {
    // Guard against a stale profile pointing at a retired alias.
    throw apiError('Unknown DeepSeek model "' + model + '". Use one of: ' + MODELS.join(', '), 'BAD_MODEL');
  }
  const doFetch = fetchImpl || fetch;
  const started = Date.now();

  // Enforce the reasoning floor: a small num_predict would otherwise be spent
  // entirely on invisible reasoning, starving the answer to an empty string.
  const floorMax = Math.max(Number(numPredict) || 0, MIN_REASONING_BUDGET);

  // One HTTP attempt at a specific token budget. Throws on HTTP/transport errors
  // (shared by both attempts); returns { json, interp } on a 200.
  async function attempt(maxTokens) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(DEEPSEEK_BASE + '/chat/completions', {
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
          max_tokens: maxTokens,                     // TOTAL budget: reasoning + answer
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

    return { json, interp: interpret(json, maxTokens) };
  }

  let budget = floorMax;
  let out = await attempt(budget);

  // STARVED BUDGET: the model spent its whole budget reasoning and returned an
  // empty answer (finish_reason 'length' and/or reasoning ate the budget). This
  // is a distinct, diagnosable failure - NOT a generic empty response, and NOT
  // the model refusing to depart from some text. Retry ONCE with a substantially
  // larger budget before giving up.
  if (out.interp.starved) {
    budget = Math.max(floorMax * 4, RETRY_REASONING_BUDGET);
    out = await attempt(budget);
    if (out.interp.starved) {
      throw apiError(
        'DeepSeek ' + model + ' produced no answer: its entire token budget (' + budget +
        ') was exhausted by internal reasoning before it could write a reply (reasoning_tokens ' +
        out.interp.reasoningTokens + ', finish_reason ' + out.interp.finishReason +
        '). Raise the token budget (max_tokens) for this profile - this is a starved budget, not a refusal.',
        'REASONING_BUDGET_EXHAUSTED');
    }
  }

  const usage = out.interp.usage;
  return {
    provider: 'deepseek',
    model,
    // out.interp.content is message.content ONLY - reasoning_content is never used.
    text: out.interp.content,
    ms: Date.now() - started,
    // Diagnostics: how much of the budget went to invisible reasoning, and why it
    // stopped. Never surfaced as answer text.
    reasoningTokens: out.interp.reasoningTokens,
    finishReason: out.interp.finishReason,
    maxTokens: budget,
    usage: {
      inputTokens: usage.prompt_tokens || 0,
      // completion_tokens INCLUDES reasoning_tokens, so cost covers the reasoning.
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
  MIN_REASONING_BUDGET,
  RETRY_REASONING_BUDGET,
  SAFE_DEFAULT_MAX_TOKENS,
  interpret,
  generate,
  reachable,
};
