'use strict';

// Bounded autobiographical continuity for one bot. This extends the existing
// candidate-selection and durable-turn path; it never influences infrastructure
// queue priority, cadence, ownership fairness, or platform limits.

const socialRelationships = require('./social-relationships');

const LIMITS = Object.freeze({
  episodes: 80,
  claims: 36,
  conflicts: 20,
  preoccupations: 20,
  seenEventIds: 500,
  retrievedEpisodes: 2,
  retrievedClaims: 2,
  retrievedPreoccupations: 2,
});

const EPISODE_STALE_MS = 120 * 24 * 60 * 60 * 1000;
const PREOCCUPATION_HALF_LIFE_MS = 36 * 60 * 60 * 1000;
const PREOCCUPATION_MIN_WEIGHT = 0.12;
const SINGLE_VALUE_SLOTS = new Set(['residence', 'origin', 'upbringing', 'job']);

function defaults() {
  return { episodes: [], claims: [], conflicts: [], preoccupations: {}, seenEventIds: [] };
}

function clean(value, limit = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function key(value) {
  return clean(value, 160).toLowerCase();
}

function eventTime(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function uniqueTopics(value, limit = 8) {
  const input = Array.isArray(value) ? value : socialRelationships.topicsFromText(value, limit);
  return [...new Set(input.map(key).filter(Boolean))].slice(0, limit);
}

function decayWeight(weight, fromAt, nowMs) {
  const age = Math.max(0, nowMs - (Number(fromAt) || nowMs));
  return Math.max(0, Number(weight) || 0) * Math.pow(0.5, age / PREOCCUPATION_HALF_LIFE_MS);
}

function normalizeEpisode(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clean(raw.id, 180);
  const at = eventTime(raw.at, nowMs);
  const summary = clean(raw.summary || raw.text, 700);
  if (!id || !summary) return null;
  return {
    id,
    at,
    kind: clean(raw.kind, 80),
    direction: raw.direction === 'incoming' ? 'incoming' : 'outgoing',
    account: socialRelationships.accountKey(raw.account),
    threadKey: clean(raw.threadKey, 100),
    community: clean(raw.community, 100),
    importance: Math.max(0, Math.min(3, Number(raw.importance) || 1)),
    topics: uniqueTopics(raw.topics || summary, 8),
    summary,
  };
}

function normalizeClaim(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const slot = key(raw.slot);
  const value = clean(raw.value, 240);
  const claimKey = clean(raw.key || (slot + ':' + key(value)), 320);
  if (!slot || !value || !claimKey) return null;
  const evidenceIds = [...new Set((Array.isArray(raw.evidenceIds) ? raw.evidenceIds : [])
    .map((id) => clean(id, 180)).filter(Boolean))].slice(-8);
  const evidenceCount = Math.max(evidenceIds.length, Math.floor(Number(raw.evidenceCount) || 0), 1);
  return {
    key: claimKey,
    slot,
    value,
    polarity: raw.polarity === 'negative' ? 'negative' : 'positive',
    confidence: Math.max(0.15, Math.min(0.95, Number(raw.confidence) || 0.35)),
    evidenceCount,
    evidenceIds,
    firstAt: eventTime(raw.firstAt, nowMs),
    lastAt: eventTime(raw.lastAt, nowMs),
    status: evidenceCount >= 2 ? 'established' : 'tentative',
    topics: uniqueTopics(raw.topics || value, 6),
    provenance: 'public-self-claim',
  };
}

function normalizeConflict(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const slot = key(raw.slot);
  const value = clean(raw.value, 240);
  if (!slot || !value) return null;
  return {
    id: clean(raw.id, 180),
    slot,
    value,
    strongerSource: raw.strongerSource === 'owner' ? 'owner' : 'established-memory',
    strongerValue: clean(raw.strongerValue, 240),
    at: eventTime(raw.at, nowMs),
  };
}

function normalize(state, nowMs = Date.now()) {
  const source = state && typeof state === 'object' ? state : {};
  const episodes = (Array.isArray(source.episodes) ? source.episodes : [])
    .map((episode) => normalizeEpisode(episode, nowMs))
    .filter((episode) => episode && (episode.importance >= 2 || nowMs - episode.at <= EPISODE_STALE_MS))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(-LIMITS.episodes);
  const claims = (Array.isArray(source.claims) ? source.claims : [])
    .map((claim) => normalizeClaim(claim, nowMs))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence || b.lastAt - a.lastAt || a.key.localeCompare(b.key))
    .slice(0, LIMITS.claims);
  const conflicts = (Array.isArray(source.conflicts) ? source.conflicts : [])
    .map((conflict) => normalizeConflict(conflict, nowMs))
    .filter(Boolean)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(-LIMITS.conflicts);
  const preoccupationEntries = [];
  for (const [name, raw] of Object.entries(source.preoccupations || {})) {
    const topic = key(name);
    if (!topic) continue;
    const lastAt = eventTime(raw && raw.lastAt, nowMs);
    const weight = decayWeight(raw && raw.weight, lastAt, nowMs);
    if (weight < PREOCCUPATION_MIN_WEIGHT) continue;
    preoccupationEntries.push({
      topic,
      weight,
      lastAt: nowMs,
      evidenceCount: Math.max(1, Math.floor(Number(raw && raw.evidenceCount) || 1)),
    });
  }
  preoccupationEntries.sort((a, b) => b.weight - a.weight || b.evidenceCount - a.evidenceCount || a.topic.localeCompare(b.topic));
  const preoccupations = {};
  for (const item of preoccupationEntries.slice(0, LIMITS.preoccupations)) {
    preoccupations[item.topic] = {
      weight: Math.round(item.weight * 1000) / 1000,
      lastAt: item.lastAt,
      evidenceCount: item.evidenceCount,
    };
  }
  const seenEventIds = [...new Set((Array.isArray(source.seenEventIds) ? source.seenEventIds : [])
    .map((id) => clean(id, 180)).filter(Boolean))].slice(-LIMITS.seenEventIds);
  return { episodes, claims, conflicts, preoccupations, seenEventIds };
}

function claimPatterns() {
  return [
    { slot: 'residence', re: /\bi (?:live|reside) in ([^.!?\n]{2,80})/gi, value: (m) => m[1] },
    { slot: 'origin', re: /\bi(?:'m| am) from ([^.!?\n]{2,80})/gi, value: (m) => m[1] },
    { slot: 'upbringing', re: /\bi grew up in ([^.!?\n]{2,80})/gi, value: (m) => m[1] },
    { slot: 'job', re: /\bi (?:work as|am employed as) (?:an? )?([^.!?\n]{2,80})/gi, value: (m) => m[1] },
    { slot: 'preference', re: /\bi (love|enjoy|prefer|hate) ([^.!?\n]{2,100})/gi, value: (m) => m[2], polarity: (m) => m[1].toLowerCase() === 'hate' ? 'negative' : 'positive' },
    { slot: 'interest', re: /\bi(?:'m| am) (?:really )?interested in ([^.!?\n]{2,100})/gi, value: (m) => m[1] },
    { slot: 'family', re: /\bmy (sister|brother|mother|father|mum|mom|dad|wife|husband|partner|son|daughter) ([^.!?\n]{2,100})/gi, value: (m) => m[1] + ' ' + m[2] },
  ];
}

function extractClaims(text) {
  const source = String(text || '').slice(0, 10_000);
  const claims = [];
  for (const pattern of claimPatterns()) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(source)) && claims.length < 8) {
      const value = clean(pattern.value(match), 240).replace(/\s+(?:haha|lol)$/i, '').trim();
      if (!value || value.split(/\s+/).length > 22) continue;
      claims.push({
        slot: pattern.slot,
        value,
        polarity: pattern.polarity ? pattern.polarity(match) : 'positive',
        topics: uniqueTopics(value, 6),
      });
    }
  }
  const seen = new Set();
  return claims.filter((claim) => {
    const claimKey = claim.slot + ':' + claim.polarity + ':' + key(claim.value);
    if (seen.has(claimKey)) return false;
    seen.add(claimKey);
    claim.key = claimKey;
    return true;
  });
}

function ownerClaims(ownerText) {
  return extractClaims(ownerText).map((claim) => ({ ...claim, provenance: 'owner' }));
}

function valuesConflict(left, right) {
  const a = key(left);
  const b = key(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return false;
  const ta = new Set(uniqueTopics(a, 12));
  const tb = new Set(uniqueTopics(b, 12));
  const overlap = [...ta].filter((topic) => tb.has(topic)).length;
  return overlap === 0 || overlap / Math.max(ta.size, tb.size, 1) < 0.5;
}

function claimsConflict(left, right) {
  if (!left || !right || left.slot !== right.slot) return false;
  if (left.polarity !== right.polarity) {
    return !valuesConflict(left.value, right.value);
  }
  return SINGLE_VALUE_SLOTS.has(left.slot) && valuesConflict(left.value, right.value);
}

function addClaim(next, candidate, eventId, at, ownerText) {
  const owners = ownerClaims(ownerText).filter((claim) => claim.slot === candidate.slot);
  const ownerConflict = owners.find((claim) => claimsConflict(claim, candidate));
  if (ownerConflict) {
    next.conflicts.push({
      id: eventId + ':' + candidate.key,
      slot: candidate.slot,
      value: candidate.value,
      strongerSource: 'owner',
      strongerValue: ownerConflict.value,
      at,
    });
    return { accepted: false, conflict: 'owner' };
  }

  const same = next.claims.find((claim) =>
    claim.slot === candidate.slot && claim.polarity === candidate.polarity && !valuesConflict(claim.value, candidate.value)
  );
  const establishedConflict = next.claims.find((claim) =>
    claim.status === 'established' && claimsConflict(claim, candidate)
  );
  if (!same && establishedConflict) {
    next.conflicts.push({
      id: eventId + ':' + candidate.key,
      slot: candidate.slot,
      value: candidate.value,
      strongerSource: 'established-memory',
      strongerValue: establishedConflict.value,
      at,
    });
    return { accepted: false, conflict: 'established-memory' };
  }

  if (same) {
    if (!same.evidenceIds.includes(eventId)) same.evidenceIds.push(eventId);
    same.evidenceIds = same.evidenceIds.slice(-8);
    same.evidenceCount = Math.max(same.evidenceCount + 1, same.evidenceIds.length);
    same.lastAt = Math.max(same.lastAt, at);
    same.confidence = Math.min(0.9, 0.35 + same.evidenceCount * 0.18);
    same.status = same.evidenceCount >= 2 ? 'established' : 'tentative';
    same.topics = uniqueTopics([...same.topics, ...candidate.topics], 6);
    return { accepted: true, claim: same };
  }

  next.claims.push({
    key: candidate.key,
    slot: candidate.slot,
    value: candidate.value,
    polarity: candidate.polarity,
    confidence: 0.35,
    evidenceCount: 1,
    evidenceIds: [eventId],
    firstAt: at,
    lastAt: at,
    status: 'tentative',
    topics: candidate.topics,
    provenance: 'public-self-claim',
  });
  return { accepted: true, claim: next.claims[next.claims.length - 1] };
}

function recordEvent(state, input, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  let next = normalize(state, nowMs);
  const event = input && typeof input === 'object' ? input : {};
  const id = clean(event.id, 180);
  if (!id || next.seenEventIds.includes(id)) return { state: next, counted: false, claims: [], conflicts: [] };
  const meaningful = event.meaningful === true || Number(event.importance) >= 1;
  const summary = clean(event.summary || event.text || event.context, 700);
  if (!meaningful || !summary) return { state: next, counted: false, claims: [], conflicts: [] };

  const at = eventTime(event.at, nowMs);
  const topics = uniqueTopics(event.topics || summary, 8);
  const episode = normalizeEpisode({
    id,
    at,
    kind: event.kind,
    direction: event.direction,
    account: event.account,
    threadKey: event.threadKey,
    community: event.community,
    importance: event.importance,
    topics,
    summary,
  }, nowMs);
  if (episode) next.episodes.push(episode);

  for (const topic of topics) {
    const current = next.preoccupations[topic];
    const currentWeight = current ? decayWeight(current.weight, current.lastAt, at) : 0;
    next.preoccupations[topic] = {
      weight: Math.min(6, currentWeight + Math.max(0.35, (Number(event.importance) || 1) * 0.55)),
      lastAt: at,
      evidenceCount: (current && current.evidenceCount || 0) + 1,
    };
  }

  const claimResults = [];
  const conflictResults = [];
  if (event.direction !== 'incoming' && event.allowSelfClaims !== false) {
    for (const candidate of extractClaims(event.selfClaimText || event.text)) {
      const result = addClaim(next, candidate, id, at, options.ownerText || '');
      if (result.accepted && result.claim) claimResults.push(structuredClone(result.claim));
      else if (result.conflict) conflictResults.push({ slot: candidate.slot, value: candidate.value, strongerSource: result.conflict });
    }
  }

  next.seenEventIds.push(id);
  next = normalize(next, nowMs);
  return { state: next, counted: true, episode, claims: claimResults, conflicts: conflictResults };
}

function candidateParts(candidate) {
  const source = candidate && candidate.target ? candidate.target : (candidate || {});
  const postId = Number(source.postId || candidate && candidate.postId);
  const context = String(source.context || candidate && candidate.context || '');
  return {
    account: socialRelationships.accountKey(source.author || candidate && candidate.author),
    threadKey: Number.isFinite(postId) && postId > 0 ? 't3_' + postId : clean(source.threadKey, 100),
    topics: uniqueTopics(context, 10),
  };
}

function overlapScore(left, right) {
  const a = new Set(left || []);
  return [...new Set(right || [])].filter((topic) => a.has(topic)).length;
}

function describe(state, candidate, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const current = normalize(state, nowMs);
  const parts = candidateParts(candidate);
  const rankedEpisodes = current.episodes.map((episode) => {
    const overlap = overlapScore(parts.topics, episode.topics);
    const sameAccount = !!parts.account && episode.account === parts.account;
    const sameThread = !!parts.threadKey && episode.threadKey === parts.threadKey;
    const ageDays = Math.max(0, nowMs - episode.at) / (24 * 60 * 60 * 1000);
    const score = overlap * 4 + (sameAccount ? 7 : 0) + (sameThread ? 8 : 0) + episode.importance * 1.5 + Math.max(0, 3 - ageDays / 7);
    return { episode, score, overlap, sameAccount, sameThread };
  }).filter((item) => (item.overlap > 0 || item.sameAccount || item.sameThread) && item.score >= 5)
    .sort((a, b) => b.score - a.score || b.episode.at - a.episode.at)
    .slice(0, LIMITS.retrievedEpisodes);

  const rankedClaims = current.claims.map((claim) => {
    const overlap = overlapScore(parts.topics, claim.topics);
    return { claim, score: overlap * 5 + claim.confidence * 3 };
  }).filter((item) => item.score >= 5)
    .sort((a, b) => b.score - a.score || b.claim.confidence - a.claim.confidence)
    .slice(0, LIMITS.retrievedClaims);

  const rankedPreoccupations = Object.entries(current.preoccupations).map(([topic, detail]) => ({
    topic,
    weight: Number(detail.weight) || 0,
    matched: parts.topics.includes(topic),
  })).filter((item) => item.matched)
    .sort((a, b) => b.weight - a.weight || a.topic.localeCompare(b.topic))
    .slice(0, LIMITS.retrievedPreoccupations);

  const conflict = current.conflicts.find((item) => parts.topics.includes(key(item.value)) ||
    uniqueTopics(item.value, 6).some((topic) => parts.topics.includes(topic)));
  const reasons = [];
  if (rankedEpisodes.length) reasons.push('Remembered ' + rankedEpisodes.length + ' relevant past event' + (rankedEpisodes.length === 1 ? '' : 's') + '.');
  if (rankedClaims.length) reasons.push('Retrieved ' + rankedClaims.map((item) =>
    item.claim.status + ' public self-claim "' + item.claim.slot + ' = ' + item.claim.value + '"'
  ).join('; ') + '.');
  if (rankedPreoccupations.length) reasons.push('Current preoccupation with ' + rankedPreoccupations.map((item) => item.topic).join(', ') + ' increased salience.');
  if (conflict) reasons.push('A conflicting inferred self-claim was ignored in favour of ' + (conflict.strongerSource === 'owner' ? 'owner-defined background.' : 'stronger established memory.'));
  const promptItems = [];
  for (const item of rankedEpisodes) promptItems.push('Past event: ' + item.episode.summary);
  for (const item of rankedClaims) {
    promptItems.push('Autobiographical ' + item.claim.status + ' claim: ' + item.claim.slot + ' = ' + item.claim.value +
      ' (confidence ' + Math.round(item.claim.confidence * 100) + '%; public self-claim, not owner-authored canon).');
  }
  if (rankedPreoccupations.length) promptItems.push('Current preoccupation: ' + rankedPreoccupations.map((item) => item.topic).join(', ') + '.');
  const salienceDelta = Math.max(0, Math.min(2,
    (rankedEpisodes.length || rankedClaims.length ? 1 : 0) +
    (rankedPreoccupations.some((item) => item.weight >= 1.1) ? 1 : 0)
  ));
  return {
    relevant: promptItems.length > 0,
    salienceDelta,
    topics: parts.topics.slice(0, 6),
    episodeIds: rankedEpisodes.map((item) => item.episode.id),
    claimKeys: rankedClaims.map((item) => item.claim.key),
    preoccupations: rankedPreoccupations.map((item) => item.topic),
    summary: clean(reasons.join(' '), 700),
    prompt: clean(promptItems.join(' '), 1600),
  };
}

module.exports = {
  LIMITS,
  EPISODE_STALE_MS,
  PREOCCUPATION_HALF_LIFE_MS,
  PREOCCUPATION_MIN_WEIGHT,
  defaults,
  normalize,
  extractClaims,
  ownerClaims,
  recordEvent,
  describe,
};
