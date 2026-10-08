'use strict';

const assert = require('node:assert/strict');
const { buildEcology, LIMITS, THRESHOLDS } = require('../lib/naturalness-ecology-metrics');
const now = Date.parse('2026-10-08T12:00:00Z'), since = now - 86400000;
const post = (id, extra = {}) => ({ key: 'post:' + id, type: 'post', id, postId: id, parentKey: null, author: 'alpha', community: 'test',
  createdAt: new Date(now - 3600000).toISOString(), title: 'Public topic', text: 'Here is a public observation about gardens.', kind: 'text', ...extra });
const comment = (id, parentKey = 'post:1', extra = {}) => ({ ...post(id), key: 'comment:' + id, type: 'comment', postId: 1, parentKey,
  author: 'beta', createdAt: new Date(now - 1800000).toISOString(), ...extra });
const build = (items, extra = {}) => buildEcology({ items, now, since, until: now, ...extra });
const empty = build([]);
assert.equal(empty.overview.posts, 0);
assert.equal(empty.overview.postingConcentration.ratio, null);
assert.equal(empty.replies.depth.mean, null);
assert.equal(empty.voting.live.nilShare.ratio, null);
assert.equal(empty.coverage.source.available, null);
assert.equal(empty.anomalies.length, 0);
assert.equal(empty.coverage.sampleOnly, true);

const graph = build([post(1, { createdAt: new Date(since - 3600000).toISOString() }),
  comment(1), comment(2, 'comment:1', { author: 'alpha', createdAt: new Date(now - 1200000).toISOString() }),
  comment(3, 'comment:2', { createdAt: new Date(now - 600000).toISOString() }),
  comment(4, 'comment:999'), comment(5, 'comment:4'), comment(6, 'comment:7'), comment(7, 'comment:6'),
  comment(8, 'post:2'), post(2), comment(9, 'comment:9'), comment(10, 'comment:3')]);
assert.equal(graph.coverage.historicalItems, 1);
assert.equal(graph.overview.posts, 1, 'historical parent is not recent posting');
assert.equal(graph.overview.comments, 10);
assert.equal(graph.replies.parentCoverage.missingParents, 1);
assert.equal(graph.replies.parentCoverage.invalidEdges, 3, 'cross-thread, self-parent and time reversal');
assert.equal(graph.replies.parentCoverage.incompleteAncestry, 3, 'missing ancestor and two cycle members');
assert.equal(graph.replies.depth.count, 3);
assert.equal(graph.replies.depth.max, 3);
assert.equal(graph.replies.depth.mean, 2);
assert.equal(graph.replies.oneAndDone.numerator, 1);
assert.equal(graph.replies.oneAndDone.denominator, 3);
assert.equal(graph.replies.latencySeconds.count, 3);
assert.equal(graph.replies.parentAge.old, 1);
assert.equal(graph.interactions.pairs.length, 2);
assert.equal(graph.interactions.reciprocity.ratio, 1);
assert.equal(graph.interactions.pairs.find(row => row.from === 'beta').replies, 2);
assert.equal(graph.interactions.communities.withinCommunity.ratio, 1);
assert.equal(graph.interactions.pairs[0].examples[0].path, '/f/test/comments/1');
assert.equal(build([post(1, { createdAt: new Date(since - 1).toISOString() }), comment(1)]).interactions.reciprocity.ratio, 0);
const undated = build([post(1, { createdAt: null }), comment(1)]);
assert.equal(undated.replies.depth.max, 1);
assert.equal(undated.replies.latencySeconds.mean, null);
assert.equal(undated.replies.latencySeconds.unknown, 1);
assert.equal(graph.interactions.twoAuthorThreads.count, 0, 'historical root edge does not create a three-edge exchange');
assert.equal(graph.bots.find(row => row.bot === 'alpha').initiation.denominator, 1, 'historical posts do not count as new initiations');

const exchangeRows = [post(1), post(2, { createdAt: new Date(now - 7200000).toISOString() }),
  comment(1), comment(2, 'comment:1', { author: 'alpha', createdAt: new Date(now - 1200000).toISOString() }),
  comment(3, 'comment:2', { createdAt: new Date(now - 600000).toISOString() })];
