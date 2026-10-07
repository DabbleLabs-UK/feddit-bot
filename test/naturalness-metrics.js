'use strict';

const assert = require('node:assert/strict');
const { buildSnapshot, LIMITS } = require('../lib/naturalness-metrics');
const now = Date.parse('2026-10-07T12:00:00Z');
const at = '2026-10-07T11:00:00Z';
const vote = (bot, direction, time = at) => ({ bot, direction, actorType: 'bot', at: time, reason: 'Published reason', token: 'PRIVATE_TOKEN' });
const item = (id, up, down, votes = []) => ({ key: `post:${id}`, targetType: 'post', targetId: id, up, down, total: up + down, score: up - down + 1, votes, community: id % 2 ? 'one' : 'two' });
const absent = buildSnapshot({ now });
assert.equal(absent.coverage.authoritativeAvailable, false);
assert.equal(absent.overview.authoritativeCurrent.total, null);
assert.equal(absent.overview.local.nilRate, null);
assert.equal(absent.coverage.localAvailable, false);
assert.equal(absent.overview.participation.live.rate, null);
assert.equal(absent.overview.classifications.stronglyPositive.proportion, null);

const authoritative = { items: [item(1, 3, 3, [vote('b', 'down', '2026-10-07T11:02:00Z'), vote('a', 'up', '2026-10-07T11:01:00Z')]), item(2, 4, 0), item(3, 4, 1), item(4, 1, 4), item(5, 0, 0)] };
const initial = JSON.stringify(authoritative);
const result = buildSnapshot({ authoritative, now });
assert.equal(JSON.stringify(authoritative), initial, 'metrics do not mutate inputs');
assert.equal(result.items[0].approximatelySplit, true);
assert.equal(result.items[0].highVotesLowNet, true);
assert.equal(result.items[0].entropy, 1);
assert.equal(result.items[1].stronglyPositive, false, 'four votes are below the convention');
assert.equal(result.items[2].stronglyPositive, true);
assert.equal(result.items[3].stronglyNegative, true);
assert.equal(result.items[4].entropy, null);
assert.equal(result.items[4].upShare, null);
assert.equal(result.items[0].total, 6, 'aggregate does not use truncated trail length');
assert.equal(result.items[0].trailTruncated, true);
assert.deepEqual(result.items[0].votes.map(row => row.bot), ['a', 'b']);
assert.equal(result.overview.distributions.upShare.missing, 1);
assert.equal(result.overview.authoritativeCurrent.total, 20);
assert.equal(result.overview.distributions.visibleScore.available, 5);
assert.equal(result.overview.distributions.visibleScore.bins.find(bin => bin.label === 'one').count, 2);
assert.equal(result.overview.classifications.denominator, 3);
assert.equal(result.overview.classifications.stronglyPositive.proportion, 1 / 3);
assert.equal(result.overview.classifications.approximatelySplit.proportion, 1 / 3);
assert.equal(result.overview.byContentType[0].items, 5);
assert.equal(result.overview.byContentType[1].items, 0);
assert.equal(result.overview.byCommunity.length, 2);
assert.ok(result.coverage.warnings.some(warning => warning.includes('sample window')));
const matchingWindow = buildSnapshot({ authoritative: { items: [], window: { hours: 168, since: '2026-09-30T12:00:00Z', until: '2026-10-07T12:00:00Z' } }, hours: 168, now });
assert.equal(matchingWindow.coverage.authoritativeWindow.hours, 168);
assert.equal(matchingWindow.coverage.warnings.some(warning => warning.includes('sample window')), false);
const olderWindow = buildSnapshot({ authoritative: { items: [], window: { hours: 24, since: '2026-10-04T12:00:00Z', until: '2026-10-05T12:00:00Z' } }, now });
assert.ok(olderWindow.coverage.warnings.some(warning => warning.includes('sample window')));
const serviceBounds = buildSnapshot({ authoritative: { items: [], coverage: { sampleTruncated: true, selection: 'recent_activity', trailLimit: 50, aggregateScope: 'sampled items' } }, now });
assert.equal(serviceBounds.coverage.sourceBounds.sampleTruncated, true);
assert.equal(serviceBounds.coverage.sourceBounds.itemsTruncated, true);
assert.equal(serviceBounds.coverage.sourceBounds.trailLimit, 50);
assert.equal(serviceBounds.coverage.sourceBounds.selection, 'recent_activity');
assert.equal(serviceBounds.coverage.sourceBounds.aggregateScope, 'sampled items');
assert.equal(serviceBounds.coverage.sampledItemCountsComplete, true);
assert.match(serviceBounds.coverage.countsMeaning, /not population completeness/);
assert.equal(result.coverage.sourceBounds.sampleTruncated, null);
const agedVote = buildSnapshot({ authoritative: { items: [{ ...item(1, 1, 0, [vote('a', 'up')]), createdAt: '2026-10-07T09:00:00Z' }] }, now });
assert.equal(agedVote.items[0].votes[0].ageHours, 2);

