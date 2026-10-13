'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeWriting, sanitizeEvent, createEvidenceStore, WRITING_LIMITS } = require('../lib/naturalness-evidence');
const { buildSnapshot } = require('../lib/naturalness-metrics');
const { createObserver } = require('../lib/naturalness-observer');
const { create } = require('../public/ui-naturalness');

const now = Date.parse('2026-10-13T12:00:00Z');
const sentence = 'The moon has borrowed every last bicycle in town.';
const target = { postId: 10, commentId: 20, feddit: 'fixtures', replyBranch: { version: 1,
  post: { id: 10, title: 'Original fixture', body: 'A separate beginning.' },
  target: { id: 20, body: sentence, parentId: 19 },
  ancestors: [{ id: 19, body: 'Older context preserves the branch history.' }], complete: true } };
const input = { kind: 'comment', text: sentence, target, version: 3, trigger: 'scheduled', postId: 10, commentId: 21 };
const event = (options = {}) => ({ opportunityId: 'turn-1', profileId: 'a', bot: 'fixture_bot', origin: 'system',
  cohort: 'fixture', mode: 'live', stage: 'writing', at: new Date(now - 1000).toISOString(), community: 'fixtures', items: [],
  writing: { ...analyzeWriting(input), status: 'published' }, ...options });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-naturalness-writing-'));
let checks = 0;
async function test(name, run) { await run(); checks++; console.log('PASS ' + name); }

class Element {
  constructor(tag, document) { this.tag = tag; this.document = document; this.children = []; this.listeners = {}; this.hidden = false; this.open = false; this.textContent = ''; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
}
function documentStub() {
  const document = { listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } };
  document.createElement = tag => new Element(tag, document);
  document.head = document.createElement('head'); document.body = document.createElement('body');
  return document;
}
const flatten = element => [element, ...element.children.flatMap(flatten)];

