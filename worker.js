'use strict';

// Outbound-only DELL inference worker. It claims jobs from the public runner,
// runs them through local Ollama, and returns the result. It never opens a port.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ollama = require('./lib/providers/ollama');
const { createMaintenanceGate } = require('./lib/worker-maintenance');
const { createDeliveryStore } = require('./lib/worker-delivery-store');

const VERSION = '1';
const DEFAULT_POLL_MS = 10 * 1000;
const DEFAULT_RENEW_MS = 60 * 1000;

function cleanRunnerUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('FEDDIT_RUNNER_URL is required.');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('FEDDIT_RUNNER_URL must use HTTPS unless it is localhost.');
  }
  parsed.hash = '';
  parsed.search = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function parseAllowedModels(value, fallback) {
  const models = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(models.length ? models : [fallback]);
}

function cleanPayload(payload, models) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const model = String(input.model || ollama.DEFAULT_MODEL);
  if (!models.has(model)) {
    const err = new Error('This DELL worker does not allow model ' + model + '.');
    err.code = 'UNSUPPORTED_MODEL';
    throw err;
  }
  const system = String(input.system || '');
  const prompt = String(input.prompt || '');
  if (!prompt.trim()) throw new Error('The inference job has no prompt.');
  if (system.length > 20_000 || prompt.length > 100_000) {
    throw new Error('The inference prompt exceeds this worker size limit.');
  }
  return {
    model,
    system,
    prompt,
    temperature: Math.max(0, Math.min(2, Number(input.temperature) || 0.8)),
    numPredict: Math.max(1, Math.min(4096, Number(input.numPredict) || 200)),
    timeoutMs: Math.max(30_000, Math.min(30 * 60 * 1000, Number(input.timeoutMs) || 5 * 60 * 1000)),
  };
}

function sharedPriority(job) {
  if (job && (job.priority === 'interactive' || job.allocationClass === 'interactive')) return 'interactive';
  if (job && (job.allocationClass === 'synthetic' || job.priority === 'background')) return 'synthetic';
  return 'user';
}

function validClaimJob(job) {
  return job && typeof job === 'object' && !Array.isArray(job) && job.status === 'claimed'
    && typeof job.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(job.id)
    && job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)
    && (job.leaseProtocolVersion === 2 ? /^l_[a-f0-9]{32}$/.test(job.leaseToken || '')
      : (job.leaseProtocolVersion === undefined || job.leaseProtocolVersion === 1) && job.leaseToken === undefined);
}