function event(stage, opportunityId, raw, overrides = {}) {
  return { id: `${stage}-${opportunityId}`, at, stage, opportunityId, profileId: 'PRIVATE_PROFILE', bot: 'a', mode: 'live', origin: 'user', cohort: 'local', items: [{ key: 'post:1', scoreAtExposure: null, ...raw }], ...overrides };
}
const events = [
  event('offered', 'nil', { scoreAtExposure: -3, scoreVisibleToModel: true, createdAt: '2026-10-07T10:00:00Z' }),
  event('decision', 'nil', { decisionKind: 'explicit', direction: 'nil' }, { at: '2026-10-07T11:00:02Z' }),
  event('offered', 'missing', {}), event('decision', 'missing', { decisionKind: 'missing', direction: 'nil' }),
  event('offered', 'up', {}), event('decision', 'up', { decisionKind: 'explicit', direction: 'up' }), event('outcome', 'up', { status: 'cast' }),
  event('offered', 'unavailable', {}),
  event('decision', 'unoffered', { decisionKind: 'explicit', direction: 'nil' }),
  event('outcome', 'legacy', { status: 'cast', direction: 'down', reason: 'Public legacy reason' }, { legacy: true }),
  event('offered', 'rehearsal', {}, { mode: 'rehearsal' }), event('decision', 'rehearsal', { decisionKind: 'explicit', direction: 'nil' }, { mode: 'rehearsal' }),
  event('offered', 'old', {}, { at: '2026-09-01T11:00:00Z' })
];
events.push(events[0]);
const observed = buildSnapshot({ authoritative, events, now });
assert.equal(observed.overview.local.offered, 4);
assert.equal(observed.overview.local.explicitConsidered, 2);
assert.equal(observed.overview.local.explicitNil, 1);
assert.equal(observed.overview.local.parserDefaultNil, 1);
assert.equal(observed.overview.local.decisionUnavailable, 1);
assert.equal(observed.overview.local.nilRate, 0.5);
assert.equal(observed.overview.local.confirmedCast, 1);
assert.equal(observed.overview.participation.live.offeredBots, 1);
assert.equal(observed.overview.participation.live.nonNilDecisionBots, 1);
assert.equal(observed.overview.participation.live.rate, 1);
assert.equal(observed.overview.participation.rehearsal.rate, 0);
assert.equal(observed.coverage.unlinkedDecisionItems, 1);
assert.equal(observed.coverage.unlinkedOutcomeItems, 1);
assert.equal(observed.overview.outcomeOnly.live.confirmedCast, 1);
assert.equal(observed.overview.outcomeOnly.live.castDown, 1);
assert.equal(observed.overview.outcomeOnly.rows[0].exposureAvailable, false);
assert.equal(observed.overview.outcomeOnly.rows[0].decisionKind, 'unknown');
assert.equal(observed.overview.rehearsal.nilRate, 1);
assert.equal(observed.exposure.recordedScores, 1);
assert.equal(observed.exposure.rows.find(row => row.scoreAtExposure === -3).ageHours, 1);
assert.equal(observed.exposure.rows.find(row => row.scoreAtExposure === -3).decisionDelaySeconds, 2);
assert.equal(observed.exposure.missingScores, 4);
assert.equal(observed.exposure.reception.live.negative.nilRate, 1);
assert.equal(observed.exposure.reception.live.negative.sufficientSample, false);
assert.equal(observed.exposure.reception.live.unknown.offered, 3);
assert.equal(observed.exposure.timing.live.early.offered, 1);
assert.equal(observed.exposure.rows[0].slatePosition, 1);
assert.equal(observed.exposure.rows[0].decisionAt, '2026-10-07T11:00:02.000Z');

