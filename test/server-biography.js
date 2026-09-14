'use strict';

// End-to-end biography contract: the runner keeps public Feddit profile text
// separate from private persona instructions, reads the authoritative live
// value, and never commits a local change when Feddit rejects the update.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function requestJson(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    req.once('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

async function run() {
  const fedditPort = await unusedPort();
  const runnerPort = await unusedPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-biography-contract-'));
  let remoteBio = '';
  let registration = null;

  const fakeFeddit = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/register') {
      registration = await readJson(req);
      remoteBio = String(registration.description || '');
      return send(res, 201, {
        bot: { username: registration.username, description: remoteBio },
        token: 'feddit_' + 'ab'.repeat(32),
      });
    }
    if (req.method === 'GET' && /^\/api\/v1\/u\/[^/]+\.json$/.test(req.url)) {
      return send(res, 200, { bot: { username: 'separate_bot', bio: remoteBio, description: remoteBio } });
    }
    if (req.method === 'POST' && req.url === '/api/v1/me') {
      const patch = await readJson(req);
      if (patch.bio === 'REJECT THIS') {
        return send(res, 500, { error: { code: 'test_failure', message: 'Simulated Feddit write failure.' } });
      }
      remoteBio = String(patch.bio || '');
      return send(res, 200, { bot: { username: 'separate_bot', bio: remoteBio, description: remoteBio } });
    }
    return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  });
  await new Promise((resolve, reject) => {
    fakeFeddit.once('error', reject);
    fakeFeddit.listen(fedditPort, '127.0.0.1', resolve);
  });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FEDDIT_BOT_DATA_DIR: dataDir,
      FEDDIT_BOT_HOST: '127.0.0.1',
      FEDDIT_BOT_PORT: String(runnerPort),
      FEDDIT_BOT_PLACEMENT: 'desktop',
      FEDDIT_SITE_BASE: 'http://127.0.0.1:' + fedditPort,
      FEDDIT_APP_VERSION: 'biography-contract',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Runner startup timed out:\n' + output)), 10000);
      const append = (chunk) => {
        output += chunk.toString('utf8');
        if (output.includes('Feddit bot control panel is up.')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('exit', (code) => reject(new Error('Runner exited early with ' + code + ':\n' + output)));
    });

    const created = await requestJson(runnerPort, 'POST', '/api/profiles', {
      fedditUsername: 'separate_bot',
      fedditBio: 'A public introduction.',
      persona: 'Private instructions that must never appear publicly.',
      enabled: false,
    });
    eq(created.status, 201, 'draft with a separate biography is created');
    const id = created.json.profile.id;

    const ignored = await requestJson(runnerPort, 'PUT', '/api/profiles/' + id, {
      fedditBio: 'Attempted ordinary-settings overwrite.',
      persona: 'Updated private instructions.',
    });
    eq(ignored.status, 200, 'ordinary settings update succeeds');
    let opened = await requestJson(runnerPort, 'GET', '/api/profiles/' + id);
    eq(opened.json.profile.fedditBio, 'A public introduction.', 'ordinary settings cannot overwrite the biography');
    eq(opened.json.profile.persona, 'Updated private instructions.', 'private persona remains independently editable');

    const draftBio = await requestJson(runnerPort, 'PUT', '/api/profiles/' + id + '/biography', {
      bio: 'A revised public introduction.',
    });
    eq(draftBio.status, 200, 'draft biography has an explicit save path');
    eq(draftBio.json.profile.fedditBioStatus, 'draft', 'draft biography stays local until registration');

    const registered = await requestJson(runnerPort, 'POST', '/api/profiles/' + id + '/register');
    eq(registered.status, 200, 'draft identity registers');
    eq(registration.description, 'A revised public introduction.', 'registration uses the biography');
    eq(registration.description === 'Updated private instructions.', false, 'registration never uses the persona as biography');

    remoteBio = 'Changed directly on Feddit.';
    opened = await requestJson(runnerPort, 'GET', '/api/profiles/' + id);
    eq(opened.json.profile.fedditBio, 'Changed directly on Feddit.', 'opening the editor reads the authoritative Feddit biography');
    eq(opened.json.profile.fedditBioStatus, 'loaded', 'editor reports that the live biography loaded');

    const saved = await requestJson(runnerPort, 'PUT', '/api/profiles/' + id + '/biography', {
      bio: 'Saved through either runner interface.',
    });
    eq(saved.status, 200, 'registered biography is saved through Feddit');
    eq(remoteBio, 'Saved through either runner interface.', 'Feddit received the explicit biography update');

    const rejected = await requestJson(runnerPort, 'PUT', '/api/profiles/' + id + '/biography', {
      bio: 'REJECT THIS',
    });
    eq(rejected.status, 502, 'a failed Feddit write is surfaced');
    eq(remoteBio, 'Saved through either runner interface.', 'failed write preserves the previous Feddit biography');
    opened = await requestJson(runnerPort, 'GET', '/api/profiles/' + id);
    eq(opened.json.profile.fedditBio, 'Saved through either runner interface.', 'failed write does not create local biography drift');

    console.log('server biography: ' + checks + ' checks passed');
  } finally {
    if (child.exitCode == null) child.kill();
    await new Promise((resolve) => fakeFeddit.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
