'use strict';

// Diagnostic conventions, not a score or a target distribution.
const LIMITS = Object.freeze({ items: 300, votesPerItem: 300, events: 10000, eventItems: 8, pairs: 100, pairComparisons: 250000 });
const THRESHOLDS = Object.freeze({ observedVotes: 5, positiveShare: 0.8, negativeShare: 0.2, splitMin: 0.4, splitMax: 0.6, lowAbsoluteNet: 2, pairMinimum: 5 });
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => number(value) !== null && value >= 0 ? Math.floor(value) : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value, max = 160) => typeof value === 'string' ? value.replace(/Bearer\s+\S+/gi, '[redacted]').replace(/\b(?:sk-|sk_)[a-zA-Z0-9_-]{12,}/g, '[redacted]').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]').replace(/\b(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s&,;]+/gi, '$1=[redacted]').slice(0, max) : null;
const direction = value => ['up', 'down', 'nil'].includes(value) ? value : null;
const key = item => /^(post|comment):[1-9]\d*$/.test(item && item.key) ? item.key : null;
const rate = (n, d) => d ? n / d : null;
const entropy = (up, down) => {
  if (up === null || down === null || up + down === 0) return null;
  const p = up / (up + down);
  return p === 0 || p === 1 ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
};

function histogram(values, bins) {
  return { available: values.length, missing: 0, bins: bins.map(([label, min, max]) => ({ label, count: values.filter(value => value >= min && value < max).length })) };
}

function distributionsFor(items) {
  const output = {};
  for (const [name, field, bins] of [
    ['votesPerItem', 'total', [['0', 0, 1], ['1-4', 1, 5], ['5-9', 5, 10], ['10-24', 10, 25], ['25+', 25, Infinity]]],
    ['visibleScore', 'score', [['negative', -Infinity, 0], ['zero', 0, 1], ['one', 1, 2], ['2-4', 2, 5], ['5+', 5, Infinity]]],
    ['net', 'net', [['negative', -Infinity, 0], ['zero', 0, 1], ['1-4', 1, 5], ['5+', 5, Infinity]]],
    ['upShare', 'upShare', [['0-<0.2', 0, 0.2], ['0.2-<0.4', 0.2, 0.4], ['0.4-0.6', 0.4, 0.600000000001], ['>0.6-<0.8', 0.600000000001, 0.8], ['0.8-1', 0.8, 1.1]]]
  ]) {
    output[name] = histogram(items.map(item => item[field]).filter(value => value !== null), bins);
    output[name].missing = items.length - output[name].available;
  }
  return output;
}

function exposureSummary(rows) {
  const explicit = rows.filter(row => row.decisionKind === 'explicit' && direction(row.direction));
  const up = explicit.filter(row => row.direction === 'up').length;
  const down = explicit.filter(row => row.direction === 'down').length;
  const nil = explicit.filter(row => row.direction === 'nil').length;
  return { offered: rows.length, explicitConsidered: explicit.length, up, down, nil,
    nilRate: rate(nil, explicit.length), nonNilUpShare: rate(up, up + down), sufficientSample: explicit.length >= THRESHOLDS.pairMinimum };
}

