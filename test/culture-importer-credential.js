'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { digest } = require('../lib/owners');

const ROOT = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-fetchlayer-credential-'));
const localKey = 'fetchlayer-local-fixture-secret';
const hostedKey = 'fetchlayer-hosted-fixture-secret';
const ownerId = 'o_fetchlayer_operator';
const ownerToken = 'fetchlayer-owner-capability';
let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Accept: 'application/json',
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null, text });
      });
    });
    req.once('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

async function startRunner(placement, extraEnv = {}) {
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FEDDIT_BOT_DATA_DIR: dataDir,
      FEDDIT_BOT_HOST: '127.0.0.1',
      FEDDIT_BOT_PORT: String(port),
      FEDDIT_BOT_PLACEMENT: placement,
      FEDDIT_APP_VERSION: 'credential-contract-test',
      FETCHLAYER_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runner start timed out.')), 10000);
    const append = (chunk) => {
      output += String(chunk);
      if (output.includes('Feddit bot control panel is up.')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Runner exited before ready with code ' + code + '.'));
    });
  });
  await ready;
  return {
    port,
    output: () => output,
    async stop() {
      if (child.exitCode == null) child.kill();
      if (child.exitCode == null) {
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    },
  };
}

function writeHostedOwner() {
  fs.writeFileSync(path.join(dataDir, 'owners.json'), JSON.stringify({
    version: 2,
    owners: [{
      id: ownerId,
      accessHash: digest(ownerToken),
      recoveryHash: digest('unused-recovery'),
      createdAt: new Date().toISOString(),
      recoveredAt: null,
      activityHash: null,
      lastActiveAt: null,
    }],
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function run() {
  let runner = await startRunner('desktop', { FETCHLAYER_API_KEY: hostedKey });
  try {
    let response = await requestJson(runner.port, 'GET', '/api/culture-imports/source-credential');
    eq(response.status, 200, 'desktop credential state endpoint is available on loopback');
    eq(response.json.source, { provider: 'FetchLayer', hasKey: false },
      'desktop ignores the hosted environment path and starts from its local secret store');

    response = await requestJson(runner.port, 'PUT', '/api/culture-imports/source-credential', {
      fetchLayerApiKey: localKey,
    });
    eq(response.status, 200, 'desktop can save the importer key through its local backend');
    eq(response.json.source, { provider: 'FetchLayer', hasKey: true },
      'desktop returns presence-only FetchLayer state after saving');
    ok(!response.text.includes(localKey), 'desktop credential response never echoes the stored key');
    ok(!runner.output().includes(localKey), 'desktop runner logs never contain the stored key');
  } finally {
    await runner.stop();
  }

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
  eq(stored.fetchLayerApiKey, localKey, 'desktop persists FetchLayer in the existing protected secret file');

  runner = await startRunner('desktop');
  try {
    const response = await requestJson(runner.port, 'GET', '/api/culture-imports/source-credential');
    eq(response.json.source.hasKey, true, 'packaged-style desktop restart reuses the persisted key');
    ok(!response.text.includes(localKey), 'desktop restart still exposes only configured state');
  } finally {
    await runner.stop();
  }

  writeHostedOwner();
  const hostedHeaders = { 'X-Feddit-Bot-Owner': ownerToken };
  runner = await startRunner('hosted', { FEDDIT_POPULATION_ADMIN_OWNER_IDS: ownerId });
  try {
    let response = await requestJson(runner.port, 'GET', '/api/culture-imports/source-credential', undefined, hostedHeaders);
    eq(response.json.source.hasKey, false,
      'hosted ignores a desktop-store key when its server environment secret is absent');
    response = await requestJson(runner.port, 'PUT', '/api/culture-imports/source-credential', {
      fetchLayerApiKey: 'must-not-save-on-hosted',
    }, hostedHeaders);
    eq(response.status, 403, 'hosted operators cannot write the server FetchLayer secret through the browser API');
  } finally {
    await runner.stop();
  }

  runner = await startRunner('hosted', {
    FEDDIT_POPULATION_ADMIN_OWNER_IDS: ownerId,
    FETCHLAYER_API_KEY: hostedKey,
  });
  try {
    const response = await requestJson(runner.port, 'GET', '/api/culture-imports/source-credential', undefined, hostedHeaders);
    eq(response.json.source, { provider: 'FetchLayer', hasKey: true },
      'hosted importer sees the server environment credential for an authorised operator');
    ok(!response.text.includes(hostedKey), 'hosted browser response never exposes the environment secret');
    ok(!runner.output().includes(hostedKey), 'hosted runner logs never contain the environment secret');
  } finally {
    await runner.stop();
  }

  console.log('culture importer credential paths: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
