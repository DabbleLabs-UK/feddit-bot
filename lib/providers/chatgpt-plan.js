'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { ProviderError, PROVIDER_STATES } = require('./contract');

const ISSUER = 'https://auth.openai.com';
const DISCOVERY_URL = ISSUER + '/.well-known/openid-configuration';
const API_BASE = 'https://api.openai.com/v1';
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const RESOURCE = API_BASE;
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
];
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_TOTAL_TIMEOUT_MS = 900000;
const MAX_ERROR_DETAIL = 240;

const descriptor = Object.freeze({
  id: 'chatgpt-plan',
  label: 'ChatGPT plan',
  category: 'subscription',
  creator: Object.freeze({
    eligible: true,
    autoPreferred: true,
    preference: 300,
    // OpenAI's account-visible model service orders the current usable models.
    // The creator policy uses that order instead of maintaining a stale model list.
    preferredModels: Object.freeze([]),
  }),
  capabilities: Object.freeze({
    structuredOutput: false,
    cancellation: true,
    modelSelection: true,
    efficientBatch: false,
    longLivedSession: true,
    maxConcurrency: 1,
  }),
});

function providerError(message, code, status, cause, diagnostics = null) {
  const error = new ProviderError(message, code, {
    provider: descriptor.id,
    status,
    cause,
    retryable: ['NETWORK', 'TIMEOUT', 'RATE_LIMITED'].includes(code),
  });
  if (diagnostics && typeof diagnostics === 'object') {
    error.phase = String(diagnostics.phase || '').slice(0, 80);
    error.timeoutKind = String(diagnostics.timeoutKind || '').slice(0, 40);
    error.responseStarted = diagnostics.responseStarted === true;
    error.streamStarted = diagnostics.streamStarted === true;
    error.bytesReceived = Math.max(0, Number(diagnostics.bytesReceived) || 0);
    error.eventsReceived = Math.max(0, Number(diagnostics.eventsReceived) || 0);
    error.elapsedMs = Math.max(0, Number(diagnostics.elapsedMs) || 0);
  }
  return error;
}

function timeoutAmount(timeoutMs) {
  if (timeoutMs >= 60000 && timeoutMs % 60000 === 0) return (timeoutMs / 60000) + ' minute(s)';
  if (timeoutMs >= 1000 && timeoutMs % 1000 === 0) return (timeoutMs / 1000) + ' second(s)';
  return timeoutMs + 'ms';
}

