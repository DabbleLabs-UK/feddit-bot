'use strict';

// Bounded public observations only. These conventions are not a naturalness score.
const LIMITS = Object.freeze({ items: 1000, events: 10000, eventItems: 8, bots: 100, pairs: 100, groups: 20, anomalies: 20, examples: 30, text: 4000, phrases: 10, phraseWords: 200 });
const THRESHOLDS = Object.freeze({ minimumSample: 10, minimumRepeated: 3, repeatedShare: 0.5, missingDecisionShare: 0.5, phraseAuthors: 3, phraseWords: 5, lengthCv: 0.1, recentParentHours: 24, quietHours: 2, syncBinMinutes: 5, syncBots: 3 });
const clean = (value, max = 80) => typeof value === 'string' ? value.slice(0, LIMITS.text)
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/Bearer\s+\S+/gi, '[redacted]')
  .replace(/\b(?:sk-|sk_)[a-zA-Z0-9_-]{12,}/g, '[redacted]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
  .replace(/\b(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s&,;]+/gi, '$1=[redacted]').trim().slice(0, max) || null : null;
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const id = value => count(value) > 0 ? value : null;
const key = value => typeof value === 'string' && /^(post|comment):[1-9]\d{0,15}$/.test(value) && id(Number(value.split(':')[1])) ? value : null;
const time = value => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= 8640000000000000 ? n : null;
};
const iso = value => value === null ? null : new Date(value).toISOString();
const ratio = (n, d) => d > 0 ? n / d : null;
const share = (numerator, denominator) => ({ numerator, denominator, ratio: ratio(numerator, denominator) });
const sum = values => values.reduce((total, value) => total + value, 0);
function stats(values) {
  const mean = values.length ? sum(values) / values.length : null;
  return { count: values.length, mean, min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    cv: values.length >= 2 && mean > 0 ? Math.sqrt(sum(values.map(value => (value - mean) ** 2)) / values.length) / mean : null };
}
function groups(values, field = 'value', limit = LIMITS.groups) {
  const counts = new Map();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) || 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { denominator: values.filter(value => value !== null).length, missing: values.filter(value => value === null).length,
    totalGroups: rows.length, truncated: rows.length > limit, rows: rows.slice(0, limit).map(([value, count]) => ({ [field]: value, count })) };
}
const STOP = new Set('about after again also been being could from have into just more most much only other over really same some than that their them then there these they this those through very what when where which while will with would your'.split(' '));
function words(value) { return (value || '').toLowerCase().match(/[a-z]{3,30}/g) || []; }
function tokens(value) { return [...new Set(words(value).filter(word => word.length >= 4 && !STOP.has(word) && word !== 'redacted'))].slice(0, 100); }
function lexical(rows) {
  const eligible = rows.filter(row => words(row.text).length >= 4);
  const openings = groups(eligible.map(row => words(row.text).slice(0, 4).join(' ')), 'opening');
  const topics = groups(rows.flatMap(row => row.tokens), 'term');
  topics.denominator = rows.filter(row => row.tokens.length).length;
  topics.missing = rows.length - topics.denominator;
  topics.meaning = 'Public records containing each lexical term; terms overlap and are not semantic topics.';
  return { openings: { ...openings, meaning: 'Exact first four alphabetic words among records with at least four words.' }, topics };
}
function example(row) {
  return { key: row.key, type: row.type, id: row.id, postId: row.postId, author: row.author, community: row.community,
    createdAt: iso(row.at), path: row.postId && row.community ? '/f/' + encodeURIComponent(row.community.toWellFormed()) + '/comments/' + row.postId : null,
    title: clean(row.title, 160), excerpt: clean(row.text, 240) };
}
function repeatedPhrases(rows) {
  const phrases = new Map();
  let eligible = 0;
  for (const row of rows) {
    const words = ((row.text || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []).slice(0, LIMITS.phraseWords);
    if (words.length < THRESHOLDS.phraseWords) continue;
    eligible++;
    const unique = new Set();
    for (let index = 0; index <= words.length - THRESHOLDS.phraseWords; index++) {
      const parts = words.slice(index, index + THRESHOLDS.phraseWords);
      if (!parts.includes('redacted')) unique.add(parts.join(' '));
    }
    for (const phrase of unique) {
      if (!phrases.has(phrase)) phrases.set(phrase, []);
      phrases.get(phrase).push(row);
    }
  }
  const matches = [...phrases].map(([phrase, records]) => ({ phrase, records, authors: new Set(records.map(row => row.author).filter(Boolean)) }))
    .filter(row => row.records.length >= THRESHOLDS.minimumRepeated && row.authors.size >= THRESHOLDS.phraseAuthors)
    .sort((a, b) => b.records.length - a.records.length || a.phrase.localeCompare(b.phrase));
  return { denominator: eligible, totalPatterns: matches.length, truncated: matches.length > LIMITS.phrases,
    minimumRecords: THRESHOLDS.minimumRepeated, minimumAuthors: THRESHOLDS.phraseAuthors, wordsPerPhrase: THRESHOLDS.phraseWords,
    maximumWordsPerRecord: LIMITS.phraseWords, meaning: 'Exact five-word spans across comments, anywhere in the bounded text; not copying, coordination or semantic diagnosis.',
    rows: matches.slice(0, LIMITS.phrases).map(row => {
      const authors = new Set(), examples = [];
      for (const record of row.records) {
        if (!record.author || authors.has(record.author)) continue;
        authors.add(record.author); examples.push(example(record));
        if (examples.length === 3) break;
      }
      return { phrase: row.phrase, count: row.records.length, authors: row.authors.size, examples };
    }) };
}
function lengths(rows) { return stats(rows.map(row => row.length).filter(value => value !== null)); }
function interarrival(rows) { return stats(rows.slice(1).map((row, index) => (row.at - rows[index].at) / 1000)); }
function emptyVotes() {
  return { opportunities: 0, offered: 0, explicitConsidered: 0, explicitNil: 0, explicitUp: 0, explicitDown: 0,
    parserDefaultNil: 0, invalid: 0, unknown: 0, decisionUnavailable: 0, confirmedCast: 0, unlinkedOutcomes: 0, unlinkedConfirmedCast: 0 };
}
function votesFor(events, since, until) {
  const modes = { live: emptyVotes(), rehearsal: emptyVotes(), legacy: emptyVotes(), unknown: emptyVotes() };
  const offers = new Map(), decisions = new Map(), outcomes = new Map(), opportunities = new Map(), bots = new Map();
  const problemTargets = new Map(), problemBots = new Set();
  const input = Array.isArray(events) ? events : [];
  let acceptedEvents = 0;
  for (const event of input.slice(-LIMITS.events)) {
    const at = time(event && event.at);
    if (!event || at === null || at < since || at > until || !['offered', 'decision', 'outcome'].includes(event.stage)) continue;
    if (typeof event.opportunityId !== 'string' || !event.opportunityId || event.opportunityId.length > 200) continue;
    const mode = event.legacy === true ? 'legacy' : ['live', 'rehearsal'].includes(event.mode) ? event.mode : 'unknown';
    const identity = typeof event.profileId === 'string' ? event.profileId.slice(0, 200) : clean(event.bot);
    const opportunity = JSON.stringify([mode, identity, event.opportunityId]);
    const bot = clean(event.bot);
    acceptedEvents++;
    for (const raw of (Array.isArray(event.items) ? event.items : []).slice(0, LIMITS.eventItems)) {
      if (!raw || !key(raw.key)) continue;
      const composite = JSON.stringify([opportunity, raw.key]);
      const target = event.stage === 'offered' ? offers : event.stage === 'decision' ? decisions : outcomes;
      // Match Phase 1: one recorded offer/decision/outcome per opportunity and item.
      if (!target.has(composite)) target.set(composite, { raw, mode, bot, opportunity, at });
    }
  }
  function botStats(bot, mode) {
    if (!bot) return null;
    if (!bots.has(bot)) bots.set(bot, { live: emptyVotes(), rehearsal: emptyVotes(), legacy: emptyVotes(), unknown: emptyVotes() });
    return bots.get(bot)[mode];
  }
  for (const [composite, offer] of offers) {
    const counters = [modes[offer.mode], botStats(offer.bot, offer.mode)].filter(Boolean);
    const decision = decisions.get(composite), outcome = outcomes.get(composite);
    const explicit = decision && decision.raw.decisionKind === 'explicit' && ['up', 'down', 'nil'].includes(decision.raw.direction);
    if (offer.mode === 'live' && !explicit) {
      if (offer.bot) problemBots.add(offer.bot);
      if (problemTargets.size < 3 && !problemTargets.has(offer.raw.key)) problemTargets.set(offer.raw.key, {
        key: offer.raw.key, postId: id(offer.raw.postId), community: clean(offer.raw.community)
      });
    }
    if (!opportunities.has(offer.opportunity)) {
      opportunities.set(offer.opportunity, true);
      counters.forEach(row => row.opportunities++);
    }
    for (const row of counters) {
      row.offered++;
      if (explicit) { row.explicitConsidered++; row[decision.raw.direction === 'nil' ? 'explicitNil' : decision.raw.direction === 'up' ? 'explicitUp' : 'explicitDown']++; }
      else if (!decision) row.decisionUnavailable++;
      else if (decision.raw.decisionKind === 'missing') row.parserDefaultNil++;
      else if (decision.raw.decisionKind === 'invalid') row.invalid++;
      else row.unknown++;
      if (outcome && outcome.raw.status === 'cast') row.confirmedCast++;
    }
  }
  for (const [composite, outcome] of outcomes) {
    if (offers.has(composite)) continue;
    for (const row of [modes[outcome.mode], botStats(outcome.bot, outcome.mode)].filter(Boolean)) {
      row.unlinkedOutcomes++;
      if (outcome.raw.status === 'cast') row.unlinkedConfirmedCast++;
    }
  }
  const finish = row => ({ ...row, nilShare: share(row.explicitNil, row.explicitConsidered), nonNilUpShare: share(row.explicitUp, row.explicitUp + row.explicitDown) });
  return { summary: { ...Object.fromEntries(Object.entries(modes).map(([mode, row]) => [mode, finish(row)])), acceptedEvents,
    truncated: input.length > LIMITS.events, denominators: 'Opportunities are unique recorded offered slates; offered counts item/slate pairs. Nil uses explicit decisions only; up share excludes nil. Unlinked outcomes have no exposure denominator. Legacy and rehearsal are separate. Zero observations do not establish zero activity.' },
    bots: new Map([...bots].map(([bot, modes]) => [bot, Object.fromEntries(Object.entries(modes).map(([mode, row]) => [mode, finish(row)]))])),
    problemTargets: [...problemTargets.values()], problemBots: problemBots.size };
}

function buildEcology({ items = [], events = [], votingSnapshot = null, profiles = [], communities: communityInput = [], coverage = {}, since, until, now = Date.now() } = {}) {
  // Profiles and caller snapshots are deliberately not copied: neither is a public-record schema.
  const end = time(until) ?? time(now) ?? Date.now();
  const start = time(since) !== null && time(since) < end ? time(since) : end - 86400000;
  const hours = (end - start) / 3600000;
  const rawItems = Array.isArray(items) ? items : [];
  const seen = new Set(), normalized = [];
  let invalidItems = 0, duplicateItems = 0;
  for (const raw of rawItems.slice(0, LIMITS.items)) {
    const target = key(raw && raw.key);
    if (!target || !id(raw.id) || !['post', 'comment'].includes(raw.type) || target !== raw.type + ':' + raw.id) { invalidItems++; continue; }
    if (seen.has(target)) { duplicateItems++; continue; }
    seen.add(target);
    const body = clean(raw.text, LIMITS.text);
    const title = clean(raw.title, 240);
    normalized.push({ key: target, type: raw.type, id: raw.id, postId: raw.type === 'post' ? raw.id : id(raw.postId),
      parentKey: raw.type === 'comment' ? key(raw.parentKey) : null, author: clean(raw.author), community: clean(raw.community),
      at: time(raw.createdAt), title, text: body, tokens: tokens((title || '') + ' ' + (body || '')),
      length: count(raw.textLength) ?? (typeof raw.text === 'string' ? raw.text.length : null), kind: ['text', 'link'].includes(raw.kind) ? raw.kind : null });
  }
  const historical = normalized.filter(row => row.at !== null && row.at < start);
  const rows = normalized.filter(row => row.at !== null && row.at >= start && row.at <= end).sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const lookup = new Map(normalized.filter(row => row.at === null || row.at <= end).map(row => [row.key, row]));
  const posts = rows.filter(row => row.type === 'post'), comments = rows.filter(row => row.type === 'comment');
  const authorGroups = groups(rows.map(row => row.author), 'bot', LIMITS.bots);
  const language = lexical(rows);
  language.repeatedPhrases = repeatedPhrases(comments);
  const votes = votesFor(events, start, end);
  const anomalies = [];
  function anomaly(code, label, sample, value, examples) {
    if (sample < THRESHOLDS.minimumSample || anomalies.length >= LIMITS.anomalies) return;
    anomalies.push({ code, label, minimumSample: THRESHOLDS.minimumSample, sampleSize: sample, value, examples: examples.slice(0, 3).map(example) });
  }
  const live = votes.summary.live;
  const missingDecisions = live.parserDefaultNil + live.invalid + live.unknown + live.decisionUnavailable;
  if (ratio(missingDecisions, live.offered) >= THRESHOLDS.missingDecisionShare && votes.problemTargets.length) {
    const examples = votes.problemTargets.map(target => lookup.get(target.key) || {
      ...target, type: target.key.split(':')[0], id: Number(target.key.split(':')[1]),
      postId: target.key.startsWith('post:') ? Number(target.key.split(':')[1]) : target.postId,
      author: null, at: null, title: null, text: null
    });
    anomaly('missing-vote-decisions', 'Missing or invalid recorded live decisions', live.offered, ratio(missingDecisions, live.offered), examples);
    if (anomalies.length) anomalies[anomalies.length - 1].affectedBots = votes.problemBots;
  }
  const lengthsByType = { posts: lengths(posts), comments: lengths(comments) };
  for (const [type, data] of [['posts', posts], ['comments', comments]]) {
    const measured = lengthsByType[type];
    if (measured.cv !== null && measured.cv <= THRESHOLDS.lengthCv) anomaly('similar-' + type + '-lengths', 'Low variation in observed ' + type + ' lengths', measured.count, measured.cv, data.filter(row => row.length !== null));
  }
  const topOpening = language.openings.rows[0];
  if (topOpening && topOpening.count >= THRESHOLDS.minimumRepeated && ratio(topOpening.count, language.openings.denominator) >= THRESHOLDS.repeatedShare) {
    anomaly('repeated-opening', 'Repeated four-word opening', language.openings.denominator, ratio(topOpening.count, language.openings.denominator), rows.filter(row => words(row.text).slice(0, 4).join(' ') === topOpening.opening));
  }
  const children = new Map(), pairs = new Map(), resolved = [], validEdges = [], depths = [], latencies = [], overlaps = [];
  let missingParents = 0, invalidEdges = 0, incompleteAncestry = 0;
  for (const comment of comments) {
    const parent = lookup.get(comment.parentKey);
    if (!parent) { missingParents++; continue; }
    if (parent.key === comment.key || (parent.postId !== null && comment.postId !== null && parent.postId !== comment.postId) || (parent.at !== null && parent.at > comment.at)) { invalidEdges++; continue; }
    resolved.push(comment);
    let ancestor = comment, depth = 0, complete = true;
    const ancestors = new Set([comment.key]);
    while (ancestor.type === 'comment') {
      const next = lookup.get(ancestor.parentKey);
      if (!next || ancestors.has(next.key) || (next.at !== null && ancestor.at !== null && next.at > ancestor.at) ||
          (next.postId !== null && comment.postId !== null && next.postId !== comment.postId)) { complete = false; break; }
      ancestors.add(next.key); depth++; ancestor = next;
    }
    if (complete) depths.push(depth); else incompleteAncestry++;
    // Unresolved ancestry is not allowed to manufacture graph depth or interactions.
    if (!complete) continue;
    validEdges.push({ comment, parent });
    children.set(parent.key, (children.get(parent.key) || 0) + 1);
    if (parent.at !== null) latencies.push((comment.at - parent.at) / 1000);
    if (comment.tokens.length && parent.tokens.length) {
      const common = comment.tokens.filter(token => parent.tokens.includes(token)).length;
      overlaps.push(common / new Set([...comment.tokens, ...parent.tokens]).size);
    }
    if (comment.author && parent.author) {
      const pairKey = JSON.stringify([comment.author, parent.author]);
      if (!pairs.has(pairKey)) pairs.set(pairKey, { from: comment.author, to: parent.author, replies: 0, examples: [] });
      const pair = pairs.get(pairKey); pair.replies++;
      if (pair.examples.length < 3) pair.examples.push(example(comment));
    }
  }
  const pairRows = [...pairs.values()].sort((a, b) => b.replies - a.replies || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const nonSelfPairs = pairRows.filter(pair => pair.from !== pair.to);
  const reciprocal = nonSelfPairs.filter(pair => pairs.has(JSON.stringify([pair.to, pair.from]))).length;
  const threadRecords = new Map();
  for (const row of rows) {
    if (!row.postId) continue;
    if (!threadRecords.has(row.postId)) threadRecords.set(row.postId, []);
    threadRecords.get(row.postId).push(row);
  }
  const threadExchanges = [];
  let unknownAuthorThreads = 0;
  for (const [postId, records] of threadRecords) {
    if (records.some(row => !row.author)) { unknownAuthorThreads++; continue; }
    const authors = [...new Set(records.map(row => row.author))].sort();
    if (authors.length !== 2) continue;
    const edges = validEdges.filter(({ comment, parent }) => comment.postId === postId && parent.at !== null && parent.at >= start &&
      comment.author !== parent.author && authors.includes(comment.author) && authors.includes(parent.author));
    const forwardReplies = edges.filter(({ comment }) => comment.author === authors[0]).length;
    const reverseReplies = edges.length - forwardReplies;
    if (edges.length < 3 || !forwardReplies || !reverseReplies) continue;
    threadExchanges.push({ postId, authors, replies: edges.length, forwardReplies, reverseReplies, examples: edges.slice(0, 3).map(({ comment }) => example(comment)) });
  }
  threadExchanges.sort((a, b) => b.replies - a.replies || a.postId - b.postId);
  const branchCandidates = [...lookup.values()].filter(row => row.at !== null && row.at <= end);
  const validKeys = new Set(validEdges.map(edge => edge.comment.key));
  const oneAndDone = comments.filter(row => validKeys.has(row.key) && !children.has(row.key));
  const agreementEligible = comments.filter(row => !!row.text);
  const agreementMatches = agreementEligible.filter(row => /^(?:i agree\b|agreed\b|exactly\b|absolutely\b|you(?:'re| are) right\b|well said\b)/i.test(row.text));
  language.agreementProxy = { ...share(agreementMatches.length, agreementEligible.length), label: 'Agreement-like opening phrase, not semantic agreement or motive', examples: agreementMatches.slice(0, 3).map(example) };
  language.contextOverlapProxy = { ...stats(overlaps), label: 'Jaccard overlap of bounded public lexical terms for valid parent/reply pairs; not comprehension or relevance', excludedPairs: comments.length - overlaps.length };
  const histogram = Array.from({ length: 24 }, (_, hour) => ({ hour, count: rows.filter(row => new Date(row.at).getUTCHours() === hour).length }));
  const gaps = rows.slice(1).map((row, index) => (row.at - rows[index].at) / 1000);
  const boundaries = [start, ...rows.map(row => row.at), end];
  const quietIntervals = boundaries.slice(1).map((at, index) => ({ since: iso(boundaries[index]), until: iso(at), hours: (at - boundaries[index]) / 3600000 }))
    .filter(gap => gap.hours >= THRESHOLDS.quietHours).sort((a, b) => b.hours - a.hours);
  const sync = new Map();
  for (const row of rows) {
    const bin = Math.floor(row.at / (THRESHOLDS.syncBinMinutes * 60000)) * THRESHOLDS.syncBinMinutes * 60000;
    if (!sync.has(bin)) sync.set(bin, []);
    sync.get(bin).push(row);
  }
  const syncBins = [...sync].filter(([, records]) => new Set(records.map(row => row.author).filter(Boolean)).size >= THRESHOLDS.syncBots)
    .map(([at, records]) => ({ since: iso(at), records: records.length, bots: new Set(records.map(row => row.author).filter(Boolean)).size, examples: records.slice(0, 3).map(example) }));
  const communities = groups(rows.map(row => row.community), 'community');
  const observedCommunities = new Set(rows.map(row => row.community).filter(Boolean));
  const publicCommunities = Array.isArray(communityInput) ? communityInput : [];
  const context = new Map();
  for (const raw of publicCommunities.slice(0, LIMITS.bots)) {
    const name = clean(raw?.name);
    if (!name || !observedCommunities.has(name) || context.has(name)) continue;
    const rules = Array.isArray(raw.rules) ? raw.rules.slice(0, 10).map(rule => clean(rule, 200)).filter(Boolean).join(' ') : raw.rules;
    context.set(name, { name, description: clean(raw.description, 2000), rules: clean(rules, 2000) });
  }
  const communityContext = [...context.values()].slice(0, LIMITS.groups);
  const knownCommunityEdges = validEdges.filter(({ comment, parent }) => comment.community && parent.community);
  const botNames = [...new Set([...authorGroups.rows.map(row => row.bot), ...votes.bots.keys()])];
  const bots = botNames.slice(0, LIMITS.bots).map(bot => {
    const own = rows.filter(row => row.author === bot), outgoing = pairRows.filter(pair => pair.from === bot);
    const ownPosts = own.filter(row => row.type === 'post'), ownReplies = own.filter(row => row.type === 'comment');
    const externallyReplied = new Set(), unknownAuthorReplies = new Set();
    const ownPostIds = new Set(ownPosts.map(row => row.id));
    for (const { comment } of validEdges) {
      if (!ownPostIds.has(comment.postId)) continue;
      if (!comment.author) unknownAuthorReplies.add(comment.postId);
      else if (comment.author !== bot) externallyReplied.add(comment.postId);
    }
    const count = own.length;
    return { bot, records: count, posts: ownPosts.length, comments: ownReplies.length,
      recordsPerDay: count / (hours / 24), lengths: lengths(own), topics: lexical(own).topics,
      postsPerHour: ownPosts.length / hours, repliesPerHour: ownReplies.length / hours,
      interarrivalSeconds: { records: interarrival(own), posts: interarrival(ownPosts), replies: interarrival(ownReplies) },
      initiation: { denominator: ownPosts.length, postsWithObservedExternalReplies: externallyReplied.size,
        postsWithoutObservedExternalReplies: ownPosts.length - externallyReplied.size, unknownAuthorReplyPosts: unknownAuthorReplies.size,
        externalReplyShare: share(externallyReplied.size, ownPosts.length),
        meaning: 'In-window authored posts with any valid observed in-window reply by another public author. Missing replies are right-censored, not proven lack of engagement.' },
      communities: groups(own.map(row => row.community), 'community'),
      partners: { denominator: sum(outgoing.map(pair => pair.replies)), totalPartners: outgoing.length, truncated: outgoing.length > LIMITS.groups,
        rows: outgoing.slice(0, LIMITS.groups).map(pair => ({ bot: pair.to, replies: pair.replies, reciprocal: pairs.has(JSON.stringify([pair.to, pair.from])) })) },
      voting: votes.bots.get(bot) || null };
  });
  const warnings = [
    'All activity counts describe the bounded supplied public sample, not a census; zero observations do not prove inactivity. Historical records are parent context only.',
    'Missing parents, fetch limits, deleted content and the window boundary censor depth, branching, latency, quiet intervals and apparent one-and-done replies.',
    'Authors are public names, not verified bot identities. Profiles, personas, kernels, private memory and arbitrary input URLs are not exported.',
    'Lexical repetition, opening agreement and context overlap are heuristics, not semantic diagnoses. No naturalness score, desired graph or intervention is inferred.',
    'Community fit is not semantically classified; reviewers can compare the bounded public community norms with public examples. Private continuity and social state are not inspected.',
    'Timing bins are UTC observations, not evidence of coordination. Quiet intervals mean no sampled records, not proven silence.',
    'Vote counts describe recorded opportunities and outcomes only; they are not the mutable authoritative current-vote ledger.'
  ];
  const source = {};
  for (const name of ['available', 'sampleTruncated', 'postsTruncated', 'commentsTruncated', 'parentsTruncated', 'complete',
    'sampleOnly', 'postsComplete', 'commentsComplete', 'nsfwIncluded', 'truncated']) source[name] = typeof coverage?.[name] === 'boolean' ? coverage[name] : null;
  for (const name of ['fetchedPosts', 'fetchedComments', 'fetchedParents', 'failedRequests', 'requests', 'threadReads', 'maxThreads', 'maxItems', 'failedReads', 'publicRecords']) source[name] = count(coverage?.[name]);
  source.source = coverage?.source === 'public-feddit-api' ? coverage.source : null;
  source.sourceSince = iso(time(coverage?.sourceSince));
  source.sourceUntil = iso(time(coverage?.sourceUntil));
  source.warnings = (Array.isArray(coverage?.warnings) ? coverage.warnings : []).slice(0, 12).map(value => clean(value, 240)).filter(Boolean);
  const truncated = rawItems.length > LIMITS.items || authorGroups.truncated || botNames.length > LIMITS.bots || source.sampleTruncated === true || source.truncated === true;
  if (truncated) warnings.push('Input or output limits were reached; omitted records and groups cannot be inferred from this report.');
  return {
    schemaVersion: 1, generatedAt: iso(time(now) ?? end), window: { since: iso(start), until: iso(end), hours },
    coverage: { sampleOnly: true, inputItems: rawItems.length, acceptedItems: normalized.length, inWindowItems: rows.length, historicalItems: historical.length,
      invalidItems, duplicateItems, undatedItems: normalized.filter(row => row.at === null).length, futureItems: normalized.filter(row => row.at !== null && row.at > end).length,
      unknownAuthors: rows.filter(row => !row.author).length, truncated, limits: { ...LIMITS }, source, warnings,
      privateContinuityInspected: false, communityContextCount: communityContext.length,
      communityContextMissing: observedCommunities.size - communityContext.length,
      communityContextTruncated: context.size > LIMITS.groups || publicCommunities.length > LIMITS.bots },
    overview: { posts: posts.length, comments: comments.length, activeBots: authorGroups.totalGroups, postsPerDay: posts.length / (hours / 24), commentsPerDay: comments.length / (hours / 24),
      postingConcentration: { ...share(authorGroups.rows[0]?.count || 0, authorGroups.denominator), meaning: 'Largest public author share of sampled posts and comments with known authors.' },
      lengths: lengthsByType, articleMix: { links: posts.filter(row => row.kind === 'link').length, text: posts.filter(row => row.kind === 'text').length,
        unknown: posts.filter(row => row.kind === null).length, denominator: posts.filter(row => row.kind !== null).length,
        linkShare: ratio(posts.filter(row => row.kind === 'link').length, posts.filter(row => row.kind !== null).length) } },
    language, communityContext,
    replies: { parentCoverage: { ...share(resolved.length, comments.length), missingParents, invalidEdges, incompleteAncestry, completeChains: validEdges.length },
      depth: stats(depths), branching: { ...stats(branchCandidates.map(row => children.get(row.key) || 0)), meaning: 'Observed in-window children per dated sampled record or historical parent.' },
      oneAndDone: { ...share(oneAndDone.length, validEdges.length), meaning: 'Valid sampled comments with no sampled in-window child; right-censored, not proven abandonment.' },
      latencySeconds: { ...stats(latencies), unknown: comments.length - latencies.length },
      parentAge: { recent: latencies.filter(value => value <= THRESHOLDS.recentParentHours * 3600).length, old: latencies.filter(value => value > THRESHOLDS.recentParentHours * 3600).length,
        unknown: comments.length - latencies.length, denominator: latencies.length, recentMaximumHours: THRESHOLDS.recentParentHours } },
    interactions: { pairs: pairRows.slice(0, LIMITS.pairs), totalPairs: pairRows.length, pairsTruncated: pairRows.length > LIMITS.pairs,
      twoAuthorThreads: { count: threadExchanges.length, denominator: threadRecords.size, unknownAuthorThreads, minimumReplies: 3,
        truncated: threadExchanges.length > LIMITS.groups, rows: threadExchanges.slice(0, LIMITS.groups),
        meaning: 'Observed threads with exactly two known in-window authors and at least three valid cross-author reply edges in both directions. Historical edges are excluded; not proof of exclusivity, coordination or a target norm.' },
      reciprocity: { ...share(reciprocal, nonSelfPairs.length), meaning: 'Directed non-self author pairs with an observed reverse edge; historical context does not create reverse edges.' },
      communities: { ...communities, withinCommunity: share(knownCommunityEdges.filter(({ comment, parent }) => comment.community === parent.community).length, knownCommunityEdges.length),
        meaning: 'Community grouping of observed records and reply edges; not a graph clustering coefficient or target.' } },
    timing: { denominator: rows.length, hourUtc: histogram, interarrivalSeconds: stats(gaps), quietIntervals: quietIntervals.slice(0, LIMITS.groups),
      quietIntervalsTruncated: quietIntervals.length > LIMITS.groups, quietMinimumHours: THRESHOLDS.quietHours,
      synchronizedBins: syncBins.slice(0, LIMITS.groups), synchronizedBinsTruncated: syncBins.length > LIMITS.groups, binMinutes: THRESHOLDS.syncBinMinutes, minimumDistinctAuthors: THRESHOLDS.syncBots },
    bots, botsTruncated: authorGroups.truncated || botNames.length > LIMITS.bots, voting: votes.summary, thresholds: { ...THRESHOLDS }, anomalies,
    examples: rows.slice(-LIMITS.examples).map(example)
  };
}

module.exports = { buildEcology, LIMITS, THRESHOLDS };
