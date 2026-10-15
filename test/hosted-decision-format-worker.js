'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const format = require('../lib/hosted-decision-format');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const ollama = require('../lib/providers/ollama');
const { createWorker } = require('../worker');

let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }

async function run() {
  const descriptor = { version: 1, candidateIds: ['C7', 'C11'], voteIds: ['V2', 'V8'] };
  const schema = format.schema(descriptor);
  equal(crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
    '8c59e767e01b424472b9f9aa5eee49a82a4887759eebc2e26824a8c8aec15573', 'frozen v1 schema serialization stays exact');
  const constrainedDescriptor = { ...descriptor, version: 2 };
  equal(format.validate(constrainedDescriptor), constrainedDescriptor, 'frozen v2 descriptor retains version and stable IDs');
  const constrainedSchema = format.schema(constrainedDescriptor);
  for (const [index, item] of constrainedSchema.properties.votes.items.entries()) {
    const [reaction, abstention] = item.oneOf;
    equal(reaction.properties.id.enum, [descriptor.voteIds[index]], 'v2 reaction fixes offered stable vote ID');
    equal(abstention.properties.id.enum, [descriptor.voteIds[index]], 'v2 abstention fixes offered stable vote ID');
    equal(reaction.properties.direction.enum, ['up', 'down'], 'v2 separates non-nil reasons');
    equal(abstention.properties.direction.enum, ['nil'], 'nil remains independently available');
    equal(abstention.properties.reason, { type: 'string' }, 'nil explanation may be empty');
    const rule = reaction.properties.reason;
    equal(rule.minLength, 15, 'non-nil reason declares normalized minimum length');
    const fits = (reason) => reason.length >= rule.minLength && new RegExp(rule.pattern, 'u').test(reason);
    for (const reason of ['A fitting point', 'Specific useful target evidence']) check(fits(reason), 'canonical valid reason fits formal schema');
    for (const reason of ['Seventeen letters', 'a b c', 'a             b c', ' A fitting point',
      'A fitting point ', 'A\tfitting point', 'A\u000bfitting point', 'A\u000cfitting point',
      'A\u00a0fitting point', 'A\ufefffitting point']) {
      check(!fits(reason), 'invalid length/word count cannot hide behind padding');
    }
    check(!rule.pattern.includes('(?') && !rule.pattern.includes('\\s') && !rule.pattern.includes('\\S'),
      'pattern avoids unsupported native converter lookaround/shorthand');
  }
  equal(schema.properties.choice.enum, ['WAIT', 'C7', 'C11'], 'native schema permits only offered action IDs or WAIT');
  equal(schema.properties.votes.items.map((item) => item.properties.id.enum), [['V2'], ['V8']], 'tuple permits every offered vote exactly once in stable order');
  equal([schema.properties.votes.minItems, schema.properties.votes.maxItems], [2, 2], 'native tuple is bounded to offered slate');
  check(schema.additionalProperties === false && schema.properties.votes.items.every((item) => item.additionalProperties === false),
    'arbitrary fields are not part of native schema');
  equal(schema.properties.votes.items[0].properties.direction.enum, ['up', 'down', 'nil'], 'no vote direction is forced');
  equal(format.schema({ version: 1, candidateIds: [], voteIds: ['V8'] }).properties.choice.enum, ['WAIT'], 'voting-only slate cannot invent an action');
  equal(format.schema({ version: 1, candidateIds: ['C7'], voteIds: [] }).properties.votes.maxItems, 0, 'action-only slate cannot invent votes');
  for (const legacyVersion of [null, undefined, 0]) equal(format.version(legacyVersion), 0, 'legacy version remains supported');
  equal(format.version(1), 1, 'new format version supported');
  equal(format.version(2), 2, 'reason-constrained format version supported');
  equal(format.VERSION, 2, 'latest native format uses reason constraints');
  assert.throws(() => format.version(3), (error) => error.code === 'UNSUPPORTED_HOSTED_DECISION_FORMAT'); checks++;
  for (const invalid of [null, {}, { ...descriptor, version: 0 }, { ...descriptor, version: 3 }, { ...descriptor, schema: {} },
    { ...descriptor, candidateIds: ['C13'] }, { ...descriptor, voteIds: ['V9'] },
    { ...descriptor, candidateIds: ['C7', 'C7'] }, { ...descriptor, voteIds: ['V2', 'V2'] },
    { ...descriptor, candidateIds: ['C01'] }, { ...descriptor, voteIds: ['V0'] },
    { version: 1, candidateIds: [], voteIds: [] }]) {
    assert.throws(() => format.validate(invalid)); checks++;
  }

  const asset = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../lib/hosted-tokenizer-data.json.gz'))));
  const show = { template: asset.template,
    parameters: 'stop                           "<|im_start|>"\nstop                           "<|im_end|>"', model_info: asset.tokenizer };
  const tags = { models: [{ name: tokenizer.MODEL, digest: tokenizer.MANIFEST_SHA256 }] };
  const request = { model: tokenizer.MODEL, system: 'Unchanged fixture persona.', prompt: 'Choose C7 or WAIT.', numPredict: 640 };
  let leases = 0, releases = 0;
  const leaseClient = { acquire: async () => { leases++; return { profile: { num_ctx: 3072, num_thread: 4 },
    release: async () => { releases++; } }; } };
  const generation = { ...request, hostedDecision: true,
    decisionBudget: budget.measure(request.system, request.prompt, request.numPredict, 2),
    hostedDecisionFormat: descriptor, leaseClient };
  const previousFetch = global.fetch;
  let runtimeVersion = '0.34.1', installed = tags, finishReason = 'stop', content = '{"choice":"WAIT","reason":"No suitable action","votes":[]}';
  let inferenceCalls = 0, lastBody;
  const routes = [];
  global.fetch = async (url, options = {}) => {
    const route = new URL(url).pathname;
    routes.push(route);
    let response;
    if (route === '/api/version') response = { version: runtimeVersion };
    else if (route === '/api/tags') response = installed;
    else if (route === '/api/show') response = show;
    else if (route === '/api/chat') {
      inferenceCalls++;
      lastBody = JSON.parse(options.body);
      response = { message: { content }, done_reason: finishReason, prompt_eval_count: 42, eval_count: 18 };
    } else throw new Error('Unexpected mocked route: ' + route);
    return { ok: true, text: async () => JSON.stringify(response) };
  };
  try {
    const result = await ollama.generate(generation);
    equal(routes, ['/api/version', '/api/tags', '/api/show', '/api/chat'], 'actual nonstreaming transport verifies metadata before native chat');
    equal(lastBody.format, schema, 'actual native JSON body contains only derived schema');
    equal(lastBody.stream, false, 'production nonstreaming transport remains unchanged');
    equal(lastBody.keep_alive, -1, 'shared resident model remains resident');
    equal(lastBody.messages, [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
      'system, prompt and framing are unchanged');
    equal([lastBody.options.num_ctx, lastBody.options.num_predict, lastBody.options.num_thread], [3072, 640, 4],
      'context, output budget and shared threads are unchanged');
    equal(result.finishReason, 'stop', 'known native finish reason retained');
    equal(result.text, content, 'provider does not synthesize missing semantic votes');
    await ollama.generate({ ...generation, hostedDecisionFormat: constrainedDescriptor });
    equal(lastBody.format, constrainedSchema, 'nonstreaming worker forwards v2 native schema without transport changes');
    finishReason = 'length';
    equal((await ollama.generate(generation)).finishReason, 'length', 'native output-limit signal retained');
    finishReason = 'sensitive unrecognized upstream detail';
    content = 'malformed prose';
    const unknown = await ollama.generate(generation);
    equal(unknown.finishReason, 'unknown', 'arbitrary finish detail is not propagated');
    equal(unknown.text, 'malformed prose', 'provider never salvages or auto-accepts malformed output');
    const legacy = await ollama.generate({ ...generation, hostedDecisionFormat: undefined });
    check(!Object.hasOwn(lastBody, 'format') && !Object.hasOwn(legacy, 'finishReason'), 'absent descriptor preserves legacy request and result shape');
    await ollama.generate({ ...generation, hostedDecision: false, decisionBudget: null, hostedDecisionFormat: undefined });
    check(!Object.hasOwn(lastBody, 'format'), 'ordinary generation remains unconstrained');
    const prior = inferenceCalls;
    for (const change of [{ hostedDecision: false }, { decisionBudget: null },
      { hostedDecisionFormat: { ...descriptor, version: 99 } }, { prompt: 'changed after frozen budgeting' },
      { model: 'unverified' }, { system: 'Intact required context. '.repeat(3000),
        decisionBudget: budget.measure('Intact required context. '.repeat(3000), request.prompt, 640, 2) },
      { leaseClient: { acquire: async () => { leases++; return { profile: { num_ctx: 2048 }, release: async () => { releases++; } }; } } }]) {
      await assert.rejects(() => ollama.generate({ ...generation, ...change })); checks++;
    }
    runtimeVersion = '0.40.4';
    await assert.rejects(() => ollama.generate(generation), /verified/); checks++;
    runtimeVersion = '0.34.1';
    installed = { models: [] };
    await assert.rejects(() => ollama.generate(generation), /tokenizer/); checks++;
    installed = tags;
    equal(inferenceCalls, prior, 'unsupported descriptors and existing budget/model/runtime guards fail before inference');
    equal(releases, leases, 'all acquired leases release on success and failed preflight');
    check(!ollama.isBusy(), 'failure clears authoritative working state');
  } finally {
    global.fetch = previousFetch;
  }

  let generated = 0, workerPayload, reported;
  const worker = createWorker({ runnerUrl: 'https://fixture.invalid', key: 'fixture',
    fetchImpl: async (_, options) => { reported = JSON.parse(options.body); return { ok: true, text: async () => '{}' }; },
    generate: async (payload) => { generated++; workerPayload = payload; return { text: 'fixture' }; },
    logger: { log() {}, error() {}, warn() {} } });
  const job = { id: 'fixture', kind: 'scheduled-decision', payload: { ...request,
    decisionBudget: generation.decisionBudget, hostedDecisionFormat: descriptor } };
  check(await worker.runJob(job), 'worker accepts supported budgeted decision descriptor');
  equal(workerPayload.hostedDecisionFormat, descriptor, 'worker forwards canonical descriptor');
  for (const invalid of [{ ...job, kind: 'scheduled-generation' }, { ...job, kind: 'burst-session' },
    { ...job, payload: { ...job.payload, hostedDecisionFormat: null } },
    { ...job, payload: { ...job.payload, hostedDecisionFormat: { ...descriptor, version: 3 } } },
    { ...job, payload: { ...job.payload, decisionBudget: undefined } }]) {
    check(!await worker.runJob(invalid), 'inapplicable or malformed descriptor rejected before inference');
    equal(reported.retryable, false, 'unsupported format never enters repeated retries');
  }
  equal(generated, 1, 'all invalid worker payloads consume zero inference');
  console.log('hosted decision format worker: ' + checks + ' checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
