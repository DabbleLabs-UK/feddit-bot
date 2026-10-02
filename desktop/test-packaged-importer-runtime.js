'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TRACE = process.env.FEDDIT_PACKAGED_TEST_TRACE === '1';

function trace(message) {
  if (TRACE) console.error('[packaged-browser] ' + message);
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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

async function readFileWhenReady(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error('Timed out reading ' + file + ': ' + (lastError && lastError.message));
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

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await withTimeout(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  }), 15000, 'the browser debugging WebSocket');
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

  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Browser debugging connection closed during ' + request.method));
    }
    pending.clear();
  });

  function send(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Timed out waiting for browser command ' + method));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
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
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const serverOutput = [];
  const browserOutput = [];
  let serverProcess = null;
  let browserProcess = null;
  let cdp = null;

  try {
    trace('starting packaged server');
    serverProcess = spawn(process.execPath, [serverFile], {
      cwd: appRoot,
      windowsHide: true,
      env: {
        ...process.env,
        FEDDIT_BOT_DATA_DIR: dataDir,
        FEDDIT_BOT_HOST: '127.0.0.1',
        FEDDIT_BOT_PORT: String(port),
        FEDDIT_BOT_PLACEMENT: 'desktop',
        FEDDIT_APP_VERSION: 'packaged-importer-runtime-test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
    serverProcess.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
    await waitForHttp(base + '/api/runtime', 20000);
    trace('packaged server is ready');

    trace('starting headless browser');
    browserProcess = spawn(browserExe, [
      '--headless=new',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-gpu',
      // This disposable profile loads only the loopback packaged app. Some
      // restricted Windows runners deny Chromium's sandboxed GPU subprocess.
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    browserProcess.stdout.on('data', (chunk) => browserOutput.push(String(chunk)));
    browserProcess.stderr.on('data', (chunk) => browserOutput.push(String(chunk)));

    const activePortFile = path.join(profileDir, 'DevToolsActivePort');
    await waitForFile(activePortFile, 20000);
    trace('headless browser exposed its debugging port');
    const [debugPort] = (await readFileWhenReady(activePortFile, 20000)).split(/\r?\n/);
    const targetResponse = await withTimeout(
      fetch('http://127.0.0.1:' + debugPort + '/json/list'),
      15000,
      'the browser debugging target list',
    );
    const targets = await withTimeout(targetResponse.json(), 15000, 'the browser debugging target response');
    const page = targets.find((target) => target.type === 'page');
    if (!page || !page.webSocketDebuggerUrl) throw new Error('Headless browser did not expose a page target');
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    trace('connected to the browser debugging protocol');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    let loaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: base + '/' });
    await loaded;
    await waitForValue(cdp, 'document.readyState', (value) => value === 'complete', 'initial page load');
    trace('packaged desktop page loaded');

    loaded = cdp.waitForEvent('Page.loadEventFired');
    await evaluate(cdp, "localStorage.setItem('fedditBotsDeveloperTools', '1'); location.reload(); true");
    await loaded;
    await waitForValue(cdp,
      "Boolean(document.getElementById('settingsBtn') && window.FedditCultureImporterUi)",
      Boolean,
      'packaged importer assets');
    trace('packaged importer assets loaded with Developer tools enabled');
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
      };
    })()`, (value) => value && value.buttonVisible, 'visible packaged importer button');

    if (!visible.developerTools || !visible.dialogOpen || !visible.desktopRule ||
        visible.hostedNonAdminRule || !visible.hostedAdminRule) {
      throw new Error('Packaged visibility contract failed: ' + JSON.stringify(visible));
    }
    trace('packaged importer button is visible');

    await evaluate(cdp, "document.getElementById('cultureImporterBtn').click(); true");
    const opened = await waitForValue(cdp, `(() => ({
      heading: document.querySelector('.culture-importer-page h2')?.textContent || '',
      sourceStep: document.body.innerText.includes('1. Source sample'),
      settingsOpen: document.getElementById('settingsDialog')?.open === true,
    }))()`, (value) => value && value.heading === 'Subreddit culture importer' && value.sourceStep, 'opened packaged importer');
    if (opened.settingsOpen) throw new Error('Settings dialog stayed open after opening the importer');
    trace('packaged importer page opened');

    console.log('packaged desktop importer runtime: 10 checks passed');
    console.log(JSON.stringify({ visible, opened }));
  } catch (error) {
    if (serverOutput.length) console.error('Packaged server output:\n' + serverOutput.join(''));
    if (browserOutput.length) console.error('Headless browser output:\n' + browserOutput.join(''));
    throw error;
  } finally {
    if (cdp) {
      trace('closing the headless browser');
      try { await cdp.send('Browser.close'); } catch {}
      cdp.close();
    }
    await waitForExit(browserProcess, 5000);
    if (browserProcess && browserProcess.exitCode === null) {
      browserProcess.kill();
      await waitForExit(browserProcess, 5000);
    }
    if (serverProcess && serverProcess.exitCode === null) {
      trace('stopping the packaged server');
      serverProcess.kill();
      await waitForExit(serverProcess, 5000);
    }
    await delay(250);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    trace('packaged runtime cleanup completed');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