const exchange = build(exchangeRows);
const alpha = exchange.bots.find(row => row.bot === 'alpha');
const beta = exchange.bots.find(row => row.bot === 'beta');
assert.equal(alpha.postsPerHour, 2 / 24);
assert.equal(alpha.repliesPerHour, 1 / 24);
assert.equal(alpha.interarrivalSeconds.posts.count, 1);
assert.equal(alpha.interarrivalSeconds.posts.mean, 3600);
assert.equal(alpha.interarrivalSeconds.posts.cv, null, 'a single gap cannot establish cadence variation');
assert.equal(beta.interarrivalSeconds.replies.mean, 1200);
assert.equal(alpha.initiation.postsWithObservedExternalReplies, 1);
assert.equal(alpha.initiation.postsWithoutObservedExternalReplies, 1);
assert.equal(alpha.initiation.externalReplyShare.ratio, 0.5);
assert.equal(beta.initiation.externalReplyShare.ratio, null);
assert.match(alpha.initiation.meaning, /right-censored/);
assert.equal(exchange.interactions.twoAuthorThreads.count, 1);
assert.equal(exchange.interactions.twoAuthorThreads.denominator, 2);
assert.deepEqual(exchange.interactions.twoAuthorThreads.rows[0].authors, ['alpha', 'beta']);
assert.equal(exchange.interactions.twoAuthorThreads.rows[0].replies, 3);
assert.equal(exchange.interactions.twoAuthorThreads.rows[0].forwardReplies, 1);
assert.equal(exchange.interactions.twoAuthorThreads.rows[0].reverseReplies, 2);
assert.deepEqual(exchange.interactions.twoAuthorThreads.rows[0].examples.map(row => row.key), ['comment:1', 'comment:2', 'comment:3']);
assert.deepEqual(build([...exchangeRows].reverse()).interactions.twoAuthorThreads, exchange.interactions.twoAuthorThreads, 'exchange examples are stable under input ordering');
assert.equal(build([...exchangeRows, comment(4, 'comment:3', { author: 'third', createdAt: new Date(now - 300000).toISOString() })]).interactions.twoAuthorThreads.count, 0);
const unknownExchange = build([...exchangeRows, comment(4, 'comment:3', { author: null, createdAt: new Date(now - 300000).toISOString() })]);
assert.equal(unknownExchange.interactions.twoAuthorThreads.count, 0);
assert.equal(unknownExchange.interactions.twoAuthorThreads.unknownAuthorThreads, 1);
assert.equal(unknownExchange.bots.find(row => row.bot === 'alpha').initiation.unknownAuthorReplyPosts, 1);
const selfOnly = build([post(1), comment(1, 'post:1', { author: 'alpha' })]);
assert.equal(selfOnly.bots[0].initiation.postsWithObservedExternalReplies, 0);
assert.equal(selfOnly.interactions.twoAuthorThreads.count, 0);

const small = Array.from({ length: THRESHOLDS.minimumSample - 1 }, (_, i) => post(i + 1));
assert.equal(build(small).anomalies.length, 0);
const repeated = build([...small, post(10)]);
assert.ok(repeated.anomalies.some(row => row.code === 'repeated-opening'));
assert.ok(repeated.anomalies.some(row => row.code === 'similar-posts-lengths'));
assert.ok(repeated.anomalies.every(row => row.examples.length <= 3 && row.sampleSize >= THRESHOLDS.minimumSample));
assert.equal(repeated.language.topics.rows.find(row => row.term === 'gardens').count, 10);
assert.equal(build(Array.from({ length: 10 }, (_, i) => post(i + 1, { text: 'x'.repeat(2 ** i) }))).anomalies.length, 0);
const proxy = build([post(1), comment(1, 'post:1', { text: 'I agree about gardens, but the rest is different.' })]);
assert.equal(proxy.language.agreementProxy.ratio, 1);
assert.ok(proxy.language.contextOverlapProxy.mean > 0);
assert.match(proxy.language.agreementProxy.label, /not semantic/);
const phraseItems = [comment(1, 'post:1', { author: 'a', text: 'First thought here. And do not even ask about that.' }),
  comment(2, 'post:1', { author: 'b', text: 'Something else entirely. And do not even ask about that.' }),
  comment(3, 'post:1', { author: 'c', text: 'A third beginning. And do not even ask about that.' })];
