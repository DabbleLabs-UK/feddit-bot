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
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Accept: 'application/json',
        ...(token ? { 'X-Feddit-Bot-Owner': token } : {}),
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* static HTML or empty response */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.once('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-population-server-'));
  const ownerId = 'o_population_operator';
  const accessToken = 'test-population-operator-capability';
  fs.writeFileSync(path.join(dataDir, 'owners.json'), JSON.stringify({
    version: 2,
    owners: [{
      id: ownerId,
      accessHash: digest(accessToken),
      recoveryHash: digest('unused-recovery'),
      createdAt: new Date().toISOString(),
      recoveredAt: null,
      activityHash: null,
      lastActiveAt: null,
    }],
  }, null, 2));
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FEDDIT_BOT_DATA_DIR: dataDir,
      FEDDIT_BOT_HOST: '127.0.0.1',
      FEDDIT_BOT_PORT: String(port),
      FEDDIT_BOT_PLACEMENT: 'hosted',
      FEDDIT_POPULATION_ADMIN_OWNER_IDS: ownerId,
      FEDDIT_APP_VERSION: 'population-contract',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out starting hosted runner:\n' + output)), 10000);
      const append = (chunk) => {
        output += chunk.toString('utf8');
        if (output.includes('Feddit bot control panel is up.')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Hosted runner exited early with ' + code + ':\n' + output));
      });
    });

    const shell = await request(port, 'GET', '/population.html');
    eq(shell.status, 200, 'hosted placement serves the population operator shell');
    ok(shell.text.includes('Feddit background population'), 'operator shell identifies the staged population tool');

    const noCapability = await request(port, 'GET', '/api/population');
    eq(noCapability.status, 401, 'population state requires an existing private workspace capability');

    const ordinarySession = await request(port, 'POST', '/api/session');
    eq(ordinarySession.status, 201, 'fixture can create an ordinary hosted owner');
    const ordinary = await request(port, 'GET', '/api/population', undefined, ordinarySession.json.accessToken);
    eq(ordinary.status, 404, 'ordinary hosted owners cannot discover the operator API');

    const initial = await request(port, 'GET', '/api/population', undefined, accessToken);
    eq(initial.status, 200, 'configured existing owner can inspect population state');
    eq(initial.json.cohorts, [], 'population begins with no implicit synthetic bots');

    const created = await request(port, 'POST', '/api/population/cohorts', { count: 2 }, accessToken);
    eq(created.status, 201, 'operator can request a bounded staged cohort');
    eq(created.json.cohort.requestedCount, 2, 'operator request preserves the bounded cohort size');
    eq(created.json.cohort.status, 'generating', 'generation alone does not stage or activate accounts');

    const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8')).jobs;
    eq(jobs.length, 1, 'cohort request creates only one durable generation job');
    eq(jobs[0].source, 'feddit-population', 'durable job records system-population provenance');
    eq(jobs[0].priority, 'background', 'durable seed job uses background priority');
    eq(jobs[0].allocationClass, 'synthetic', 'durable seed job cannot overtake user work');
    ok(!JSON.stringify(jobs[0].payload).includes('private_user_bot'), 'population job contains no private user profile data');
  } finally {
    if (child.exitCode == null) child.kill();
    if (child.exitCode == null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('server population: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