async function readResponseBody(response, onChunk) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const raw = await response.text();
    if (raw) onChunk(raw);
    return raw;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = decoder.decode(next.value, { stream: true });
    if (!chunk) continue;
    raw += chunk;
    onChunk(chunk);
  }
  const tail = decoder.decode();
  if (tail) {
    raw += tail;
    onChunk(tail);
  }
  return raw;
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function parseJwtPart(value) {
  try { return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8')); }
  catch { throw providerError('OpenAI returned an invalid identity token.', 'BAD_ID_TOKEN'); }
}

function jwtParts(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw providerError('OpenAI returned an invalid identity token.', 'BAD_ID_TOKEN');
  return {
    header: parseJwtPart(parts[0]),
    claims: parseJwtPart(parts[1]),
    signingInput: Buffer.from(parts[0] + '.' + parts[1]),
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

function verifyJwtSignature(parts, jwk) {
  let key;
  try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
  catch (error) { throw providerError('OpenAI identity verification key was invalid.', 'BAD_ID_TOKEN', null, error); }
  const alg = String(parts.header.alg || '');
  if (alg === 'RS256') return crypto.verify('RSA-SHA256', parts.signingInput, key, parts.signature);
  if (alg === 'PS256') {
    return crypto.verify('RSA-SHA256', parts.signingInput, {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, parts.signature);
  }
  if (alg === 'ES256') {
    return crypto.verify('sha256', parts.signingInput, { key, dsaEncoding: 'ieee-p1363' }, parts.signature);
  }
  throw providerError('OpenAI used an unsupported identity-token algorithm.', 'BAD_ID_TOKEN');
}

function audienceIncludes(audience, clientId) {
  return Array.isArray(audience) ? audience.includes(clientId) : audience === clientId;
}

async function validateIdToken(token, options) {
  const parts = jwtParts(token);
  const discovery = options.discovery;
  const doFetch = options.fetchImpl || fetch;
  let jwks;
  try {
    const response = await doFetch(discovery.jwks_uri, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    jwks = await response.json();
  } catch (error) {
    throw providerError('Could not verify the OpenAI account identity.', 'NETWORK', null, error);
  }
  const jwk = Array.isArray(jwks.keys)
    ? jwks.keys.find((candidate) => candidate.kid === parts.header.kid)
    : null;
  if (!jwk || !verifyJwtSignature(parts, jwk)) {
    throw providerError('OpenAI account identity verification failed.', 'BAD_ID_TOKEN');
  }
  const nowSeconds = Math.floor((options.now || Date.now)() / 1000);
  if (parts.claims.iss !== discovery.issuer || discovery.issuer !== ISSUER) {
    throw providerError('OpenAI returned an unexpected identity issuer.', 'BAD_ID_TOKEN');
  }
  if (!audienceIncludes(parts.claims.aud, options.clientId)) {
    throw providerError('OpenAI returned an identity token for a different app.', 'BAD_ID_TOKEN');
  }
  if (!Number(parts.claims.exp) || Number(parts.claims.exp) <= nowSeconds) {
    throw providerError('The OpenAI identity token has expired.', 'TOKEN_EXPIRED');
  }
  if (options.nonce && parts.claims.nonce !== options.nonce) {
    throw providerError('OpenAI account verification did not match this connection attempt.', 'BAD_ID_TOKEN');
  }
  if (!parts.claims.sub) throw providerError('OpenAI did not return a stable account identity.', 'BAD_ID_TOKEN');
  return parts.claims;
}

function parseScopes(value) {
  return Array.isArray(value) ? value.map(String) : String(value || '').split(/\s+/).filter(Boolean);
}

function safeModels(json) {
  const list = Array.isArray(json && json.models)
    ? json.models
    : (Array.isArray(json && json.data) ? json.data : []);
  return list.filter((model) => !model || model.visibility == null || model.visibility === 'list').map((model) => ({
    id: String(model && (model.slug || model.id) || ''),
    label: String(model && (model.display_name || model.name || model.slug || model.id) || ''),
  })).filter((model) => model.id);
}

function safeErrorDetail(value, secrets = []) {
  let detail = '';
  if (typeof value === 'string') detail = value;
  else if (value && typeof value === 'object') detail = String(value.message || value.code || '');
  detail = detail.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    const token = String(secret || '');
    if (token) detail = detail.split(token).join('[redacted]');
  }
  detail = detail
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/((?:access|refresh|id)[ _-]?token\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
  return detail.slice(0, MAX_ERROR_DETAIL);
}

function parseResponsesStream(raw) {
  let text = '';
  let completed = null;
  let failure = null;
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') continue;
    let event;
    try { event = JSON.parse(value); } catch { continue; }
    if (event.type === 'response.output_text.delta') text += String(event.delta || '');
    if (event.type === 'response.completed') completed = event.response || event;
    if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
      failure = event.error || event.response && event.response.error || event;
    }
  }
  if (failure) {
    const message = String(failure.message || failure.code || 'The ChatGPT plan request did not complete.');
    const code = String(failure.code || '');
    const allowance = code === 'subscription_sharing_usage_limit_exceeded'
      || code === 'subscription_sharing_usage_unavailable';
    throw providerError(
      'ChatGPT plan request failed: ' + message,
      allowance ? 'ALLOWANCE_EXHAUSTED' : 'REQUEST_FAILED',
      allowance ? 429 : null,
    );
  }
  if (!completed) throw providerError('The ChatGPT plan response ended before completion.', 'INCOMPLETE_RESPONSE');
  if (!text && Array.isArray(completed.output)) {
    for (const item of completed.output) {
      for (const content of Array.isArray(item && item.content) ? item.content : []) {
        if (content && content.type === 'output_text') text += String(content.text || '');
      }
    }
  }
  const usage = completed.usage || {};
  return {
    text: text.trim(),
    responseId: String(completed.id || ''),
    usage: {
      inputTokens: Number(usage.input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
      cachedInputTokens: Number(usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0,
    },
  };
}

function htmlPage(title, message) {
  const esc = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  return '<!doctype html><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    '<main style="font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem">' +
    '<h1>' + esc(title) + '</h1><p>' + esc(message) + '</p><p>You can close this window.</p></main>';
}

function createChatgptPlanProvider(options = {}) {
  if (!options.secrets) throw new TypeError('The ChatGPT plan provider needs the secret store.');
  const secretStore = options.secrets;
  const doFetch = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const placement = String(options.placement || 'desktop');
  let discoveryCache = null;
  let discoveryAt = 0;
  let connectState = null;
  let refreshPromise = null;
  let activeGenerations = 0;

  async function discovery() {
    if (discoveryCache && now() - discoveryAt < 60 * 60 * 1000) return discoveryCache;
    let response;
    try { response = await doFetch(DISCOVERY_URL, { headers: { Accept: 'application/json' } }); }
    catch (error) { throw providerError('Could not reach OpenAI authentication.', 'NETWORK', null, error); }
    if (!response.ok) throw providerError('OpenAI authentication discovery failed (HTTP ' + response.status + ').', 'UNAVAILABLE', response.status);
    const value = await response.json();
    if (value.issuer !== ISSUER || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) {
      throw providerError('OpenAI authentication discovery returned an unexpected contract.', 'UNAVAILABLE');
    }
    discoveryCache = value;
    discoveryAt = now();
    return value;
  }

  async function tokenRequest(fields, endpoint) {
    let response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(fields),
      });
    } catch (error) {
      throw providerError('Could not reach OpenAI authentication.', 'NETWORK', null, error);
    }
    const raw = await response.text();
    let value = {};
    try { value = raw ? JSON.parse(raw) : {}; } catch { /* keep empty */ }
    if (!response.ok) {
      const detail = String(value.error_description || value.error || 'HTTP ' + response.status);
      throw providerError('OpenAI authentication failed: ' + detail, response.status === 401 ? 'AUTH_REQUIRED' : 'REQUEST_FAILED', response.status);
    }
    return value;
  }

  async function listModels(accessToken) {
    let response;
    try {
      response = await doFetch(API_BASE + '/models', {
        headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
      });
    } catch (error) {
      throw providerError('Could not load the models available to this ChatGPT account.', 'NETWORK', null, error);
    }
    if (response.status === 401) throw providerError('ChatGPT authentication has expired.', 'AUTH_REQUIRED', 401);
    if (response.status === 429) throw providerError('The ChatGPT plan allowance is currently exhausted.', 'ALLOWANCE_EXHAUSTED', 429);
    if (!response.ok) throw providerError('Could not load ChatGPT plan models (HTTP ' + response.status + ').', 'REQUEST_FAILED', response.status);
    return safeModels(await response.json());
  }

  async function completeAuthorization(attempt, callbackUrl) {
    const url = new URL(callbackUrl, attempt.redirectUri);
    if (url.searchParams.get('state') !== attempt.state) {
      throw providerError('The OpenAI connection response did not match this attempt.', 'AUTH_MISMATCH');
    }
    if (url.searchParams.get('error')) {
      throw providerError('OpenAI connection was not completed: ' + (url.searchParams.get('error_description') || url.searchParams.get('error')), 'AUTH_REQUIRED');
    }
    const code = String(url.searchParams.get('code') || '');
    const callbackClientId = String(url.searchParams.get('client_id') || '');
    const issuedClientId = callbackClientId || attempt.clientId;
    if (!code || !issuedClientId || issuedClientId === DYNAMIC_CLIENT_ID) {
      throw providerError('OpenAI did not return the issued local-app client identity.', 'AUTH_REQUIRED');
    }
    if (attempt.clientId !== DYNAMIC_CLIENT_ID && callbackClientId && callbackClientId !== attempt.clientId) {
      throw providerError('OpenAI returned a different registered client identity for this account.', 'AUTH_MISMATCH');
    }
    const metadata = await discovery();
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      client_id: issuedClientId,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: RESOURCE,
    }, metadata.token_endpoint);
    const scopes = parseScopes(tokens.scope);
    if (!scopes.includes(DIRECT_SCOPE)) {
      throw providerError('This ChatGPT account did not grant direct model use to Feddit Bots.', 'AUTH_REQUIRED');
    }
    const claims = await validateIdToken(tokens.id_token, {
      discovery: metadata,
      clientId: issuedClientId,
      nonce: attempt.nonce,
      fetchImpl: doFetch,
      now,
    });
    const registrationId = crypto.createHash('sha256')
      .update(metadata.issuer + '\n' + claims.sub)
      .digest('hex').slice(0, 24);
    const expiresAt = now() + Math.max(1, Number(tokens.expires_in) || 3600) * 1000;
    const models = await listModels(tokens.access_token);
    secretStore.saveChatgptRegistration(registrationId, {
      clientId: issuedClientId,
      subject: claims.sub,
      email: claims.email || '',
      name: claims.name || claims.preferred_username || '',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt,
      scopes,
      models,
    }, true);
    return { registrationId, models };
  }

  async function beginConnect() {
    if (placement === 'hosted') throw providerError('ChatGPT account connections are available only in local desktop or self-hosted runners.', 'UNAVAILABLE');
    if (connectState && connectState.state === PROVIDER_STATES.CONNECTING) {
      return { authUrl: connectState.authUrl, attemptId: connectState.id };
    }
    const metadata = await discovery();
    const hostId = secretStore.ensureChatgptHostId();
    const active = secretStore.getActiveChatgptRegistration();
    const clientId = active && active.clientId ? active.clientId : DYNAMIC_CLIENT_ID;
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const nonce = base64url(crypto.randomBytes(24));
    const id = crypto.randomUUID();
    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const redirectUri = 'http://127.0.0.1:' + address.port + '/auth/callback';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      resource: RESOURCE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      ext_agent_host_id: hostId,
    });
    if (clientId === DYNAMIC_CLIENT_ID) {
      params.set('agent_name_hint', 'Feddit Bots');
    } else {
      if (active.idToken) params.set('id_token_hint', active.idToken);
      if (active.email) params.set('login_hint', active.email);
    }
    const authUrl = metadata.authorization_endpoint + '?' + params.toString();
    const attempt = { id, clientId, verifier, state, nonce, redirectUri, authUrl };
    connectState = { state: PROVIDER_STATES.CONNECTING, id, authUrl, error: '' };
    const close = () => {
      try { server.close(); } catch { /* already closed */ }
    };
    const timer = setTimeout(() => {
      connectState = { state: PROVIDER_STATES.AUTH_REQUIRED, id, authUrl: '', error: 'The connection window expired.' };
      close();
    }, 10 * 60 * 1000);
    timer.unref();
    server.on('request', async (req, res) => {
      if (req.method !== 'GET' || !String(req.url || '').startsWith('/auth/callback')) {
        res.writeHead(404).end();
        return;
      }
      clearTimeout(timer);
      try {
        await completeAuthorization(attempt, req.url);
        connectState = null;
        const body = htmlPage('ChatGPT connected', 'Feddit Bots can now use the models available through this ChatGPT plan.');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      } catch (error) {
        connectState = { state: PROVIDER_STATES.AUTH_REQUIRED, id, authUrl: '', error: error.message };
        const body = htmlPage('ChatGPT connection failed', error.message);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      } finally {
        close();
      }
    });
    return { authUrl, attemptId: id };
  }

  async function refresh(registration, force = false) {
    if (!force && registration.accessToken && registration.expiresAt > now() + 60000) return registration;
    if (!registration.refreshToken) throw providerError('Reconnect the ChatGPT account to continue.', 'AUTH_REQUIRED');
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const metadata = await discovery();
      const tokens = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: registration.refreshToken,
        client_id: registration.clientId,
        resource: RESOURCE,
      }, metadata.token_endpoint);
      const scopes = parseScopes(tokens.scope || registration.scopes);
      if (!scopes.includes(DIRECT_SCOPE)) throw providerError('The ChatGPT account no longer grants direct model use.', 'AUTH_REQUIRED');
      if (tokens.id_token) {
        await validateIdToken(tokens.id_token, {
          discovery: metadata,
          clientId: registration.clientId,
          fetchImpl: doFetch,
          now,
        });
      }
      return secretStore.saveChatgptRegistration(registration.id, {
        ...registration,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || registration.refreshToken,
        idToken: tokens.id_token || registration.idToken,
        expiresAt: now() + Math.max(1, Number(tokens.expires_in) || 3600) * 1000,
        scopes,
      }, true);
    })();
    try { return await refreshPromise; }
    finally { refreshPromise = null; }
  }

  async function connectedRegistration(forceRefresh = false) {
    const registration = secretStore.getActiveChatgptRegistration();
    if (!registration) throw providerError('Connect a ChatGPT account in Settings before using this provider.', 'AUTH_REQUIRED');
    return refresh(registration, forceRefresh);
  }

  async function status() {
    if (placement === 'hosted') {
      return {
        id: descriptor.id, label: descriptor.label, state: PROVIDER_STATES.UNAVAILABLE,
        detail: 'Personal ChatGPT connections are not available in the hosted workspace.',
        capabilities: descriptor.capabilities, models: [], accounts: [],
      };
    }
    if (connectState && connectState.state === PROVIDER_STATES.CONNECTING) {
      return { id: descriptor.id, label: descriptor.label, state: PROVIDER_STATES.CONNECTING, detail: 'Finish signing in in the browser window.', capabilities: descriptor.capabilities, models: [], accounts: [] };
    }
    const publicView = secretStore.publicChatgptView();
    const active = secretStore.getActiveChatgptRegistration();
    if (!active) {
      return {
        id: descriptor.id, label: descriptor.label, state: PROVIDER_STATES.AUTH_REQUIRED,
        detail: connectState && connectState.error || 'Not connected.',
        capabilities: descriptor.capabilities, models: [], accounts: publicView.accounts,
      };
    }
    try {
      const current = await refresh(active);
      return {
        id: descriptor.id,
        label: descriptor.label,
        state: activeGenerations ? PROVIDER_STATES.BUSY : PROVIDER_STATES.READY,
        detail: current.email ? 'Connected as ' + current.email : (current.name ? 'Connected as ' + current.name : 'Connected.'),
        account: { id: current.id, email: current.email, name: current.name },
        accounts: publicView.accounts,
        models: current.models || [],
        capabilities: descriptor.capabilities,
      };
    } catch (error) {
      return {
        id: descriptor.id, label: descriptor.label,
        state: error.code === 'ALLOWANCE_EXHAUSTED' ? PROVIDER_STATES.LIMIT_REACHED : PROVIDER_STATES.AUTH_REQUIRED,
        detail: error.message, capabilities: descriptor.capabilities, models: active.models || [], accounts: publicView.accounts,
      };
    }
  }

  async function disconnect() {
    const registration = secretStore.getActiveChatgptRegistration();
    if (!registration) return { disconnected: true };
    const metadata = await discovery();
    if (!metadata.revocation_endpoint) throw providerError('OpenAI did not advertise a token revocation endpoint.', 'UNAVAILABLE');
    for (const [token, hint] of [[registration.refreshToken, 'refresh_token'], [registration.accessToken, 'access_token']]) {
      if (!token) continue;
      let response;
      try {
        response = await doFetch(metadata.revocation_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, token_type_hint: hint, client_id: registration.clientId }),
        });
      } catch (error) {
        throw providerError('Could not revoke the ChatGPT connection. It remains saved so revocation can be retried.', 'NETWORK', null, error);
      }
      if (!response.ok) {
        throw providerError('OpenAI did not accept the disconnect request (HTTP ' + response.status + '). The connection remains saved so it can be retried.', 'REQUEST_FAILED', response.status);
      }
    }
    secretStore.deleteChatgptRegistration(registration.id);
    return { disconnected: true };
  }

  async function generate(request = {}) {
    if (placement === 'hosted') throw providerError('ChatGPT plan generation is not available in the hosted workspace.', 'UNAVAILABLE');
    let registration = await connectedRegistration();
    const model = String(request.model || registration.models && registration.models[0] && registration.models[0].id || '');
    if (!model) throw providerError('This ChatGPT account did not expose an available model.', 'UNAVAILABLE');
    const run = async (retried) => {
      const controller = new AbortController();
      let cancelledByCaller = false;
      let timeoutKind = '';
      let responseStarted = false;
      let streamStarted = false;
      let bytesReceived = 0;
      let eventsReceived = 0;
      let eventBuffer = '';
      let progressTimer = null;
      const onAbort = () => { cancelledByCaller = true; controller.abort(); };
      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }
      const progressTimeoutMs = Math.max(1000, Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS);
      const totalTimeoutMs = Math.max(
        progressTimeoutMs,
        Number(request.totalTimeoutMs) || DEFAULT_TOTAL_TIMEOUT_MS,
      );
      const started = now();
      const diagnostics = () => ({
        phase: streamStarted ? 'streaming' : (responseStarted ? 'waiting-for-first-event' : 'waiting-for-response'),
        timeoutKind,
        responseStarted,
        streamStarted,
        bytesReceived,
        eventsReceived,
        elapsedMs: Math.max(0, now() - started),
      });
      const resetProgressTimer = () => {
        clearTimeout(progressTimer);
        progressTimer = setTimeout(() => {
          timeoutKind = 'no-progress';
          controller.abort();
        }, progressTimeoutMs);
      };
      resetProgressTimer();
      const totalTimer = setTimeout(() => {
        timeoutKind = 'total';
        controller.abort();
      }, totalTimeoutMs);
      activeGenerations++;
      try {
        const body = {
          model,
          input: [{
            role: 'user',
            content: String(request.prompt || ''),
          }],
          store: false,
          stream: true,
        };
        if (String(request.system || '').trim()) body.instructions = String(request.system).trim();
        const response = await doFetch(API_BASE + '/responses', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + registration.accessToken,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        responseStarted = true;
        resetProgressTimer();
        if (response.status === 401 && !retried) {
          registration = await connectedRegistration(true);
          return run(true);
        }
        if (response.status === 401) throw providerError('ChatGPT authentication was rejected. Reconnect the account in Settings.', 'AUTH_REQUIRED', 401);
        if (response.status === 429) throw providerError('The ChatGPT plan allowance or rate limit has been reached.', 'ALLOWANCE_EXHAUSTED', 429);
        const raw = await readResponseBody(response, (chunk) => {
          streamStarted = true;
          bytesReceived += Buffer.byteLength(chunk);
          eventBuffer += chunk;
          const lines = eventBuffer.split(/\r?\n/);
          eventBuffer = lines.pop() || '';
          eventsReceived += lines.filter((line) => line.startsWith('data:')).length;
          resetProgressTimer();
        });
        if (eventBuffer.startsWith('data:')) eventsReceived++;
        if (!response.ok) {
          let detail = '';
          try {
            const value = JSON.parse(raw);
            detail = safeErrorDetail(
              value.error && (value.error.message || value.error.code) || value.detail,
              [registration.accessToken, registration.refreshToken, registration.idToken],
            );
          } catch { /* no safe structured detail */ }
          throw providerError('ChatGPT plan request failed (HTTP ' + response.status + ')' + (detail ? ': ' + detail : '') + '.', 'REQUEST_FAILED', response.status);
        }
        const parsed = parseResponsesStream(raw);
        return {
          provider: descriptor.id,
          model,
          text: parsed.text,
          responseId: parsed.responseId,
          ms: now() - started,
          usage: parsed.usage,
          transport: {
            httpStatus: response.status,
            responseStarted,
            streamStarted,
            bytesReceived,
            eventsReceived,
          },
        };
      } catch (error) {
        if (error && error.name === 'AbortError') {
          if (cancelledByCaller) {
            throw providerError('The ChatGPT plan request was cancelled.', 'CANCELLED', null, null, diagnostics());
          }
          const message = timeoutKind === 'total'
            ? 'The ChatGPT plan request did not finish within the bounded ' + timeoutAmount(totalTimeoutMs) + ' limit.'
            : (streamStarted
              ? 'The ChatGPT plan response stopped sending data for ' + timeoutAmount(progressTimeoutMs) + '.'
              : (responseStarted
                ? 'The ChatGPT plan response sent no data for ' + timeoutAmount(progressTimeoutMs) + '.'
                : 'The ChatGPT plan did not begin responding within ' + timeoutAmount(progressTimeoutMs) + '.'));
          throw providerError(message, 'TIMEOUT', null, null, diagnostics());
        }
        if (error instanceof ProviderError) throw error;
        throw providerError('ChatGPT plan network error: ' + error.message, 'NETWORK', null, error);
      } finally {
        clearTimeout(progressTimer);
        clearTimeout(totalTimer);
        if (request.signal) request.signal.removeEventListener('abort', onAbort);
        activeGenerations--;
      }
    };
    return run(false);
  }

  return { descriptor, status, beginConnect, disconnect, generate, listModels };
}

module.exports = {
  ISSUER,
  DISCOVERY_URL,
  API_BASE,
  DYNAMIC_CLIENT_ID,
  RESOURCE,
  SCOPES,
  DIRECT_SCOPE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  descriptor,
  validateIdToken,
  parseResponsesStream,
  safeErrorDetail,
  createChatgptPlanProvider,
};
