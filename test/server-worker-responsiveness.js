'use strict';

// Execute the real worker route and acknowledgement helpers without starting
// a runner or loading any live profiles/providers. HTTP checks use loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const helpers = source.slice(source.indexOf('function sendJson('), source.indexOf('function sendCultureImportError('));
const routes = source.slice(source.indexOf("  if (urlPath.startsWith('/api/worker/'))"),
  source.indexOf('  // Anonymous hosted ownership:'));
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function fixture(options = {}) {
  const calls = [], immediates = [], errors = [];
  const job = { id: 'job-1', status: 'completed', result: { text: 'private response' }, payload: { prompt: 'private prompt' } };
  const jobQueue = Object.fromEntries(['heartbeat', 'claim', 'renew', 'complete', 'fail'].map((action) => [action, (...args) => {
    calls.push({ action, args });
    if (options.error) throw options.error;
    return action === 'claim' ? { ...job, status: 'claimed' } : job;
  }]));
  const context = vm.createContext({ Buffer, jobQueue,
    quietConversations: { status: () => { calls.push({ action: 'quiet-status' });
      return { enabled: true, populationAware: true, evaluation: null, stale: true }; } },
    secrets: { getWorkerKey: () => 'fixture-key' },
    workerAuth: { authorised: (header, key) => header === 'Bearer ' + key },
    readBody: async (req) => req.body,
    schedulerHandle: { reconcileDurableTurns: () => {
      calls.push({ action: 'reconcile' });
      if (options.reconcile) options.reconcile();
    } },
    setImmediate: options.realImmediate ? setImmediate : (callback) => immediates.push(callback),
    console: { error: (message) => errors.push(message) },
  });
  vm.runInContext(helpers + '\nthis.handle = async function(req, res, urlPath) { const method = req.method;\n' + routes + '\n};', context);
  function request(body = {}) {
    return { method: 'POST', headers: { authorization: 'Bearer fixture-key' },
      body: { workerId: 'fixture-worker', ...body }, socket: { destroyed: false }, aborted: false, destroyed: true };
  }
  function response() {
    const res = new EventEmitter();
    res.destroyed = false;
    res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
    res.end = (bytes) => { res.body = JSON.parse(bytes); calls.push({ action: 'response' }); };
    return res;
  }
  return { calls, immediates, errors, request, response, handle: context.handle };
}

