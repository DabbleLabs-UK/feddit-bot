'use strict';

// Outbound-only DELL inference worker. It claims jobs from the public runner,
// runs them through local Ollama, and returns the result. It never opens a port.

const os = require('node:os');
const ollama = require('./lib/providers/ollama');

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
  let stopped = false;

  async function request(route, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
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
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      if (!response.ok) {
        throw new Error((data && data.error) || ('Runner returned HTTP ' + response.status + '.'));
      }
      return data;
    } finally {
      clearTimeout(timer);
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
    let renewTimer = null;
    try {
      const payload = cleanPayload(job.payload, models);
      renewTimer = setInterval(() => {
        request('api/worker/jobs/' + encodeURIComponent(job.id) + '/renew', workerDetails(true))
          .catch((err) => logger.warn('Could not renew job ' + job.id + ': ' + err.message));
      }, renewMs);
      if (renewTimer && renewTimer.unref) renewTimer.unref();

      const result = await generate(payload);
      await request('api/worker/jobs/' + encodeURIComponent(job.id) + '/complete', {
        ...workerDetails(false),
        result,
      });
      logger.log('Completed inference job ' + job.id + '.');
      return true;
    } catch (err) {
      await request('api/worker/jobs/' + encodeURIComponent(job.id) + '/fail', {
        ...workerDetails(false),
        error: err.message,
        retryable: err.code !== 'UNSUPPORTED_MODEL',
      }).catch((reportErr) => {
        logger.error('Could not report failed job ' + job.id + ': ' + reportErr.message);
      });
      logger.error('Inference job ' + job.id + ' failed: ' + err.message);
      return false;
    } finally {
      if (renewTimer) clearInterval(renewTimer);
    }
  }

  async function pollOnce() {
    const response = await request('api/worker/claim', workerDetails(false));
    if (!response.job) return false;
    await runJob(response.job);
    return true;
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

  return { runnerUrl, workerId, models, request, runJob, pollOnce, run, stop };
}

if (require.main === module) {
  let worker;
  try {
    worker = createWorker({
      runnerUrl: process.env.FEDDIT_RUNNER_URL,
      key: process.env.FEDDIT_WORKER_KEY,
      workerId: process.env.FEDDIT_WORKER_ID || os.hostname(),
      allowedModels: process.env.FEDDIT_WORKER_MODELS,
    });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  process.on('SIGINT', () => worker.stop());
  process.on('SIGTERM', () => worker.stop());
  worker.run().catch((err) => {
    console.error('Worker stopped: ' + err.message);
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
  createWorker,
};

