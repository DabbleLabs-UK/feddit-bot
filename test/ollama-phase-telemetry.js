'use strict';

// No HTTP, model calls, or application data: injected terminal records only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-phase-telemetry-'));
process.env.FEDDIT_BOT_DATA_DIR = dir;
const ollama = require('../lib/providers/ollama');
const { safeEvent, createLocalGenerationTelemetry } = require('../lib/local-generation-telemetry');
let checks = 0;
const eq = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };

async function run() {
  eq(ollama._test.nativeTiming({ load_duration: 1234567, prompt_eval_duration: 1100000000000,
    eval_duration: 92000000000, total_duration: 1192001234567 }), {
    modelLoadMs: 1.234567, promptEvalMs: 1100000, generationEvalMs: 92000, ollamaTotalMs: 1192001.234567,
  });
  for (const value of [null, undefined, 'secret', '123', -1, NaN, Infinity, {}, []]) {
    eq(ollama._test.nativeTiming({ load_duration: value }).modelLoadMs, null);
  }
  eq(ollama._test.nativeTiming({ load_duration: 0 }).modelLoadMs, 0);
  const old = safeEvent({ id: 1, status: 'completed', inputTokens: 14 });
  for (const key of ['modelLoadMs', 'promptEvalMs', 'generationEvalMs', 'ollamaTotalMs',
    'systemCharacters', 'promptCharacters', 'requestedContextTokens', 'leaseWaitMs']) eq(old[key], null);
  const poisoned = safeEvent({ prompt: 'PRIVATE_PROMPT', system: 'PRIVATE_SYSTEM',
    modelLoadMs: 'PRIVATE_PROMPT', promptEvalMs: -1, generationEvalMs: Infinity,
    ollamaTotalMs: NaN, arbitrary: 'SECRET' });
  eq([poisoned.modelLoadMs, poisoned.promptEvalMs, poisoned.generationEvalMs, poisoned.ollamaTotalMs],
    [null, null, null, null]);
  assert.doesNotMatch(JSON.stringify(poisoned), /PRIVATE_|SECRET/); checks++;

  const terminal = { message: { content: 'PRIVATE_GENERATED_TEXT', thinking: 'PRIVATE_THINKING' },
    done: true, prompt_eval_count: 11528, eval_count: 296, load_duration: 1000000,
    prompt_eval_duration: 1113195940000, eval_duration: 484318810000, total_duration: 1597514760000 };
  let sent;
  const generated = await ollama.generate({ system: 'PRIVATE_SYSTEM', prompt: 'PRIVATE_PROMPT',
    model: 'fixture-local', kind: 'scheduled-decision', numPredict: 640, leaseClient: null,
    decisionEvidenceVersion: 1,
    chatTransport: async (body) => { sent = body; return terminal; },
  });
  eq(generated.text, 'PRIVATE_GENERATED_TEXT');
  eq(generated.usage, { inputTokens: 11528, outputTokens: 296, cachedInputTokens: 0 });
  eq(generated.queueMs, 0);
  eq(sent, { model: 'fixture-local', messages: [{ role: 'system', content: 'PRIVATE_SYSTEM' },
    { role: 'user', content: 'PRIVATE_PROMPT' }], stream: true, keep_alive: -1,
    options: { temperature: .8, num_predict: 640, num_thread: 4 } });
  let saved = JSON.parse(fs.readFileSync(ollama._test.telemetryFile)).events[0];
  eq(saved.modelLoadMs, 1);
  eq(saved.promptEvalMs, 1113195.94);
  eq(saved.generationEvalMs, 484318.81);
  eq(saved.ollamaTotalMs, 1597514.76);
  eq(saved.systemCharacters, 'PRIVATE_SYSTEM'.length);
  eq(saved.promptCharacters, 'PRIVATE_PROMPT'.length);
  eq(saved.requestedOutputTokens, 640);
  eq(saved.decisionEvidenceVersion, 1);
  eq(saved.requestedContextTokens, null);
  eq(saved.requestedThreads, 4);
  eq(saved.leaseWaitMs, 0);
  eq(ollama.generationActivity().active, null);

  let releases = 0;
  await ollama.generate({ model: 'fixture-leased', leaseClient: { acquire: async () => ({
    waitMs: 1234, profile: { num_ctx: 3072, num_thread: 4 }, release: async () => { releases++; },
  }) }, chatTransport: async () => ({ message: { content: 'Leased output' }, done: true }) });
  saved = JSON.parse(fs.readFileSync(ollama._test.telemetryFile)).events[0];
  eq(saved.leaseWaitMs, 1234);
  eq(saved.requestedContextTokens, 3072);
  eq(saved.modelLoadMs, null);
  eq(saved.decisionEvidenceVersion, null);
  eq(releases, 1);

  await assert.rejects(ollama.generate({ model: 'fixture-failed', leaseClient: null,
    chatTransport: async () => { throw Object.assign(new Error('PRIVATE_ERROR'), {
      code: 'OLLAMA_FIRST_OUTPUT_TIMEOUT', failureClass: 'waiting-for-first-output-timeout',
    }); },
  }), { code: 'OLLAMA_FIRST_OUTPUT_TIMEOUT' }); checks++;
  saved = JSON.parse(fs.readFileSync(ollama._test.telemetryFile)).events[0];
  eq(saved.status, 'failed');
  eq(saved.modelLoadMs, null);
  eq(saved.promptEvalMs, null);
  eq(saved.inputTokens, null);
  eq(saved.failureCode, 'OLLAMA_FIRST_OUTPUT_TIMEOUT');
  eq(ollama.isBusy(), false);
  eq(ollama.generationActivity().active, null);
  assert.doesNotMatch(fs.readFileSync(ollama._test.telemetryFile, 'utf8'), /PRIVATE_/); checks++;
  const reloaded = createLocalGenerationTelemetry({ file: ollama._test.telemetryFile }).read();
  eq(reloaded.find(e => e.model === 'fixture-local').promptEvalMs, 1113195.94);
  console.log('ollama-phase-telemetry: ' + checks + ' checks passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
