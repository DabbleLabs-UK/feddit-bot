'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const writing = require('../lib/reply-continuity');
const branch = require('../lib/reply-branch');
const at = Date.parse('2026-10-23T14:00:00Z');
const retained = require('./fixtures/reply-continuity-public.json');
let checks = 0;
const eq = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
eq(writing.version(), 0, 'old frozen turns default to zero');
eq(writing.version(1), 1);
for (const v of [2, -1, '1', false]) { assert.throws(() => writing.version(v), { code: 'UNSUPPORTED_REPLY_CONTINUITY' }); checks++; }
const repeated = 'It is not a book. It is a reaction. You are just existing, like a drawer with feelings.';
const hash = writing.fingerprint(repeated);
eq(writing.fingerprint('  ' + repeated.replaceAll(' ', '\n') + ' '), hash, 'layout cannot evade exact duplicate detection');
eq(writing.fingerprint('Thanks.'), null, 'ordinary brief acknowledgements remain legitimate');
let result = writing.reserve(undefined, { hash, id: 'turn-1', at });
eq(result.allowed, true);
eq(writing.reserve(result.state, { hash, id: 'turn-1', at }).allowed, true, 'same operation replay remains allowed');
eq(writing.reserve(result.state, { hash, id: 'turn-2', at }).allowed, false, 'a different target/turn cannot republish the same body');
eq(writing.reserve(result.state, { hash: writing.fingerprint(repeated + ' The drawer now charges rent.'), id: 'turn-2', at }).allowed, true,
  'a callback developing the premise is not fuzzy-blocked');
for (let i = 0; i < 90; i++) result = writing.reserve(result.state, { hash: writing.fingerprint(repeated + i), id: 'turn-' + i, at: at + i });
eq(result.state.entries.length, 64, 'history is bounded');
assert.throws(() => writing.outputState({ version: 2, entries: [] }), { code: 'REPLY_CONTINUITY_BOOKKEEPING_PENDING' }); checks++;
const state = { episodes: [
  { id: 'mine', at: at - 5000, kind: 'reply', direction: 'outgoing', threadKey: 't3_258', summary: 'Replied to @alice in f/bookclub: ' + repeated },
  { id: 'incoming', at: at - 3000, kind: 'reply', direction: 'incoming', threadKey: 't3_258', summary: 'Do not treat another bot as me.' },
  { id: 'old', at: at - 25 * 3600000, kind: 'reply', direction: 'outgoing', threadKey: 't3_258', summary: 'Expired story.' },
] };
const prior = writing.priorReplies(state, { postId: 258 }, at);
eq(prior.hints.length, 1); eq(prior.historicalHashes, [hash], 'short historical outputs are protected without rewriting memory');
const memory = { relevant: true, prompt: 'COPYABLE_OLD_ANECDOTE', writingContext: { version: 1, claims: [{ slot: 'job', value: 'librarian', polarity: 'positive', status: 'tentative' }],
  episodes: [{ account: 'alice', topics: ['books'] }], preoccupations: ['HIJACK'] } };
const target = { postId: 258, context: 'UNRELATED_SIBLING', replyBranch: branch.fromComment({ id: 258, title: 'Books' },
  { id: 1963, post_id: 258, parent_comment_id: 1945, author: 'alice', body: 'Can you give a concrete example rather than another metaphor?' },
  [{ id: 1945, parent_comment_id: null, author: 'bob', body: 'I doubt books literally remember us.' }]) };
const task = writing.prompt({ target, memory, recent: prior, socialGuidance: 'Known from earlier public exchanges.\n', styleGuidance: 'CANARY_STYLE_UNCHANGED\n' });
assert.doesNotMatch(task, /COPYABLE_OLD_ANECDOTE|HIJACK|UNRELATED_SIBLING/); checks++;
assert.match(task, /librarian/); checks++;
assert.match(task, /Known from earlier public exchanges/); checks++;
assert.match(task, /CANARY_STYLE_UNCHANGED/); checks++;
assert.ok(task.endsWith('Can you give a concrete example rather than another metaphor?\n\nYour reply:')); checks++;
assert.ok(task.indexOf('I doubt books literally remember us.') < task.indexOf('IMMEDIATE PARENT')); checks++;
eq(writing.priorReplies({ episodes: [{ ...state.episodes[0], summary: 'Replied to @alice in f/bookclub: ' + 'x'.repeat(600) }] }, target, at).historicalHashes.length, 0,
  'truncated old summaries never pretend to be complete fingerprints');

// The actual two public book-thread outputs differ in parent, not body.
const first = retained.comments.find(c => c.id === 1953), second = retained.comments.find(c => c.id === 1978);
eq(first.body, second.body); assert.notEqual(first.parent_comment_id, second.parent_comment_id); checks++;
eq(writing.reserve(writing.reserve(undefined, { hash: writing.fingerprint(first.body), id: 'old-target', at }).state,
  { hash: writing.fingerprint(second.body), id: 'new-target', at }).allowed, false, 'retained verbatim duplicate is prevented');
const realTarget = retained.comments.find(c => c.id === second.parent_comment_id);
const realBranch = branch.fromComment(retained.posts.find(p => p.id === 258), realTarget, retained.comments);
const realTask = writing.prompt({ target: { postId: 258, replyBranch: realBranch }, recent: { hints: [{ threadKey: 't3_258', text: first.body }] } });
assert.ok(realTask.endsWith(realTarget.body + '\n\nYour reply:')); checks++;
assert.match(realTask, /RECENTLY SAID BY YOU/); checks++;
assert.doesNotMatch(realTask, /It is not a book. It is a reaction/); checks++;

// Real store persistence, mode separation and atomic failure, entirely disposable.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-reply-output-'));
process.env.FEDDIT_BOT_DATA_DIR = directory;
const storePath = require.resolve('../lib/store');
try {
  let store = require(storePath);
  const profile = store.createProfile({ refName: 'reply-test', persona: 'Unchanged persona' });
  eq(store.reserveReplyOutput(profile.id, { hash, id: 'operation-a', at }), true);
  eq(store.reserveReplyOutput(profile.id, { hash, id: 'operation-b', at }), false);
  eq(store.reserveReplyOutput(profile.id, { hash, id: 'operation-b', at }, { simulation: true }), true, 'rehearsal is independent');
  delete require.cache[storePath]; store = require(storePath);
  eq(store.reserveReplyOutput(profile.id, { hash, id: 'operation-c', at }), false, 'restart retains the claim');
  eq(store.reserveReplyOutput(profile.id, { hash, id: 'operation-a', at }), true, 'restart permits exact owner replay');
  const rename = fs.renameSync;
  const failedHash = writing.fingerprint(repeated + ' New output before a failed write.');
  try {
    fs.renameSync = () => { throw new Error('fixture write failure'); };
    assert.throws(() => store.reserveReplyOutput(profile.id, { hash: failedHash, id: 'failed', at })); checks++;
  } finally { fs.renameSync = rename; }
  eq(store.reserveReplyOutput(profile.id, { hash: failedHash, id: 'later', at }), true, 'failed save did not poison cached state');
  eq(store.getProfile(profile.id).persona, 'Unchanged persona');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('reply continuity: ' + checks + ' checks passed');
