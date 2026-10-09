'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const actions = require('../lib/action-candidates');
const ollama = require('../lib/providers/ollama');
const { createWorker } = require('../worker');
const { createDellProvider } = require('../lib/providers/dell');

let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function fixture(count = 6) {
  return { model: tokenizer.MODEL, system: 'You enjoy detailed conversations. Tone/style: precise.',
    decisionAt: 100000, decisionContractVersion: 2,
    candidates: Array.from({ length: count }, (_, i) => ({ id: 'C' + (i + 1), candidateType: 'ordinary_post',
      context: ('Real complete forum context ' + i + '. ').repeat(30),
      social: { summary: 'A familiar but not obligatory conversation.' },
      memory: { relevant: true, prompt: 'An intact memory, not an instruction.' } })),
    voteCandidates: Array.from({ length: count }, (_, i) => ({ id: 'V' + (i + 1), targetType: 'post',
      targetId: i + 1, author: 'fixture', label: 'Exact target ' + i,
      content: ('Vote target ' + i + ' actual content. ').repeat(20),
      socialContext: 'Independent social context.', memoryContext: 'Independent memory context.' })),
    voteAllowance: { remaining: 10 } };
}

async function run() {
  const input = fixture();
  const before = JSON.stringify(input);
  const packed = budget.construct(input);
  check(!packed.failure, 'a complete minimum slate fits');
  check(packed.deferredCandidateIds.length + packed.deferredVoteIds.length > 0, 'oversized menu reduces whole target blocks');
  check(budget.fits(packed.budget) && budget.fits(packed.repairBudget), 'initial and repair fit with output and safety reservations');
  equal(JSON.stringify(input), before, 'source persona, memory, social context and slates remain untouched');
  equal(packed.candidateIds, input.candidates.slice(0, packed.candidateIds.length).map((c) => c.id), 'stable action prefix');
  equal(packed.voteIds, input.voteCandidates.slice(0, packed.voteIds.length).map((c) => c.id), 'stable independent vote prefix');
  const options = { voteCandidates: input.voteCandidates.slice(0, packed.voteIds.length), voteAllowance: input.voteAllowance, decisionContractVersion: 2 };
  equal(packed.prompt, actions.prompt(input.candidates.slice(0, packed.candidateIds.length), input.decisionAt, options), 'no wording or context slices changed');
  equal(packed.repair, actions.repairPrompt(input.candidates.slice(0, packed.candidateIds.length), input.decisionAt, options), 'repair retains the identical offered slate');
  const small = fixture(1);
  equal(budget.construct(small).deferredCandidateIds, [], 'already-fitting prompts unchanged');
  const voteOnly = budget.construct({ ...small, candidates: [] });
  check(!voteOnly.failure && voteOnly.prompt.includes('voting-only'), 'voting-only mode preserved');
  const primaryOnly = budget.construct({ ...small, voteCandidates: [] });
  equal(primaryOnly.numPredict, 120, 'nonvoting output budget unchanged');
  const impossible = budget.construct({ ...input, system: 'Mandatory persona detail. '.repeat(3000) });
  check(impossible.failure && !impossible.prompt, 'oversized mandatory persona fails rather than being cut');
  const request = { model: tokenizer.MODEL, system: input.system, prompt: packed.prompt, numPredict: packed.numPredict, budget: packed.budget };
  equal(budget.verifyRequest(request, { num_ctx: 3072 }), packed.budget, 'worker independently recomputes correct budget');
  for (const [change, profile] of [[{}, {}], [{}, { num_ctx: 2048 }], [{ prompt: 'tampered' }, { num_ctx: 3072 }],
    [{ model: 'unknown' }, { num_ctx: 3072 }], [{ budget: null, prompt: 'Long unbudgeted legacy content. '.repeat(4000) }, { num_ctx: 3072 }]]) {
    assert.throws(() => budget.verifyRequest({ ...request, ...change }, profile), /Hosted|hosted/); checks++;
  }
  let queued;
  createDellProvider({ enqueue: (job) => { queued = job; return { id: 'test' }; }, get: () => null }).enqueue({ ...request, decisionBudget: packed.budget });
  equal(queued.payload.decisionBudget, packed.budget, 'budget survives queue serialization');

  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../lib/hosted-tokenizer-data.json.gz'))));
  const show = { template: data.template, parameters: 'stop                           "<|im_start|>"\nstop                           "<|im_end|>"', model_info: data.tokenizer };
  const tags = { models: [{ name: tokenizer.MODEL, digest: tokenizer.MANIFEST_SHA256 }] };
  let leases = 0, releases = 0, inferenceCalls = 0, metadataCalls = 0;
  const transport = async (route) => { metadataCalls++; return route === '/api/version' ? { version: '0.34.1' } : route === '/api/tags' ? tags : show; };
  const leaseClient = { acquire: async () => { leases++; return { profile: { num_ctx: 3072, num_thread: 4 }, release: async () => { releases++; } }; } };
  const chatTransport = async (body) => { inferenceCalls++; equal(body.options.num_ctx, 3072, 'context is not increased'); return { message: { content: '{"choice":"WAIT"}' } }; };
  const generation = { ...request, decisionBudget: packed.budget, hostedDecision: true, leaseClient, chatTransport, metadataTransport: transport };
  await ollama.generate(generation);
  equal(inferenceCalls, 1, 'verified fitting request reaches inference once');
  equal(metadataCalls, 3, 'runtime and model metadata are verified before sending inference');
  await assert.rejects(() => ollama.generate({ ...generation, prompt: 'changed' }), /budget/); checks++;
  equal(inferenceCalls, 1, 'mismatched request never reaches inference');
  await assert.rejects(() => ollama.generate({ ...generation, metadataTransport: async () => ({}) }), /verified/); checks++;
  equal(inferenceCalls, 1, 'unknown rendering version cannot start inference');
  await assert.rejects(() => ollama.generate({ ...generation,
    metadataTransport: async (route) => route === '/api/tags' ? { models: [] } : transport(route) }), /tokenizer/); checks++;
  equal(inferenceCalls, 1, 'model identity mismatch cannot start inference');
  equal(releases, leases, 'all budget/metadata failures release authoritative lease');
  check(!ollama.isBusy(), 'failed preflight clears working state');
  let reported;
  const worker = createWorker({ runnerUrl: 'https://fixture.invalid', key: 'test',
    fetchImpl: async (_, options) => { reported = JSON.parse(options.body); return { ok: true, text: async () => '{}' }; },
    generate: async (payload) => { check(payload.hostedDecision, 'legacy durable decision also gets worker guard'); throw budget.failure('Fixture budget rejection'); },
    logger: { log() {}, error() {}, warn() {} } });
  await worker.runJob({ id: 'test', kind: 'scheduled-decision', payload: { model: tokenizer.MODEL, prompt: 'legacy' } });
  equal(reported.retryable, false, 'deterministic budget rejection is not retried');
  console.log('hosted decision budget: ' + checks + ' checks passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
