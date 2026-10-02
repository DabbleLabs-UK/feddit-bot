'use strict';

const childProcess = require('child_process');
const {
  ProviderError,
  PROVIDER_STATES,
  normalizeUsage,
} = require('./contract');

const descriptor = Object.freeze({
  id: 'claude-plan',
  label: 'Claude subscription',
  category: 'subscription',
  creator: Object.freeze({
    eligible: true,
    autoPreferred: true,
    preference: 290,
    preferredModels: Object.freeze(['opus', 'sonnet', 'haiku']),
  }),
  capabilities: Object.freeze({
    structuredOutput: true,
    cancellation: true,
    modelSelection: true,
    efficientBatch: false,
    longLivedSession: false,
    maxConcurrency: 1,
  }),
});

const MODELS = Object.freeze(['sonnet', 'opus', 'haiku']);
const DEFAULT_TIMEOUT_MS = 180000;
const BLOCKED_ENVIRONMENT = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

function subscriptionEnvironment(source = process.env) {
  const clean = { ...source };
  for (const key of BLOCKED_ENVIRONMENT) delete clean[key];
  return clean;
}

function defaultRun(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const abort = () => child.kill();
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (options.signal) options.signal.removeEventListener('abort', abort);
      resolve({ code: Number(code) || 0, stdout, stderr });
    });
    child.stdin.end(String(options.input || ''));
  });
}

function defaultLaunchLogin(command, env) {
  const child = childProcess.spawn(command, ['auth', 'login'], {
    env,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });
  child.unref();
  return { launched: true };
}

function parseJson(value) {
  try { return JSON.parse(String(value || '').trim()); }
  catch { return null; }
}

function isSubscriptionAuth(auth) {
  return Boolean(auth
    && auth.loggedIn === true
    && auth.apiProvider === 'firstParty'
    && auth.authMethod === 'claude.ai'
    && String(auth.subscriptionType || '').trim());
}

function safeFailure(result) {
  const text = String(result && result.stderr || '').toLowerCase();
  if (/login|logged in|authentication|oauth|unauthorized/.test(text)) return 'AUTH_REQUIRED';
  if (/usage limit|rate limit|allowance|quota/.test(text)) return 'ALLOWANCE_EXHAUSTED';
  if (/not recognized|not found|enoent/.test(text)) return 'UNAVAILABLE';
  return 'PROVIDER_ERROR';
}

