'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-theme-writing-canary-'));
const previous = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
global.fetch = async () => { throw new Error('No live network in theme writing canary tests'); };
const { harness, makeProfile, completeJob, settle } = require('./durable-scheduler');
const store = require('../lib/store');
const interest = require('../lib/theme-interest');
const writing = require('../lib/public-writing');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };
function configuration(id) {
  const p = store.getProfile(id);
  return { persona: p.persona, provider: p.provider, model: p.model, temperature: p.temperature,
    numPredict: p.numPredict, postsPerHour: p.postsPerHour, commentsPerHour: p.commentsPerHour,
    votesPerHour: p.votesPerHour, enabled: p.enabled, dryRun: p.dryRun };
}
async function run() {
  store.updateSettings({ paused: false, dryRun: false });
  const source = makeProfile('theme-canary', false);
  Object.assign(source, { canReply: true, canVote: false, canStartDiscussions: false,
    postsPerHour: 0, commentsPerHour: 1, votesPerHour: 0, persona: 'A dry municipal observer.' });
  Object.assign(source.sched, { nextPostAt: null, nextCommentAt: 0, nextVoteAt: null });
  const id = store.createProfile(source).id;
  const posts = [20, 21, 22].map(postId => ({ id: postId, author: 'other', feddit: 'general',
    title: 'ZIRCONLANTERNS municipal parking for ZIRCONLANTERNS', selftext: 'Lunar parking permits demand municipal paperwork.',
    created_utc: 9, independently_assessed: false }));
  store.recordThemeInterest(id, [{ id: 'seed', at: 9000, kind: 'exposure', sourceKey: 't3_1',
    threadKey: 't3_1', community: 'general', author: 'other', features: interest.features(posts[0].selftext),
    identityVersion: 2, motifs: ['zirconlanterns'] }]);
  const scoped = Object.create(store);
  scoped.listProfiles = () => [store.getProfile(id)];
  const h = harness({ profiles: [store.getProfile(id)], store: scoped, placement: 'hosted',
    themeInterestEnabled: true, themeInterestCommunities: 'general', feedPosts: () => posts });
  try {
    store.updateSettings({ writingCanary: { version: 1, profileIds: [id] } });
    const membership = structuredClone(store.getSettings().writingCanary);
    const before = configuration(id);
    const runtime = h.scheduler();
    await runtime.runTick(); await settle(18);
    const turn = h.turnStore.activeForProfile(id);
    ok(turn && turn.generations.length === 1, 'combined feature reaches the existing durable decision request');
    eq(turn.input.publicWritingVersion, 3, 'selected ordinary turn freezes writing-v3');
    eq(turn.input.themeInterestVersion, 1, 'same turn independently freezes theme-v1');
    eq(store.getSettings().writingCanary, membership, 'theme admission never changes canary membership');
    eq(configuration(id), before, 'theme admission never changes persona, provider, model, settings or cadence');
    const snapshot = turn.checkpoints['opportunity-candidates'];
    const packed = turn.checkpoints['hosted-decision-construction'];
    const selected = snapshot.candidates.find(c => c.action === 'comment' && c.target.key.startsWith('t3_') &&
      packed.candidateIds.includes(c.id) && c.themeInterest);
    ok(selected, 'known root reaches a complete actual reply offer with optional theme evidence');
    store.updateSettings({ writingCanary: { version: 1, profileIds: [] } });
    completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({ choice: selected.id,
      reason: 'The lunar permit question suits a municipal reply.', votes: [] }));
    runtime.reconcileDurableTurns(); await settle(18);
    const admitted = h.turnStore.get(turn.id);
    eq(admitted.generations.length, 2, 'selection uses one existing writing request');
    const request = admitted.generations[1].request;
    ok(request.prompt.includes(writing.contentGuidance('comment', 3)), 'theme cue coexists with exact reviewed v3 writing guidance');
    ok(request.prompt.includes('OPTIONAL BOT-LOCAL FAMILIARITY'), 'bounded familiarity cue reaches selected writing');
    ok(request.prompt.indexOf('OPTIONAL BOT-LOCAL FAMILIARITY') < request.prompt.lastIndexOf(posts[0].selftext),
      'actual target remains after optional familiarity guidance');
    ok(request.prompt.endsWith('\n\nYour reply:'), 'target keeps final reply cue');
    eq(h.writes, [], 'decision and queued writing cannot publish before mocked completion');
    eq(configuration(id), before, 'combined prompt construction does not rewrite bot configuration');
    const signature = admitted.generations[1].signature;
    const frozenRequest = JSON.stringify(request);
    const restart = h.restartRuntime();
    restart.scheduler.reconcileDurableTurns(); await settle(18);
    const resumed = restart.turnStore.get(turn.id);
    eq(resumed.input.publicWritingVersion, 3, 'canary removal and restart preserve admitted writing-v3');
    eq(resumed.input.themeInterestVersion, 1, 'restart preserves independently frozen theme-v1');
    eq(resumed.generations[1].signature, signature, 'restart retains existing writing generation identity');
    eq(JSON.stringify(resumed.generations[1].request), frozenRequest, 'restart retains exact combined request bytes');
    eq(h.writes, [], 'restart cannot publish pending writing or generate a replacement');
    completeJob(restart.queue, resumed.generations[1].jobId,
      'The lunar parking office requires a permit for the permit office, naturally.');
    restart.scheduler.reconcileDurableTurns(); await settle(18);
    eq(restart.turnStore.get(turn.id).status, 'completed', 'frozen combined writing completes normally after canary removal');
    eq(h.writes.length, 1, 'only explicit mocked writing completion reaches the mocked publication path');
    eq(configuration(id), before, 'normal completion preserves configured cadence, model and persona');
    h.advance(3600000);
    store.updateSched(id, { nextCommentAt: 0 });
    await restart.scheduler.runTick(); await settle(18);
    const next = restart.turnStore.activeForProfile(id);
    ok(next && next.id !== turn.id, 'next ordinary opportunity admitted without forcing social output');
    eq(next.input.publicWritingVersion, 1, 'future ordinary work after removal returns to released writing');
    eq(next.input.themeInterestVersion, 1, 'canary removal does not alter separate theme rollout');
    eq(store.getSettings().writingCanary.profileIds, [], 'explicit removed membership persists');
    eq(h.writes.length, 1, 'next decision admission does not automatically publish');
    console.log('theme writing canary: ' + checks + ' checks passed');
  } finally { h.cleanup(); }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  if (previous === undefined) delete process.env.FEDDIT_BOT_DATA_DIR; else process.env.FEDDIT_BOT_DATA_DIR = previous;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