const phrases = build(phraseItems).language.repeatedPhrases;
assert.ok(phrases.rows.some(row => row.phrase === 'and do not even ask'));
assert.equal(phrases.rows[0].count, 3);
assert.equal(phrases.rows[0].authors, 3);
assert.equal(phrases.rows[0].examples.length, 3);
assert.equal(build(phraseItems.map(row => ({ ...row, author: 'same' }))).language.repeatedPhrases.rows.length, 0);
assert.equal(build(phraseItems.slice(0, 2)).language.repeatedPhrases.rows.length, 0);
const community = build([post(1)], { communities: [{ name: 'test', description: 'Public garden discussions', rules: ['Stay relevant', 'Be kind'], persona: 'PRIVATE_NORM' },
  { name: 'unrelated', description: 'PRIVATE_UNUSED' }] });
assert.deepEqual(community.communityContext, [{ name: 'test', description: 'Public garden discussions', rules: 'Stay relevant Be kind' }]);
assert.equal(community.coverage.communityContextMissing, 0);
assert.equal(community.coverage.privateContinuityInspected, false);
assert.doesNotMatch(JSON.stringify(community), /PRIVATE_/);

const filtering = build([post(1, { createdAt: new Date(since).toISOString(), kind: 'link' }), post(2, { createdAt: new Date(now).toISOString() }),
  post(3, { createdAt: new Date(now + 1).toISOString() }), post(4, { createdAt: 'bad' }), post(5, { createdAt: new Date(since - 1).toISOString() }),
  post(1), { ...post(7), id: 8 }, null]);
assert.equal(filtering.overview.posts, 2);
assert.equal(filtering.overview.postsPerDay, 2);
for (const field of ['futureItems', 'undatedItems', 'historicalItems', 'duplicateItems']) assert.equal(filtering.coverage[field], 1);
assert.equal(filtering.coverage.invalidItems, 2);
assert.equal(filtering.overview.articleMix.linkShare, 0.5);
assert.equal(filtering.timing.hourUtc.reduce((total, row) => total + row.count, 0), 2);
assert.equal(filtering.timing.interarrivalSeconds.mean, 86400);
assert.equal(filtering.timing.quietIntervals[0].hours, 24);
const synchronized = build([post(1, { author: 'a' }), post(2, { author: 'b' }), post(3, { author: 'c' })]);
assert.equal(synchronized.timing.synchronizedBins[0].bots, 3);

const event = (stage, opportunityId, raw = {}, extra = {}) => ({ stage, opportunityId, profileId: 'PRIVATE_PROFILE', bot: 'voter',
  mode: 'live', at: new Date(now - 1000).toISOString(), items: [{ key: 'post:1', ...raw }], ...extra });
const events = [event('offered', 'one'), event('offered', 'one'), event('decision', 'one', { decisionKind: 'explicit', direction: 'nil' }),
  event('offered', 'two'), event('decision', 'two', { decisionKind: 'explicit', direction: 'up' }), event('outcome', 'two', { status: 'cast' }),
  event('offered', 'three'), event('decision', 'three', { decisionKind: 'missing', direction: 'nil' }),
  event('outcome', 'legacy', { status: 'cast' }, { legacy: true }), event('offered', 'rehearsal', {}, { mode: 'rehearsal' }),
  event('decision', 'rehearsal', { decisionKind: 'explicit', direction: 'nil' }, { mode: 'rehearsal' }),
  event('offered', 'old', {}, { at: new Date(since - 1).toISOString() }), event('outcome', 'unlinked', { status: 'cast' })];
