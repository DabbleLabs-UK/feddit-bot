'use strict';

// Bounded, asymmetric social continuity for one bot. This module records only
// meaningful public interaction events. It does not infer friendship, rewrite a
// persona, or affect infrastructure queue priority.

const LIMITS = Object.freeze({
  relationships: 100,
  recentEventsPerRelationship: 16,
  topicsPerRelationship: 8,
  seenEventIds: 500,
});

const LOW_VALUE_STALE_MS = 90 * 24 * 60 * 60 * 1000;
const CONVERSATION_WINDOW_MS = 72 * 60 * 60 * 1000;
const SATIATION_WINDOW_MS = 24 * 60 * 60 * 1000;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'always', 'another', 'because', 'being',
  'comment', 'comments', 'could', 'does', 'from', 'have', 'into', 'just',
  'more', 'most', 'only', 'other', 'people', 'post', 'posts', 'reply', 'said',
  'some', 'someone', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
  'they', 'thing', 'this', 'very', 'want', 'what', 'when', 'where', 'which',
  'will', 'with', 'would', 'your', 'youre', 'feddit', 'title', 'body', 'link',
  'http', 'https', 'www', 'community', 'thread', 'discussion',
]);

function defaults() {
  return { relationships: {}, seenEventIds: [] };
}

function clean(value, limit = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function accountKey(value) {
  return clean(value, 128).replace(/^@/, '').toLowerCase();
}

function topicsFromText(value, limit = 6) {
  const text = String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[a-z0-9_-]+/g, ' ');
  const words = text.match(/[a-z][a-z0-9_-]{3,}/g) || [];
  const counts = new Map();
  const first = new Map();
  for (const word of words) {
    if (STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
    if (!first.has(word)) first.set(word, first.size);
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || first.get(a[0]) - first.get(b[0]) || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([name]) => name);
}

function eventTime(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

function normalizeRecentEvent(raw, fallbackAt) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clean(raw.id, 180);
  const direction = raw.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const at = eventTime(raw.at, fallbackAt);
  if (!id || !at) return null;
  return {
    id,
    at,
    direction,
    kind: clean(raw.kind, 80),
    threadKey: clean(raw.threadKey, 100),
    topics: [...new Set((Array.isArray(raw.topics) ? raw.topics : [])
      .map((topic) => accountKey(topic)).filter(Boolean))].slice(0, 6),
  };
}

function normalizeRelationship(raw, fallbackKey, nowMs) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const account = accountKey(source.account || fallbackKey);
  if (!account) return null;
  const interactionCount = Math.max(0, Math.floor(Number(source.interactionCount) || 0));
  const recentEvents = (Array.isArray(source.recentEvents) ? source.recentEvents : [])
    .map((event) => normalizeRecentEvent(event, Number(source.lastAt) || nowMs))
    .filter(Boolean)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(-LIMITS.recentEventsPerRelationship);
  const lastAt = Math.max(
    0,
    Number(source.lastAt) || 0,
    ...recentEvents.map((event) => event.at),
  );
  const firstAt = Math.max(0, Number(source.firstAt) || (recentEvents[0] && recentEvents[0].at) || lastAt);
  const topics = (Array.isArray(source.topics) ? source.topics : [])
    .map((topic) => ({
      name: accountKey(topic && topic.name),
      count: Math.max(0, Math.floor(Number(topic && topic.count) || 0)),
      lastAt: Math.max(0, Number(topic && topic.lastAt) || 0),
    }))
    .filter((topic) => topic.name && topic.count > 0)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt || a.name.localeCompare(b.name))
    .slice(0, LIMITS.topicsPerRelationship);
  return {
    account,
    firstAt,
    lastAt,
    interactionCount,
    incomingCount: Math.max(0, Math.floor(Number(source.incomingCount) || 0)),
    outgoingCount: Math.max(0, Math.floor(Number(source.outgoingCount) || 0)),
    continuationCount: Math.max(0, Math.floor(Number(source.continuationCount) || 0)),
    topics,
    recentEvents,
  };
}

function relationshipValue(relationship, nowMs) {
  const ageDays = Math.max(0, nowMs - relationship.lastAt) / (24 * 60 * 60 * 1000);
  return relationship.interactionCount * 12 + relationship.continuationCount * 8 - ageDays;
}