function createWorker(options = {}) {
  const runnerUrl = cleanRunnerUrl(options.runnerUrl);
  const key = String(options.key || '');
  if (!key) throw new Error('FEDDIT_WORKER_KEY is required.');
  const workerId = String(options.workerId || os.hostname()).trim();
  if (!workerId) throw new Error('FEDDIT_WORKER_ID must not be empty.');

  const fetchImpl = options.fetchImpl || fetch;
  const generate = options.generate || ollama.generate;
  const logger = options.logger || console;
  const pollMs = Number(options.pollMs) || DEFAULT_POLL_MS;
  const renewMs = Number(options.renewMs) || DEFAULT_RENEW_MS;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const models = parseAllowedModels(options.allowedModels, ollama.DEFAULT_MODEL);
  const delivery = createDeliveryStore({
    directory: options.stateDir || process.env.FEDDIT_WORKER_STATE_DIR || path.join(
      process.env.FEDDIT_BOT_DATA_DIR || path.join(__dirname, 'data'), 'worker-delivery'),
    runnerUrl, workerId,
    fsImpl: options.deliveryFsImpl,
  });
  let state = delivery.read();
  const maintenance = createMaintenanceGate({ directory: options.maintenanceDir, logger,
    recovering: !!state.pending, deliveryBlocked: state.pending && state.pending.blocked });
  let stopped = false;
  let polling = false;
  let admitted = !!state.pending;
  let renewTimer = null;
  let deliveryError = false;
  let quarantineReported = false;

  function persist(next) {
    try { state = delivery.write(next); }
    catch (error) {
      deliveryError = true;
      maintenance.blockDelivery('storage');
      stopRenew();
      logger.error('Worker delivery state unavailable. New claims are blocked.');
      throw error;
    }
  }

  async function request(route, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(options.requestTimeoutMs) || 30_000);
    const operation = String(route).split('/').pop();
    const started = Date.now();
    let phase = 'headers';
    let status = null;
    try {
      const url = new URL(String(route || '').replace(/^\/+/, ''), runnerUrl);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      status = response.status;
      phase = 'body';
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw Object.assign(new Error('Runner response exceeds the protocol size limit.'), { code: 'WORKER_RESPONSE_PROTOCOL' });
      let data;
      try { data = JSON.parse(text); } catch {
        throw Object.assign(new Error('Runner returned invalid JSON.'), { code: 'WORKER_RESPONSE_PROTOCOL' });
      }
      if (!response.ok) {
        throw Object.assign(new Error('Runner returned HTTP ' + response.status + '.'), { status: response.status, code: 'WORKER_HTTP' });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)
          || (operation === 'claim' ? !Object.hasOwn(data, 'job')
            || (data.job !== null && !validClaimJob(data.job))
            : data.ok !== true)) {
        throw Object.assign(new Error('Runner returned an invalid worker protocol response.'), { code: 'WORKER_RESPONSE_PROTOCOL' });
      }
      return data;
    } catch (original) {
      const reason = ctrl.signal.aborted ? 'timeout' : status === 401 || status === 403 ? 'auth'
        : status === 409 || status === 410 ? 'conflict' : status >= 500 ? 'http5xx'
            : status === 429 ? 'http429' : original && original.code === 'WORKER_RESPONSE_PROTOCOL' ? 'protocol'
            : status ? 'http' : 'connection';
      const error = new Error('Worker ' + operation + ' request failed (' + reason + ').');
      Object.assign(error, { code: 'WORKER_REQUEST_' + reason.toUpperCase(), reason, status, phase });
      (logger.warn || logger.error).call(logger, { event: 'request_failed', operation, phase, reason, status,
        elapsedMs: Math.max(0, Date.now() - started) });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function fencedDetails(job, busy) {
    return { ...workerDetails(busy), ...(job.leaseToken ? { leaseToken: job.leaseToken } : {}) };
  }

  function startRenew(job) {
    if (renewTimer) return;
    let renewing = false;
    renewTimer = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try { await request('api/worker/jobs/' + encodeURIComponent(job.id) + '/renew', fencedDetails(job, true)); }
      catch (error) { logger.warn('Could not renew job ' + job.id + ': ' + error.message); }
      finally { renewing = false; }
    }, renewMs);
    if (renewTimer.unref) renewTimer.unref();
  }

  function stopRenew() {
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = null;
  }

  function finishAdmission() {
    stopRenew();
    if (admitted) maintenance.end();
    admitted = false;
  }

  async function flushPending() {
    if (!state.pending || deliveryError) return false;
    const pending = state.pending;
    if (!admitted) {
      if (!maintenance.beginRecovery()) return false;
      admitted = true;
    }
    if (pending.blocked) {
      stopRenew();
      maintenance.blockDelivery(pending.blocked);
      if (!quarantineReported) {
        logger.error({ event: 'delivery_quarantined', operation: pending.operation,
          jobId: pending.jobId, reason: pending.blocked });
        quarantineReported = true;
      }
      return false;
    }
    startRenew({ id: pending.jobId, leaseToken: pending.leaseToken });
    try {
      await request('api/worker/jobs/' + encodeURIComponent(pending.jobId) + '/' + pending.operation, {
        ...fencedDetails(pending, true), ...pending.body,
      });
      persist({ ...state, pending: null });
      logger.log(pending.operation === 'complete' ? 'Completed inference job ' + pending.jobId + '.'
        : 'Inference job ' + pending.jobId + ' failed: ' + pending.body.error);
      finishAdmission();
      return true;
    } catch (error) {
      if (['auth', 'conflict', 'protocol'].includes(error.reason)) {
        persist({ ...state, pending: { ...pending, blocked: error.reason } });
        stopRenew();
        maintenance.blockDelivery(error.reason);
        logger.error({ event: 'delivery_quarantined', operation: pending.operation,
          jobId: pending.jobId, reason: error.reason });
        quarantineReported = true;
      }
      logger.error('Could not deliver job ' + pending.jobId + ': ' + error.message);
      return false;
    }
  }

  function workerDetails(busy) {
    return {
      workerId,
      version: VERSION,
      model: Array.from(models).join(','),
      busy: busy === true,
    };
  }

  async function runJob(job) {
    if (state.pending || deliveryError) throw new Error('Worker has an unresolved delivery. New inference is blocked.');
    let terminal;
    startRenew(job);
    try {
      const payload = cleanPayload(job.payload, models);
      // Hosted jobs keep the existing absolute/stream-idle contract. The new
      // first-output/progress policy is for desktop/self-hosted local requests.
      payload.legacyTimeouts = true;
      payload.hostedDecision = /^(scheduled|simulation-now)-decision(?:-retry)?$/.test(String(job.kind || '')) || !!job.payload.decisionBudget;
      if (job.payload.decisionBudget) payload.decisionBudget = job.payload.decisionBudget;
      payload.priorityClass = sharedPriority(job);
      const result = await generate(payload);
      terminal = { operation: 'complete', body: { result } };
    } catch (err) {
      const code = /^(?:UNSUPPORTED_MODEL|EMPTY_RESPONSE|THINKING_EXHAUSTED|HOSTED_(?:DECISION|TOKENIZER)[A-Z0-9_]*|(?:OLLAMA|SHARED_OLLAMA)_[A-Z0-9_]+)$/.test(err.code || '')
        ? err.code.slice(0, 80) : 'INFERENCE_FAILED';
      terminal = { operation: 'fail', body: {
        error: 'Worker inference failed (' + code + ').',
        retryable: err.code !== 'UNSUPPORTED_MODEL' && !String(err.code || '').startsWith('HOSTED_DECISION') && !String(err.code || '').startsWith('HOSTED_TOKENIZER'),
      } };
    }
    // Generation has finished. A delivery failure must never be reclassified as
    // an inference failure or create another model call. Persist before sending.
    persist({ ...state, pending: { jobId: job.id, leaseToken: job.leaseToken || null, ...terminal, blocked: null } });
    const delivered = await flushPending();
    return delivered && terminal.operation === 'complete';
  }

  async function pollOnce() {
    if (polling || deliveryError) return false;
    polling = true;
    try {
      if (state.pending) return await flushPending();
      if (!maintenance.begin()) return false;
      admitted = true;
      if (!state.claimRequestId) persist({ ...state, claimRequestId: 'c_' + crypto.randomBytes(16).toString('hex') });
      const response = await request('api/worker/claim', { ...workerDetails(false), claimRequestId: state.claimRequestId });
      persist({ ...state, claimRequestId: null });
      if (!response.job) return false;
      await runJob(response.job);
      return true;
    } finally {
      if (!state.pending && !deliveryError) finishAdmission();
      polling = false;
    }
  }

  async function run() {
    logger.log('DELL worker ' + workerId + ' is polling ' + runnerUrl);
    while (!stopped) {
      let worked = false;
      try {
        worked = await pollOnce();
      } catch (err) {
        logger.error('Worker poll failed: ' + err.message);
      }
      if (!stopped) await sleep(worked ? 1000 : pollMs);
    }
  }

  function stop() {
    stopped = true;
  }

  return { runnerUrl, workerId, models, request, runJob, pollOnce, run, stop, maintenance,
    deliveryFile: delivery.file, flushPending };
}

if (require.main === module) {
  const logger = process.env.FEDDIT_WORKER_LOG_FILE
    ? require('./lib/worker-operational-log').createLogger(process.env.FEDDIT_WORKER_LOG_FILE, process.env.FEDDIT_WORKER_KEY)
    : console;
  let worker;
  try {
    worker = createWorker({
      runnerUrl: process.env.FEDDIT_RUNNER_URL,
      key: process.env.FEDDIT_WORKER_KEY,
      workerId: process.env.FEDDIT_WORKER_ID || os.hostname(),
      allowedModels: process.env.FEDDIT_WORKER_MODELS,
      maintenanceDir: process.env.FEDDIT_MAINTENANCE_DIR,
      logger,
    });
  } catch (err) {
    logger.error(err.message);
    process.exitCode = 1;
    return;
  }
  process.on('SIGINT', () => worker.stop());
  process.on('SIGTERM', () => worker.stop());
  worker.run().catch((err) => {
    logger.error('Worker stopped: ' + err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  VERSION,
  DEFAULT_POLL_MS,
  DEFAULT_RENEW_MS,
  cleanRunnerUrl,
  parseAllowedModels,
  cleanPayload,
  sharedPriority,
  validClaimJob,
  createWorker,
};

