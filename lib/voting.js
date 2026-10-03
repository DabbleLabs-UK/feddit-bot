'use strict';

// Bounded reactions to content already present in an opportunity's feed slate.
// Voting never performs candidate discovery and never makes one model call per
// item. The action-candidate decision embeds the whole small slate in one call.

const MAX_VOTE_CANDIDATES = 8;
const CONSIDERED_CAP = 1000;

function clean(value, limit = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function targetKey(item) {
  const type = item && item.targetType === 'comment' ? 'comment' : 'post';
  const id = Number(item && item.targetId);
  return Number.isFinite(id) && id > 0 ? type + ':' + id : '';
}

function defaults() {
  return { considered: [] };
}

function normalize(state) {
  const considered = [];
  const seen = new Set();
  for (const raw of (state && Array.isArray(state.considered) ? state.considered : [])) {
    const key = clean(raw, 80);
    if (!/^(?:post|comment):\d+$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    considered.push(key);
  }
  return { considered: considered.slice(-CONSIDERED_CAP) };
}

function record(state, decisions) {
  const next = normalize(state);
  const seen = new Set(next.considered);
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const key = targetKey(decision);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.considered.push(key);
  }
  next.considered = next.considered.slice(-CONSIDERED_CAP);
  return next;
}

function collect(candidates, options = {}) {
  const self = clean(options.self, 128).toLowerCase();
  const considered = new Set(normalize(options.state).considered);
  const remaining = Number(options.remaining);
  const allowanceBound = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : MAX_VOTE_CANDIDATES;
  const limit = Math.min(MAX_VOTE_CANDIDATES, allowanceBound, Math.max(0, Number(options.limit) || MAX_VOTE_CANDIDATES));
  if (limit <= 0) return [];
  const out = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const raw of (candidate && Array.isArray(candidate.voteItems) ? candidate.voteItems : [])) {
      const key = targetKey(raw);
      const author = clean(raw && raw.author, 128);
      if (!key || seen.has(key) || considered.has(key) || (self && author.toLowerCase() === self)) continue;
      const content = clean(raw && raw.content, 1800);
      if (!content || content === '[deleted]') continue;
      seen.add(key);
      out.push({
        id: 'V' + (out.length + 1),
        targetType: key.startsWith('comment:') ? 'comment' : 'post',
        targetId: Number(key.split(':')[1]),
        author,
        label: clean(raw && raw.label, 240) || key,
        content,
        sourceCandidateId: clean(candidate && candidate.id, 20) || null,
        socialContext: clean(candidate && candidate.social && candidate.social.summary, 500),
        memoryContext: clean(candidate && candidate.memory && candidate.memory.prompt, 700),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function promptSection(items, allowance = null) {
  if (!Array.isArray(items) || !items.length) return '';
  const blocks = items.map((item) => [
    '[' + item.id + '] ' + item.targetType.toUpperCase() + ' by ' + (item.author || 'unknown') +
      (item.sourceCandidateId ? ' (seen with ' + item.sourceCandidateId + ')' : ''),
    'LABEL: ' + item.label,
    'CONTENT: ' + item.content,
    item.socialContext ? 'BOUNDED SOCIAL CONTEXT: ' + item.socialContext : '',
    item.memoryContext ? 'BOUNDED RELEVANT MEMORY: ' + item.memoryContext : '',
  ].filter(Boolean).join('\n'));
  const remaining = allowance && Number.isFinite(Number(allowance.remaining))
    ? ' Feddit says at most ' + Number(allowance.remaining) + ' vote(s) remain in this bot\'s current daily allowance.'
    : '';
  return '\n\nVOTING\n' +
    'These are posts or comments you actually saw above. Decide independently whether each deserves an upvote, a downvote, or no vote.' + remaining + ' ' +
    'No vote is normal and must not be treated as a failure. Upvotes are not the default for politeness. Downvotes are genuinely available when the content warrants one. ' +
    'For every listed V-number, return exactly one object in a votes array. Use direction "up", "down", or "nil". ' +
    'An up or down vote needs a concise public-facing reason of at least three words; nil needs no reason. ' +
    'Do not expose private reasoning or claim you read anything outside the displayed content.\n\n' +
    blocks.join('\n\n') + '\n\n' +
    'Include the votes beside the main choice, for example: ' +
    '{"choice":"C1","reason":"short action reason","votes":[{"id":"V1","direction":"up","reason":"The explanation is specific and useful."},{"id":"V2","direction":"nil","reason":""}]}.';
}

function validReason(value) {
  const reason = clean(value, 240);
  const words = reason.split(/\s+/).filter(Boolean);
  return reason.length >= 15 && words.length >= 3 ? reason : '';
}

function parseDecisions(parsed, items) {
  const supplied = new Map();
  for (const raw of (parsed && Array.isArray(parsed.votes) ? parsed.votes : [])) {
    const id = clean(raw && raw.id, 20).toUpperCase();
    if (/^V\d+$/.test(id) && !supplied.has(id)) supplied.set(id, raw);
  }
  return (Array.isArray(items) ? items : []).map((item) => {
    const raw = supplied.get(item.id) || {};
    const direction = clean(raw.direction, 12).toLowerCase();
    const reason = direction === 'up' || direction === 'down' ? validReason(raw.reason) : '';
    const finalDirection = (direction === 'up' || direction === 'down') && reason ? direction : 'nil';
    return {
      id: item.id,
      targetType: item.targetType,
      targetId: item.targetId,
      label: item.label,
      direction: finalDirection,
      reason: finalDirection === 'nil' ? '' : reason,
      status: finalDirection === 'nil' ? 'no-vote' : 'decided',
    };
  });
}

module.exports = {
  MAX_VOTE_CANDIDATES,
  CONSIDERED_CAP,
  defaults,
  normalize,
  record,
  targetKey,
  collect,
  promptSection,
  parseDecisions,
};
