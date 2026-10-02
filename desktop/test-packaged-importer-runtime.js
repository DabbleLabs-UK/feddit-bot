'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function arg(name) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0 || !process.argv[index + 1]) throw new Error('Missing --' + name);
  return process.argv[index + 1];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error('HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + url + ': ' + (lastError && lastError.message));
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + file);
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    timer = setTimeout(finish, timeoutMs);
  });
}

function filesBelow(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(file));
    else if (entry.isFile()) output.push(file);
  }
  return output;
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to the browser debug socket')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', (error) => { clearTimeout(timer); reject(error); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || 'CDP request failed'));
      else request.resolve(message.result || {});
      return;
    }
    for (let index = eventWaiters.length - 1; index >= 0; index--) {
      const waiter = eventWaiters[index];
      if (waiter.method !== message.method) continue;
      eventWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params || {});
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Timed out waiting for browser command ' + method));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function waitForEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = eventWaiters.indexOf(waiter);
        if (index >= 0) eventWaiters.splice(index, 1);
        reject(new Error('Timed out waiting for CDP event ' + method));
      }, timeoutMs);
      eventWaiters.push(waiter);
    });
  }

  return { send, waitForEvent, close: () => socket.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
  }
  return result.result && result.result.value;
}

async function waitForValue(cdp, expression, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(cdp, expression);
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + label + '; last value: ' + JSON.stringify(value));
}

