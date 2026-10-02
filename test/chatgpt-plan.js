'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  ISSUER,
  DISCOVERY_URL,
  API_BASE,
  DYNAMIC_CLIENT_ID,
  DIRECT_SCOPE,
  parseResponsesStream,
  safeErrorDetail,
  validateIdToken,
  createChatgptPlanProvider,
} = require('../lib/providers/chatgpt-plan');

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSecrets(initial = null) {
  let registration = initial ? { ...initial } : null;
  let deleted = false;
  return {
    ensureChatgptHostId: () => 'urn:uuid:test-host',
    getActiveChatgptRegistration: () => registration && !deleted ? { ...registration } : null,
    publicChatgptView: () => ({
      activeRegistrationId: registration && !deleted ? registration.id : '',
      accounts: registration && !deleted ? [{
        id: registration.id,
        email: registration.email,
        name: registration.name,
        models: registration.models || [],
      }] : [],
    }),
    saveChatgptRegistration: (id, next) => {
      registration = { ...(registration || {}), ...next, id };
      deleted = false;
      return { ...registration };
    },
    deleteChatgptRegistration: (id) => {
      if (!registration || registration.id !== id) return false;
      deleted = true;
      return true;
    },
    current: () => registration && !deleted ? { ...registration } : null,
  };
}

function discovery() {
  return {
    issuer: ISSUER,
    authorization_endpoint: ISSUER + '/api/accounts/authorize',
    token_endpoint: ISSUER + '/api/accounts/oauth/token',
    revocation_endpoint: ISSUER + '/api/accounts/oauth/revoke',
    jwks_uri: ISSUER + '/.well-known/jwks.json',
  };
}

function signedToken(privateKey, kid, claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = header + '.' + payload;
  return input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
}

