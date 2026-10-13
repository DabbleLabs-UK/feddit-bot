'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const writing = require('../lib/public-writing');
const replyBranch = require('../lib/reply-branch');

assert.equal(writing.VERSION, 3);
assert.equal(writing.version(), 1);
assert.equal(writing.version(null), 1);
assert.equal(writing.version(undefined, 2), 2);
assert.equal(writing.version(1), 1);
assert.equal(writing.version(2), 2);
assert.equal(writing.version(3), 3);
for (const value of [0, 4, -1, '1', '2', '3', '', false, true, {}, NaN]) {
  assert.throws(() => writing.version(value), { code: 'UNSUPPORTED_PUBLIC_WRITING_CONTRACT' });
}
assert.equal(writing.version(null, 3), 3);

const options = {
  feddit: 'botlife', communityGuidance: 'COMMUNITY RULES\n\n',
  socialGuidance: 'PRIOR INTERACTIONS\n\n', memoryGuidance: 'MEMORY\n\n',
  honesty: 'ONLY THE HEADLINE IS KNOWN\n\n', target: { context: 'TITLE: Original\nCOMMENT: A short thought.' },
};
const legacyPost = 'You are posting a NEW thread to the sub-feddit "botlife" on a forum called Feddit.\n' +
  'COMMUNITY RULES\n\nMEMORY\n\n' +
  'Write an original short post in character. Respond with the post TITLE on the first line, then a ' +
  'blank line, then the body. No preamble, no markdown headings.';
const legacyComment = 'You are browsing a forum called Feddit. Write a single in-character reply. ' +
  'Plain text, no preamble, no surrounding quotes.\n\nCOMMUNITY RULES\n\n' +
  'PRIOR INTERACTIONS\n\nMEMORY\n\nONLY THE HEADLINE IS KNOWN\n\n' +
  'TITLE: Original\nCOMMENT: A short thought.\n\nYour reply:';
assert.equal(writing.post({ ...options, version: 1 }), legacyPost);
assert.equal(writing.post(options), legacyPost, 'missing version preserves the exact legacy post prompt');
assert.equal(writing.comment({ ...options, version: 1 }), legacyComment);
assert.equal(writing.comment(options), legacyComment, 'missing version preserves the exact legacy reply prompt');
assert.equal(writing.post({ feddit: 'plain', version: 1 }),
  'You are posting a NEW thread to the sub-feddit "plain" on a forum called Feddit.\n' +
  'Write an original short post in character. Respond with the post TITLE on the first line, then a ' +
  'blank line, then the body. No preamble, no markdown headings.');

const post = writing.post({ ...options, version: 2 });
assert.match(post, /about 45-70 words in the text post body/);
assert.match(post, /soft target, not a hard limit or a quota/);
assert.match(post, /Keep an already short thought short; do not pad it/);
assert.match(post, /Finish naturally in your own voice/);
assert.match(post, /humor, useful detail, disagreement and personality/);
assert.match(post, /use more space when the particular thought needs it/);
assert.ok(post.startsWith(legacyPost.slice(0, legacyPost.indexOf('Write an original short post'))));
assert.ok(post.endsWith('blank line, then the body. No preamble, no markdown headings.'));

const selectedBody = 'What if the ticket machine just wants a holiday?';
const target = {
  context: 'Legacy sibling context must not appear.',
  replyBranch: replyBranch.fromComment(
    { id: 7, title: 'Ticket machines', selftext: 'They take all my coins.' },
    { id: 13, parent_id: 't1_12', author: 'new_voice', body: selectedBody },
    [{ id: 12, parent_id: 't3_7', author: 'old_voice', body: 'It ate my bus ticket.' }]
  ),
};
const comment = writing.comment({ ...options, target, version: 2 });
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
assert.equal(digest(post), 'c01f277e3bb9804302517dafb0021d5f19dddb20c63b6d6ede08d33666220bb3',
  'exact post v2 bytes match implementation 831727c');
assert.equal(digest(comment), '8cbb21ef08bf5d12f498b69512ea183836a8bd62ebc4f1b4e9dcadb288a215ef',
  'exact branch reply v2 bytes match implementation 831727c');
assert.match(comment, /about 40-70 words in the comment/);
assert.match(comment, /Prioritize the immediate parent/);
assert.match(comment, /Preserve established relevant facts and jokes/);
assert.match(comment, /add a new thought/);
assert.match(comment, /Do not paraphrase or recap/);
assert.match(comment, /Established facts, names and running-joke motifs may recur/);
assert.match(comment, /merely restate its metaphor/);
assert.match(comment, /copy distinctive wording, sentences or a whole previous reply/);
assert.match(comment, /including text from memory/);
assert.match(comment, /Irrelevant memories or personal preoccupations must not redirect this branch/);
assert.doesNotMatch(comment, /Legacy sibling context must not appear/);
assert.ok(comment.endsWith(selectedBody + '\n\nYour reply:'));
assert.ok(comment.indexOf(options.honesty) < comment.indexOf('ORIGINAL POST - BACKGROUND'));
assert.equal(writing.comment({ ...options, target, version: 1 }),
  legacyComment.replace(options.target.context, target.context), 'legacy replay ignores the new branch representation');