function createClaudePlanProvider(options = {}) {
  const placement = String(options.placement || 'desktop');
  const command = String(options.command || 'claude');
  const env = subscriptionEnvironment(options.env || process.env);
  const run = options.run || defaultRun;
  const launchLogin = options.launchLogin || defaultLaunchLogin;
  let connecting = false;
  let active = 0;

  async function authStatus() {
    try {
      const result = await run(command, ['auth', 'status'], { env });
      if (result.code !== 0) return { installed: true, authenticated: false };
      const auth = parseJson(result.stdout);
      return {
        installed: true,
        authenticated: isSubscriptionAuth(auth),
        auth,
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { installed: false, authenticated: false };
      return { installed: true, authenticated: false };
    }
  }

  async function status() {
    if (placement === 'hosted') {
      return {
        id: descriptor.id,
        label: descriptor.label,
        state: PROVIDER_STATES.UNAVAILABLE,
        detail: 'Claude subscription access is available only in the desktop runner.',
        capabilities: descriptor.capabilities,
        models: [],
      };
    }
    const found = await authStatus();
    if (!found.installed) {
      return {
        id: descriptor.id,
        label: descriptor.label,
        state: PROVIDER_STATES.UNAVAILABLE,
        detail: 'Install Claude Code to use a Claude subscription.',
        capabilities: descriptor.capabilities,
        models: [],
      };
    }
    if (!found.authenticated) {
      const incompatible = found.auth && found.auth.loggedIn
        ? 'Claude Code is signed in with an API or cloud-provider account. Sign in with a Claude subscription; Feddit will not fall back to paid API usage.'
        : 'Sign in through Claude Code with a Claude subscription.';
      return {
        id: descriptor.id,
        label: descriptor.label,
        state: connecting ? PROVIDER_STATES.CONNECTING : PROVIDER_STATES.AUTH_REQUIRED,
        detail: connecting ? 'Waiting for Claude Code sign-in to finish.' : incompatible,
        capabilities: descriptor.capabilities,
        models: [],
      };
    }
    connecting = false;
    return {
      id: descriptor.id,
      label: descriptor.label,
      state: active ? PROVIDER_STATES.BUSY : PROVIDER_STATES.READY,
      detail: active ? 'Generating through Claude Code.' : 'Connected through Claude Code using this computer\'s Claude subscription.',
      capabilities: descriptor.capabilities,
      models: MODELS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
      account: {
        email: String(found.auth.email || ''),
        plan: String(found.auth.subscriptionType || ''),
      },
    };
  }

  async function beginConnect() {
    if (placement === 'hosted') throw new ProviderError('Claude subscription sign-in is desktop-only.', 'UNAVAILABLE', { provider: descriptor.id });
    connecting = true;
    try { launchLogin(command, env); }
    catch (error) {
      connecting = false;
      throw new ProviderError('Claude Code could not be opened for sign-in.', 'UNAVAILABLE', { provider: descriptor.id, cause: error });
    }
    return { provider: descriptor.id, state: PROVIDER_STATES.CONNECTING };
  }

  async function disconnect() {
    if (placement === 'hosted') throw new ProviderError('Claude subscription sign-out is desktop-only.', 'UNAVAILABLE', { provider: descriptor.id });
    let result;
    try { result = await run(command, ['auth', 'logout'], { env }); }
    catch (error) {
      throw new ProviderError('Claude Code could not be signed out.', 'UNAVAILABLE', { provider: descriptor.id, cause: error });
    }
    if (result.code !== 0) throw new ProviderError('Claude Code could not be signed out.', safeFailure(result), { provider: descriptor.id });
    connecting = false;
    return { provider: descriptor.id, state: PROVIDER_STATES.AUTH_REQUIRED };
  }

  async function generate(request = {}) {
    if (placement === 'hosted') throw new ProviderError('Claude subscription generation is desktop-only.', 'UNAVAILABLE', { provider: descriptor.id });
    const found = await authStatus();
    if (!found.installed) throw new ProviderError('Claude Code is not installed.', 'UNAVAILABLE', { provider: descriptor.id });
    if (!found.authenticated) throw new ProviderError('Sign in to Claude Code with a Claude subscription.', 'AUTH_REQUIRED', { provider: descriptor.id });
    const model = MODELS.includes(String(request.model || '')) ? String(request.model) : 'sonnet';
    const args = [
      '-p', '--output-format', 'json', '--model', model,
      '--tools', '', '--disallowedTools', 'mcp__*',
      '--permission-prompts', 'none', '--no-session-persistence',
      '--safe-mode', '--restricted', '--strict-mcp-config',
    ];
    const input = 'SYSTEM INSTRUCTION:\n' + String(request.system || '') + '\n\nTASK:\n' + String(request.prompt || '');
    const controller = new AbortController();
    let cancelledByCaller = false;
    const onAbort = () => {
      cancelledByCaller = true;
      controller.abort();
    };
    if (request.signal) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS));
    active++;
    let result;
    try {
      result = await run(command, args, { env, input, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderError(cancelledByCaller ? 'Claude generation was cancelled.' : 'Claude generation timed out.', cancelledByCaller ? 'CANCELLED' : 'TIMEOUT', { provider: descriptor.id });
      }
      throw new ProviderError('Claude Code could not be started.', error && error.code === 'ENOENT' ? 'UNAVAILABLE' : 'PROVIDER_ERROR', { provider: descriptor.id, cause: error });
    } finally {
      clearTimeout(timeout);
      if (request.signal) request.signal.removeEventListener('abort', onAbort);
      active--;
    }
    if (controller.signal.aborted) throw new ProviderError(cancelledByCaller ? 'Claude generation was cancelled.' : 'Claude generation timed out.', cancelledByCaller ? 'CANCELLED' : 'TIMEOUT', { provider: descriptor.id });
    if (result.code !== 0) throw new ProviderError('Claude Code did not complete the generation.', safeFailure(result), { provider: descriptor.id });
    const payload = parseJson(result.stdout);
    if (!payload || typeof payload.result !== 'string') throw new ProviderError('Claude Code returned an invalid response.', 'INVALID_RESPONSE', { provider: descriptor.id });
    if (payload.is_error) throw new ProviderError('Claude Code did not complete the generation.', safeFailure({ stderr: payload.result }), { provider: descriptor.id });
    const usage = payload.usage || {};
    return {
      text: payload.result,
      model,
      provider: descriptor.id,
      ms: Number(payload.duration_ms) || 0,
      usage: normalizeUsage({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedInputTokens: usage.cache_read_input_tokens,
      }),
      raw: payload,
    };
  }

  return { descriptor, status, beginConnect, disconnect, generate, authStatus };
}

module.exports = {
  BLOCKED_ENVIRONMENT,
  MODELS,
  descriptor,
  subscriptionEnvironment,
  isSubscriptionAuth,
  createClaudePlanProvider,
};