(async () => {
  const now = 1790000000000;
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-key';
  const token = signedToken(pair.privateKey, jwk.kid, {
    iss: ISSUER,
    aud: 'oaiapp_test',
    exp: Math.floor(now / 1000) + 3600,
    sub: 'subject-test',
    nonce: 'nonce-test',
    email: 'person@example.test',
  });
  const claims = await validateIdToken(token, {
    discovery: { issuer: ISSUER, jwks_uri: 'https://example.test/jwks' },
    clientId: 'oaiapp_test',
    nonce: 'nonce-test',
    now: () => now,
    fetchImpl: async () => jsonResponse({ keys: [jwk] }),
  });
  assert.equal(claims.sub, 'subject-test');
  await assert.rejects(
    () => validateIdToken(token, {
      discovery: { issuer: ISSUER, jwks_uri: 'https://example.test/jwks' },
      clientId: 'different-client',
      nonce: 'nonce-test',
      now: () => now,
      fetchImpl: async () => jsonResponse({ keys: [jwk] }),
    }),
    (error) => error.code === 'BAD_ID_TOKEN',
  );

  const completed = parseResponsesStream([
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    'data: {"type":"response.output_text.delta","delta":" there"}',
    'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":4,"output_tokens":2}}}',
    '',
  ].join('\n'));
  assert.equal(completed.text, 'Hello there');
  assert.equal(completed.responseId, 'resp_1');
  const completedStructured = parseResponsesStream([
    'data: {"type":"response.completed","response":{"id":"resp_structured","output":[{"content":[{"type":"output_text","text":"{\\"ok\\":true}"}]}]}}',
    '',
  ].join('\n'));
  assert.equal(completedStructured.text, '{"ok":true}',
    'a completed structured response is recovered from the final response envelope');
  assert.throws(
    () => parseResponsesStream('data: {"type":"response.failed","error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}}'),
    (error) => error.code === 'ALLOWANCE_EXHAUSTED' && error.status === 429,
  );

  const calls = [];
  const secrets = makeSecrets({
    id: 'saved-account',
    clientId: 'oaiapp_saved',
    subject: 'saved-subject',
    email: 'saved@example.test',
    name: 'Saved Person',
    idToken: 'saved-id-token',
    accessToken: 'saved-access-token',
    refreshToken: 'saved-refresh-token',
    expiresAt: now + 3600000,
    scopes: [DIRECT_SCOPE],
    models: [{ id: 'gpt-test', label: 'GPT Test' }],
  });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === DISCOVERY_URL) return jsonResponse(discovery());
    if (String(url) === API_BASE + '/responses') {
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"Generated"}',
        'data: {"type":"response.completed","response":{"id":"resp_generated","usage":{"input_tokens":7,"output_tokens":1}}}',
        '',
      ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (String(url) === discovery().revocation_endpoint) return new Response('', { status: 200 });
    throw new Error('Unexpected fetch ' + url);
  };
  const provider = createChatgptPlanProvider({
    secrets,
    placement: 'desktop',
    fetchImpl,
    now: () => now,
  });
  const status = await provider.status();
  assert.equal(status.state, 'ready');
  assert.equal(JSON.stringify(status).includes('saved-access-token'), false);
  const output = await provider.generate({
    system: 'System instruction',
    prompt: 'User instruction',
    model: 'gpt-test',
    temperature: 0.1,
    numPredict: 10,
  });
  assert.equal(output.text, 'Generated');
  const generationCall = calls.find((call) => call.url === API_BASE + '/responses');
  const generationBody = JSON.parse(generationCall.options.body);
  assert.deepEqual(generationBody, {
    model: 'gpt-test',
    input: [{ role: 'user', content: 'User instruction' }],
    store: false,
    stream: true,
    instructions: 'System instruction',
  }, 'unsupported temperature and output-token options are not sent to the plan endpoint');
  assert.equal(generationBody.input[0].role, 'user');
  assert.equal(generationBody.input[0].content, 'User instruction');

  const detailProvider = createChatgptPlanProvider({
    secrets: makeSecrets({
      id: 'detail-account',
      clientId: 'oaiapp_detail',
      subject: 'detail-subject',
      accessToken: 'secret-access-token-for-test',
      refreshToken: 'secret-refresh-token-for-test',
      idToken: 'secret-id-token-for-test',
      expiresAt: now + 3600000,
      scopes: [DIRECT_SCOPE],
      models: [{ id: 'gpt-test', label: 'GPT Test' }],
    }),
    placement: 'desktop',
    now: () => now,
    fetchImpl: async (url) => {
      if (String(url) === API_BASE + '/responses') {
        return jsonResponse({
          detail: 'Invalid input near Bearer bearer-secret and secret-access-token-for-test; access_token=sk-project-secret12345 ' + 'x'.repeat(400),
        }, 400);
      }
      throw new Error('Unexpected fetch ' + url);
    },
  });
  await assert.rejects(
    () => detailProvider.generate({ prompt: 'safe prompt', model: 'gpt-test' }),
    (error) => {
      assert.equal(error.code, 'REQUEST_FAILED');
      assert.equal(error.status, 400);
      assert.match(error.message, /Invalid input near Bearer \[redacted\]/);
      assert.equal(error.message.includes('secret-access-token-for-test'), false);
      assert.equal(error.message.includes('bearer-secret'), false);
      assert.equal(error.message.includes('sk-project-secret12345'), false);
      assert.ok(error.message.length < 320, 'provider diagnostics remain bounded');
      return true;
    },
  );
  assert.equal(safeErrorDetail({ message: 'safe detail' }), 'safe detail');

  const reconnect = await provider.beginConnect();
  const authUrl = new URL(reconnect.authUrl);
  assert.equal(authUrl.origin + authUrl.pathname, ISSUER + '/api/accounts/authorize');
  assert.equal(authUrl.searchParams.get('client_id'), 'oaiapp_saved');
  assert.equal(authUrl.searchParams.get('id_token_hint'), 'saved-id-token');
  assert.equal(authUrl.searchParams.get('login_hint'), 'saved@example.test');
  assert.equal(authUrl.searchParams.has('agent_name_hint'), false,
    'returning sign-in does not masquerade as a new registration');
  const callback = new URL(authUrl.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authUrl.searchParams.get('state'));
  callback.searchParams.set('error', 'access_denied');
  const cancelled = await fetch(callback);
  assert.equal(cancelled.status, 400);

  const disconnected = await provider.disconnect();
  assert.equal(disconnected.disconnected, true);
  assert.equal(secrets.current(), null);
  assert.equal(calls.filter((call) => call.url === discovery().revocation_endpoint).length, 2,
    'disconnect revokes refresh and access tokens before deleting local credentials');

  const expiredSecrets = makeSecrets({
    id: 'expired-account',
    clientId: 'oaiapp_expired',
    subject: 'expired-subject',
    accessToken: 'expired-access',
    refreshToken: 'old-refresh',
    expiresAt: now - 1,
    scopes: [DIRECT_SCOPE],
    models: [{ id: 'gpt-test', label: 'GPT Test' }],
  });
  const refreshProvider = createChatgptPlanProvider({
    secrets: expiredSecrets,
    placement: 'desktop',
    now: () => now,
    fetchImpl: async (url) => {
      if (String(url) === DISCOVERY_URL) return jsonResponse(discovery());
      if (String(url) === discovery().token_endpoint) return jsonResponse({
        access_token: 'fresh-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        scope: DIRECT_SCOPE,
      });
      if (String(url) === API_BASE + '/responses') {
        return new Response([
          'data: {"type":"response.output_text.delta","delta":"Refreshed"}',
          'data: {"type":"response.completed","response":{"id":"resp_refresh"}}',
          '',
        ].join('\n'), { status: 200 });
      }
      throw new Error('Unexpected fetch ' + url);
    },
  });
  const refreshed = await refreshProvider.generate({ prompt: 'test', model: 'gpt-test' });
  assert.equal(refreshed.text, 'Refreshed');
  assert.equal(expiredSecrets.current().refreshToken, 'rotated-refresh',
    'rotating refresh credentials are saved atomically by the secret-store boundary');

  const freshSecrets = makeSecrets();
  const freshProvider = createChatgptPlanProvider({
    secrets: freshSecrets,
    placement: 'desktop',
    now: () => now,
    fetchImpl: async (url) => {
      if (String(url) === DISCOVERY_URL) return jsonResponse(discovery());
      throw new Error('Unexpected fetch ' + url);
    },
  });
  const firstConnect = await freshProvider.beginConnect();
  const firstUrl = new URL(firstConnect.authUrl);
  assert.equal(firstUrl.searchParams.get('client_id'), DYNAMIC_CLIENT_ID);
  assert.equal(firstUrl.searchParams.get('agent_name_hint'), 'Feddit Bots');
  assert.equal(firstUrl.searchParams.get('ext_agent_host_id'), 'urn:uuid:test-host');
  const firstCallback = new URL(firstUrl.searchParams.get('redirect_uri'));
  firstCallback.searchParams.set('state', firstUrl.searchParams.get('state'));
  firstCallback.searchParams.set('error', 'access_denied');
  await fetch(firstCallback);

  console.log('chatgpt-plan: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
