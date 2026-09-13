'use strict';

// Public-runner side of the hosted provider. Generation is placed in the
// durable queue and fulfilled by an outbound-only DELL worker.

const crypto = require('node:crypto');

const DEFAULT_WAIT_MS = 26 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;

function hashRequest(opts) {
  const stable = JSON.stringify({
    profileId: String(opts.profileId || ''),
    kind: String(opts.kind || ''),
    model: String(opts.model || ''),
    system: String(opts.system || ''),
    prompt: String(opts.prompt || ''),
    temperature: Number(opts.temperature) || 0,
    numPredict: Number(opts.numPredict) || 0,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function createDellProvider(queue, options = {}) {
  if (!queue || typeof queue.enqueue !== 'function' || typeof queue.get !== 'function') {
    throw new Error('A durable inference queue is required.');
  }
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.max(10, Number(options.pollMs) || DEFAULT_POLL_MS);

  function enqueue(opts = {}) {
    const profileId = String(opts.profileId || '');
    return queue.enqueue({
      source: String(opts.source || 'feddit'),
      kind: String(opts.kind || 'scheduled-generation'),
      ownerKey: String(opts.ownerKey || profileId || 'hosted'),
      profileId: profileId || null,
      priority: String(opts.priority || 'normal'),
      dedupeKey: String(opts.dedupeKey || hashRequest(opts)),
      activityAction: String(opts.activityAction || ''),
      activityTrigger: String(opts.activityTrigger || ''),
      activityTarget: String(opts.activityTarget || ''),
      payload: {
        model: opts.model,
        system: opts.system,
        prompt: opts.prompt,
        temperature: opts.temperature,
        numPredict: opts.numPredict,
        timeoutMs: opts.timeoutMs,
      },
    });
  }

  async function wait(jobId, waitMs = DEFAULT_WAIT_MS) {
    const startedAt = now();
    while (now() - startedAt <= waitMs) {
      const job = queue.get(jobId);
      if (!job) throw new Error('The hosted inference job disappeared.');
      if (job.status === 'completed') {
        const result = job.result && typeof job.result === 'object' ? job.result : {};
        if (!String(result.text || '').trim()) throw new Error('DELL returned an empty generation.');
        return {
          ...result,
          provider: 'dell',
          workerProvider: String(result.provider || 'ollama'),
        };
      }
      if (job.status === 'failed') {
        const err = new Error(job.lastError || 'The hosted inference job failed.');
        err.code = 'HOSTED_FAILED';
        throw err;
      }
      await sleep(pollMs);
    }
    const err = new Error('The hosted inference job did not finish within the wait window.');
    err.code = 'HOSTED_TIMEOUT';
    throw err;
  }

  async function generate(opts = {}) {
    const job = enqueue(opts);
    return wait(job.id, Number(opts.waitMs) || DEFAULT_WAIT_MS);
  }

  return { enqueue, wait, generate };
}

module.exports = {
  DEFAULT_WAIT_MS,
  DEFAULT_POLL_MS,
  hashRequest,
  createDellProvider,
};