async function main() {
  await test('writing analysis is pure and keeps only bounded diagnostic metadata', () => {
    const before = JSON.stringify(input), writing = analyzeWriting(input);
    assert.equal(JSON.stringify(input), before);
    assert.equal(writing.words, 9); assert.equal(writing.chars, sentence.length);
    assert.equal(writing.titleWords, 0); assert.equal(writing.endsWithTerminalPunctuation, true);
    assert.equal(writing.sourceOverlap.parent, 9);
    assert.equal(writing.sourceOverlap.memory, 0);
    assert.equal(writing.hasWritingMemory, false);
    assert.equal(writing.outputLimitReached, null);
    assert.equal(writing.status, undefined, 'confirmation belongs to publication caller');
    assert.equal(writing.depth, 3); assert.equal(writing.depthLowerBound, 3);
    assert.deepEqual(writing.ancestorIds, [19]);
    assert.equal(JSON.stringify(writing).includes(sentence), false);
    assert.equal(analyzeWriting({ ...input, version: 99 }), null);
  });
  await test('exact depth requires a complete known branch and uncertain branches retain lower bounds', () => {
    const incomplete = analyzeWriting({ ...input, target: { ...target, replyBranch: { ...target.replyBranch, complete: false } } });
    assert.equal(incomplete.depth, null); assert.equal(incomplete.depthLowerBound, 3); assert.equal(incomplete.branchComplete, false);
    const legacy = analyzeWriting({ ...input, target: { postId: 10, commentId: 20, context: 'PRIVATE_LEGACY_CONTEXT' } });
    assert.equal(legacy.depth, null); assert.equal(legacy.depthLowerBound, 2);
    assert.equal(legacy.sourceOverlap.parent, 0, 'unstructured context is not asserted to be the parent');
    const root = analyzeWriting({ ...input, target: { postId: 10, commentId: null } });
    assert.equal(root.depth, 1); assert.equal(root.branchComplete, true);
    const absent = analyzeWriting({ ...input, target: {} });
    assert.equal(absent.depth, null); assert.equal(absent.depthLowerBound, 1);
    const mismatch = analyzeWriting({ ...input, target: { ...target, replyBranch: { ...target.replyBranch, post: { id: 99 } } } });
    assert.equal(mismatch.depth, null); assert.equal(mismatch.sourceOverlap.parent, 0);
    const truncated = analyzeWriting({ ...input, target: { ...target, replyBranch: { ...target.replyBranch,
      ancestors: [1, 2, 3, 4].map(id => ({ id, body: 'An ancestor.' })) } } });
    assert.equal(truncated.ancestorIds.length, 3); assert.equal(truncated.depth, null); assert.equal(truncated.depthLowerBound, 5);
    const post = analyzeWriting({ ...input, kind: 'post', title: 'Three title words' });
    assert.equal(post.titleWords, 3); assert.equal(post.depth, null); assert.equal(post.depthLowerBound, null);
    assert.equal(post.parentCommentId, null); assert.equal(post.commentId, null);
  });
  await test('writing screens bound text and token work without declaring semantic copying', () => {
    const writing = analyzeWriting({ ...input, text: 'word '.repeat(5000), target: { ...target,
      replyBranch: { ...target.replyBranch, target: { ...target.replyBranch.target, body: 'word '.repeat(5000) } } },
    usage: { outputTokens: 100 }, outputLimit: 100 });
    assert(writing.chars <= WRITING_LIMITS.chars);
    assert.equal(writing.sourceOverlap.parent, 512);
    assert.equal(writing.endsWithTerminalPunctuation, false);
    assert.equal(writing.outputLimitReached, true);
    assert.equal(analyzeWriting({ ...input, usage: { outputTokens: 20 }, outputLimit: 100 }).outputLimitReached, false);
    for (const usage of [null, {}, { outputTokens: 0 }, { outputTokens: '100' }, { outputTokens: Infinity }]) {
      assert.equal(analyzeWriting({ ...input, usage, outputLimit: 100 }).outputLimitReached, null);
    }
    assert.equal(analyzeWriting({ ...input, usage: { outputTokens: 100 }, outputLimit: null }).outputLimitReached, null);
    assert.equal(analyzeWriting({ ...input, text: 'A complete thought.)' }).endsWithTerminalPunctuation, true);
    assert.equal(analyzeWriting({ ...input, text: '' }).endsWithTerminalPunctuation, false);
  });
  await test('memory attribution uses only the selected contract writing context', () => {
    const memory = { relevant: true, prompt: sentence };
    const legacy = analyzeWriting({ ...input, version: 2, memory });
    assert.equal(legacy.hasWritingMemory, true); assert.equal(legacy.sourceOverlap.memory, 9);
    assert.equal(analyzeWriting({ ...input, version: 2, memory: { ...memory, relevant: false } }).hasWritingMemory, false);
    const modern = analyzeWriting({ ...input, memory });
    assert.equal(modern.hasWritingMemory, false); assert.equal(modern.sourceOverlap.memory, 0);
    const cue = analyzeWriting({ ...input, memory: { ...memory, writingContext: { version: 1,
      claims: [{ status: 'established', polarity: 'positive', slot: 'transport', value: 'bicycle' }] } } });
    assert.equal(cue.hasWritingMemory, true);
    assert.equal(JSON.stringify(cue).includes('transport'), false);
  });
  await test('legacy Burst memory screens only its actual trimmed 800-character prompt projection', () => {
    const memory = { relevant: true, prompt: 'prefix '.repeat(140) + sentence };
    for (const version of [1, 2]) {
      const scheduled = analyzeWriting({ ...input, version, memory });
      const burst = analyzeWriting({ ...input, version, trigger: 'burst', memory });
      assert.equal(scheduled.sourceOverlap.memory, 9);
      assert.equal(burst.sourceOverlap.memory, 0, 'memory after character 800 was not supplied to Burst');
      assert.equal(burst.hasWritingMemory, true);
      const ignoredRelevance = { relevant: false, prompt: ' '.repeat(900) + sentence + '\n' };
      const included = analyzeWriting({ ...input, version, trigger: 'burst', memory: ignoredRelevance });
      assert.equal(included.hasWritingMemory, true, 'legacy Burst does not gate prompt memory on relevant');
      assert.equal(included.sourceOverlap.memory, 9, 'Burst trims before limiting memory characters');
      assert.equal(analyzeWriting({ ...input, version, memory: ignoredRelevance }).hasWritingMemory, false);
      const omittedScheduled = analyzeWriting({ ...input, version, memory: { relevant: true, prompt: ' '.repeat(1600) + sentence } });
      assert.equal(omittedScheduled.sourceOverlap.memory, 0, 'ordinary memory truncates before whitespace normalization');
    }
    const modern = analyzeWriting({ ...input, trigger: 'burst', memory });
    assert.equal(modern.hasWritingMemory, false, 'v3 does not fall back to the legacy prompt');
  });
  await test('writing journal whitelist rejects malformed enums and strips source text and injected vote items', () => {
    const raw = event({ prompt: 'PRIVATE_PROMPT', raw: 'PRIVATE_RAW', community: '../bad?token=PRIVATE_TOKEN',
      items: [{ targetType: 'post', targetId: 10, reason: 'PRIVATE_VOTE' }] });
    raw.writing = { ...raw.writing, text: 'PRIVATE_TEXT', title: 'PRIVATE_TITLE', memory: 'PRIVATE_MEMORY',
      parentCommentId: true, commentId: '21x', ancestorIds: [1, 1, '2', 3, 4], chars: 999999,
      sourceOverlap: { parent: 999999, ancestors: -1, memory: '9', secret: 'PRIVATE_SECRET' } };
    const sanitized = sanitizeEvent(raw, now);
    assert(sanitized); assert.deepEqual(sanitized.items, []); assert.equal(sanitized.community, null);
    assert.equal(sanitized.writing.commentId, null); assert.equal(sanitized.writing.parentCommentId, null);
    assert.deepEqual(sanitized.writing.ancestorIds, [1, 2]);
    assert.equal(sanitized.writing.chars, 10000);
    assert.deepEqual(sanitized.writing.sourceOverlap, { parent: 512, ancestors: 0, memory: 0 });
    assert.doesNotMatch(JSON.stringify(sanitized), /PRIVATE_/);
    for (const [key, value] of [['contractVersion', 99], ['kind', 'message'], ['trigger', 'auto'], ['status', 'failed'],
      ['words', -1], ['endsWithTerminalPunctuation', 'true'], ['hasWritingMemory', null]]) {
      assert.equal(sanitizeEvent(event({ writing: { ...event().writing, [key]: value } }), now), null, key);
    }
    assert.equal(sanitizeEvent(event({ mode: 'rehearsal' }), now), null, 'live confirmation cannot become rehearsal');
  });
  await test('writing journal survives restart and keeps first evidence through durable replay', () => {
    const file = path.join(temporary, 'writing.json');
    const store = createEvidenceStore({ file, now: () => now });
    assert.equal(store.record(event()), true);
    const restart = createEvidenceStore({ file, now: () => now });
    assert.equal(restart.record(event({ attempt: 1, writing: { ...event().writing, words: 999 } })), false);
    assert.equal(restart.list()[0].writing.words, 9);
    assert.equal(restart.list()[0].attempt, 0);
    assert.equal(restart.record(event({ profileId: 'b' })), true, 'separate profile attribution');
    const copy = restart.list(); copy[0].writing.words = 999;
    assert.equal(restart.list()[0].writing.words, 9);
    assert.equal(fs.readdirSync(temporary).some(name => name.endsWith('.tmp')), false);
  });
  await test('writing summaries separate contract, profile, mode, kind and known or lower-bound depth', () => {
    const records = [event(), event({ opportunityId: 'turn-2', writing: { ...event().writing, words: 20, chars: 100 } }),
      event({ opportunityId: 'turn-3', writing: { ...event().writing, contractVersion: 2 } }),
      event({ opportunityId: 'turn-4', writing: { ...event().writing, depth: null, branchComplete: false } }),
      event({ opportunityId: 'turn-5', mode: 'rehearsal', writing: { ...event().writing, status: 'simulated' } }),
      event({ profileId: 'b' }), event({ opportunityId: 'turn-post', writing: { ...analyzeWriting({ ...input, kind: 'post' }), status: 'published' } })];
    const snapshot = buildSnapshot({ now, events: records.concat(records[0]) });
    assert.equal(snapshot.writing.coverage.records, 7);
    assert.equal(snapshot.writing.coverage.profiles, 2);
    assert.equal(snapshot.writing.coverage.published, 6);
    assert.equal(snapshot.writing.coverage.simulated, 1);
    assert.equal(snapshot.writing.groups.length, 6);
    const group = snapshot.writing.groups.find(row => row.profileId === 'a' && row.mode === 'live' && row.contractVersion === 3 && row.replyDepth === '3');
    assert.equal(group.records, 2); assert.equal(group.medianWords, 14.5);
    assert.equal(group.flags.parentOverlap, 2); assert.equal(group.flags.outputLimitUnknown, 2);
    assert.equal(snapshot.writing.recent.find(row => row.status === 'simulated').path, null);
    assert(snapshot.writing.recent.some(row => row.path === '/f/fixtures/comments/10#comment-21'));
    assert(snapshot.writing.groups.some(row => row.replyDepth === '3+'));
    assert.equal(snapshot.coverage.localAvailable, false); assert.equal(snapshot.coverage.localEvents, 0);
    assert.equal(snapshot.overview.local.offered, 0);
    assert.doesNotMatch(JSON.stringify(snapshot.writing), /Original fixture|borrowed every|Older context/);
  });
  await test('scheduled, manual and Burst writing retain separate rows, medians and flags', () => {
    const recorded = (trigger, words, extra = {}) => event({ opportunityId: trigger + '-' + words,
      writing: { ...event().writing, contractVersion: 1, trigger, words, ...extra } });
    const records = [recorded('scheduled', 8), recorded('scheduled', 12), recorded('manual', 50),
      recorded('burst', 100, { endsWithTerminalPunctuation: false, outputLimitReached: true,
        sourceOverlap: { parent: 0, ancestors: 0, memory: 8 } }),
      recorded('burst', 160, { endsWithTerminalPunctuation: false, outputLimitReached: false,
        sourceOverlap: { parent: 0, ancestors: 0, memory: 9 } })];
    const snapshot = buildSnapshot({ now, events: records });
    assert.equal(snapshot.writing.groups.length, 3);
    const groups = Object.fromEntries(snapshot.writing.groups.map(row => [row.trigger, row]));
    assert.deepEqual(Object.keys(groups).sort(), ['burst', 'manual', 'scheduled']);
    assert.equal(groups.scheduled.records, 2); assert.equal(groups.scheduled.medianWords, 10);
    assert.equal(groups.manual.records, 1); assert.equal(groups.manual.medianWords, 50);
    assert.equal(groups.burst.records, 2); assert.equal(groups.burst.medianWords, 130);
    assert.equal(groups.scheduled.flags.missingTerminalPunctuation, 0);
    assert.equal(groups.scheduled.flags.parentOverlap, 2); assert.equal(groups.scheduled.flags.memoryOverlap, 0);
    assert.equal(groups.scheduled.flags.outputLimitReached, 0); assert.equal(groups.scheduled.flags.outputLimitUnknown, 2);
    assert.equal(groups.burst.flags.missingTerminalPunctuation, 2);
    assert.equal(groups.burst.flags.parentOverlap, 0); assert.equal(groups.burst.flags.memoryOverlap, 2);
    assert.equal(groups.burst.flags.outputLimitReached, 1); assert.equal(groups.burst.flags.outputLimitUnknown, 0);
  });
  await test('writing example links and summaries remain bounded and cannot inject arbitrary URLs', () => {
    const records = Array.from({ length: 250 }, (_, n) => event({ profileId: 'profile-' + n, opportunityId: 'bounded-' + n,
      community: n % 2 ? 'fixtures' : 'https://evil.example/?token=secret',
      at: new Date(now - 1000 - (250 - n)).toISOString() }));
    records.push(event({ at: new Date(now - 25 * 3600000).toISOString(), opportunityId: 'expired' }));
    const snapshot = buildSnapshot({ now, events: records });
    assert.equal(snapshot.writing.coverage.records, 250);
    assert.equal(snapshot.writing.groups.length, 200); assert.equal(snapshot.writing.coverage.groupsTruncated, true);
    assert.equal(snapshot.writing.recent.length, 30); assert.equal(snapshot.writing.coverage.recentTruncated, true);
    assert(snapshot.writing.recent.every(row => !row.path || row.path === '/f/fixtures/comments/10#comment-21'));
    assert.doesNotMatch(JSON.stringify(snapshot.writing), /evil\.example/);
  });
  await test('owner observer scopes writing and writing instrumentation never suppresses legacy votes', async () => {
    const store = createEvidenceStore({ now: () => now });
    store.record(event({ at: new Date(now - 3000).toISOString() }));
    store.record(event({ profileId: 'other-owner' }));
    let calls = 0;
    const observer = createObserver({ dataDir: temporary, evidenceStore: store, now: () => now, buildSnapshot,
      request: async () => { calls++; return { ok: true, data: { schemaVersion: 1, source: 'feddit-current-votes', items: [] } }; } });
    const snapshot = await observer.snapshot({ hours: 24, profiles: [{ id: 'a', activity: [{ kind: 'vote',
      at: new Date(now - 2000).toISOString(), votes: [{ targetType: 'post', targetId: 10, direction: 'up', status: 'cast' }] }] }] });
    assert.equal(calls, 1);
    assert.equal(snapshot.writing.coverage.records, 1);
    assert.equal(snapshot.writing.groups[0].profileId, 'a');
    assert.equal(snapshot.overview.outcomeOnly.live.confirmedCast, 1);
    const separate = await observer.snapshot({ hours: 24, profiles: [{ id: 'other-owner' }] });
    assert.equal(separate.writing.groups[0].profileId, 'other-owner');
    assert.equal(separate.overview.outcomeOnly.live.confirmedCast, 0);
    const empty = await observer.snapshot({ hours: 24, profiles: [] });
    assert.equal(empty.writing.coverage.records, 0);
  });
  await test('writing UI displays read-only groups and safe public links with no write request', async () => {
    const document = documentStub(), calls = [];
    const snapshot = buildSnapshot({ now, events: [event(), ...['manual', 'burst'].map(trigger =>
      event({ opportunityId: 'ui-' + trigger, writing: { ...event().writing, contractVersion: 1, trigger } }))] });
    snapshot.writingRollout = { profileIds: ['a'], profiles: [{ id: 'a', name: 'Fixture canary' }], releasedVersion: 1, canaryVersion: 3, maxProfiles: 3 };
    snapshot.writing.recent.push({ ...snapshot.writing.recent[0], path: 'javascript:alert(1)' });
    const controller = create({ document, api: async (...args) => { calls.push(args); return snapshot; },
      getDeveloperTools: () => true, getPlacement: () => 'desktop', getPopulationAdmin: () => false });
    await controller.open();
    const elements = flatten(document.body);
    assert(elements.some(node => node.textContent === 'Writing canary / controls'));
    assert(elements.some(node => node.textContent.includes('1 accessible profiles selected for v3')));
    assert(elements.some(node => node.textContent.includes('Fixture canary')));
    for (const label of ['Scheduled', 'Manual', 'Burst']) {
      assert(elements.some(node => node.tag === 'td' && node.textContent === label), label + ' trigger is visible');
    }
    const links = elements.filter(node => node.tag === 'a');
    assert.equal(links.length, 3);
    assert.equal(links[0].href, 'https://feddit.dabblelabs.uk/f/fixtures/comments/10#comment-21');
    assert.equal(links[0].rel, 'noopener noreferrer');
    assert.equal(elements.some(node => node.innerHTML !== undefined), false);
    assert.deepEqual(calls, [['/api/naturalness?hours=24']]);
    controller.close();
  });
  console.log('naturalness-writing: ' + checks + ' checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