function normalize(state, nowMs = Date.now()) {
  const source = state && typeof state === 'object' ? state : {};
  const entries = [];
  for (const [key, raw] of Object.entries(source.relationships || {})) {
    const relationship = normalizeRelationship(raw, key, nowMs);
    if (!relationship) continue;
    if (relationship.interactionCount <= 1 && relationship.lastAt > 0 &&
        nowMs - relationship.lastAt > LOW_VALUE_STALE_MS) continue;
    entries.push(relationship);
  }
  entries.sort((a, b) => relationshipValue(b, nowMs) - relationshipValue(a, nowMs) ||
    b.lastAt - a.lastAt || a.account.localeCompare(b.account));
  const relationships = {};
  for (const relationship of entries.slice(0, LIMITS.relationships)) {
    relationships[relationship.account] = relationship;
  }
  const seenEventIds = [...new Set((Array.isArray(source.seenEventIds) ? source.seenEventIds : [])
    .map((id) => clean(id, 180)).filter(Boolean))].slice(-LIMITS.seenEventIds);
  return { relationships, seenEventIds };
}

function recordEvent(state, input, nowMs = Date.now()) {
  let next = normalize(state, nowMs);
  const event = input && typeof input === 'object' ? input : {};
  const id = clean(event.id, 180);
  const account = accountKey(event.account);
  if (!id || !account || next.seenEventIds.includes(id)) {
    return { state: next, relationship: next.relationships[account] || null, counted: false };
  }
  const at = eventTime(event.at, nowMs);
  const direction = event.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const threadKey = clean(event.threadKey, 100);
  const topics = [...new Set((Array.isArray(event.topics) ? event.topics : topicsFromText(event.text || event.context))
    .map((topic) => accountKey(topic)).filter(Boolean))].slice(0, 6);
  const current = next.relationships[account] || normalizeRelationship({ account }, account, nowMs);
  const previousInThread = [...current.recentEvents].reverse().find((prior) =>
    threadKey && prior.threadKey === threadKey && at >= prior.at && at - prior.at <= CONVERSATION_WINDOW_MS
  );
  if (previousInThread && previousInThread.direction !== direction) current.continuationCount += 1;
  current.interactionCount += 1;
  if (direction === 'outgoing') current.outgoingCount += 1;
  else current.incomingCount += 1;
  current.firstAt = current.firstAt || at;
  current.lastAt = Math.max(current.lastAt || 0, at);
  current.recentEvents.push({ id, at, direction, kind: clean(event.kind, 80), threadKey, topics });
  current.recentEvents = current.recentEvents
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(-LIMITS.recentEventsPerRelationship);

  const topicMap = new Map(current.topics.map((topic) => [topic.name, { ...topic }]));
  for (const name of topics) {
    const topic = topicMap.get(name) || { name, count: 0, lastAt: 0 };
    topic.count += 1;
    topic.lastAt = Math.max(topic.lastAt, at);
    topicMap.set(name, topic);
  }
  current.topics = [...topicMap.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt || a.name.localeCompare(b.name))
    .slice(0, LIMITS.topicsPerRelationship);
  next.relationships[account] = current;
  next.seenEventIds.push(id);
  next.seenEventIds = next.seenEventIds.slice(-LIMITS.seenEventIds);
  next = normalize(next, nowMs);
  return { state: next, relationship: next.relationships[account] || null, counted: true };
}

function candidateParts(candidate) {
  const source = candidate && candidate.target ? candidate.target : (candidate || {});
  const postId = Number(source.postId || candidate && candidate.postId);
  return {
    account: accountKey(source.author || candidate && candidate.author),
    threadKey: Number.isFinite(postId) && postId > 0 ? 't3_' + postId : clean(source.threadKey, 100),
    topics: topicsFromText(source.context || candidate && candidate.context),
    candidateType: clean(source.candidateType || candidate && candidate.candidateType, 80),
    createdAt: Number(source.createdUtc || candidate && candidate.createdUtc) > 0
      ? Number(source.createdUtc || candidate.createdUtc) * 1000
      : 0,
  };
}

function familiarityLabel(count) {
  if (count <= 0) return 'No previous meaningful interaction.';
  if (count <= 2) return 'A little previous interaction.';
  if (count <= 5) return 'Several previous interactions.';
  return 'Familiar through repeated interaction.';
}

