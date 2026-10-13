'use strict';

const assert = require('node:assert/strict');
global.fetch = async () => { throw new Error('No live network in writing canary tests'); };
const { harness, makeProfile, completeJob, queueContentGeneration, settle } = require('./durable-scheduler');
const { createEvidenceStore } = require('../lib/naturalness-evidence');
const writing = require('../lib/public-writing');
const burst = require('../lib/burst');
const rollout = require('../lib/writing-rollout');
const post = { id: 42, feddit: 'general', author: 'alice', title: 'A garden question',
  selftext: 'Does the cucumber need a parking permit?', kind: 'text', created_utc: 9 };
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function reply(id, provider = 'dell') {
  const p = makeProfile(id, false);
  Object.assign(p, { provider, canReply: true, canStartDiscussions: false, canVote: false,
    postsPerHour: 0, commentsPerHour: 1 });
  Object.assign(p.sched, { nextPostAt: null, nextCommentAt: 0 });
  return p;
}
function enroll(h, ids) { h.store.getSettings().writingCanary = { version: 1, profileIds: ids }; }
async function selected(h, runtime, turn) {
  completeJob(h.queue, turn.generations[0].jobId, '{"choice":"C1","reason":"A fitting question.","votes":[]}');
  return queueContentGeneration({ scheduler: runtime, turnStore: h.turnStore }, turn.id);
}

async function durableSelection() {
  const p = reply('selected'), other = reply('control');
  const evidence = createEvidenceStore({ now: () => h.now() });
  const h = harness({ profiles: [p, other], feedPosts: [post], evidenceStore: evidence });
  try {
    enroll(h, [p.id]);
    const runtime = h.scheduler();
    await runtime.runTick(); await settle();
    const selectedTurn = h.turnStore.activeForProfile(p.id);
    const control = h.turnStore.activeForProfile(other.id);
    eq(selectedTurn.input.publicWritingVersion, 3, 'selected bot freezes v3 at admission');
    eq(control.input.publicWritingVersion, 1, 'unselected bot freezes released v1');
    const selectedSettings = { provider: p.provider, model: p.model, persona: p.persona,
      postsPerHour: p.postsPerHour, commentsPerHour: p.commentsPerHour, memoryState: structuredClone(p.memoryState) };
    enroll(h, []); // Remove while decision inference remains unresolved.
    const generation = await selected(h, runtime, selectedTurn);
    assert.ok(generation.request.prompt.includes(writing.contentGuidance('comment', 3)));
    eq(generation.request.numPredict, p.numPredict, 'output allowance unchanged');
    eq(generation.request.model, p.model, 'model unchanged');
    const controlGeneration = await selected(h, runtime, control);
    assert.doesNotMatch(controlGeneration.request.prompt, /PUBLIC WRITING:|REPLY TO THIS BRANCH:|OPTIONAL REMEMBERED BACKGROUND/);
    const signature = generation.signature;
    const restarted = h.restartRuntime();
    restarted.scheduler.reconcileDurableTurns(); await settle();
    eq(restarted.turnStore.get(selectedTurn.id).generations[1].signature, signature,
      'removal/restart does not reinterpret admitted request');
    completeJob(restarted.queue, generation.jobId, 'The cucumber needs a permit, but the greenhouse accepts pickles.');
    restarted.scheduler.reconcileDurableTurns(); await settle();
    eq(restarted.turnStore.get(selectedTurn.id).status, 'completed', 'frozen v3 completes after removal');
    const records = evidence.list().filter(event => event.stage === 'writing');
    eq(records.length, 1, 'confirmed writing recorded once');
    eq(records[0].writing.contractVersion, 3, 'evidence uses frozen contract, not removed membership');
    eq(records[0].writing.status, 'published', 'only confirmed public result is attributed');
    eq(records[0].writing.depth, 1, 'root reply depth recorded');
    eq(records[0].writing.commentId, 1001, 'evidence joins confirmed public comment');
    restarted.scheduler.reconcileDurableTurns(); await settle();
    eq(evidence.list().filter(event => event.stage === 'writing').length, 1, 'replay does not duplicate output evidence');
    completeJob(restarted.queue, controlGeneration.jobId, 'A released fixture reply.');
    restarted.scheduler.reconcileDurableTurns(); await settle();
    eq(p.provider, selectedSettings.provider, 'membership never switches provider');
    eq(p.model, selectedSettings.model, 'membership never switches model');
    eq(p.persona, selectedSettings.persona, 'membership never rewrites persona');
    eq(p.postsPerHour, selectedSettings.postsPerHour, 'stored post cadence unchanged');
    eq(p.commentsPerHour, selectedSettings.commentsPerHour, 'stored reply cadence unchanged');
    h.advance(3600000);
    h.feddit.feddit = async () => ({ ok: true, data: { data: { children: [{ data: { ...post, id: 43 } }] } } });
    await restarted.scheduler.runTick(); await settle();
    eq(restarted.turnStore.activeForProfile(p.id).input.publicWritingVersion, 1,
      'future turn after removal returns to released writing');
  } finally { h.cleanup(); }
}

