'use strict';

const assert = require('node:assert/strict');
const { createModelInstaller } = require('../lib/model-installer');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  const gate = deferred();
  let progress = null;
  let ready = null;
  const installer = createModelInstaller({
    pullModel: async (model, onProgress) => {
      assert.equal(model, 'qwen3:4b-instruct');
      progress = onProgress;
      return gate.promise;
    },
    onReady: (model) => { ready = model; },
  });

  assert.equal(installer.start('qwen3:4b-instruct').state, 'starting');
  await settle();
  progress({ status: 'downloading', completed: 25, total: 100 });
  assert.equal(installer.get('qwen3:4b-instruct').percent, 25);
  assert.throws(() => installer.start('qwen2.5:7b'), /Finish downloading/);
  gate.resolve({ ok: true });
  await settle();
  assert.equal(installer.get('qwen3:4b-instruct').state, 'ready');
  assert.equal(ready, 'qwen3:4b-instruct');
  assert.throws(() => installer.start('not-guided'), /guided local models/);

  const failed = createModelInstaller({ pullModel: async () => { throw new Error('disk full'); } });
  failed.start('qwen2.5:1.5b');
  await settle();
  assert.equal(failed.get('qwen2.5:1.5b').state, 'failed');
  assert.equal(failed.get('qwen2.5:1.5b').error, 'disk full');
  console.log('model-installer: all checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