function describe(state, candidate, nowMs = Date.now()) {
  const current = normalize(state, nowMs);
  const parts = candidateParts(candidate);
  const relationship = parts.account ? current.relationships[parts.account] : null;
  if (!relationship) {
    return {
      account: parts.account || null,
      known: false,
      familiarity: 'none',
      momentum: 'none',
      satiation: 'none',
      sharedTopics: [],
      salienceDelta: 0,
      summary: parts.account ? 'No previous meaningful interaction with @' + parts.account + '.' : 'No social counterpart for this candidate.',
    };
  }

  const sameThread = relationship.recentEvents.filter((event) =>
    parts.threadKey && event.threadKey === parts.threadKey && nowMs - event.at <= CONVERSATION_WINDOW_MS
  );
  const directions = new Set(sameThread.map((event) => event.direction));
  if (/^(?:reply_to_|nested_continuation|mention_)/.test(parts.candidateType)) directions.add('incoming');
  const lastThreadAt = Math.max(parts.createdAt || 0, ...sameThread.map((event) => event.at), 0);
  const threadAge = lastThreadAt ? Math.max(0, nowMs - lastThreadAt) : Number.POSITIVE_INFINITY;
  const exchangeEvidence = sameThread.length + (parts.createdAt ? 1 : 0);
  let momentum = 'none';
  if (exchangeEvidence >= 2 && directions.has('incoming') && directions.has('outgoing')) {
    if (threadAge <= 6 * 60 * 60 * 1000) momentum = 'active';
    else if (threadAge <= 18 * 60 * 60 * 1000) momentum = 'warm';
    else if (threadAge <= 48 * 60 * 60 * 1000) momentum = 'cooling';
  }

  const recentThreadTurns = sameThread.filter((event) => nowMs - event.at <= SATIATION_WINDOW_MS).length +
    (parts.createdAt && nowMs - parts.createdAt <= SATIATION_WINDOW_MS ? 1 : 0);
  const satiation = recentThreadTurns >= 6 ? 'high' : (recentThreadTurns >= 4 ? 'rising' : 'low');
  const recurring = relationship.topics.filter((topic) => topic.count >= 2).map((topic) => topic.name);
  const sharedTopics = parts.topics.filter((topic) => recurring.includes(topic)).slice(0, 3);
  const familiarity = relationship.interactionCount >= 6 ? 'familiar' :
    (relationship.interactionCount >= 3 ? 'several' : 'little');

  let salienceDelta = 0;
  if (momentum === 'active' || momentum === 'warm') salienceDelta += 1;
  if (sharedTopics.length) salienceDelta += 1;
  if (relationship.interactionCount >= 3) salienceDelta += 1;
  if (satiation === 'rising') salienceDelta -= 1;
  if (satiation === 'high') salienceDelta -= 2;
  salienceDelta = Math.max(-1, Math.min(2, salienceDelta));

  const pieces = [familiarityLabel(relationship.interactionCount).replace(/\.$/, '') + ' with @' + relationship.account + '.'];
  if (momentum === 'active') pieces.push('A two-way conversation in this thread is currently active.');
  else if (momentum === 'warm') pieces.push('A recent two-way conversation in this thread still has some momentum.');
  else if (momentum === 'cooling') pieces.push('The previous conversation in this thread has cooled.');
  if (sharedTopics.length) pieces.push('Recurring shared topic' + (sharedTopics.length === 1 ? '' : 's') + ': ' + sharedTopics.join(', ') + '.');
  if (satiation === 'rising') pieces.push('Several recent turns reduce novelty.');
  else if (satiation === 'high') pieces.push('Many recent turns make repetition a strong reason to stop or choose something else.');

  return {
    account: relationship.account,
    known: true,
    familiarity,
    interactionCount: relationship.interactionCount,
    continuationCount: relationship.continuationCount,
    momentum,
    satiation,
    sharedTopics,
    salienceDelta,
    summary: clean(pieces.join(' '), 500),
  };
}

module.exports = {
  LIMITS,
  LOW_VALUE_STALE_MS,
  CONVERSATION_WINDOW_MS,
  SATIATION_WINDOW_MS,
  defaults,
  accountKey,
  topicsFromText,
  normalize,
  recordEvent,
  describe,
};