async function unitChecks() {
  {
    const h=fixture(), req=h.request(), res=h.response(); req.method='GET';
    await h.handle(req,res,'/api/worker/quiet-status');
    eq(res.statusCode,200,'private read-only quiet status is available behind worker auth');
    eq(h.calls.map(c=>c.action),['quiet-status','response'],'status neither claims work nor samples providers');
    eq(plain(res.body),{enabled:true,populationAware:true,evaluation:null,stale:true},'status contains only cached safe projection');
    const denied=fixture(), bad=denied.request(), badResponse=denied.response(); bad.method='GET';bad.headers.authorization='Bearer wrong';
    await denied.handle(bad,badResponse,'/api/worker/quiet-status');
    eq(badResponse.statusCode,401,'unauthorised status request reveals no policy state');
    eq(denied.calls.map(c=>c.action),['response'],'denied status does not access controller or queue');
  }
  for (const action of ['complete', 'fail']) {
    const h = fixture(), res = h.response();
    await h.handle(h.request({ leaseToken: 'fixture-lease', result: { text: 'result' }, error: 'failed', retryable: false }),
      res, '/api/worker/jobs/job-1/' + action);
    eq(h.calls.map((call) => call.action), [action, 'response'], 'durable ' + action + ' precedes ACK without synchronous replay');
    eq(plain(res.body), { ok: true, job: { id: 'job-1', status: 'completed' } }, 'ACK excludes response/prompt/queue simulation');
    eq(h.calls[0].args[action === 'complete' ? 3 : 4], 'fixture-lease', 'terminal transition receives lease fence');
    eq(h.immediates.length, 0, 'reconciliation waits until response finish');
    res.emit('finish');
    eq(h.immediates.length, 1, 'response finish schedules one I/O-yielding replay');
    h.immediates.shift()();
    eq(h.calls.at(-1).action, 'reconcile', 'durable replay runs after acknowledgement');
  }
  {
    const h = fixture(), first = h.response(), second = h.response();
    await h.handle(h.request(), first, '/api/worker/jobs/job-1/complete');
    await h.handle(h.request(), second, '/api/worker/jobs/job-1/fail');
    first.emit('finish'); second.emit('finish');
    eq(h.immediates.length, 1, 'concurrent terminal ACKs coalesce one reconciliation');
    h.immediates.shift()();
    const later = h.response();
    await h.handle(h.request(), later, '/api/worker/jobs/job-1/complete'); later.emit('finish');
    eq(h.immediates.length, 1, 'later transitions still schedule reconciliation');
  }
  {
    const h = fixture({ reconcile: () => { throw new Error('fixture replay failure'); } }), res = h.response();
    await h.handle(h.request(), res, '/api/worker/jobs/job-1/complete');
    res.emit('finish'); h.immediates.shift()();
    eq(h.errors, ['[worker] Deferred durable reconciliation failed: fixture replay failure'],
      'deferred replay errors are observable without crashing after durable completion');
    const later = h.response();
    await h.handle(h.request(), later, '/api/worker/jobs/job-1/complete'); later.emit('finish');
    eq(h.immediates.length, 1, 'failed deferred replay cannot leave the reconciliation latch stuck');
  }
  for (const disconnected of ['aborted', 'response', 'socket', 'none']) {
    const h = fixture(), req = h.request({ claimRequestId: 'fixture-claim' }), res = h.response();
    const waiting = h.handle(req, res, '/api/worker/claim');
    await new Promise((resolve) => setImmediate(resolve));
    eq(h.calls.length, 0, 'claim allocation yields to pending disconnect events');
    if (disconnected === 'aborted') req.aborted = true;
    if (disconnected === 'response') res.destroyed = true;
    if (disconnected === 'socket') req.socket.destroyed = true;
    h.immediates.shift()();
    await waiting;
    if (disconnected === 'none') {
      eq(h.calls[0].action, 'claim', 'normal completed POST body is not confused with a disconnected client');
      eq(h.calls[0].args[1].claimRequestId, 'fixture-claim', 'claim response retry identity reaches queue');
      eq(h.calls[0].args[1].includeQueueMetadata, false, 'worker claim does not compute diagnostic queue simulations');
      res.emit('close');
      eq(h.calls.map((call) => call.action), ['claim', 'response'],
        'ambiguous close after allocation never releases a potentially accepted lease');
    } else eq(h.calls.length, 0, 'disconnected ' + disconnected + ' poll never allocates a lease');
  }
  {
    const h = fixture(), res = h.response();
    await h.handle(h.request({ leaseToken: 'renew-fence' }), res, '/api/worker/jobs/job-1/renew');
    eq(h.calls[0].args[3], 'renew-fence', 'renewal passes the lease fence in argument four');
    eq(plain(res.body), { ok: true, job: { id: 'job-1', status: 'completed' } }, 'renewal ACK is also bounded');
    eq(h.immediates.length, 0, 'renewal never starts durable replay');
  }
  for (const code of ['WORKER_LEASE_CONFLICT', 'PRIVATE_INTERNAL_CODE']) {
    const error = new Error('This worker does not hold the job lease.'); error.code = code;
    const h = fixture({ error }), res = h.response();
    await h.handle(h.request(), res, '/api/worker/jobs/job-1/complete');
    eq(res.statusCode, 409, 'ownership conflict never acknowledges success');
    eq(res.body.code, code === 'WORKER_LEASE_CONFLICT' ? code : undefined, 'only the safe protocol conflict code is exposed');
    eq(h.immediates.length, 0, 'failed durable transition cannot schedule replay');
  }
}

async function childHttp() {
  const h = fixture({ realImmediate: true, reconcile() {
    const until = Date.now() + 2000;
    while (Date.now() < until) { /* deliberately expensive synchronous replay */ }
    process.send({ replayed: true });
  } });
  const server = http.createServer((req, res) => {
    req.body = { workerId: 'fixture-worker', result: { text: 'fixture' } };
    h.handle(req, res, '/api/worker/jobs/job-1/complete').catch((error) => {
      res.writeHead(500); res.end(JSON.stringify({ error: error.message }));
    });
  });
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
}

async function httpCheck() {
  const child = spawn(process.execPath, [__filename, '--http-child'], { windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; }); child.stderr.on('data', (bytes) => { output += bytes; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP fixture start timeout: ' + output)), 10000);
      child.once('message', (message) => { clearTimeout(timer); resolve(message.port); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('HTTP fixture exited: ' + output)); });
    });
    const began = Date.now();
    const res = await fetch('http://127.0.0.1:' + port + '/api/worker/jobs/job-1/complete', {
      method: 'POST', headers: { authorization: 'Bearer fixture-key' }, body: '{}' });
    eq(await res.json(), { ok: true, job: { id: 'job-1', status: 'completed' } }, 'real HTTP client receives bounded durable ACK');
    ok(Date.now() - began < 1000, 'HTTP acknowledgement is flushed before 2s synchronous replay ends');
  } finally {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
}

if (process.argv.includes('--http-child')) childHttp().catch((error) => { console.error(error); process.exitCode = 1; });
else (async () => { await unitChecks(); await httpCheck();
  console.log('Worker HTTP responsiveness: ' + checks + ' checks passed; no inference or live state.');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
