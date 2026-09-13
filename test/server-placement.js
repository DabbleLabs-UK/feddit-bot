'use strict';

// Process-level API contracts for the placement boundary and registered bot
// identity. Every runner uses an isolated temporary data directory and a
// loopback-only ephemeral port. No external service is contacted.

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

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function requestJson(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        Accept: 'application/json',
        ...(bytes ? {
          'Content-Type': 'application/json',
          'Content-Length': bytes.length,
        } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* assertion reports raw text */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.once('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

async function startRunner(placement) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-server-contract-'));
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FEDDIT_BOT_DATA_DIR: dataDir,
      FEDDIT_BOT_HOST: '127.0.0.1',
      FEDDIT_BOT_PORT: String(port),
      FEDDIT_BOT_PLACEMENT: placement,
      FEDDIT_APP_VERSION: 'test-contract',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      'Timed out starting ' + placement + ' runner. Output:\n' + output,
    )), 10_000);
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
      reject(new Error(placement + ' runner exited early with ' + code + '. Output:\n' + output));
    });
  });

  try {
    await ready;
  } catch (error) {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    async stop() {
      if (child.exitCode == null) child.kill();
      if (child.exitCode == null) {
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function localPlacementContract(placement) {
  const runner = await startRunner(placement);
  try {
    const runtime = await requestJson(runner.port, 'GET', '/api/runtime');
    eq(runtime.status, 200, placement + ' runtime endpoint responds');
    eq(runtime.json.placement, placement, placement + ' reports its real placement');
    eq(runtime.json.ownerSessionRequired, false, placement + ' does not impose hosted owner sessions');
    eq(runtime.json.hostedPolicy, null, placement + ' does not apply hosted cadence policy');

    const created = await requestJson(runner.port, 'POST', '/api/profiles', {
      fedditUsername: placement + '_draft',
      enabled: false,
      provider: 'deepseek',
      deepseekModel: 'deepseek-v4-flash',
      postsPerHour: 7,
      commentsPerHour: 11,
      canReply: true,
      canStartDiscussions: true,
      canShareLinks: false,
    });
    eq(created.status, 201, placement + ' can create a configurable profile');
    eq(created.json.profile.provider, 'deepseek', placement + ' preserves the selected provider');
    eq(created.json.profile.postsPerHour, 7, placement + ' preserves the selected post cadence');
    eq(created.json.profile.commentsPerHour, 11, placement + ' preserves the selected reply cadence');

    if (placement !== 'desktop') return;

    const draftId = created.json.profile.id;
    const renamed = await requestJson(runner.port, 'PUT', '/api/profiles/' + draftId, {
      fedditUsername: 'renamed_draft',
    });
    eq(renamed.status, 200, 'HTTP permits renaming an unregistered draft identity');
    eq(renamed.json.profile.fedditUsername, 'renamed_draft', 'the draft rename is persisted through HTTP');

    const registered = await requestJson(runner.port, 'POST', '/api/profiles', {
      fedditUsername: 'fixed_http_bot',
      token: 'feddit_test_token_for_isolated_temp_store',
      enabled: false,
    });
    eq(registered.status, 201, 'HTTP fixture creates a registered identity in its isolated store');
    ok(registered.json.profile.hasToken, 'registered identity is reported without exposing its bearer token');

    const rejected = await requestJson(runner.port, 'PUT', '/api/profiles/' + registered.json.profile.id, {
      fedditUsername: 'different_http_bot',
    });
    eq(rejected.status, 409, 'HTTP rejects renaming a registered Feddit identity');
    ok(/permanent/i.test(rejected.json.error), 'HTTP identity rejection explains that the username is permanent');

    const sameIdentity = await requestJson(runner.port, 'PUT', '/api/profiles/' + registered.json.profile.id, {
      fedditUsername: 'FIXED_HTTP_BOT',
      persona: 'Other settings remain editable.',
    });
    eq(sameIdentity.status, 200, 'HTTP accepts a case-insensitive no-op identity update');
    eq(sameIdentity.json.profile.fedditUsername, 'fixed_http_bot', 'HTTP preserves the registered username spelling');
    eq(sameIdentity.json.profile.persona, 'Other settings remain editable.', 'HTTP still permits unrelated profile edits');
  } finally {
    await runner.stop();
  }
}

async function hostedPlacementContract() {
  const runner = await startRunner('hosted');
  try {
    const runtime = await requestJson(runner.port, 'GET', '/api/runtime');
    eq(runtime.status, 200, 'hosted runtime endpoint responds');
    eq(runtime.json.placement, 'hosted', 'hosted runner reports its real placement');
    eq(runtime.json.ownerSessionRequired, true, 'hosted runner requires a private owner session');
    ok(runtime.json.hostedPolicy && runtime.json.hostedPolicy.managedCadence,
      'hosted runtime advertises centrally managed cadence');

    const unauthorised = await requestJson(runner.port, 'GET', '/api/profiles');
    eq(unauthorised.status, 401, 'hosted profiles are inaccessible without their owner capability');

    const session = await requestJson(runner.port, 'POST', '/api/session');
    eq(session.status, 201, 'hosted runner issues an anonymous private workspace');
    const ownerHeaders = { 'X-Feddit-Bot-Owner': session.json.accessToken };
    const created = await requestJson(runner.port, 'POST', '/api/profiles', {
      fedditUsername: 'hosted_contract_bot',
      enabled: true,
      provider: 'deepseek',
      model: 'owner-selected-model',
      postsPerHour: 99,
      commentsPerHour: 99,
      canReply: true,
      canStartDiscussions: true,
      canShareLinks: false,
    }, ownerHeaders);
    eq(created.status, 201, 'hosted owner can create a bot in the private workspace');
    eq(created.json.profile.provider, 'dell', 'hosted creation forces the shared DELL provider');
    eq(created.json.profile.hostedDailyTurns, 6, 'new hosted bot receives the managed introductory target');
    eq(created.json.profile.postsPerHour * 24, 2, 'hosted policy owns the mixed bot post cadence');
    eq(created.json.profile.commentsPerHour * 24, 4, 'hosted policy owns the mixed bot reply cadence');

    const updated = await requestJson(runner.port, 'PUT', '/api/profiles/' + created.json.profile.id, {
      provider: 'deepseek',
      postsPerHour: 500,
      commentsPerHour: 500,
      persona: 'Hosted creative settings remain editable.',
    }, ownerHeaders);
    eq(updated.status, 200, 'hosted owner can update legitimate creative settings');
    eq(updated.json.profile.provider, 'dell', 'hosted update cannot escape the DELL placement');
    eq(updated.json.profile.postsPerHour * 24, 2, 'hosted update cannot replace managed post cadence');
    eq(updated.json.profile.commentsPerHour * 24, 4, 'hosted update cannot replace managed reply cadence');
    eq(updated.json.profile.persona, 'Hosted creative settings remain editable.',
      'hosted policy does not clobber shared-core creative settings');
  } finally {
    await runner.stop();
  }
}

(async () => {
  await localPlacementContract('desktop');
  await localPlacementContract('advanced');
  await hostedPlacementContract();
  console.log('server placement and identity: ' + checks + ' checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