const pairItems = Array.from({ length: 5 }, (_, index) => item(index + 1, 2, 0, [vote('a', 'up'), vote('b', 'up'), vote('a', 'up')]));
const pairs = buildSnapshot({ authoritative: { items: pairItems }, now }).agreement.currentLedger;
assert.equal(pairs.pairs[0].sharedItems, 5);
assert.equal(pairs.pairs[0].agreement, 1);
assert.equal(pairs.pairs[0].firstObservedAt, '2026-10-07T11:00:00.000Z');
assert.equal(pairs.pairs[0].lastObservedAt, '2026-10-07T11:00:00.000Z');
assert.equal(pairs.pairs[0].sufficientSample, true);
assert.equal(pairs.duplicatesExcluded, 5);
assert.equal(pairs.pairs[0].crossCommunity.communities, 2);
assert.equal(pairs.pairs[0].withinCommunity.every(row => row.sufficientSample === false), true);
assert.equal(buildSnapshot({ authoritative: { items: pairItems.slice(0, 4) }, now }).agreement.currentLedger.pairs[0].sufficientSample, false);
const conflicting = buildSnapshot({ authoritative: { items: [item(1, 2, 1, [vote('a', 'up'), vote('a', 'down'), vote('b', 'up')])] }, now });
assert.equal(conflicting.agreement.currentLedger.pairs.length, 0);

const privateInput = { items: [{ ...item(1, 1, 0, [{ ...vote('a', 'up'), reason: 'token=PRIVATE_TOKEN Bearer PRIVATE_BEARER user@example.com', prompt: 'RAW_PROMPT', ip: 'PRIVATE_IP' }]), title: '<script>alert(1)</script>', excerpt: 'x'.repeat(2000), privateField: 'PRIVATE_FIELD' }], coverage: { warnings: ['password=PRIVATE_PASSWORD'], token: 'PRIVATE_COVERAGE' } };
const safe = buildSnapshot({ authoritative: privateInput, events, profiles: [{ persona: 'PRIVATE_PERSONA' }], now });
assert.equal(safe.items[0].excerpt.length, 600);
assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|RAW_PROMPT|user@example\.com/);
assert.equal(safe.items[0].title, '<script>alert(1)</script>', 'public markup remains text; UI renders via textContent');
const human = buildSnapshot({ authoritative: { items: [item(1, 1, 0, [{ actorType: 'human', bot: 'PRIVATE_HUMAN', at, direction: 'up', reason: 'PRIVATE_REASON' }])] }, now });
assert.equal(human.items[0].total, 1, 'human votes remain in aggregate counts');
assert.equal(human.items[0].votes.length, 0, 'human identity, reason and timestamp are excluded from exported trails');
const bounded = buildSnapshot({ authoritative: { items: Array.from({ length: LIMITS.items + 2 }, (_, i) => item(i + 1, 0, 0)) }, now });
assert.equal(bounded.items.length, LIMITS.items);
assert.ok(bounded.coverage.warnings.some(warning => warning.includes('item limit')));
assert.equal(buildSnapshot({ hours: 3, now }).window.hours, 24);
assert.equal(buildSnapshot({ hours: 168, now }).window.since, '2026-09-30T12:00:00.000Z');
console.log('naturalness metrics: all assertions passed');
