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
const dell = require('../lib/providers/dell');
const { createWorker } = require('../worker');
const actions = require('../lib/action-candidates');
const voting = require('../lib/voting');

let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejected(value) {
  assert.throws(() => format.validate(value), (error) => ['HOSTED_DECISION_FORMAT', 'UNSUPPORTED_HOSTED_DECISION_FORMAT'].includes(error.code));
  checks++;
}

async function run() {
  // Content-free shapes from the retained failure taxonomy, not copied private
  // prompts or responses. Native framing is not permission to salvage any one.
  const menu = [{ id: 'C1', candidateType: 'ordinary_post' }];
  const slate = [{ id: 'V1', targetType: 'post', targetId: 1 }];
  const valid = { choice: 'C1', reason: 'This candidate fits the current conversation.',
    votes: [{ id: 'V1', direction: 'up', reason: 'A clear and specific explanation.' }] };
  for (const malformed of [JSON.stringify(valid) + '|im_end|>', 'Commentary ' + JSON.stringify(valid),
    JSON.stringify(valid).slice(0, -1), '{choice:"C1"}', 'C1 in prose',
    '{"choice":"C1","choice":"WAIT","votes":[]}', JSON.stringify({ ...valid, choice: 'C12' })]) {
    const parsed = actions.parseDecision(malformed, menu, { voteCandidates: slate, decisionContractVersion: 2 });
    equal(parsed.valid, false, 'framing, syntax and invalid-primary shapes are not salvaged');
    if (malformed !== JSON.stringify({ ...valid, choice: 'C12' })) {
      equal(voting.record({}, parsed.votes).considered, [], 'unreadable decisions never manufacture considered abstentions');
    }
  }
  const partial = actions.parseDecision(JSON.stringify({ ...valid, choice: 'UNKNOWN' }), menu,
    { voteCandidates: [...slate, { id: 'V2', targetType: 'post', targetId: 2 }], decisionContractVersion: 2 });
  equal(partial.valid, false, 'invalid primary choice remains unresolved');
  equal(partial.votes.map(v => v.decisionKind), ['explicit', 'missing'], 'independently valid partial vote is retained without filling missing votes');
  equal(voting.record({}, partial.votes).considered, ['post:1'], 'only the explicit vote can become considered');
  const descriptor = { version: 1, candidateIds: ['C7', 'C11'], voteIds: ['V2', 'V8'] };
  for (const value of [undefined, null, 0]) equal(format.version(value), 0, 'legacy format version remains exact');
  equal(format.version(1), 1, 'native format version recognized');
  for (const value of ['1', 2, false, -1, {}]) {
    assert.throws(() => format.version(value), (error) => error.code === 'UNSUPPORTED_HOSTED_DECISION_FORMAT'); checks++;
  }
  equal(format.validate(descriptor), descriptor, 'descriptor retains offered stable IDs and order');
  const clone = format.validate(descriptor);
  clone.candidateIds.push('C12');
  equal(descriptor.candidateIds, ['C7', 'C11'], 'canonical descriptor does not share input arrays');
  for (const invalid of [undefined, null, [], {}, { ...descriptor, version: 2 }, { ...descriptor, version: '1' },
    { ...descriptor, schema: {} }, { ...descriptor, voteIds: undefined }, { ...descriptor, candidateIds: 'C1' },
    { ...descriptor, candidateIds: ['C1', 'C1'] }, { ...descriptor, voteIds: ['V2', 'V2'] },
    { ...descriptor, candidateIds: ['C0'] }, { ...descriptor, candidateIds: ['C01'] },
    { ...descriptor, candidateIds: ['C13'] }, { ...descriptor, voteIds: ['V9'] },
    { ...descriptor, candidateIds: ['C1\n'] }, { ...descriptor, candidateIds: ['C1 ' ] },
    { ...descriptor, candidateIds: ['V1'] }, { ...descriptor, voteIds: ['C1'] },
    { ...descriptor, voteIds: [null] }, { ...descriptor, voteIds: Array(1) },
    { ...descriptor, candidateIds: ['C' + '1'.repeat(20)] },
    { ...descriptor, candidateIds: Array.from({ length: 13 }, (_, i) => 'C' + (i + 1)) },
    { ...descriptor, voteIds: Array.from({ length: 9 }, (_, i) => 'V' + (i + 1)) },
    { version: 1, candidateIds: [], voteIds: [] }]) rejected(invalid);

  const schema = format.schema(descriptor);
  equal(schema.properties.choice.enum, ['WAIT', 'C7', 'C11'], 'only actual offered primary IDs and explicit WAIT allowed');
  equal(schema.required, ['choice', 'reason', 'votes'], 'complete top-level structural fields required');
  equal(schema.additionalProperties, false, 'arbitrary top-level keys disallowed');
  equal([schema.properties.votes.minItems, schema.properties.votes.maxItems], [2, 2], 'vote count exactly matches offered slate');
  equal(schema.properties.votes.items.map((item) => item.properties.id.enum), [['V2'], ['V8']], 'tuple fixes each unique offered ID exactly once');
  for (const item of schema.properties.votes.items) {
    equal(item.properties.direction.enum, ['up', 'down', 'nil'], 'schema never forces a vote direction');
    equal(item.properties.reason, { type: 'string' }, 'reason semantics stay with existing validator');
    equal(item.required, ['id', 'direction', 'reason'], 'all vote structure required');
    equal(item.additionalProperties, false, 'arbitrary vote fields disallowed');
  }
  equal(schema.properties.votes.additionalItems, false, 'extra votes are forbidden');
  const maximum = { version: 1,
    candidateIds: Array.from({ length: 12 }, (_, index) => 'C' + (index + 1)),
    voteIds: Array.from({ length: 8 }, (_, index) => 'V' + (index + 1)) };
  equal(format.validate(maximum), maximum, 'complete maximum supported action and vote slates remain accepted');
  equal(format.schema(maximum).properties.votes.items.length, 8, 'maximum native vote tuple remains bounded');
  equal(format.schema({ version: 1, candidateIds: [], voteIds: ['V8'] }).properties.choice.enum,
    ['WAIT'], 'voting-only opportunity cannot invent a primary action');
  const noVotes = format.schema({ version: 1, candidateIds: ['C11'], voteIds: [] }).properties.votes;
  equal([noVotes.items, noVotes.minItems, noVotes.maxItems], [{ type: 'object' }, 0, 0], 'empty vote slate uses legal empty-array schema');
  check(!JSON.stringify(schema).includes('default'), 'schema cannot manufacture a decision or reason');

  const request = { model: tokenizer.MODEL, profileId: 'fixture', kind: 'scheduled-decision',
    system: 'An unchanged fixture persona.', prompt: 'Choose C7 or WAIT with an independent reaction to V2.',
    temperature: 0.8, numPredict: 640 };
  const legacyHash = crypto.createHash('sha256').update(JSON.stringify({ profileId: request.profileId,
    kind: request.kind, model: request.model, system: request.system, prompt: request.prompt,
    temperature: request.temperature, numPredict: request.numPredict })).digest('hex');
  equal(dell.hashRequest(request), legacyHash, 'absent descriptor preserves exact historical queue signature');
  check(dell.hashRequest({ ...request, hostedDecisionFormat: descriptor }) !== legacyHash,
    'format-enabled request has independent durable identity');
  check(dell.hashRequest({ ...request, hostedDecisionFormat: descriptor }) !==
    dell.hashRequest({ ...request, hostedDecisionFormat: { ...descriptor, voteIds: ['V8'] } }),
  'different offered format changes durable identity');
  let queued;
  const provider = dell.createDellProvider({ enqueue: (job) => { queued = job; return job; }, get: () => null });
  provider.enqueue(request);
  check(!Object.hasOwn(queued.payload, 'hostedDecisionFormat'), 'legacy payload stays unchanged');
  provider.enqueue({ ...request, hostedDecisionFormat: descriptor });
  equal(queued.payload.hostedDecisionFormat, descriptor, 'descriptor survives durable queue payload');
  assert.throws(() => provider.enqueue({ ...request, hostedDecisionFormat: null }), /descriptor/); checks++;

  const asset = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../lib/hosted-tokenizer-data.json.gz'))));
  const show = { template: asset.template,
    parameters: 'stop                           "<|im_start|>"\nstop                           "<|im_end|>"', model_info: asset.tokenizer };
  const tags = { models: [{ name: tokenizer.MODEL, digest: tokenizer.MANIFEST_SHA256 }] };
  let leases = 0, releases = 0, inferenceCalls = 0, lastBody;
  const leaseClient = { acquire: async () => { leases++; return { profile: { num_ctx: 3072, num_thread: 4 },
    release: async () => { releases++; } }; } };
  const metadataTransport = async (route) => route === '/api/version' ? { version: '0.34.1' } : route === '/api/tags' ? tags : show;
  const chatTransport = async (body) => {
    lastBody = body; inferenceCalls++;
    return { message: { content: '{"choice":"WAIT","reason":"No fitting action","votes":[]}' },
      done_reason: 'stop', prompt_eval_count: 42, eval_count: 18 };
  };
  const generation = { ...request, hostedDecision: true, decisionBudget: budget.measure(request.system, request.prompt, 640, 2),
    hostedDecisionFormat: descriptor, leaseClient, metadataTransport, chatTransport };
  const result = await ollama.generate(generation);
  equal(lastBody.format, schema, 'native Ollama request receives only derived schema');
  equal(lastBody.messages, [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
    'no persona, framing or prompt changes');
  equal([lastBody.options.num_ctx, lastBody.options.num_predict], [3072, 640], 'context and output reserve unchanged');
  equal(result.finishReason, 'stop', 'format-enabled result retains bounded native finish reason');
  equal(result.text, '{"choice":"WAIT","reason":"No fitting action","votes":[]}', 'provider does not invent or fill missing votes');
  const legacy = await ollama.generate({ ...generation, hostedDecisionFormat: undefined });
  check(!Object.hasOwn(lastBody, 'format') && !Object.hasOwn(legacy, 'finishReason'), 'legacy provider body and result shape unchanged');
  await ollama.generate({ ...generation, hostedDecision: false, decisionBudget: null, hostedDecisionFormat: undefined,
    metadataTransport: async () => { throw new Error('Local generation must not enter hosted metadata verification.'); } });
  check(!Object.hasOwn(lastBody, 'format'), 'desktop/local requests retain their existing unconstrained request');
  const boundedReason = await ollama.generate({ ...generation, chatTransport: async () => ({
    message: { content: 'not valid JSON' }, done_reason: 'x'.repeat(100) }) });
  equal(boundedReason.finishReason, 'unknown', 'unrecognized finish metadata cannot leak arbitrary response text');
  equal(boundedReason.text, 'not valid JSON', 'provider does not salvage malformed model output or pretend schema implies semantic validity');
  const largeSystem = 'Required intact persona detail. '.repeat(3000);
  const overflow = { system: largeSystem, decisionBudget: budget.measure(largeSystem, request.prompt, 640, 2) };
  const beforeGuards = inferenceCalls;
  for (const change of [{ hostedDecision: false }, { decisionBudget: null }, { hostedDecisionFormat: { ...descriptor, version: 99 } },
    { prompt: 'changed without recalculating frozen budget' }, overflow, { model: 'not verified' },
    { metadataTransport: async () => ({ version: '0.40.4' }) },
    { metadataTransport: async (route) => route === '/api/tags' ? { models: [] } : metadataTransport(route) },
    { decisionBudget: budget.measure(request.system, request.prompt, 640, 2),
      leaseClient: { acquire: async () => { leases++; return { profile: { num_ctx: 2048, num_thread: 4 },
        release: async () => { releases++; } }; } } }]) {
    await assert.rejects(() => ollama.generate({ ...generation, ...change })); checks++;
  }
  equal(inferenceCalls, beforeGuards, 'invalid format, runtime, model, budget and context never reach inference');
  equal(releases, leases, 'all preflight failures release authoritative lease');
  check(!ollama.isBusy(), 'preflight failures leave no busy state');

  let reported, generated = 0, workerPayload;
  const worker = createWorker({ runnerUrl: 'https://fixture.invalid', key: 'fixture',
    fetchImpl: async (_, options) => { reported = JSON.parse(options.body); return { ok: true, text: async () => '{}' }; },
    generate: async (payload) => { generated++; workerPayload = payload; return { text: 'fixture' }; },
    logger: { log() {}, error() {}, warn() {} } });
  const job = { id: 'fixture', kind: 'scheduled-decision', payload: { ...request,
    decisionBudget: generation.decisionBudget, hostedDecisionFormat: descriptor } };
  check(await worker.runJob(job), 'worker accepts valid budgeted format job');
  equal(workerPayload.hostedDecisionFormat, descriptor, 'worker forwards validated descriptor');
  for (const invalid of [{ ...job, kind: 'scheduled-generation' },
    { ...job, payload: { ...job.payload, hostedDecisionFormat: null } },
    { ...job, payload: { ...job.payload, hostedDecisionFormat: { ...descriptor, version: 2 } } },
    { ...job, payload: { ...job.payload, decisionBudget: undefined } }]) {
    check(!await worker.runJob(invalid), 'worker refuses malformed or inapplicable format before generation');
    equal(reported.retryable, false, 'descriptor failure is deterministic and nonretryable');
  }
  equal(generated, 1, 'rejected descriptors cannot consume inference');
  console.log('hosted decision format: ' + checks + ' checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
