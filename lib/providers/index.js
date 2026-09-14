'use strict';

// Provider facade. Routes a generation to the right backend and enforces the
// per-provider concurrency rules the scheduler relies on:
//
//  - ollama: AT MOST ONE in-flight generation, ever (its single-flight gate
//    lives in providers/ollama.js and forces keep_alive: -1). This gate exists
//    solely to protect Cy's resident model on DELL. It is LOCAL to ollama.
//  - deepseek: a REMOTE call, independent of the ollama gate. Up to
//    DEEPSEEK_MAX_CONCURRENT run at once so a burst of due profiles can't spawn
//    an unbounded pile of concurrent HTTP requests.
//
// Common interface (all providers):
//   generate({ provider, system, prompt, temperature, numPredict, model, apiKey })
//     -> { text, usage:{ inputTokens, outputTokens, cachedInputTokens }, provider, model, ms }

const ollama = require('./ollama');
const deepseek = require('./deepseek');
const dellFactory = require('./dell');

const PROVIDERS = ['ollama', 'dell', 'deepseek'];
const DEEPSEEK_MAX_CONCURRENT = 3; // sane cap so a cadence burst can't run away
let dell = null;

// ---- tiny async semaphore for deepseek --------------------------------------

let dsActive = 0;
const dsWaiters = [];

function acquireDeepseekSlot() {
  if (dsActive < DEEPSEEK_MAX_CONCURRENT) {
    dsActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => dsWaiters.push(resolve));
}

function releaseDeepseekSlot() {
  const next = dsWaiters.shift();
  if (next) next(); // hand the slot straight to a waiter (dsActive stays put)
  else dsActive--;
}

function deepseekInFlight() {
  return dsActive;
}

// ---- routing ----------------------------------------------------------------

function normProvider(p) {
  return p === 'deepseek' || p === 'dell' ? p : 'ollama';
}

function configureDellQueue(queue, options) {
  dell = dellFactory.createDellProvider(queue, options);
  return dell;
}

// Is the ollama single-flight gate currently busy? DeepSeek ignores this.
function ollamaBusy() {
  return ollama.isBusy();
}

async function generate(opts = {}) {
  const provider = normProvider(opts.provider);
  if (provider === 'deepseek') {
    await acquireDeepseekSlot();
    try {
      return await deepseek.generate(opts);
    } finally {
      releaseDeepseekSlot();
    }
  }
  if (provider === 'dell') {
    if (!dell) throw new Error('The hosted compute queue is not configured.');
    return dell.generate(opts);
  }
  return ollama.generate(opts); // ollama enforces its own single-flight gate
}

function enqueueDell(opts = {}) {
  if (!dell) throw new Error('The hosted compute queue is not configured.');
  return dell.enqueue(opts);
}

module.exports = {
  PROVIDERS,
  DEEPSEEK_MAX_CONCURRENT,
  DEFAULT_MODEL: ollama.DEFAULT_MODEL,
  ollama,
  deepseek,
  dellFactory,
  generate,
  enqueueDell,
  configureDellQueue,
  ollamaBusy,
  deepseekInFlight,
  normProvider,
};