async function localFreeze() {
  const p = reply('local-selected', 'ollama');
  let begin, release;
  const admitted = new Promise(resolve => { begin = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const evidence = createEvidenceStore({ now: () => h.now() });
  const h = harness({ profiles: [p], feedPosts: [post], evidenceStore: evidence,
    providerGenerate: async (request) => {
      requests.push(structuredClone(request));
      if (request.kind === 'scheduled-decision') {
        begin(); await gate;
        return { text: '{"choice":"C1","reason":"A fitting question.","votes":[]}', model: p.model,
          usage: { inputTokens: 10, outputTokens: 10 }, ms: 1 };
      }
      return { text: 'A compact complete reply.', model: p.model, usage: { inputTokens: 10, outputTokens: 5 }, ms: 1 };
    } });
  try {
    enroll(h, [p.id]);
    const runtime = h.scheduler();
    const tick = runtime.runTick();
    await admitted;
    enroll(h, []);
    release(); await tick;
    const content = requests.find(request => request.kind === 'scheduled-generation');
    assert.ok(content.prompt.includes(writing.contentGuidance('comment', 3)), 'local decision-to-writing scope remains frozen');
    eq(evidence.list().filter(x => x.stage === 'writing')[0].writing.contractVersion, 3,
      'non-durable local evidence retains admitted v3 after removal');
    h.advance(3600000);
    h.feddit.feddit = async () => ({ ok: true, data: { data: { children: [{ data: { ...post, id: 43 } }] } } });
    await runtime.runTick();
    const next = requests.filter(request => request.kind === 'scheduled-generation').at(-1);
    assert.doesNotMatch(next.prompt, /PUBLIC WRITING:/, 'future local work returns to released contract');
    eq(evidence.list().filter(x => x.stage === 'writing').map(x => x.writing.contractVersion), [3, 1]);
  } finally { release(); h.cleanup(); }
}

async function burstDefaults() {
  const p = reply('burst-selected');
  const requests = [];
  const h = harness({ profiles: [p], feedPosts: [post], providerGenerate: async request => {
    requests.push(structuredClone(request));
    return { text: '{"wait":true,"reason":"No contribution needed.","actions":[],"votes":[]}',
      model: 'sonnet', usage: { inputTokens: 10, outputTokens: 10 }, ms: 1 };
  } });
  try {
    enroll(h, [p.id]);
    const started = h.scheduler().startBurstSession(p.id, 'claude-plan'); await settle();
    eq(h.turnStore.get(started.turnId).input.publicWritingVersion, 1, 'selected bot Burst still freezes released writing');
    assert.doesNotMatch(requests[0].prompt, /PUBLIC WRITING:|OPTIONAL REMEMBERED BACKGROUND|IMMEDIATE PARENT/);
    eq(h.turnStore.get(started.turnId).result.waited, true, 'WAIT unchanged');
    eq(h.writes.length, 0, 'canary selection creates no Burst publication');
    eq(burst.prompt([], []), burst.prompt([], [], { publicWritingVersion: 1 }), 'unversioned Burst helper also defaults released');
  } finally { h.cleanup(); }
}

async function noFalsePublication() {
  for (const brokenObserver of [false, true]) {
    const p = reply('publication-fixture');
    const evidence = createEvidenceStore({ now: () => 10000 });
    const h = harness({ profiles: [p], feedPosts: [post],
      evidenceStore: brokenObserver ? { record() { throw new Error('Observer unavailable'); } } : evidence,
      ...(brokenObserver ? {} : { commentResponse: async () => ({ ok: false, status: 500, error: 'Fixture rejection' }) }) });
    try {
      enroll(h, [p.id]); const runtime = h.scheduler();
      await runtime.runTick(); await settle();
      const turn = h.turnStore.activeForProfile(p.id);
      const generation = await selected(h, runtime, turn);
      completeJob(h.queue, generation.jobId, 'A complete fixture reply.');
      runtime.reconcileDurableTurns(); await settle();
      eq(h.turnStore.get(turn.id).status, 'completed', 'observer never blocks bot finalisation');
      eq(h.writes.length, 1, 'publication is not repeated for observation');
      eq(evidence.list().filter(x => x.stage === 'writing').length, 0,
        brokenObserver ? 'unavailable observer remains optional' : 'rejected publication never appears as confirmed writing');
    } finally { h.cleanup(); }
  }
}

async function manualHosted() {
  const p = reply('manual-hosted');
  const requests = [];
  const h = harness({ profiles: [p], feedPosts: [post], providerGenerate: async request => {
    requests.push(structuredClone(request));
    return { text: request.kind === 'simulation-now-decision'
      ? '{"choice":"C1","reason":"A fitting question.","votes":[]}' : 'A complete rehearsal reply.',
      provider: 'dell', model: p.model, usage: { inputTokens: 10, outputTokens: 5 }, ms: 1 };
  } });
  try {
    enroll(h, [p.id]);
    const result = await h.scheduler().simulateNow(p.id, 'comment');
    eq(result.ok, true, 'manual hosted simulation uses its existing blocking path: ' + JSON.stringify(result));
    eq(requests.length, 2, 'decision and writing return without a bogus durable suspension');
    assert.doesNotMatch(requests[1].prompt, /PUBLIC WRITING:/, 'manual simulation remains released');
    eq(h.turnStore.activeForProfile(p.id), null, 'manual writing scope is not a durable turn');
    eq(h.writes.length, 0, 'manual rehearsal never publishes');
  } finally { h.cleanup(); }
}

async function burstEvidence() {
  const p = reply('burst-usage', 'ollama');
  const evidence = createEvidenceStore({ now: () => 10000 });
  const h = harness({ profiles: [p], feedPosts: [post], evidenceStore: evidence,
    providerGenerate: async () => ({ provider: 'claude-plan', model: 'sonnet',
      text: JSON.stringify({ actions: [{ candidate: 'C1', text: 'A short complete reply.', reason: 'It fits.' }], votes: [] }),
      usage: { inputTokens: 10, outputTokens: 300 }, ms: 1 }) });
  try {
    enroll(h, [p.id]);
    const started = h.scheduler().startBurstSession(p.id, 'claude-plan'); await settle(12);
    eq(h.turnStore.get(started.turnId).status, 'completed');
    const event = evidence.list().find(x => x.stage === 'writing');
    eq(event.writing.contractVersion, 1, 'Burst output is attributed to released contract');
    eq(event.writing.trigger, 'burst');
    eq(event.writing.outputLimitReached, null,
      'aggregate subscription plan tokens are not an individual Ollama output limit');
  } finally { h.cleanup(); }
}

(async () => {
  eq(rollout.select({}, 'unset', { kind: 'ordinary' }), 1, 'no configuration means released behavior');
  await durableSelection(); await localFreeze(); await burstDefaults(); await noFalsePublication();
  await manualHosted(); await burstEvidence();
  console.log('writing-canary-scheduler: ' + checks + ' checks passed (mock providers/publications only)');
})().catch(error => { console.error(error); process.exitCode = 1; });
