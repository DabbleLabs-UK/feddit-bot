'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { digest } = require('../lib/owners');
const store = require('../lib/store');
const ROOT = path.resolve(__dirname, '..');

// Only this fixture's child loads the preload. All generation is a recorded
// in-process stub. Snapshot reads/status probes are fixtures; fetch is forbidden.
function installFixture({ root, log }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const record = (call) => {
    const calls = JSON.parse(fs.readFileSync(log, 'utf8'));
    calls.push(call);
    fs.writeFileSync(log, JSON.stringify(calls));
  };
  const forbidden = async () => { record({ forbidden: true }); throw new Error('Fixture forbids external calls'); };
  global.fetch = forbidden;
  require(path.join(root, 'lib/feddit')).request = async (route) => {
    record({ read: route });
    if (route.startsWith('/evidence.json?')) return { ok: true, data: { schemaVersion: 1, source: 'feddit-current-votes',
      generatedAt: new Date().toISOString(), items: [], coverage: { warnings: [] } } };
    if (route.startsWith('/front/new?')) return { ok: true, data: { kind: 'Listing', data: { after: null, children: [] } } };
    if (route === '/feddits') return { ok: true, data: { feddits: [] } };
    throw new Error('Unexpected fixture read: ' + route);
  };
  const providers = require(path.join(root, 'lib/providers'));
  providers.status = async (id) => { record({ status: id }); return { id, state: 'unavailable' }; };
  providers.ollama.isBusy = () => false;
  providers.generate = async (request) => {
    record({ kind: request.kind, prompt: request.prompt });
    if (request.kind !== 'preview') throw new Error('Only the explicit preview fixture may generate');
    return { text: 'A fixture reply.', provider: 'ollama', model: request.model, ms: 0, usage: {} };
  };
}

async function port() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const value = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return value;
}