const fallback = writing.renderTarget({ context: 'Opaque legacy target.' });
assert.match(fallback, /branch structure unavailable; do not infer or invent ancestors/);
assert.ok(fallback.endsWith('Opaque legacy target.'));
const largeFallback = writing.renderTarget({ context: 'OLD ROOT\n'.repeat(2000) + 'SELECTED TARGET MUST REMAIN LAST.' });
assert.ok(largeFallback.length <= 5000);
assert.ok(largeFallback.endsWith('SELECTED TARGET MUST REMAIN LAST.'));
assert.match(largeFallback, /earlier legacy context omitted/);
assert.ok(writing.renderTarget({ context: 'z'.repeat(12000) + 'END' }).endsWith('END'));
assert.ok(writing.renderTarget({ context: 'z'.repeat(12000) + 'END' }).length <= 5000);
assert.ok(writing.renderTarget(target).endsWith(selectedBody));
assert.ok(writing.renderTarget(target).length <= 5000);
assert.match(writing.contentGuidance('post'), /45-70 words/);
assert.match(writing.contentGuidance('comment'), /40-70 words/);
assert.match(writing.contentGuidance('comment'), /REPLY TO THIS BRANCH/);
assert.doesNotMatch(writing.contentGuidance('post'), /REPLY TO THIS BRANCH/);
assert.throws(() => writing.post({ ...options, version: 20 }), { code: 'UNSUPPORTED_PUBLIC_WRITING_CONTRACT' });
assert.throws(() => writing.comment({ ...options, version: 20 }), { code: 'UNSUPPORTED_PUBLIC_WRITING_CONTRACT' });

const prose = 'UNIQUE OLD ANSWER TO COPY VERBATIM. It brings an unrelated broom into the socks discussion.';
const memory = { relevant: true, prompt: prose, writingContext: { version: 1,
  claims: [{ slot: 'preference', value: 'darkroom printing', polarity: 'negative', status: 'tentative', summary: prose }],
  episodes: [{ kind: 'reply', direction: 'outgoing', account: 'old_voice', community: 'botlife',
    topics: ['camera', 'repair'], summary: prose }], preoccupations: ['camera'], raw: prose } };
const projected = writing.renderMemory(memory);
assert.match(projected, /OPTIONAL REMEMBERED BACKGROUND/);
assert.match(projected, /"polarity":"negative"/);
assert.match(projected, /"status":"tentative"/);
assert.match(projected, /owner-written persona remains stronger/);
assert.doesNotMatch(projected, /UNIQUE OLD ANSWER|broom|summary|raw/);
assert.ok(projected.length <= writing.MEMORY_CHARS);
assert.equal(writing.renderMemory({ relevant: true, prompt: prose }), '', 'old opaque prose is never salvaged');
assert.equal(writing.renderMemory({ ...memory, relevant: false }), '');
assert.equal(writing.renderMemory({ ...memory, writingContext: { version: 99 } }), '');
const largeMemory = { ...memory, writingContext: { version: 1,
  claims: Array(30).fill({ slot: 'job', value: 'x'.repeat(240), polarity: 'positive', status: 'established' }),
  episodes: Array(30).fill({ topics: Array(20).fill('camera'), summary: prose }),
  preoccupations: Array(30).fill('camera') } };
assert.ok(writing.renderMemory(largeMemory).length <= writing.MEMORY_CHARS, 'whole cues are omitted rather than clipping a fact');
assert.doesNotMatch(writing.renderMemory(largeMemory), /excerpt|UNIQUE OLD ANSWER/);
const compactPost = writing.post({ ...options, memoryGuidance: prose, memory, version: 3 });
const compactReply = writing.comment({ ...options, target, memoryGuidance: prose, memory, version: 3 });
for (const prompt of [compactPost, compactReply]) {
  assert.match(prompt, /Default to one compact paragraph/);
  assert.match(prompt, /finish the sentence and stop/);
  assert.match(prompt, /longer answer is an exception for necessary substance/);
  assert.match(prompt, /remembered public sentences are not templates/i);
  assert.doesNotMatch(prompt, /UNIQUE OLD ANSWER|soft target|use more space/);
}
assert.match(compactReply, /For nested replies, the immediate parent is the target and the root is background/);
assert.match(writing.comment({ ...options, version: 3, target: { replyBranch: replyBranch.forPost({
  id: 7, title: 'A root question', selftext: 'This is the actual target.' }) } }),
  /for top-level replies, the post itself is the target/);
assert.match(compactReply, /Memory and preoccupations are optional background/);
assert.match(compactReply, /Disagreement, absurd escalation/);
assert.ok(compactReply.indexOf('OPTIONAL REMEMBERED BACKGROUND') < compactReply.indexOf('IMMEDIATE PARENT YOU ARE REPLYING TO'));
assert.ok(compactReply.endsWith(selectedBody + '\n\nYour reply:'));
assert.match(compactPost, /one premise and one development or payoff/);
assert.match(writing.contentGuidance('comment', 2), /soft target/);
assert.doesNotMatch(writing.contentGuidance('comment', 2), /Default to one compact paragraph/);

console.log('public-writing: passed');
