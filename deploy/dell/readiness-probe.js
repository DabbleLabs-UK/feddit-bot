'use strict';

// Run with Windows Node: these loopback listeners belong to Windows, not WSL.
// Metadata only. Never acquire a lease, load a model, or run inference here.
const tokenizer = require('../../lib/hosted-tokenizer');
const VERSION = '0.34.1';

async function verifyReadiness(fetchImpl = fetch, environment = process.env) {
  // Check the same inherited Windows environment the worker will use. A healthy
  // default listener proves nothing if the provider is configured elsewhere.
  const ollama = String(environment.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const arbiterUrl = String(environment.SHARED_OLLAMA_ARBITER_URL || '').replace(/\/$/, '');
  const models = String(environment.FEDDIT_WORKER_MODELS || tokenizer.MODEL).split(',').map((value) => value.trim()).filter(Boolean);
  if (ollama !== 'http://127.0.0.1:11434' || arbiterUrl !== 'http://127.0.0.1:11435'
      || models.length !== 1 || models[0] !== tokenizer.MODEL) {
    return { ready: false, reason: 'PROVIDER_CONFIGURATION_UNVERIFIED' };
  }
  async function read(url, body) {
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('METADATA_UNAVAILABLE');
    return response.json();
  }
  try {
    const version = await read(ollama + '/api/version');
    if (version.version !== VERSION) return { ready: false, reason: 'OLLAMA_VERSION_MISMATCH' };
    const tags = await read(ollama + '/api/tags');
    const show = await read(ollama + '/api/show', { model: tokenizer.MODEL });
    tokenizer.verifyModel(show, tags);
    const arbiter = await read(arbiterUrl + '/health');
    if (arbiter.ok !== true || arbiter.profile?.num_ctx !== 3072 || arbiter.profile?.num_thread !== 4) {
      return { ready: false, reason: 'ARBITER_UNVERIFIED' };
    }
    return { ready: true, version: VERSION };
  } catch (error) {
    return { ready: false, reason: String(error.code || '').startsWith('HOSTED_TOKENIZER')
      ? 'TOKENIZER_UNVERIFIED' : 'METADATA_UNAVAILABLE' };
  }
}

if (require.main === module) {
  verifyReadiness().then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ready ? 0 : 1;
  }).catch(() => { process.stdout.write('{"ready":false,"reason":"PROBE_FAILED"}\n'); process.exitCode = 1; });
}

module.exports = { verifyReadiness, VERSION };