async function run(placement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-writing-api-'));
  let child;
  let base;
  const hosted = placement === 'hosted';
  const profileFile = path.join(dir, 'profiles.json');
  const log = path.join(dir, 'calls.json');
  const headers = { 'content-type': 'application/json', 'x-feddit-bot-owner': 'admin-capability' };
  const request = async (route = '/api/naturalness/writing-canary', method = 'GET', body, extraHeaders = {}) => {
    const response = await fetch(base + route, {
      method, headers: { ...headers, ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const read = () => JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const calls = () => JSON.parse(fs.readFileSync(log, 'utf8'));
  const settingsWithoutCanary = (data) => {
    const copy = structuredClone(data);
    delete copy.settings.writingCanary;
    return copy;
  };
  async function stop() {
    if (child && child.exitCode === null) {
      const ended = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await ended;
    }
    child = null;
  }
  async function start() {
    const apiPort = await port();
    base = 'http://127.0.0.1:' + apiPort;
    child = spawn(process.execPath, ['--require', path.join(dir, 'preload.js'), 'server.js'], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, FEDDIT_BOT_DATA_DIR: dir, FEDDIT_BOT_HOST: '127.0.0.1', FEDDIT_BOT_PORT: String(apiPort),
        FEDDIT_BOT_PLACEMENT: placement, FEDDIT_POPULATION_ADMIN_OWNER_IDS: 'admin',
        FEDDIT_SITE_BASE: 'http://127.0.0.1:1',
      },
    });
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 15000);
      const append = (chunk) => {
        output += chunk;
        if (output.includes('Feddit bot control panel is up.')) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
    });
  }
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'owners.json'), JSON.stringify({ version: 2, owners: ['admin', 'other'].map((id) => ({
      id, accessHash: digest(id + '-capability'), recoveryHash: digest(id + '-recovery'), createdAt: now,
    })) }));
    const groups = [{ id: 'group1', name: 'Fixture group', ownerId: hosted ? 'admin' : '' }];
    const profiles = store.migrateProfiles([
      { id: 'owned', ownerId: hosted ? 'admin' : null, fedditUsername: 'owned_public', groupId: 'group1',
        persona: 'PRIVATE_PERSONA', toneNotes: 'PRIVATE_TONE', fedditBio: 'PRIVATE_BIO', sched: { nextCommentAt: 12345 },
        enabled: false, dryRun: true, provider: 'ollama' },
      { id: 'spare', ownerId: hosted ? 'admin' : null, fedditUsername: 'spare_public', enabled: false, dryRun: true },
      { id: 'third', ownerId: hosted ? 'admin' : null, fedditUsername: 'third_public', enabled: false, dryRun: true },
      { id: 'population', botOrigin: 'system', fedditUsername: 'system_public', enabled: false, dryRun: true },
      { id: 'hidden', ownerId: 'other', fedditUsername: 'PRIVATE_OTHER_IDENTITY', enabled: false, dryRun: true },
    ], store.DATA_SCHEMA_VERSION);
    fs.writeFileSync(profileFile, JSON.stringify({ schemaVersion: store.DATA_SCHEMA_VERSION, groups, profiles,
      settings: store.migrateSettings({ paused: true, writingCanary: { version: 1, profileIds: hosted ? ['hidden'] : [] } }),
    }));
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ schemaVersion: 5, deepseekApiKey: 'PRIVATE_API_KEY',
      fedditTokens: { owned: 'PRIVATE_BEARER_TOKEN', hidden: 'PRIVATE_OTHER_TOKEN' },
    }));
    fs.writeFileSync(log, '[]');
    fs.writeFileSync(path.join(dir, 'preload.js'), '(' + installFixture.toString() + ')(' + JSON.stringify({ root: ROOT, log }) + ');');
    await start();
    const before = read();
    const beforeBytes = fs.readFileSync(profileFile, 'utf8');
    const secretBytes = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    const ownerBytes = fs.readFileSync(path.join(dir, 'owners.json'), 'utf8');

    if (hosted) {
      for (const method of ['GET', 'PUT']) {
        assert.equal((await request(undefined, method, method === 'PUT' ? { profileIds: [] } : undefined,
          { 'x-feddit-bot-owner': '' })).status, 401, 'anonymous cannot access canary controls');
        assert.equal((await request(undefined, method, method === 'PUT' ? { profileIds: [] } : undefined,
          { 'x-feddit-bot-owner': 'other-capability' })).status, 404, 'ordinary owner cannot access operator controls');
      }
    }
    const initial = await request();
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.data.profileIds, [], 'unmanaged membership is hidden');
    assert.equal(initial.data.releasedVersion, 1);
    assert.equal(initial.data.canaryVersion, 3);
    assert.equal(initial.data.maxProfiles, 3);
    assert.deepEqual(Object.keys(initial.data).sort(), ['canaryVersion', 'maxProfiles', 'profileIds', 'profiles', 'releasedVersion']);
    assert.deepEqual(initial.data.profiles.find((profile) => profile.id === 'owned'), { id: 'owned', name: 'owned_public' });
    assert.doesNotMatch(JSON.stringify(initial.data), /PRIVATE_PERSONA|PRIVATE_TONE|PRIVATE_BIO|PRIVATE_API_KEY|PRIVATE_BEARER_TOKEN|capability/);
    if (hosted) assert.doesNotMatch(JSON.stringify(initial.data), /hidden|PRIVATE_OTHER/);
    assert.equal((await request(undefined, 'POST', { profileIds: ['owned'] })).status, 404);
    for (const body of [null, [], {}, { profileIds: null }, { profileIds: ['owned'], version: 1 },
      { profileIds: ['owned'], paused: false }, { profileIds: ['owned', 'owned'] }, { profileIds: ['owned', 'bad id'] },
      { profileIds: ['a'.repeat(101)] }, { profileIds: ['owned', 'spare', 'third', 'population'] }]) {
      assert.equal((await request(undefined, 'PUT', body)).status, 400, 'strict replacement body');
    }
    assert.equal((await fetch(base + '/api/naturalness/writing-canary', { method: 'PUT', headers, body: '{' })).status, 400);
    for (const extra of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/json-invalid' }]) {
      assert.equal((await request(undefined, 'PUT', { profileIds: ['owned'] }, extra)).status, 415);
    }
    for (const extra of [{ origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await request(undefined, 'PUT', { profileIds: ['owned'] }, extra)).status, 403);
    }
    assert.equal((await request(undefined, 'PUT', { profileIds: ['missing'] })).status, 404);
    if (hosted) assert.equal((await request(undefined, 'PUT', { profileIds: ['hidden'] })).status, 404, 'cannot edit private owner membership');
    assert.equal((await request('/api/settings', 'PUT', { writingCanary: { version: 1, profileIds: ['owned'] }, paused: false })).status,
      hosted ? 403 : 400, 'generic settings cannot enroll or partially apply a rejected request');
    assert.equal(fs.readFileSync(profileFile, 'utf8'), beforeBytes, 'GET and all rejected requests leave disk unchanged');
    assert.deepEqual(calls(), [], 'control requests do not call providers or upstream');

    const enrolled = await request(undefined, 'PUT', { profileIds: ['owned', 'population'] }, { origin: base });
    assert.equal(enrolled.status, 200);
    assert.deepEqual(enrolled.data.profileIds, ['owned', 'population']);
    assert.deepEqual(read().settings.writingCanary, { version: 1, profileIds: hosted ? ['hidden', 'owned', 'population'] : ['owned', 'population'] });
    assert.deepEqual(settingsWithoutCanary(read()), settingsWithoutCanary(before), 'membership does not edit profiles, deadlines, groups, enablement or other settings');
    assert.deepEqual(calls(), [], 'enrollment itself does not fetch evidence or generate');
    const enrolledSnapshot = await request('/api/naturalness');
    assert.equal(enrolledSnapshot.status, 200);
    assert.deepEqual(enrolledSnapshot.data.writingRollout, enrolled.data, 'snapshot shows current manageable enrollment');
    assert(calls().every((call) => call.read || call.status), 'snapshot uses only fixture reads and status probes');
    fs.writeFileSync(log, '[]');
    if (hosted) {
      const enrolledBytes = fs.readFileSync(profileFile, 'utf8');
      assert.equal((await request(undefined, 'PUT', { profileIds: ['owned', 'spare', 'third'] })).status, 409, 'hidden membership counts towards global cap');
      assert.equal(fs.readFileSync(profileFile, 'utf8'), enrolledBytes);
    }
    await stop();
    await start();
    assert.deepEqual((await request()).data.profileIds, ['owned', 'population'], 'API enrollment survives server restart');
    const removed = await request(undefined, 'PUT', { profileIds: [] });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data.profileIds, []);
    assert.deepEqual(read().settings.writingCanary, { version: 1, profileIds: hosted ? ['hidden'] : [] }, 'removal preserves unmanaged membership');
    assert.deepEqual(settingsWithoutCanary(read()), settingsWithoutCanary(before));
    assert.equal(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'), secretBytes, 'controls do not alter secrets');
    assert.equal(fs.readFileSync(path.join(dir, 'owners.json'), 'utf8'), ownerBytes, 'controls do not alter owner state');
    assert.deepEqual(calls(), [], 'enrollment/removal/restart never generates or fetches');

    const snapshotBytes = fs.readFileSync(profileFile, 'utf8');
    const snapshot = await request('/api/naturalness');
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.data.writingRollout, removed.data, 'Naturalness exposes the same scoped read-only rollout summary');
    if (hosted) assert.doesNotMatch(JSON.stringify(snapshot.data.writingRollout), /hidden|PRIVATE_OTHER/);
    assert.equal(fs.readFileSync(profileFile, 'utf8'), snapshotBytes, 'snapshot is read-only');
    assert(calls().every((call) => call.read || call.status), 'snapshot uses only fixture public reads/status probes');
    fs.writeFileSync(log, '[]');

    assert.equal((await request(undefined, 'PUT', { profileIds: ['spare', 'third'] })).status, 200);
    assert.equal((await request('/api/profiles/spare', 'DELETE')).status, 200);
    const afterDelete = read();
    assert(afterDelete.settings.writingCanary.profileIds.includes('spare'), 'fixture contains the deleted profile enrollment');
    const replacementIds = hosted ? ['owned', 'third'] : ['owned', 'third', 'population'];
    const replacement = await request(undefined, 'PUT', { profileIds: replacementIds });
    assert.equal(replacement.status, 200, 'deleting an enrolled profile frees the slot for a full replacement');
    assert.deepEqual(replacement.data.profileIds, replacementIds);
    assert.deepEqual(read().settings.writingCanary.profileIds, hosted ? ['hidden', ...replacementIds] : replacementIds,
      'replacement drops deleted IDs and preserves existing foreign-owner membership');
    assert.deepEqual(settingsWithoutCanary(read()), settingsWithoutCanary(afterDelete), 'replacement only changes enrollment');

    assert.equal((await request('/api/profiles/third', 'DELETE')).status, 200);
    const beforeClear = read();
    assert(beforeClear.settings.writingCanary.profileIds.includes('third'), 'fixture contains another stale selection');
    assert.equal((await request(undefined, 'PUT', { profileIds: [] })).status, 200);
    assert.deepEqual(read().settings.writingCanary, { version: 1, profileIds: hosted ? ['hidden'] : [] },
      'empty replacement clears nonexistent selections while retaining real foreign-owner enrollment');
    assert.deepEqual(settingsWithoutCanary(read()), settingsWithoutCanary(beforeClear), 'clearing stale enrollment does not edit profiles');
    assert.deepEqual(calls(), [], 'deletion and enrollment controls never call providers or upstream');

    if (!hosted) {
      assert.equal((await request(undefined, 'PUT', { profileIds: ['owned'] })).status, 200);
      const preview = await request('/api/profiles/owned/test-generate', 'POST', { title: 'Fixture title', body: 'Fixture body' });
      assert.equal(preview.status, 200);
      assert.deepEqual(calls(), [{ kind: 'preview', prompt:
        'You are browsing a forum called Feddit. Write a single reply to this post. ' +
        'Reply in character, plain text, no preamble, no quotes around it.\n\n' +
        'POST TITLE: Fixture title\nPOST BODY: Fixture body\n\nYour reply:' }],
      'enrolled manual preview preserves the exact released prompt and supplied context with mocked generation');
    }
    console.log('PASS writing canary API (' + placement + '): access, strict input, scoped replacement, persistence, no control side effects or secrets');
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await run('desktop');
  await run('advanced');
  await run('hosted');
})().catch((error) => { console.error(error); process.exitCode = 1; });