function agreementFor(items) {
  const pairs = new Map();
  let comparisons = 0;
  let duplicatesExcluded = 0;
  let bounded = false;
  for (const item of items) {
    const unique = new Map();
    const timesByBot = new Map();
    const conflicting = new Set();
    for (const vote of item.votes) {
      if (!vote.bot || !['up', 'down'].includes(vote.direction)) continue;
      const at = date(vote.at);
      if (at) {
        const times = timesByBot.get(vote.bot) || { first: at, last: at };
        if (at < times.first) times.first = at;
        if (at > times.last) times.last = at;
        timesByBot.set(vote.bot, times);
      }
      if (unique.has(vote.bot)) {
        duplicatesExcluded++;
        if (unique.get(vote.bot) !== vote.direction) conflicting.add(vote.bot);
      } else unique.set(vote.bot, vote.direction);
    }
    const voters = [...unique].filter(([bot]) => !conflicting.has(bot)).sort(([a], [b]) => a.localeCompare(b));
    for (let a = 0; a < voters.length; a++) {
      for (let b = a + 1; b < voters.length; b++) {
        if (comparisons >= LIMITS.pairComparisons) { bounded = true; break; }
        comparisons++;
        const id = JSON.stringify([voters[a][0], voters[b][0]]);
        if (!pairs.has(id)) pairs.set(id, { bots: [voters[a][0], voters[b][0]], sharedItems: 0, sameDirection: 0, firstObservedAt: null, lastObservedAt: null, communities: new Map() });
        const pair = pairs.get(id);
        pair.sharedItems++;
        for (const bot of pair.bots) {
          const times = timesByBot.get(bot);
          if (!times) continue;
          if (!pair.firstObservedAt || times.first < pair.firstObservedAt) pair.firstObservedAt = times.first;
          if (!pair.lastObservedAt || times.last > pair.lastObservedAt) pair.lastObservedAt = times.last;
        }
        const same = voters[a][1] === voters[b][1] ? 1 : 0;
        pair.sameDirection += same;
        const community = item.community || 'unknown';
        if (!pair.communities.has(community)) pair.communities.set(community, { community, sharedItems: 0, sameDirection: 0 });
        pair.communities.get(community).sharedItems++;
        pair.communities.get(community).sameDirection += same;
      }
      if (bounded) break;
    }
    if (bounded) break;
  }
  const all = [...pairs.values()].sort((a, b) => b.sharedItems - a.sharedItems || JSON.stringify(a.bots).localeCompare(JSON.stringify(b.bots)));
  return {
    minimumSharedItems: THRESHOLDS.pairMinimum, totalPairs: all.length, comparisons, duplicatesExcluded,
    truncated: bounded || all.length > LIMITS.pairs,
    pairs: all.slice(0, LIMITS.pairs).map(pair => ({
      bots: pair.bots, sharedItems: pair.sharedItems, sameDirection: pair.sameDirection,
      firstObservedAt: pair.firstObservedAt, lastObservedAt: pair.lastObservedAt,
      agreement: rate(pair.sameDirection, pair.sharedItems), sufficientSample: pair.sharedItems >= THRESHOLDS.pairMinimum,
      withinCommunity: [...pair.communities.values()].map(row => ({ ...row, agreement: rate(row.sameDirection, row.sharedItems), sufficientSample: row.sharedItems >= THRESHOLDS.pairMinimum })),
      crossCommunity: { communities: pair.communities.size, sharedItems: pair.sharedItems, agreement: rate(pair.sameDirection, pair.sharedItems) }
    }))
  };
}

