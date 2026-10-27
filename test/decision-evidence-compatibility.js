'use strict';

// Offline scheduler/store integration; no server, model or live endpoint.
global.fetch = async () => { throw new Error('No network in evidence compatibility tests'); };
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-evidence-compatibility-'));
const previous = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
const { harness, makeProfile } = require('./durable-scheduler');
const store = require('../lib/store');
const interest = require('../lib/theme-interest');
const actionCandidates = require('../lib/action-candidates');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };

async function runCase(mode) {
  const p = makeProfile('evidence-compatibility-' + mode, false);
  Object.assign(p, { provider: 'ollama', model: 'fixture-model', canReply: true, canVote: true,
    canStartDiscussions: false, postsPerHour: 0, commentsPerHour: 1, votesPerHour: 0, feedSort: 'best' });
  Object.assign(p.sched, { nextPostAt: null, nextCommentAt: 0, nextVoteAt: null });
  const id = store.createProfile(p).id;
  const scoped = Object.create(store);
  scoped.listProfiles = () => [store.getProfile(id)];
  const content = 'The ZIRCONLANTERNS municipal office requires a permit before a folding greenhouse can move. ' +
    'The clerk says that its removable roof is a temporary object, while the trellis insists that it is a building. ' +
    'A neighbour offered a reversible strap but does not consent to glue or holes. ' +
    'The planning committee has asked for the original observation and the unresolved constraint to remain visible. ' +
    'Nobody has authorised a real application, and every participant may leave the conversation without agreement.';
  const posts = Array.from({ length: 6 }, (_, i) => ({ id: 20 + i, author: 'other', feddit: 'general',
    title: 'ZIRCONLANTERNS municipal permit ' + i, selftext: content, created_utc: 9 }));
  store.recordThemeInterest(id, [{ id: 'seed', at: 9000, kind: 'exposure', sourceKey: 't3_1', threadKey: 't3_1',
    community: 'general', author: 'other', features: interest.features(posts[0].title + ' ' + content),
    identityVersion: 2, motifs: ['zirconlanterns'] }]);
  store.updateSettings({ paused: false, dryRun: false, writingCanary: { version: 1, profileIds: [id] } });
  const calls = [];
  const frozen = [];
  const originalCompact = actionCandidates.compactPrompt;
  actionCandidates.compactPrompt = (...args) => {
    const compact = originalCompact(...args);
    frozen.push({ compact, candidates: structuredClone(args[0]), options: structuredClone(args[2]) });
    return compact;
  };
  const h = harness({ profiles: [store.getProfile(id)], store: scoped, placement: 'desktop', feedPosts: posts,
    themeInterestEnabled: true, themeInterestCommunities: 'general', providerGenerate: async request => {
      calls.push(structuredClone(request));
      const malformed = mode === 'invalid' || mode === 'repair' && calls.length === 1;
      return { text: malformed ? '{"choice":"E1","votes":[]}' : JSON.stringify({ choice: 'WAIT',
        reason: 'The complete offers do not need another reply.',
        votes: [...request.prompt.matchAll(/^\[(V\d+)\] /gm)].map(m => ({ id: m[1], direction: 'nil' })) }),
      ms: 1, model: p.model, usage: { inputTokens: 10, outputTokens: 10 } };
    } });
  try {
    if (mode === 'manual') await h.scheduler().simulateNow(id, 'comment');
    else await h.scheduler().runTick();
    eq(calls.length, mode === 'invalid' || mode === 'repair' ? 2 : 1, 'only initial request and existing one repair');
    eq(h.writes, [], 'WAIT or invalid decisions never publish');
    if (mode === 'manual') {
      eq(frozen, [], 'manual simulation never constructs compact evidence');
      eq(calls[0].decisionEvidenceVersion, undefined, 'manual request has no compaction metadata');
      ok(!calls[0].prompt.includes('SHARED EVIDENCE'), 'manual representation remains released text');
      return;
    }
    eq(frozen.length, 1, 'one frozen representation covers both attempts');
    const { compact, candidates, options } = frozen[0];
    eq(compact.version, 1, 'real ordinary local slate compacts');
    eq(calls[0].prompt, compact.prompt, 'initial request uses frozen layout');
    eq(calls[0].decisionEvidenceVersion, 1, 'request carries metadata-only evidence version');
    if (calls.length > 1) {
      eq(calls[1].prompt, compact.repair, 'repair uses exact same shared table and candidate body');
      eq(calls[1].decisionEvidenceVersion, 1, 'repair preserves evidence version');
    }
    const expanded = actionCandidates.expandEvidence(compact.body, compact.entries);
    eq(expanded, actionCandidates.prompt(candidates, h.now(), options), 'current theme menu expands byte-exactly');
    ok(expanded.includes('OPTIONAL BOT-LOCAL FAMILIARITY:'), 'current stable-motif theme hint survives compaction');
    eq(candidates.filter(c => c.candidateGroup === 'ordinary').length, 3, 'ordinary turnover cap preserved');
    ok(candidates.some(c => c.target.key === 't3_20'), 'first-look root remains an action offer');
    const receipt = store.getOrdinaryCandidateState(id);
    const considered = store.getVoteState(id).considered;
    const events = store.getThemeInterestState(id).events.filter(e => e.id !== 'seed');
    eq(store.hasReplied(id, 't3_20'), false, 'assessment cannot invent a published reply');
    eq(considered.includes('post:25'), false, 'gathered but deferred root remains unconsidered');
    ok(!(receipt.assessed || []).some(e => e.key === 't3_25'), 'deferred root has no assessment receipt');
    ok(!events.some(e => e.sourceKey === 't3_25'), 'deferred root has no theme receipt');
    if (mode === 'invalid') {
      eq(considered, [], 'invalid votes never become considered');
      eq(receipt.assessed, undefined, 'invalid primary and votes assess no first-look root');
      eq(events, [], 'invalid decisions create no theme exposure receipts');
    } else {
      ok((receipt.assessed || []).some(e => e.key === 't3_20'), 'valid offered first-look root is assessed');
      ok((receipt.assessed || []).some(e => e.key === 't3_21'), 'first-look-v2 secondary NIL is independently assessed');
      ok(considered.includes('post:21'), 'explicit secondary NIL becomes considered');
      ok(events.some(e => e.sourceKey === 't3_20'), 'valid actual offer retains theme exposure');
    }
    eq(h.turnStore.listActive(), [], 'ordinary local inference creates no durable jobs');
    eq(store.getSettings().writingCanary.profileIds, [id], 'writing-v3 canary membership is unchanged');
  } finally {
    actionCandidates.compactPrompt = originalCompact;
    h.cleanup();
  }
}

(async () => {
  try {
    for (const mode of ['valid', 'repair', 'invalid', 'manual']) await runCase(mode);
    console.log('decision-evidence-compatibility: ' + checks + ' checks passed');
  } finally {
    if (previous == null) delete process.env.FEDDIT_BOT_DATA_DIR;
    else process.env.FEDDIT_BOT_DATA_DIR = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
