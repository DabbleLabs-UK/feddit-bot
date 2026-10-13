'use strict';

const assert = require('node:assert/strict');
const branch = require('../lib/reply-branch');

const post = { id: 7, title: 'A small machine', selftext: 'The machine only accepts coins.', kind: 'text' };
const root = { id: 11, post_id: 7, parent_id: 't3_7', author: 'first', body: 'The machine ate my coin.' };
const middle = { id: 12, post_id: 7, parent_id: 't1_11', author: 'second', body: 'It also ate my bus ticket.' };
const target = { id: 13, post_id: 7, parent_id: 't1_12', author: 'third', body: 'Perhaps it wants to go home.' };
const sibling = { id: 14, post_id: 7, parent_id: 't1_11', author: 'sibling', body: 'SIBLING MUST NOT LEAK.' };

const top = branch.forPost(post);
assert.equal(top.version, 1);
assert.equal(top.target, null);
assert.deepEqual(top.ancestors, []);
assert.equal(top.complete, true);
assert.equal(top.post.body, post.selftext);
assert.match(branch.render(top), /^POST YOU ARE REPLYING TO:/);
assert.doesNotMatch(branch.render(top), /ANCESTOR|BACKGROUND|IMMEDIATE PARENT/);

const nested = branch.fromComment(post, target, [sibling, target, middle, root]);
assert.deepEqual(nested.target, { id: 13, author: 'third', body: target.body, parentId: 12 });
assert.deepEqual(nested.ancestors.map((item) => item.id), [11, 12]);
assert.equal(nested.complete, true);
const rendered = branch.render(nested);
assert.match(rendered, /^ORIGINAL POST - BACKGROUND:/);
assert.ok(rendered.indexOf(root.body) < rendered.indexOf(middle.body));
assert.ok(rendered.indexOf(middle.body) < rendered.indexOf('IMMEDIATE PARENT YOU ARE REPLYING TO'));
assert.ok(rendered.endsWith(target.body));
assert.doesNotMatch(rendered, /SIBLING MUST NOT LEAK/);

const rootComment = branch.fromComment(post, root, [root, sibling]);
assert.deepEqual(rootComment.ancestors, []);
assert.equal(rootComment.target.id, root.id);
assert.equal(rootComment.complete, true);
assert.ok(branch.render(rootComment).endsWith(root.body));
assert.equal(branch.fromComment(post, { ...root, parent_id: 't3_9' }, []).complete, false);

const missing = branch.fromComment(post, target, [target]);
assert.deepEqual(missing.ancestors, []);
assert.equal(missing.complete, false);
assert.match(branch.render(missing), /Do not invent it/);
const unknown = branch.fromComment(post, { id: 90, body: 'Unknown ancestry.' }, []);
assert.equal(unknown.complete, false);

const cyclic = branch.fromComment(post, target, [middle, { ...root, parent_id: 't1_13' }]);
assert.equal(cyclic.complete, false);
assert.deepEqual(cyclic.ancestors.map((item) => item.id), [11, 12]);
const selfCycle = branch.fromComment(post, { ...target, parent_id: 't1_13' }, [target]);
assert.deepEqual(selfCycle.ancestors, []);
assert.equal(selfCycle.complete, false);

const foreign = branch.fromComment(post, target, [{ ...middle, post_id: 9 }, root]);
assert.deepEqual(foreign.ancestors, []);
assert.equal(foreign.complete, false);
assert.deepEqual(branch.fromComment(post, { ...target, post_id: 9 }, [middle, root]).ancestors, []);
assert.deepEqual(branch.fromComment(post, target, [{ ...middle, post_id: undefined, link_id: 't3_9' }]).ancestors, []);
assert.deepEqual(branch.fromComment(post, target, [{ ...middle, parent_id: 't3_9' }]).ancestors, []);

const deep = Array.from({ length: 100 }, (_, index) => ({
  id: index + 1, post_id: 7, parent_id: index ? 't1_' + index : 't3_7',
  author: 'voice', body: 'Thought ' + index + '.',
}));
const bounded = branch.fromComment(post, deep[99], deep);
assert.deepEqual(bounded.ancestors.map((item) => item.id), [97, 98, 99]);
assert.equal(bounded.complete, false);
const four = branch.fromComment(post, deep[4], deep);
assert.deepEqual(four.ancestors.map((item) => item.id), [2, 3, 4]);
assert.equal(four.complete, false);

const attention = branch.fromAttention({
  source_type: 'comment', post_id: 7, comment_id: 13, parent_comment_id: 12,
  author: target.author, body: target.body,
  context: { post, parent_chain: [root, middle] },
});
assert.deepEqual(attention, nested);
const limitedAttention = branch.fromAttention({
  source_type: 'comment', post_id: 7, comment_id: 13, parent_comment_id: 12, body: target.body,
  context: { post, parent_chain: [{ comment_id: 11, body: 'First.' }, { comment_id: 12, body: 'Next.' }] },
});
assert.deepEqual(limitedAttention.ancestors.map((item) => item.id), [11, 12]);
assert.equal(limitedAttention.complete, false);
assert.equal(branch.fromAttention({ source_type: 'post', post_id: 7, context: { post } }).target, null);
assert.deepEqual(branch.fromAttention({
  comment_id: 13, parent_comment_id: 12, context: { post, parent_chain: [root, sibling] },
}).ancestors, []);

