'use strict';
// Actual scheduler and profile persistence; all providers and Feddit calls are
// deterministic fixtures. Never creates a real identity or publishes anything.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-naturalness-scheduler-'));
process.env.FEDDIT_BOT_DATA_DIR = temporary;
global.fetch = async () => { throw new Error('Unexpected live fetch in fixture test'); };
const store = require('../lib/store');
const scheduler = require('../lib/scheduler');
const { createEvidenceStore } = require('../lib/naturalness-evidence');
const now = Date.parse('2026-10-07T12:00:00Z');
const normal = JSON.stringify({ choice: 'WAIT', votes: [
  { id: 'V1', direction: 'up', reason: 'This contribution provides concrete and useful information.' },
  { id: 'V2', direction: 'nil' },
] });

async function exercise(options = {}) {
  const simulation = options.simulation !== false;
  const profile = store.createProfile({ fedditUsername: 'fixture_bot', token: 'fixture_fake_token',
    provider: 'ollama', model: 'fixture-model', enabled: true, dryRun: simulation,
    persona: 'PRIVATE_PERSONA_SENTINEL', readFeddits: ['gardening'], postFeddits: ['gardening'],
    canReply: false, canStartDiscussions: false, canShareLinks: false, canVote: true,
    postsPerHour: 0, articlePostsPerHour: 0, commentsPerHour: 0, votesPerHour: 1,
    botOrigin: 'system', populationProvenance: { cohortId: 'fixture-cohort' },
  });
  store.updateSched(profile.id, { nextVoteAt: now - 1 }, { simulation });
  const prompts = [];
  const votes = [];
  const calls = { feed: 0, comments: 0, allowance: 0, generated: 0 };
  const evidence = options.evidence === false ? null : options.evidence || createEvidenceStore({ now: () => now });
  const feddit = {
    feddits: async () => ({ ok: true, data: { feddits: [] } }),
    botInfo: async () => ({ ok: true, data: { probation: { on_probation: false } } }),
    feddit: async () => {
      calls.feed++;
      return { ok: true, data: { data: { children: [{ data: {
        id: 10, feddit: 'gardening', title: 'A visible post', selftext: 'Concrete details.',
        author: 'alice', score: 7, created_utc: now / 1000 - 60,
      } }] } } };
    },
    comments: async () => {
      calls.comments++;
      return { ok: true, data: { comments: { data: { children: [{ data: {
        id: 20, post_id: 10, author: 'bob', body: 'A visible comment.', score: -2,
        created_utc: now / 1000 - 30,
      } }] } } } };
    },
    voteAllowance: async () => {
      calls.allowance++;
      return { ok: true, data: { vote_allowance: { limited: true, remaining: 8 } } };
    },
    vote: async (request) => {
      votes.push({ targetType: request.targetType, targetId: request.targetId, direction: request.direction, reason: request.reason });
      if (options.voteThrows) throw new Error('PRIVATE_TRANSPORT_ERROR');
      return options.voteResponse || { ok: true, status: 200 };
    },
    submit: async () => { throw new Error('Unexpected post publication'); },
    comment: async () => { throw new Error('Unexpected comment publication'); },
  };
  const providers = {
    ollamaBusy: () => false,
    generate: async (request) => {
      prompts.push({ prompt: request.prompt, system: request.system, priority: request.priority,
        model: request.model, provider: request.provider, numPredict: request.numPredict });
      calls.generated++;
      if (options.failGeneration) throw new Error('PRIVATE_PROVIDER_ERROR_SENTINEL');
      const text = options.repair && calls.generated === 1 ? 'unreadable answer' : (options.text ?? normal);
      return { text, provider: 'ollama', model: 'fixture-model', ms: 1,
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 } };
    },
  };
  const instance = scheduler.createScheduler({ store, providers, feddit, evidenceStore: evidence,
    now: () => now, random: () => 0 });
  const result = await instance.runTick();
  const saved = store.getProfile(profile.id);
  store.updateProfile(profile.id, { enabled: false });
  assert.equal(saved.votesPerHour, 1);
  assert.equal(saved.postsPerHour, 0);
  assert.equal(saved.commentsPerHour, 0);
  return { result, prompts, votes, calls, evidence, saved };
}

(async () => {
  const baseline = await exercise({ evidence: false });
  const observed = await exercise();
  assert.equal(observed.calls.generated, 1);
  assert.deepEqual(observed.prompts, baseline.prompts, 'observer must not change any provider request field');
  assert.deepEqual(observed.calls, baseline.calls, 'observer adds no provider or Feddit read calls');
  assert.deepEqual(observed.votes, baseline.votes);
  const events = observed.evidence.list();
  assert.deepEqual(events.map((event) => event.stage), ['offered', 'decision', 'outcome']);
  assert.equal(events[0].mode, 'rehearsal');
  assert.equal(events[0].origin, 'system');
  assert.equal(events[0].cohort, 'fixture-cohort');
  assert.equal(events[0].items.length, 2);
  assert.equal(events[0].items[0].scoreAtExposure, 7);
  assert.equal(events[0].items[1].scoreAtExposure, -2);
  assert.equal(events[0].items[0].createdAt, new Date(now - 60000).toISOString());
  assert.equal(events[2].items[0].status, 'simulated');
  assert.equal(events[2].items[1].decisionKind, 'explicit');
  assert.equal(observed.votes.length, 0, 'rehearsal never reaches publication stub');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|Concrete details|visible comment/);

  const live = await exercise({ simulation: false });
  assert.equal(live.votes.length, 1);
  assert.equal(live.evidence.list().at(-1).items[0].status, 'cast');
  const rejected = await exercise({ simulation: false, voteResponse: { ok: false, status: 429 } });
  assert.equal(rejected.evidence.list().at(-1).items[0].status, 'capacity-exhausted');
  const uncertain = await exercise({ simulation: false, voteThrows: true });
  assert.equal(uncertain.evidence.list().at(-1).items[0].status, 'uncertain');
  assert.equal(uncertain.votes.length, 1, 'uncertain publication is never retried by observer');

  const missing = await exercise({ text: JSON.stringify({ choice: 'WAIT', votes: [{ id: 'V1', direction: 'up', reason: 'bad' }] }) });
  assert.deepEqual(missing.evidence.list().find((event) => event.stage === 'decision').items.map((item) => item.decisionKind), ['invalid', 'missing']);
  const repaired = await exercise({ repair: true });
  assert.equal(repaired.calls.generated, 2, 'existing single repair remains unchanged');
  assert.equal(repaired.evidence.list().filter((event) => event.stage === 'offered').length, 1);
  assert.equal(repaired.evidence.list().filter((event) => event.stage === 'decision').length, 1);
  assert.equal(repaired.evidence.list().find((event) => event.stage === 'decision').attempt, 1);

  const failed = await exercise({ failGeneration: true });
  assert.equal(failed.calls.generated, 1);
  assert.equal(failed.evidence.list().find((event) => event.stage === 'decision').items[0].decisionKind, 'unknown');
  assert.equal(failed.evidence.list().find((event) => event.stage === 'decision').items[0].status, 'generation-failed');
  assert.doesNotMatch(JSON.stringify(failed.evidence.list()), /PRIVATE_PROVIDER_ERROR/);
  const brokenObserver = await exercise({ evidence: { record: () => { throw new Error('observer unavailable'); } } });
  assert.deepEqual(brokenObserver.prompts, baseline.prompts);
  assert.equal(brokenObserver.calls.generated, 1, 'observer errors never cause retries');
  console.log('naturalness-scheduler: observed/unobserved request parity, metadata, rehearsal/live, failure, repair and fail-open checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});