async function main() {
  const appRoot = path.resolve(arg('app-root'));
  const browserExe = path.resolve(arg('browser'));
  const serverFile = path.join(appRoot, 'server.js');
  const publicIndex = path.join(appRoot, 'public', 'index.html');
  const importerFile = path.join(appRoot, 'public', 'ui-culture-importer.js');
  for (const file of [serverFile, publicIndex, importerFile, browserExe]) {
    if (!fs.existsSync(file)) throw new Error('Required packaged-runtime file is missing: ' + file);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-packaged-importer-runtime-'));
  const profileDir = path.join(work, 'browser-profile');
  const dataDir = path.join(work, 'data');
  const fetchLayerKey = 'fetchlayer-packaged-fixture-secret';
  const fetchLayerPreload = path.join(work, 'fetchlayer-fixture-preload.cjs');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(fetchLayerPreload, `'use strict';
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, options = {}) => {
  const url = String(input && input.url || input);
  if (!url.startsWith('https://api.fetchlayer.dev/reddit/')) return originalFetch(input, options);
  if (!options.headers || options.headers.Authorization !== 'Bearer ${fetchLayerKey}') {
    return new Response(JSON.stringify({ error: 'fixture authorization failed' }), { status: 401 });
  }
  const now = new Date().toISOString();
  if (url.endsWith('/community-posts')) {
    return new Response(JSON.stringify({
      blocked: false,
      items: [
        { id: 'packaged1', fullname: 't3_packaged1', subreddit: 'ExampleSub', author: 'FixtureStarter', createdAt: now, score: 12, title: 'Packaged source retrieval', previewText: 'A bounded fixture post.', permalink: 'https://www.reddit.com/r/ExampleSub/comments/packaged1/thread/', url: 'https://www.reddit.com/r/ExampleSub/comments/packaged1/thread/', commentCount: 2 },
        { id: 'packaged2', fullname: 't3_packaged2', subreddit: 'ExampleSub', author: 'SecondFixture', createdAt: now, score: 4, title: 'Second packaged post', previewText: 'Another bounded fixture post.', permalink: 'https://www.reddit.com/r/ExampleSub/comments/packaged2/thread/', url: 'https://www.reddit.com/r/ExampleSub/comments/packaged2/thread/', commentCount: 0 },
      ],
      pagesRequested: 1,
      pagesScraped: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.endsWith('/post')) {
    return new Response(JSON.stringify({
      blocked: false,
      id: 'packaged1',
      fullname: 't3_packaged1',
      subreddit: 'ExampleSub',
      author: 'FixtureStarter',
      title: 'Packaged source retrieval',
      bodyText: 'The full packaged fixture post body.',
      permalink: 'https://www.reddit.com/r/ExampleSub/comments/packaged1/thread/',
      comments: [{
        id: 'packaged-comment-1', fullname: 't1_packaged-comment-1', parentFullname: 't3_packaged1', author: 'FixtureReply', createdAt: now, score: 3, bodyText: 'First fixture comment.', permalink: 'https://www.reddit.com/r/ExampleSub/comments/packaged1/thread/packaged-comment-1/', depth: 0,
        children: [{ id: 'packaged-comment-2', fullname: 't1_packaged-comment-2', parentFullname: 't1_packaged-comment-1', author: 'NestedFixture', createdAt: now, score: 2, bodyText: 'Nested fixture reply.', permalink: 'https://www.reddit.com/r/ExampleSub/comments/packaged1/thread/packaged-comment-2/', depth: 1, children: [] }],
      }],
      commentPagesScraped: 1,
      remainingMoreCommentsCount: 0,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'unexpected fixture route' }), { status: 404 });
};
`, { encoding: 'utf8', mode: 0o600 });
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const serverOutput = [];
  const browserOutput = [];
  let serverProcess = null;
  let browserProcess = null;
  let cdp = null;

  try {
    serverProcess = spawn(process.execPath, [serverFile], {
      cwd: appRoot,
      windowsHide: true,
      env: {
        ...process.env,
        NODE_OPTIONS: '--require=' + fetchLayerPreload,
        FEDDIT_BOT_DATA_DIR: dataDir,
        FEDDIT_BOT_HOST: '127.0.0.1',
        FEDDIT_BOT_PORT: String(port),
        FEDDIT_BOT_PLACEMENT: 'desktop',
        FEDDIT_APP_VERSION: 'packaged-importer-runtime-test',
        FETCHLAYER_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
    serverProcess.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
    await waitForHttp(base + '/api/runtime', 20000);
    console.log('[packaged-runtime] backend ready');

    browserProcess = spawn(browserExe, [
      '--headless=new',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    browserProcess.stdout.on('data', (chunk) => browserOutput.push(String(chunk)));
    browserProcess.stderr.on('data', (chunk) => browserOutput.push(String(chunk)));

    const activePortFile = path.join(profileDir, 'DevToolsActivePort');
    console.log('[packaged-runtime] waiting for browser debug port');
    await waitForFile(activePortFile, 20000);
    console.log('[packaged-runtime] browser debug port file ready');
    const [debugPort] = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
    if (browserProcess.exitCode !== null) throw new Error('Headless browser exited before exposing its page target');
    console.log('[packaged-runtime] reading browser page target');
    const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list', {
      signal: AbortSignal.timeout(10000),
    })).json();
    console.log('[packaged-runtime] browser page target ready');
    const page = targets.find((target) => target.type === 'page');
    if (!page || !page.webSocketDebuggerUrl) throw new Error('Headless browser did not expose a page target');
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    console.log('[packaged-runtime] browser debug socket connected');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    console.log('[packaged-runtime] browser ready');

    let loaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: base + '/' });
    await loaded;
    await waitForValue(cdp, 'document.readyState', (value) => value === 'complete', 'initial page load');

    loaded = cdp.waitForEvent('Page.loadEventFired');
    await evaluate(cdp, "localStorage.setItem('fedditBotsDeveloperTools', '1'); location.reload(); true");
    await loaded;
    await waitForValue(cdp,
      "Boolean(document.getElementById('settingsBtn') && window.FedditCultureImporterUi)",
      Boolean,
      'packaged importer assets');
    console.log('[packaged-runtime] developer tools loaded');
    await evaluate(cdp, "document.getElementById('settingsBtn').click(); true");

    const visible = await waitForValue(cdp, `(() => {
      const button = document.getElementById('cultureImporterBtn');
      const dialog = document.getElementById('settingsDialog');
      return {
        placement: 'desktop',
        developerTools: document.getElementById('developerToolsToggle')?.checked === true,
        dialogOpen: dialog?.open === true,
        buttonExists: Boolean(button),
        buttonVisible: Boolean(button && getComputedStyle(button).display !== 'none' && button.getClientRects().length),
        desktopRule: window.FedditCultureImporterUi.entryVisible(true, 'desktop', false),
        hostedNonAdminRule: window.FedditCultureImporterUi.entryVisible(true, 'hosted', false),
        hostedAdminRule: window.FedditCultureImporterUi.entryVisible(true, 'hosted', true),
        sourceSettingsVisible: Boolean(document.getElementById('cultureSourceSettings')?.getClientRects().length),
        sourceKeyState: document.getElementById('fetchLayerKeyState')?.textContent || '',
      };
    })()`, (value) => value && value.buttonVisible && value.sourceKeyState === 'not configured', 'visible packaged importer button');

    if (!visible.developerTools || !visible.dialogOpen || !visible.desktopRule ||
        visible.hostedNonAdminRule || !visible.hostedAdminRule || !visible.sourceSettingsVisible) {
      throw new Error('Packaged visibility contract failed: ' + JSON.stringify(visible));
    }
    console.log('[packaged-runtime] credential settings visible');

    await evaluate(cdp, "document.getElementById('cultureImporterBtn').click(); true");
    const opened = await waitForValue(cdp, `(() => ({
      heading: document.querySelector('.culture-importer-page h2')?.textContent || '',
      sourceStep: document.body.innerText.includes('1. Source sample'),
      settingsOpen: document.getElementById('settingsDialog')?.open === true,
    }))()`, (value) => value && value.heading === 'Subreddit culture importer' && value.sourceStep, 'opened packaged importer', 60000);
    if (opened.settingsOpen) throw new Error('Settings dialog stayed open after opening the importer');

    await evaluate(cdp, `(() => {
      document.getElementById('cultureSubreddit').value = 'ExampleSub';
      document.getElementById('culturePostCount').value = '2';
      document.getElementById('cultureCommentCount').value = '2';
      document.getElementById('cultureWindow').value = '7';
      document.getElementById('cultureFetchBtn').click();
      return true;
    })()`);
    const missingKey = await waitForValue(cdp, `(() => ({
      failed: Boolean(document.querySelector('.culture-progress.failed')),
      message: document.querySelector('.culture-progress')?.textContent || '',
    }))()`, (value) => value && value.failed, 'clear packaged missing-key result');
    if (!missingKey.message.includes('Configure the key in Developer tools')) {
      throw new Error('Packaged missing-key result was unclear: ' + JSON.stringify(missingKey));
    }
    console.log('[packaged-runtime] missing-key state verified');

    await evaluate(cdp, `(() => {
      document.getElementById('cultureBackBtn').click();
      document.getElementById('settingsBtn').click();
      return true;
    })()`);
    await waitForValue(cdp, "document.getElementById('settingsDialog')?.open === true", Boolean, 'reopened packaged settings');
    await evaluate(cdp, `(() => {
      document.getElementById('fetchLayerKeyInput').value = '${fetchLayerKey}';
      document.getElementById('setFetchLayerKeyBtn').click();
      return true;
    })()`);
    const configuredState = await waitForValue(cdp,
      "document.getElementById('fetchLayerKeyState')?.textContent || ''",
      (value) => value === 'configured',
      'saved packaged FetchLayer key state');
    if (configuredState !== 'configured') throw new Error('Packaged FetchLayer key did not become configured');
    const clearedKeyInput = await evaluate(cdp, "document.getElementById('fetchLayerKeyInput')?.value || ''");
    if (clearedKeyInput) throw new Error('Packaged credential input retained the saved FetchLayer key');
    console.log('[packaged-runtime] local credential configured');

    await evaluate(cdp, "document.getElementById('testFetchLayerBtn').click(); true");
    const connectionTest = await waitForValue(cdp,
      "document.getElementById('notificationLive')?.textContent || ''",
      (value) => value.includes('FetchLayer connected; read 1 recent post from r/shittyaskreddit.'),
      'packaged FetchLayer connection test');
    console.log('[packaged-runtime] connection test completed');

    const browserExposure = await evaluate(cdp, `(() => ({
      dom: document.documentElement.innerHTML.includes('${fetchLayerKey}'),
      input: document.getElementById('fetchLayerKeyInput')?.value.includes('${fetchLayerKey}') || false,
      local: Object.values(localStorage).some((value) => String(value).includes('${fetchLayerKey}')),
      session: Object.values(sessionStorage).some((value) => String(value).includes('${fetchLayerKey}')),
      cookie: document.cookie.includes('${fetchLayerKey}'),
    }))()`);
    if (Object.values(browserExposure).some(Boolean)) {
      throw new Error('Packaged browser retained the FetchLayer key: ' + JSON.stringify(browserExposure));
    }

    const publicCredential = await evaluate(cdp,
      "fetch('/api/culture-imports/source-credential').then((response) => response.json())");
    if (!publicCredential?.source?.hasKey || JSON.stringify(publicCredential).includes(fetchLayerKey)) {
      throw new Error('Packaged credential state exposed more than presence: ' + JSON.stringify(publicCredential));
    }

    await evaluate(cdp, "document.getElementById('cultureImporterBtn').click(); true");
    await waitForValue(cdp, "document.querySelector('.culture-importer-page h2')?.textContent || ''",
      (value) => value === 'Subreddit culture importer', 'reopened packaged importer', 60000);
    await evaluate(cdp, `(() => {
      document.getElementById('cultureSubreddit').value = 'ExampleSub';
      document.getElementById('culturePostCount').value = '2';
      document.getElementById('cultureCommentCount').value = '2';
      document.getElementById('cultureWindow').value = '7';
      document.getElementById('cultureFetchBtn').click();
      return true;
    })()`);
    const retrieved = await waitForValue(cdp, `(() => ({
      ready: Boolean(document.querySelector('.culture-summary')),
      text: document.querySelector('.culture-summary')?.textContent || '',
    }))()`, (value) => value && value.ready && value.text.includes('2 posts and 2 comments'), 'packaged fixture retrieval');
    console.log('[packaged-runtime] fixture retrieval completed');

    const storedSecrets = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
    if (storedSecrets.fetchLayerApiKey !== fetchLayerKey) {
      throw new Error('Packaged local backend did not persist the FetchLayer key');
    }
    if (serverOutput.join('').includes(fetchLayerKey)) throw new Error('Packaged runner logged the FetchLayer key');
    const shippedSecret = filesBelow(appRoot).some((file) => {
      try { return fs.readFileSync(file, 'utf8').includes(fetchLayerKey); } catch { return false; }
    });
    if (shippedSecret) throw new Error('Packaged application assets contained the FetchLayer key');

    console.log('packaged desktop importer runtime: 22 checks passed');
    console.log(JSON.stringify({ visible, opened, missingKey, configuredState, connectionTest, browserExposure, retrieved }));
  } catch (error) {
    if (serverOutput.length) console.error('Packaged server output:\n' + serverOutput.join(''));
    if (browserOutput.length) console.error('Headless browser output:\n' + browserOutput.join(''));
    throw error;
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch {}
      cdp.close();
    }
    await waitForExit(browserProcess, 5000);
    if (browserProcess && browserProcess.exitCode === null) {
      browserProcess.kill();
      await waitForExit(browserProcess, 5000);
    }
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill();
      await waitForExit(serverProcess, 5000);
    }
    await delay(250);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