const renewed = branch.fromRenewed({ post, fresh_comment: target, parent_comment: middle });
assert.deepEqual(renewed.ancestors.map((item) => item.id), [12]);
assert.equal(renewed.complete, false);
const compactRenewed = branch.fromRenewed({
  post, fresh_comment: { id: 13, body: target.body }, parent_comment: { id: 12, body: middle.body },
});
assert.equal(compactRenewed.target.parentId, 12);
assert.equal(compactRenewed.complete, false);
assert.deepEqual(compactRenewed.ancestors.map((item) => item.id), [12]);
assert.deepEqual(branch.fromRenewed({ post, fresh_comment: target, parent_comment: sibling }).ancestors, []);
assert.deepEqual(branch.fromRenewed({ post, fresh_comment: root, parent_comment: middle }).ancestors, []);
assert.doesNotThrow(() => branch.fromRenewed({ post, fresh_comment: 'malformed', parent_comment: middle }));
const manyComments = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1000, parent_id: 't3_7' }));
const cappedInput = branch.fromComment(post, target, [...manyComments, middle, root]);
assert.deepEqual(cappedInput.ancestors, []);
assert.equal(cappedInput.complete, false, 'an oversized input cannot create false certainty about omitted comments');

const huge = 'One complete sentence. '.repeat(1000);
const hugeBranch = branch.fromComment({ ...post, selftext: huge, title: huge }, target,
  [{ ...middle, body: huge }, { ...root, body: huge }]);
assert.ok(hugeBranch.post.body.length <= 8000);
assert.ok(hugeBranch.ancestors.every((item) => item.body.length <= 4000));
const hugeRendered = branch.render(hugeBranch);
assert.ok(hugeRendered.length <= 5000);
assert.ok(hugeRendered.endsWith(target.body), 'large background and ancestors retain the short immediate parent intact');
assert.match(hugeRendered, /sentence\. \[excerpt\]/);
for (const kind of ['text', 'link']) {
  const maximum = branch.render({
    version: 1, complete: false,
    post: { id: 7, title: 'T'.repeat(1000), body: huge, kind, url: 'u'.repeat(3000), summary: huge },
    ancestors: [root, middle].map((item) => ({ ...item, author: 'a'.repeat(1000), body: huge })),
    target: { id: 13, author: 'a'.repeat(1000), body: huge },
  });
  assert.ok(maximum.length <= 5000, kind + ' context stays bounded, got ' + maximum.length);
  assert.ok(maximum.lastIndexOf('IMMEDIATE PARENT YOU ARE REPLYING TO') > maximum.lastIndexOf('ANCESTOR BRANCH'));
  assert.match(maximum, /sentence\. \[excerpt\]$/);
}
const short = 'No, that was my ticket.';
const titledLink = branch.forPost({ id: 7, kind: 'link', title: 'My authored joke', og_title: 'Publisher headline',
  og_description: short, url: 'https://example.test/story' });
assert.match(branch.render(titledLink), /TITLE: My authored joke/);
assert.match(branch.render(titledLink), /SOURCE HEADLINE: Publisher headline/);
assert.match(branch.render(branch.fromComment(titledLink.post, target, [middle, root])), /TITLE: My authored joke/);
assert.ok(branch.render({ ...hugeBranch, post: { ...titledLink.post, title: huge, headline: huge,
  summary: huge, url: huge }, target: { ...target, author: huge, body: huge } }).length <= 5000);
assert.ok(branch.render(branch.forPost({ kind: 'link', title: huge, og_title: huge,
  og_description: huge, url: huge })).length <= 5000);
assert.ok(branch.render(branch.fromComment(post, { ...target, body: short }, [middle, root])).endsWith(short));
assert.equal(branch.forPost({ id: 7, body: short }).post.body, short);
assert.equal(branch.forPost({ id: 7, kind: 'link', og_description: short }).post.summary, short);
const removal = branch.render({
  version: 1, complete: true, post: { ...post, body: 'BACKGROUND '.repeat(200) },
  ancestors: [
    { id: 10, author: 'OLDEST', body: 'Old branch thought. '.repeat(70) },
    { id: 11, author: 'MIDDLE', body: 'Another branch thought. '.repeat(70) },
    { id: 12, author: 'NEAREST', body: 'Recent branch thought. '.repeat(70) },
  ],
  target: { ...target, body: 'The selected comment continues. '.repeat(74) },
});
assert.doesNotMatch(removal, /OLDEST:/, 'oldest whole ancestors are removed before nearer ancestors');
assert.match(removal, /NEAREST:/, 'the nearest ancestor survives when it fits');
assert.match(removal, /earlier branch context was omitted for space/,
  'rendering reports omitted ancestors even when the source branch was complete');
assert.ok(removal.length <= 5000);

console.log('reply-branch: passed');
