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
  const systemProfileId = 'p_population_fixture';
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    schemaVersion: 16,
    profiles: [{
      id: systemProfileId,
      createdAt: new Date().toISOString(),
      fedditUsername: 'population_fixture',
      botOrigin: 'system',
      persona: 'Generated starting persona.',
      toneNotes: 'Generated starting tone.',
      readFeddits: ['askfeddit'],
      postFeddits: ['askfeddit'],
      canReply: true,
      canStartDiscussions: true,
      canShareLinks: false,
      enabled: false,
      dryRun: true,
      populationSeed: { temperament: 'curious' },
      populationProvenance: { cohortId: 'cohort_fixture' },
    }],
    settings: {},
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
    const ordinaryProfiles = await request(port, 'GET', '/api/profiles', undefined, ordinarySession.json.accessToken);
    eq(ordinaryProfiles.json.profiles.length, 0, 'ordinary hosted owners cannot see system-population profiles');

    const initial = await request(port, 'GET', '/api/population', undefined, accessToken);
    eq(initial.status, 200, 'configured existing owner can inspect population state');
    eq(initial.json.cohorts, [], 'population begins with no implicit synthetic bots');

    const adminProfiles = await request(port, 'GET', '/api/profiles', undefined, accessToken);
    eq(adminProfiles.status, 200, 'population operator can open the ordinary bot list');
    eq(adminProfiles.json.profiles.map((profile) => profile.id), [systemProfileId],
      'staged population bots appear in the operator ordinary bot list');
    const editable = await request(port, 'PUT', '/api/profiles/' + systemProfileId, {
      persona: 'Operator-edited persona.',
      toneNotes: 'Operator-edited tone.',
      readFeddits: ['shittyaskfeddit'],
      postFeddits: ['shittyaskfeddit'],
      canReply: true,
      canStartDiscussions: false,
      canShareLinks: true,
      enabled: false,
      dryRun: true,
      botOrigin: 'user',
      populationSeed: { temperament: 'overwritten' },
    }, accessToken);
    eq(editable.status, 200, 'population operator can edit a staged bot through the ordinary profile API');
    eq(editable.json.profile.persona, 'Operator-edited persona.', 'ordinary editor saves a system bot persona');
    eq(editable.json.profile.toneNotes, 'Operator-edited tone.', 'ordinary editor saves system bot tone notes');
    eq(editable.json.profile.readFeddits, ['shittyaskfeddit'], 'ordinary editor saves system bot communities');
    eq(editable.json.profile.canShareLinks, true, 'ordinary editor saves system bot abilities');
    eq(editable.json.profile.botOrigin, 'system', 'ordinary editor cannot replace system origin');
    eq(editable.json.profile.populationSeed.temperament, 'curious', 'ordinary editor cannot replace seed provenance');
    const biography = await request(port, 'PUT', '/api/profiles/' + systemProfileId + '/biography', {
      bio: 'A distinct public biography for this population bot.',
    }, accessToken);
    eq(biography.status, 200, 'population operator can edit the public biography');
    eq(biography.json.profile.fedditBio, 'A distinct public biography for this population bot.',
      'population bot biography remains separate from its persona');

    const deleteProtected = await request(port, 'DELETE', '/api/profiles/' + systemProfileId, undefined, accessToken);
    eq(deleteProtected.status, 409, 'ordinary editor cannot delete a system-population identity');
    const registerProtected = await request(port, 'POST', '/api/profiles/' + systemProfileId + '/register', {}, accessToken);
    eq(registerProtected.status, 409, 'ordinary editor cannot re-register a system-population identity');
    const handoverProtected = await request(port, 'POST', '/api/profiles/' + systemProfileId + '/handover', {}, accessToken);
    eq(handoverProtected.status, 409, 'ordinary editor cannot transfer a system-population identity');
    const ordinaryProfile = await request(port, 'GET', '/api/profiles/' + systemProfileId, undefined,
      ordinarySession.json.accessToken);
    eq(ordinaryProfile.status, 404, 'system-population profile remains isolated from ordinary workspaces');

    const direction = 'Prefer f/shittyaskfeddit and answer with playful, deliberately misplaced confidence.';
    const created = await request(port, 'POST', '/api/population/cohorts', { count: 2, direction }, accessToken);
    eq(created.status, 201, 'operator can request a bounded staged cohort');
    eq(created.json.cohort.requestedCount, 2, 'operator request preserves the bounded cohort size');
    eq(created.json.cohort.direction, direction, 'operator request preserves the bounded creative direction');
    eq(created.json.cohort.status, 'generating', 'generation alone does not stage or activate accounts');

    const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8')).jobs;
    eq(jobs.length, 1, 'cohort request creates only one durable generation job');
    eq(jobs[0].source, 'feddit-population', 'durable job records system-population provenance');
    eq(jobs[0].priority, 'background', 'durable seed job uses background priority');
    eq(jobs[0].allocationClass, 'synthetic', 'durable seed job cannot overtake user work');
    ok(jobs[0].payload.prompt.includes(direction), 'durable seed job receives the creative direction');
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