function buildSnapshot({ authoritative = null, events = [], hours = 24, now = Date.now() } = {}) {
  hours = [24, 168, 720].includes(Number(hours)) ? Number(hours) : 24;
  const until = new Date(now).toISOString();
  const since = new Date(Date.parse(until) - hours * 3600000).toISOString();
  const warnings = [
    'Authoritative votes are CURRENT surviving ledger rows, not immutable voting history. Flips replace rows and removals disappear; timestamps order surviving records only.',
    'This bounded recent sample cannot establish a Reddit-like distribution. Thresholds are descriptive conventions, not quality targets.',
    'Historical synthetic backfill provenance is unknown. Local origin and cohort labels cover recorded local opportunities only.',
    'Agreement is descriptive, not evidence of causality or independence. Pairs with fewer than 5 shared items are insufficient samples.',
    'Offered means submitted in a slate, not proof of attention. Public reasons are published content, not hidden reasoning or proof of motives.'
  ];
  const available = !!(authoritative && Array.isArray(authoritative.items));
  if (!available) warnings.push('Authoritative current-vote data is unavailable; missing counts are not zero.');
  const sourceWindow = authoritative && authoritative.window;
  const authoritativeWindow = sourceWindow ? { hours: count(sourceWindow.hours), since: date(sourceWindow.since), until: date(sourceWindow.until) } : null;
  if (available && (!authoritativeWindow || authoritativeWindow.hours !== hours || !authoritativeWindow.since || !authoritativeWindow.until ||
      Math.abs(Date.parse(authoritativeWindow.until) - Date.parse(until)) > 60000 || Math.abs(Date.parse(authoritativeWindow.since) - Date.parse(since)) > 60000)) warnings.push('The authoritative sample window is unknown or differs from the selected local observation window. Current ledger tallies are preserved; the sample must not be treated as matching the selected window.');
  const sourceCoverage = authoritative && authoritative.coverage || {};
  const sourceTruncated = typeof sourceCoverage.sampleTruncated === 'boolean' ? sourceCoverage.sampleTruncated : typeof sourceCoverage.itemsTruncated === 'boolean' ? sourceCoverage.itemsTruncated : null;
  if (sourceTruncated) warnings.push('The authoritative service truncated its sample. Full counts for sampled items do not establish full-population coverage.');
  const rawItems = available ? authoritative.items : [];
  const seen = new Set();
  const items = [];
  for (const raw of rawItems.slice(0, LIMITS.items)) {
    const id = key(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const up = count(raw.up), down = count(raw.down), total = count(raw.total);
    const net = up === null || down === null ? null : up - down;
    const share = up === null || down === null ? null : rate(up, up + down);
    const votes = (Array.isArray(raw.votes) ? raw.votes : []).slice(0, LIMITS.votesPerItem).filter(v => v && v.actorType === 'bot' && ['up', 'down'].includes(v.direction)).map(v => ({
      bot: v.actorType === 'bot' ? text(v.bot, 80) : null, actorType: v.actorType === 'bot' ? 'bot' : v.actorType === 'human' ? 'human' : 'unknown',
      direction: v.direction, reason: text(v.reason, 500), at: date(v.at),
      ageHours: date(raw.createdAt) && date(v.at) && date(v.at) >= date(raw.createdAt) ? (Date.parse(v.at) - Date.parse(raw.createdAt)) / 3600000 : null
    })).sort((a, b) => (a.at || '9999').localeCompare(b.at || '9999') || (a.bot || '').localeCompare(b.bot || ''));
    const observed = total !== null && total >= THRESHOLDS.observedVotes;
    items.push({
      key: id, targetType: id.split(':')[0], targetId: Number(id.split(':')[1]), postId: count(raw.postId),
      community: text(raw.community, 80), author: text(raw.author, 80), createdAt: date(raw.createdAt), title: text(raw.title, 240), excerpt: text(raw.excerpt, 600),
      score: number(raw.score), up, down, total, uniqueVotingBots: count(raw.uniqueVotingBots), net, upShare: share, entropy: entropy(up, down),
      sufficientlyObserved: observed, stronglyPositive: observed && share !== null && share >= THRESHOLDS.positiveShare,
      stronglyNegative: observed && share !== null && share <= THRESHOLDS.negativeShare,
      approximatelySplit: observed && share !== null && share >= THRESHOLDS.splitMin && share <= THRESHOLDS.splitMax,
      highVotesLowNet: observed && net !== null && Math.abs(net) <= THRESHOLDS.lowAbsoluteNet,
      trailTruncated: raw.trailTruncated === true || (Array.isArray(raw.votes) && raw.votes.length > LIMITS.votesPerItem) || (total !== null && total > votes.length), votes
    });
  }
  if (items.some(item => item.trailTruncated)) warnings.push('Some vote trails are truncated. Distributions use full provided ledger counts; agreement and chronology use only returned trails.');
  if (rawItems.length > LIMITS.items) warnings.push('The local item limit truncated the authoritative sample.');
  const sourceWarnings = authoritative && authoritative.coverage && authoritative.coverage.warnings;
  if (Array.isArray(sourceWarnings)) warnings.push(...sourceWarnings.slice(0, 12).map(value => text(value, 400)).filter(Boolean));

  const inputEvents = Array.isArray(events) ? events : [];
  const journal = inputEvents.slice(-LIMITS.events).filter(event => event && date(event.at) && date(event.at) >= since && date(event.at) <= until).sort((a, b) => date(a.at).localeCompare(date(b.at)));
  const offered = new Map(), decisions = new Map(), outcomes = new Map();
  const eventSeen = new Set();
  for (const event of journal) {
    if (!['offered', 'decision', 'outcome'].includes(event.stage) || !event.opportunityId) continue;
    const eventId = event.id || JSON.stringify([event.opportunityId, event.stage, event.at]);
    if (eventSeen.has(eventId)) continue;
    eventSeen.add(eventId);
    for (const raw of (Array.isArray(event.items) ? event.items : []).slice(0, LIMITS.eventItems)) {
      const id = key(raw);
      if (!id) continue;
      const composite = JSON.stringify([event.mode || 'unknown', event.profileId || event.bot || 'unknown', event.opportunityId, id]);
      const target = event.stage === 'offered' ? offered : event.stage === 'decision' ? decisions : outcomes;
      if (!target.has(composite)) target.set(composite, { event, raw, key: id });
    }
  }
  const local = { offered: 0, explicitConsidered: 0, explicitNil: 0, explicitUp: 0, explicitDown: 0, parserDefaultNil: 0, invalid: 0, unknown: 0, decisionUnavailable: 0, confirmedCast: 0, nilRate: null };
  const rehearsal = { ...local };
  const participationSets = Object.fromEntries(['live', 'rehearsal'].map(mode => [mode, { offered: new Set(), nonNil: new Set(), unknownBotOffers: 0 }]));
  const exposureRows = [], origins = new Map(), localItems = new Map();
  let unknownMode = 0;
  for (const [id, offer] of offered) {
    const { event, raw } = offer;
    const stats = event.mode === 'live' ? local : event.mode === 'rehearsal' ? rehearsal : null;
    if (!stats) { unknownMode++; continue; }
    stats.offered++;
    const decision = decisions.get(id), outcome = outcomes.get(id);
    const kind = decision ? decision.raw.decisionKind : null;
    const dir = decision ? direction(decision.raw.direction) : null;
    const publicBot = text(event.bot, 80);
    if (publicBot) participationSets[event.mode].offered.add(publicBot);
    else participationSets[event.mode].unknownBotOffers++;
    if (kind === 'explicit' && dir) {
      stats.explicitConsidered++;
      stats[dir === 'nil' ? 'explicitNil' : dir === 'up' ? 'explicitUp' : 'explicitDown']++;
      if (publicBot && dir !== 'nil') participationSets[event.mode].nonNil.add(publicBot);
      if (event.mode === 'live' && dir !== 'nil') {
        if (!localItems.has(offer.key)) localItems.set(offer.key, { community: text(raw.community, 80), votes: [] });
        localItems.get(offer.key).votes.push({ bot: publicBot, direction: dir, at: date(decision.event.at) });
      }
    } else if (!decision) stats.decisionUnavailable++;
    else if (kind === 'missing') stats.parserDefaultNil++;
    else if (kind === 'invalid') stats.invalid++;
    else stats.unknown++;
    if (outcome && outcome.raw.status === 'cast') stats.confirmedCast++;
    const origin = text(event.origin, 80) || 'unknown', cohort = text(event.cohort, 80) || 'unknown';
    const groupKey = JSON.stringify([event.mode, origin, cohort]);
    if (!origins.has(groupKey)) origins.set(groupKey, { mode: event.mode, origin, cohort, offered: 0 });
    origins.get(groupKey).offered++;
    const created = date(raw.createdAt), at = date(event.at);
    exposureRows.push({ key: offer.key, bot: text(event.bot, 80), mode: event.mode, at, community: text(raw.community, 80), source: text(raw.source, 80),
      scoreAtExposure: number(raw.scoreAtExposure), scoreVisibleToModel: typeof raw.scoreVisibleToModel === 'boolean' ? raw.scoreVisibleToModel : null,
      hasSocialContext: typeof raw.hasSocialContext === 'boolean' ? raw.hasSocialContext : null, hasMemoryContext: typeof raw.hasMemoryContext === 'boolean' ? raw.hasMemoryContext : null,
      ageHours: created && created <= at ? (Date.parse(at) - Date.parse(created)) / 3600000 : null,
      decisionKind: ['explicit', 'missing', 'invalid', 'unknown'].includes(kind) ? kind : 'unavailable', direction: kind === 'explicit' ? dir : null,
      decisionAt: decision ? date(decision.event.at) : null, outcomeAt: outcome ? date(outcome.event.at) : null,
      outcomeStatus: outcome ? text(outcome.raw.status, 80) : null, publicReason: kind === 'explicit' && dir && dir !== 'nil' ? text(decision.raw.reason, 500) : null,
      slatePosition: event.items.indexOf(raw) + 1, slateSize: Math.min(event.items.length, LIMITS.eventItems),
      decisionDelaySeconds: decision && date(decision.event.at) >= at ? (Date.parse(decision.event.at) - Date.parse(at)) / 1000 : null
    });
  }
  local.nilRate = rate(local.explicitNil, local.explicitConsidered);
  rehearsal.nilRate = rate(rehearsal.explicitNil, rehearsal.explicitConsidered);
  const participation = { denominator: 'Unique public bot names in recorded offered slates; numerator is those with at least one explicit non-nil decision. Unknown names are excluded. Outcome-only records cannot establish participation.' };
  for (const mode of ['live', 'rehearsal']) {
    const sets = participationSets[mode];
    participation[mode] = { offeredBots: sets.offered.size, nonNilDecisionBots: sets.nonNil.size, rate: rate(sets.nonNil.size, sets.offered.size), unknownBotOffers: sets.unknownBotOffers };
  }
  const knownExposure = exposureRows.filter(row => row.scoreAtExposure !== null);
  const unlinkedDecisionItems = [...decisions.keys()].filter(id => !offered.has(id)).length;
  const unlinkedOutcomeItems = [...outcomes.keys()].filter(id => !offered.has(id)).length;
  if (unlinkedDecisionItems || unlinkedOutcomeItems) warnings.push('Some local decisions or outcomes have no recorded offered slate. They cannot establish exposure, explicit considered counts or nil rates.');
  const outcomeOnlyRows = [...outcomes].filter(([id]) => !offered.has(id)).map(([, row]) => ({
    key: row.key, at: date(row.event.at), bot: text(row.event.bot, 80), mode: ['live', 'rehearsal'].includes(row.event.mode) ? row.event.mode : 'unknown',
    status: text(row.raw.status, 80), direction: direction(row.raw.direction),
    publicReason: row.raw.status === 'cast' && ['up', 'down'].includes(row.raw.direction) ? text(row.raw.reason, 500) : null,
    source: row.event.legacy === true ? 'legacy-activity' : 'unlinked-outcome', exposureAvailable: false, scoreAtExposure: null, decisionKind: 'unknown'
  })).sort((a, b) => a.at.localeCompare(b.at));
  const outcomeOnly = { recordedOutcomes: outcomeOnlyRows.length, rowsTruncated: outcomeOnlyRows.length > 500, rows: outcomeOnlyRows.slice(-500),
    warning: 'Outcome-only records may confirm publication when status is cast, but cannot establish offered exposure, explicit considered decisions or nil rates. These are local observations, not the authoritative current ledger.' };
  for (const mode of ['live', 'rehearsal', 'unknown']) {
    const rows = outcomeOnlyRows.filter(row => row.mode === mode);
    outcomeOnly[mode] = { recordedOutcomes: rows.length, confirmedCast: rows.filter(row => row.status === 'cast').length,
      castUp: rows.filter(row => row.status === 'cast' && row.direction === 'up').length,
      castDown: rows.filter(row => row.status === 'cast' && row.direction === 'down').length };
  }
  if (knownExposure.length !== exposureRows.length || !exposureRows.length) warnings.push('Exposure scores are missing for some or all local opportunities. Present scores are never substituted for recorded exposure scores.');
  if (!journal.length) warnings.push('Local observation coverage is unavailable in this window; local zero observations do not imply zero activity.');
  if (inputEvents.length > LIMITS.events) warnings.push('The local event limit truncated journal coverage.');
  const distributions = distributionsFor(items);
  const classifiable = items.filter(item => item.sufficientlyObserved && item.upShare !== null && item.net !== null);
  const classifications = { sufficientlyObservedItems: items.filter(item => item.sufficientlyObserved).length, denominator: classifiable.length,
    meaning: 'Proportions use sampled items with at least 5 external votes and available up/down counts. Categories do not exhaust all items; highVotesLowNet overlaps other categories.' };
  for (const name of ['stronglyPositive', 'stronglyNegative', 'approximatelySplit', 'highVotesLowNet']) {
    const matches = classifiable.filter(item => item[name]).length;
    classifications[name] = { count: matches, proportion: rate(matches, classifiable.length) };
  }
  const communities = [...new Set(items.map(item => item.community || 'unknown'))].sort();
  const byCommunity = communities.slice(0, 100).map(community => {
    const rows = items.filter(item => (item.community || 'unknown') === community);
    return { community, items: rows.length, distributions: distributionsFor(rows) };
  });
  const byContentType = ['post', 'comment'].map(targetType => {
    const rows = items.filter(item => item.targetType === targetType);
    return { targetType, items: rows.length, distributions: distributionsFor(rows) };
  });
  const reception = {}, timing = {};
  for (const mode of ['live', 'rehearsal']) {
    const rows = exposureRows.filter(row => row.mode === mode);
    reception[mode] = {
      negative: exposureSummary(rows.filter(row => row.scoreAtExposure !== null && row.scoreAtExposure < 0)),
      neutral: exposureSummary(rows.filter(row => row.scoreAtExposure === 0)),
      positive: exposureSummary(rows.filter(row => row.scoreAtExposure !== null && row.scoreAtExposure > 0)),
      unknown: exposureSummary(rows.filter(row => row.scoreAtExposure === null))
    };
    timing[mode] = {
      early: exposureSummary(rows.filter(row => row.ageHours !== null && row.ageHours <= 1)),
      later: exposureSummary(rows.filter(row => row.ageHours !== null && row.ageHours > 1)),
      unknown: exposureSummary(rows.filter(row => row.ageHours === null))
    };
  }
  const ledgerAgreement = agreementFor(items);
  const localAgreement = agreementFor([...localItems.values()]);
  const completeCounts = available && items.every(item => item.total !== null && item.up !== null && item.down !== null);
  return {
    schemaVersion: 1, generatedAt: until, window: { hours, since, until },
    coverage: { authoritativeAvailable: available, authoritativeGeneratedAt: date(authoritative && authoritative.generatedAt), authoritativeWindow, itemCount: items.length,
      countsComplete: completeCounts, trailTruncatedItems: items.filter(item => item.trailTruncated).length,
      sampledItemCountsComplete: completeCounts, countsMeaning: 'Full tallies for sampled items only; not population completeness.',
      localAvailable: journal.length > 0, localEvents: eventSeen.size, unknownModeOpportunities: unknownMode, limits: { ...LIMITS },
      unlinkedDecisionItems, unlinkedOutcomeItems,
      sourceBounds: { itemLimit: count(sourceCoverage.itemLimit), itemsTruncated: sourceTruncated, sampleTruncated: sourceTruncated,
        selection: text(sourceCoverage.selection, 200), trailLimit: count(sourceCoverage.trailLimit), aggregateScope: text(sourceCoverage.aggregateScope, 240) },
      warnings },
    overview: { participation, classifications, authoritativeCurrent: { items: available ? items.length : null, up: completeCounts ? items.reduce((sum, item) => sum + item.up, 0) : null,
      down: completeCounts ? items.reduce((sum, item) => sum + item.down, 0) : null, total: completeCounts ? items.reduce((sum, item) => sum + item.total, 0) : null },
      thresholds: { ...THRESHOLDS }, distributions, byCommunity, communityGroupsTruncated: communities.length > 100, byContentType, local, rehearsal, outcomeOnly, originCohort: [...origins.values()].slice(0, 100), originCohortTruncated: origins.size > 100 },
    items,
    agreement: { currentLedger: ledgerAgreement, localExplicitDecisions: localAgreement, warning: 'Unique non-nil voter/item pairs only; conflicting duplicates excluded. First/last bounds use known surviving-vote or explicit local-decision times, not immutable history. Local repeated decisions do not add independent samples. Community breakdowns and pooled cross-community values do not control confounding.' },
    exposure: { offered: exposureRows.length, recordedScores: knownExposure.length, missingScores: exposureRows.length - knownExposure.length,
      visibleScores: knownExposure.filter(row => row.scoreVisibleToModel === true).length, rowsTruncated: exposureRows.length > 500,
      reception, timing, timingConventions: { earlyMaximumAgeHours: 1, minimumExplicitDecisions: 5 },
      rows: exposureRows.slice(-500), warning: 'Recorded local exposure only. Rows are ordered by offer time; age and delay are descriptive. Early means at most one hour old, a display convention. Score visibility, social context and memory are recorded flags, not causal evidence. Reception summaries use recorded scores even where the model did not see them; missing scores remain separate.' }
  };
}

module.exports = { buildSnapshot, LIMITS, THRESHOLDS };
