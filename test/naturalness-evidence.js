'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const evidence = require('../lib/naturalness-evidence');
const voting = require('../lib/voting');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-naturalness-evidence-'));
let time = Date.parse('2026-10-07T12:00:00Z');
const item = { targetType: 'post', targetId: 10, community: 'gardening', author: 'alice',
  source: 'ordinary_post', scoreAtExposure: 7, createdAt: time - 1000, scoreVisibleToModel: false,
  hasSocialContext: true, hasMemoryContext: false };
const event = { opportunityId: 'turn-1', profileId: 'profile-1', bot: 'fixture_bot',
  origin: 'system', cohort: 'cohort-1', mode: 'live', stage: 'offered', items: [item] };
let count = 0;
function test(name, run) { run(); count++; console.log('PASS ' + name); }
try {
  test('journal atomically persists and deduplicates replay across restart', () => {
    const file = path.join(temporary, 'journal.json');
    const store = evidence.createEvidenceStore({ file, now: () => time });
    assert.equal(store.record(event), true);
    assert.equal(store.record(event), false);
    const resumed = evidence.createEvidenceStore({ file, now: () => time });
    assert.equal(resumed.list().length, 1);
    assert.equal(resumed.record(event), false);
    assert.equal(resumed.record({ ...event, stage: 'decision', items: [{ ...item, direction: 'nil', decisionKind: 'explicit', status: 'no-vote' }] }), true);
    assert.equal(resumed.list().length, 2);
    assert.equal(fs.readdirSync(temporary).some((name) => name.endsWith('.tmp')), false);
  });
  test('retention bounds age, count and encoded bytes with declared coverage', () => {
    const file = path.join(temporary, 'bounded.json');
    const store = evidence.createEvidenceStore({ file, now: () => time, maxEvents: 2, maxBytes: 1800 });
    for (let n = 0; n < 10; n++) store.record({ ...event, opportunityId: 'bounded-' + n });
    assert.ok(store.list().length <= 2);
    assert.ok(fs.statSync(file).size <= 1800);
    assert.ok(store.coverage().prunedEvents >= 8);
    time += evidence.MAX_AGE_MS + 1;
    assert.equal(store.list({ since: 0 }).length, 0, 'custom window cannot bypass retention');
    store.record({ ...event, opportunityId: 'fresh' });
    assert.equal(store.list().length, 1);
  });
  test('corrupt saved evidence is preserved and observer fails open', () => {
    const file = path.join(temporary, 'corrupt.json');
    fs.writeFileSync(file, '{broken old evidence');
    const store = evidence.createEvidenceStore({ file, now: () => time });
    assert.equal(store.record(event), false);
    assert.equal(store.coverage().unavailable, true);
    assert.ok(store.coverage().warnings.length);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken old evidence');
  });
  test('restart removes expired valid evidence from disk without another bot turn', () => {
    const file = path.join(temporary, 'restart-retention.json');
    const store = evidence.createEvidenceStore({ file, now: () => time });
    store.record(event);
    time += evidence.MAX_AGE_MS + 1;
    const restarted = evidence.createEvidenceStore({ file, now: () => time });
    assert.equal(restarted.list().length, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).events.length, 0);
    assert.equal(restarted.coverage().retentionCleanupPending, false);
  });
  test('write failure never throws or records a false persisted success', () => {
    const parent = path.join(temporary, 'not-a-directory');
    fs.writeFileSync(parent, 'sentinel');
    const store = evidence.createEvidenceStore({ file: path.join(parent, 'file.json'), now: () => time });
    assert.equal(store.record(event), false);
    assert.equal(store.list().length, 0);
    assert.ok(store.coverage().warnings.length);
    assert.equal(fs.readFileSync(parent, 'utf8'), 'sentinel');
  });
  test('whitelist strips prompts, personas, memory, private output and secrets', () => {
    const store = evidence.createEvidenceStore({ now: () => time });
    store.record({ ...event, stage: 'decision', token: 'PRIVATE_TOKEN', prompt: 'PRIVATE_PROMPT',
      persona: 'PRIVATE_PERSONA', items: [{ ...item, content: 'PRIVATE_CONTENT', memory: 'PRIVATE_MEMORY',
        direction: 'up', decisionKind: 'explicit', status: 'decided', reason: 'Useful information with token=SECRET_VALUE' }] });
    const serialized = JSON.stringify(store.list());
    assert.doesNotMatch(serialized, /PRIVATE_|SECRET_VALUE/);
    assert.match(serialized, /redacted/);
    const copy = store.list(); copy[0].items[0].scoreAtExposure = 999;
    assert.equal(store.list()[0].items[0].scoreAtExposure, 7);
  });
  test('eight item bound, per-target dedup, unknown metadata and nil reason omission', () => {
    const result = evidence.sanitizeEvent({ ...event, stage: 'decision', items: [
      { ...item, scoreAtExposure: null, createdAt: null, direction: 'nil', reason: 'PRIVATE_REASON' },
      item, ...Array.from({ length: 20 }, (_, n) => ({ ...item, targetId: n + 20 })),
    ] }, time);
    assert.equal(result.items.length, 8);
    assert.equal(result.items[0].scoreAtExposure, null);
    assert.equal(result.items[0].createdAt, null);
    assert.equal(Object.hasOwn(result.items[0], 'reason'), false);
  });
  const slate = [{ id: 'V1', targetType: 'post', targetId: 10 }, { id: 'V2', targetType: 'comment', targetId: 20 }];
  const offered = slate.map((vote) => ({ ...item, ...vote, key: voting.targetKey(vote) }));
  test('explicit nil remains distinct from missing, malformed and generation failure', () => {
    const parsed = { votes: [{ id: 'V1', direction: 'nil' }] };
    const result = evidence.decisionItems(JSON.stringify(parsed), offered, slate, voting.parseDecisions(parsed, slate));
    assert.deepEqual(result.map((value) => value.decisionKind), ['explicit', 'missing']);
    assert.deepEqual(result.map((value) => value.direction), ['nil', 'nil']);
    assert.equal(evidence.decisionItems('not JSON', offered, slate, [])[0].decisionKind, 'invalid');
    const failure = evidence.decisionItems('', offered, slate, [], { failed: true });
    assert.equal(failure[0].decisionKind, 'unknown');
    assert.equal(failure[0].direction, null);
    assert.equal(failure[0].status, 'generation-failed');
  });
  test('invalid upvote does not become explicit nil and retained first duplicate wins', () => {
    const parsed = { votes: [{ id: 'V1', direction: 'up', reason: 'bad' },
      { id: 'V1', direction: 'nil' }, { id: 'V2', direction: 'down', reason: 'The claimed evidence does not support the conclusion.' }] };
    const actual = voting.parseDecisions(parsed, slate);
    const before = JSON.stringify(actual);
    const result = evidence.decisionItems(JSON.stringify(parsed), offered, slate, actual);
    assert.deepEqual(result.map((value) => value.decisionKind), ['invalid', 'explicit']);
    assert.deepEqual(result.map((value) => value.direction), ['nil', 'down']);
    assert.equal(JSON.stringify(actual), before, 'observer does not mutate parser outputs');
  });
  test('exact source metadata is captured while prompt inputs remain identical', () => {
    const raw = { targetType: 'post', targetId: 10, content: 'Visible post', author: 'alice' };
    const candidate = { id: 'C1', candidateType: 'ordinary_post', target: { postId: 10, feddit: 'gardening' },
      voteItems: [raw], social: { summary: 'Bounded social context' }, memory: { prompt: 'Bounded memory' } };
    const before = voting.collect([candidate]);
    raw.observerMetadata = evidence.itemMetadata({ id: 10, score: 7, created_utc: time / 1000 }, { id: 10, feddit: 'gardening' });
    const after = voting.collect([candidate]);
    assert.deepEqual(after, before);
    assert.equal(voting.promptSection(after), voting.promptSection(before));
    const snapshot = { observationCandidates: [candidate], voteCandidates: after };
    const observed = evidence.offeredItems(snapshot)[0];
    assert.equal(observed.scoreAtExposure, 7);
    assert.equal(observed.scoreVisibleToModel, false);
    assert.equal(observed.createdAt, time);
    assert.equal(observed.hasSocialContext, true);
    assert.equal(observed.hasMemoryContext, true);
    assert.equal(evidence.offeredItems(snapshot, true)[0].hasSocialContext, null);
  });
  test('Burst default nil without a returned direction is not explicit nil', () => {
    const parsed = { votes: [{ id: 'V1' }] };
    const result = evidence.decisionItems(JSON.stringify(parsed), offered, slate,
      [{ ...slate[0], direction: 'nil', status: 'no-vote' }], { burst: true });
    assert.equal(result[0].decisionKind, 'invalid');
    assert.equal(result[1].decisionKind, 'missing');
  });
  test('missing parent-post metadata never borrows comment creation time or score', () => {
    const snapshot = { voteCandidates: [{ ...slate[0], sourceCandidateId: 'C1' }], observationCandidates: [{
      id: 'C1', candidateType: 'renewed_thread', target: { postId: 10, commentId: 20, createdUtc: time / 1000, feddit: 'gardening' },
      voteItems: [{ ...slate[0] }],
    }] };
    const value = evidence.offeredItems(snapshot)[0];
    assert.equal(value.createdAt, null);
    assert.equal(value.scoreAtExposure, null);
  });
  console.log('naturalness-evidence: ' + count + ' checks passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