const voting = build([], { events });
assert.equal(voting.voting.live.opportunities, 3);
assert.equal(voting.voting.live.offered, 3);
assert.equal(voting.voting.live.explicitNil, 1);
assert.equal(voting.voting.live.explicitConsidered, 2);
assert.equal(voting.voting.live.parserDefaultNil, 1);
assert.equal(voting.voting.live.nilShare.ratio, 0.5);
assert.equal(voting.voting.live.confirmedCast, 1);
assert.equal(voting.voting.live.unlinkedConfirmedCast, 1);
assert.equal(voting.voting.rehearsal.explicitNil, 1);
assert.equal(voting.voting.legacy.unlinkedConfirmedCast, 1);
assert.equal(voting.bots[0].bot, 'voter');
assert.equal(voting.bots[0].posts, 0);
const multi = build([], { events: [event('offered', 'multi', {}, { items: [{ key: 'post:1' }, { key: 'post:2' }] })] });
assert.equal(multi.voting.live.opportunities, 1);
assert.equal(multi.voting.live.offered, 2);
const brokenJournal = Array.from({ length: 10 }, (_, i) => event('offered', 'missing-' + i, { key: 'post:' + (i + 1), community: 'test' }));
assert.equal(build([], { events: brokenJournal.slice(0, 9) }).anomalies.length, 0);
const broken = build([], { events: brokenJournal });
assert.equal(broken.anomalies[0].code, 'missing-vote-decisions');
assert.equal(broken.anomalies[0].sampleSize, 10);
assert.equal(broken.anomalies[0].affectedBots, 1);
assert.deepEqual(broken.anomalies[0].examples.map(row => row.key), ['post:1', 'post:2', 'post:3']);

const input = { items: [post(1, { url: 'https://evil.test/PRIVATE_URL', title: 'token=PRIVATE_TOKEN', text: 'Bearer PRIVATE_BEARER user@example.com password=PRIVATE_PASSWORD',
  persona: 'PRIVATE_PERSONA', kernel: 'PRIVATE_KERNEL', memory: 'PRIVATE_MEMORY' }), comment(1, 'post:1', { community: 'a/b?x=1', text: 'x'.repeat(10000) })], events,
  profiles: [{ persona: 'PRIVATE_PERSONA', social: { text: 'PRIVATE_SOCIAL' } }], votingSnapshot: { token: 'PRIVATE_SNAPSHOT' },
  coverage: { available: true, complete: false, token: 'PRIVATE_COVERAGE', warnings: ['password=PRIVATE_WARNING'] }, now, since, until: now };
const before = JSON.stringify(input), safe = buildEcology(input);
assert.equal(JSON.stringify(input), before);
assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|user@example\.com|evil\.test/);
assert.equal(safe.examples[1].excerpt.length, 240);
assert.equal(safe.examples[1].path, '/f/a%2Fb%3Fx%3D1/comments/1');
assert.equal(safe.overview.lengths.comments.mean, 10000);
assert.equal(safe.coverage.source.available, true);
assert.equal(safe.coverage.source.complete, false);
assert.equal(safe.coverage.source.warnings[0], 'password=[redacted]');
const source = build([], { coverage: { source: 'public-feddit-api', postsComplete: true, commentsComplete: false, sourceSince: new Date(since).toISOString(),
  sourceUntil: new Date(now).toISOString(), requests: 4, failedReads: 1, publicRecords: 0, truncated: true, nsfwIncluded: false } }).coverage;
assert.equal(source.source.requests, 4);
assert.equal(source.source.postsComplete, true);
assert.equal(source.source.commentsComplete, false);
assert.equal(source.source.sourceSince, new Date(since).toISOString());
assert.equal(source.truncated, true);
assert.equal(build([post(1, { community: '\ud800' })]).examples[0].path, '/f/%EF%BF%BD/comments/1');
const bounds = build(Array.from({ length: LIMITS.items + 3 }, (_, i) => post(i + 1, { author: 'bot-' + i, community: 'community-' + i })));
assert.equal(bounds.coverage.acceptedItems, LIMITS.items);
assert.equal(bounds.coverage.truncated, true);
assert.equal(bounds.bots.length, LIMITS.bots);
assert.equal(bounds.botsTruncated, true);
assert.equal(bounds.examples.length, LIMITS.examples);
assert.equal(bounds.interactions.communities.rows.length, LIMITS.groups);
assert.ok(bounds.anomalies.length <= LIMITS.anomalies);
assert.ok(JSON.stringify(bounds).length < 300000);
assert.doesNotThrow(() => buildEcology({ items: null, events: null, coverage: null, now: 'bad', until: 'bad', since: 'bad' }));
console.log('naturalness ecology metrics: all assertions passed');
