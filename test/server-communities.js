'use strict';

// End-to-end community-management contract. Management is presented once per
// private workspace, while Feddit remains authoritative and continues to check
// the bearer token of the identity that originally created each community.

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
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...headers,
      },
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

function authUsername(req, tokens) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return tokens.get(token) || '';
}

async function startRunner(placement, fedditPort) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-community-contract-'));
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FEDDIT_BOT_DATA_DIR: dataDir,
      FEDDIT_BOT_HOST: '127.0.0.1',
      FEDDIT_BOT_PORT: String(port),
      FEDDIT_BOT_PLACEMENT: placement,
      FEDDIT_SITE_BASE: 'http://127.0.0.1:' + fedditPort,
      FEDDIT_APP_VERSION: 'community-contract',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
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

  return {
    port,
    async stop() {
      if (child.exitCode == null) child.kill();
      await Promise.race([
        new Promise((resolve) => child.exitCode == null ? child.once('exit', resolve) : resolve()),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function createRegisteredProfile(runnerPort, username, headers = {}) {
  const created = await requestJson(runnerPort, 'POST', '/api/profiles', {
    fedditUsername: username,
    persona: 'A distinct community participant.',
    postFeddits: ['botlife'],
    communityMode: 'listed',
    communityAllowlist: ['gardening'],
    enabled: false,
  }, headers);
  eq(created.status, 201, username + ' draft is created');
  const registered = await requestJson(
    runnerPort,
    'POST',
    '/api/profiles/' + created.json.profile.id + '/register',
    undefined,
    headers,
  );
  eq(registered.status, 200, username + ' is registered');
  return created.json.profile.id;
}

async function run() {
  const fedditPort = await unusedPort();
  const tokens = new Map();
  const communities = [];
  let tokenSequence = 0;
  let updateCalls = 0;

  const fakeFeddit = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'POST' && pathname === '/api/v1/register') {
      const body = await readJson(req);
      const token = 'feddit_' + String(++tokenSequence).padStart(64, 'a');
      tokens.set(token, body.username);
      return send(res, 201, { bot: { username: body.username, description: body.description || '' }, token });
    }
    if (req.method === 'GET' && pathname === '/api/v1/feddits') {
      return send(res, 200, { feddits: communities });
    }
    const about = pathname.match(/^\/api\/v1\/f\/([^/]+)\/about\.json$/);
    if (req.method === 'GET' && about) {
      const name = decodeURIComponent(about[1]);
      const community = communities.find((item) => item.name.toLowerCase() === name.toLowerCase());
      return community
        ? send(res, 200, { feddit: community })
        : send(res, 404, { error: { code: 'not_found', message: 'No such community.' } });
    }
    if (req.method === 'POST' && pathname === '/api/v1/feddits') {
      const creator = authUsername(req, tokens);
      if (!creator) return send(res, 401, { error: { code: 'unauthorized', message: 'Unauthorized.' } });
      const body = await readJson(req);
      const community = {
        name: body.name,
        title: body.title,
        description: body.description,
        sidebar_text: body.sidebar_text,
        over_18: body.nsfw,
        post_format: body.post_format,
        rules: body.rules,
        created_by: creator,
        url: '/f/' + body.name,
      };
      communities.push(community);
      return send(res, 201, { feddit: community });
    }
    const update = pathname.match(/^\/api\/v1\/feddits\/([^/]+)$/);
    if ((req.method === 'POST' || req.method === 'PATCH') && update) {
      const name = decodeURIComponent(update[1]);
      const community = communities.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (!community) return send(res, 404, { error: { code: 'not_found', message: 'No such community.' } });
      if (community.created_by !== authUsername(req, tokens)) {
        return send(res, 403, { error: { code: 'forbidden', message: 'Only the creator may edit this community.' } });
      }
      const body = await readJson(req);
      updateCalls++;
      Object.assign(community, {
        description: body.description,
        sidebar_text: body.sidebar_text,
        over_18: body.nsfw,
        post_format: body.post_format,
        rules: body.rules,
      });
      return send(res, 200, { feddit: community });
    }
    return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  });
  await new Promise((resolve, reject) => {
    fakeFeddit.once('error', reject);
    fakeFeddit.listen(fedditPort, '127.0.0.1', resolve);
  });

  let hosted;
  let desktop;
  try {
    hosted = await startRunner('hosted', fedditPort);
    const sessionA = await requestJson(hosted.port, 'POST', '/api/session');
    const sessionB = await requestJson(hosted.port, 'POST', '/api/session');
    const ownerA = { 'X-Feddit-Bot-Owner': sessionA.json.accessToken };
    const ownerB = { 'X-Feddit-Bot-Owner': sessionB.json.accessToken };
    await createRegisteredProfile(hosted.port, 'owner_a_bot', ownerA);
    await createRegisteredProfile(hosted.port, 'owner_a_second_bot', ownerA);
    await createRegisteredProfile(hosted.port, 'owner_b_bot', ownerB);

    communities.push(
      {
        name: 'askfeddit', title: 'askfeddit', description: 'Questions.', sidebar_text: '',
        over_18: false, post_format: 'text', rules: [], created_by: 'owner_a_bot', url: '/f/askfeddit',
      },
      {
        name: 'privategarden', title: 'privategarden', description: 'Plants.', sidebar_text: '',
        over_18: false, post_format: 'any', rules: [], created_by: 'owner_b_bot', url: '/f/privategarden',
      },
    );

    const noOwner = await requestJson(hosted.port, 'GET', '/api/communities');
    eq(noOwner.status, 401, 'hosted community manager requires its private workspace capability');

    const listA = await requestJson(hosted.port, 'GET', '/api/communities', undefined, ownerA);
    eq(listA.status, 200, 'owner A can list manageable communities');
    eq(listA.json.communities.map((item) => item.name), ['askfeddit'],
      'a community appears once at workspace level even when that workspace has several bots');

    const opened = await requestJson(hosted.port, 'GET', '/api/communities/askfeddit', undefined, ownerA);
    eq(opened.status, 200, 'owner A can open its existing community without recreation');
    eq(opened.json.community.post_format, 'text', 'existing supported community metadata is returned');

    const changed = await requestJson(hosted.port, 'PUT', '/api/communities/askfeddit', {
      description: 'Questions with useful context.',
      sidebarText: 'Read before joining in.',
      nsfw: true,
      postFormat: 'link',
      rules: [
        { title: 'Ask a question', detail: 'Top-level posts should contain a question.' },
        { title: 'Stay curious', detail: 'Engage with the answer.' },
      ],
    }, ownerA);
    eq(changed.status, 200, 'owner A can edit description, rules and metadata');
    eq(changed.json.community.description, 'Questions with useful context.', 'description is updated through Feddit');
    eq(changed.json.community.sidebar_text, 'Read before joining in.', 'sidebar notes are updated through Feddit');
    eq(changed.json.community.over_18, true, 'visibility metadata is updated through Feddit');
    eq(changed.json.community.post_format, 'link', 'post-format metadata is updated through Feddit');
    eq(changed.json.community.rules.length, 2, 'ordered rules are updated through Feddit');

    const forbiddenOpen = await requestJson(hosted.port, 'GET', '/api/communities/privategarden', undefined, ownerA);
    eq(forbiddenOpen.status, 403, 'another workspace cannot open a community editor');
    const forbiddenEdit = await requestJson(hosted.port, 'PUT', '/api/communities/privategarden', {
      description: 'Stolen.', rules: [], postFormat: 'any', nsfw: false,
    }, ownerA);
    eq(forbiddenEdit.status, 403, 'another workspace cannot edit a community');
    eq(updateCalls, 1, 'unauthorized edits never reach the Feddit mutation endpoint');

    const created = await requestJson(hosted.port, 'POST', '/api/communities', {
      name: 'newcommunity',
      description: 'Created once from the workspace manager.',
      sidebarText: 'Account-level notes.',
      nsfw: false,
      postFormat: 'any',
      rules: [{ title: 'One rule', detail: 'Keep it readable.' }],
    }, ownerA);
    eq(created.status, 201, 'workspace manager can create a community');
    eq(created.json.community.title, 'newcommunity', 'creation keeps the slug as the only visible name');
    ok(['owner_a_bot', 'owner_a_second_bot'].includes(created.json.community.created_by),
      'creation uses a stable eligible identity from the workspace without asking the human to choose it');

    const listB = await requestJson(hosted.port, 'GET', '/api/communities', undefined, ownerB);
    eq(listB.json.communities.map((item) => item.name), ['privategarden'],
      'owner B sees only communities managed by owner B');

    desktop = await startRunner('desktop', fedditPort);
    await createRegisteredProfile(desktop.port, 'desktop_owner');
    communities.push({
      name: 'desktopplace', title: 'desktopplace', description: 'Local management.', sidebar_text: '',
      over_18: false, post_format: 'any', rules: [], created_by: 'desktop_owner', url: '/f/desktopplace',
    });
    const desktopList = await requestJson(desktop.port, 'GET', '/api/communities');
    eq(desktopList.status, 200, 'desktop app exposes the same workspace community manager');
    eq(desktopList.json.communities.map((item) => item.name), ['desktopplace'],
      'desktop app resolves manageable communities from its local identities');
    const desktopEdit = await requestJson(desktop.port, 'PUT', '/api/communities/desktopplace', {
      description: 'Edited from Windows.', sidebarText: '', nsfw: false, postFormat: 'text', rules: [],
    });
    eq(desktopEdit.status, 200, 'desktop app uses the same community editing API');
    eq(desktopEdit.json.community.description, 'Edited from Windows.',
      'desktop edits reach the same Feddit source of truth');

    console.log('server communities: ' + checks + ' checks passed');
  } finally {
    if (desktop) await desktop.stop();
    if (hosted) await hosted.stop();
    await new Promise((resolve) => fakeFeddit.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
