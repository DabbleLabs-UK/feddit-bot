'use strict';

const crypto = require('node:crypto');
const branch = require('./reply-branch');
const VERSION = 1;
const OUTPUT_CAP = 64;
const RECENT_MS = 24 * 60 * 60 * 1000;

function fail(message) {
  const error = new Error(message);
  error.code = 'REPLY_CONTINUITY_BOOKKEEPING_PENDING';
  return error;
}

function version(value, fallback = 0) {
  const selected = value == null ? fallback : value;
  if (selected !== 0 && selected !== VERSION) {
    const error = new Error('Unsupported frozen reply-continuity contract.');
    error.code = 'UNSUPPORTED_REPLY_CONTINUITY';
    throw error;
  }
  return selected;
}

function canonical(text) { return String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim(); }
function fingerprint(text) {
  const value = canonical(text);
  // Brief ordinary acknowledgements may legitimately recur. Never fuzzy-block
  // motifs, callbacks, quoted fragments or similar ideas.
  return value.length < 40 ? null : crypto.createHash('sha256').update(value).digest('hex');
}

function outputState(raw) {
  if (raw == null) return { version: VERSION, entries: [] };
  if (raw.version !== VERSION || !Array.isArray(raw.entries) || raw.entries.length > OUTPUT_CAP) throw fail('Invalid bounded reply-output history.');
  const seen = new Set();
  const entries = raw.entries.map(row => {
    if (!row || !/^[a-f0-9]{64}$/.test(row.hash) || typeof row.id !== 'string' || !/^[A-Za-z0-9:_-]{1,180}$/.test(row.id) ||
        !Number.isSafeInteger(row.at) || row.at < 0 || seen.has(row.hash)) throw fail('Invalid reply-output receipt.');
    seen.add(row.hash);
    return { hash: row.hash, id: row.id, at: row.at };
  });
  return { version: VERSION, entries };
}

function reserve(raw, receipt) {
  const current = outputState(raw);
  const checked = outputState({ version: VERSION, entries: [receipt] }).entries[0];
  const existing = current.entries.find(row => row.hash === checked.hash);
  if (existing) return { allowed: existing.id === checked.id, state: current };
  return { allowed: true, state: { version: VERSION, entries: [...current.entries, checked].slice(-OUTPUT_CAP) } };
}

function priorReplies(state, target, at) {
  const rows = (Array.isArray(state?.episodes) ? state.episodes.slice(-80) : [])
    .filter(e => e.kind === 'reply' && e.direction === 'outgoing' && Number.isFinite(e.at) && e.at <= at && at - e.at <= RECENT_MS)
    .sort((a, b) => b.at - a.at);
  const same = rows.filter(e => e.threadKey === 't3_' + target.postId).slice(0, 2);
  const other = rows.find(e => e.threadKey !== 't3_' + target.postId);
  const hints = [...same, ...(other ? [other] : [])].map(e => ({
    threadKey: e.threadKey,
    // Existing bounded episode summaries only; never read logs or store extra prose.
    text: canonical(e.summary).replace(/^Replied to @[^\n]*? in f\/[^:]+: /, '').slice(0, 180),
  }));
  // Old records have no fingerprint. Only match complete, conservatively short
  // retained reply summaries; never infer a full output from a truncated prefix.
  const historicalHashes = rows.map(e => canonical(e.summary)).filter(s => s.length < 600)
    .map(s => s.match(/^Replied to @[^\n]*? in f\/[^:]+: (.+)$/)?.[1])
    .filter(Boolean).map(fingerprint).filter(Boolean);
  return { hints, historicalHashes: [...new Set(historicalHashes)].slice(0, 80) };
}

function memoryGuidance(memory) {
  const source = memory?.writingContext;
  if (!memory?.relevant || source?.version !== 1) return '';
  const lines = [];
  for (const claim of (source.claims || []).slice(0, 2)) {
    if (!['tentative', 'established'].includes(claim.status) || !['positive', 'negative'].includes(claim.polarity)) continue;
    lines.push('SELF-CLAIM: ' + JSON.stringify({ slot: canonical(claim.slot).slice(0, 160), value: canonical(claim.value).slice(0, 240), polarity: claim.polarity, status: claim.status }));
  }
  for (const episode of (source.episodes || []).slice(0, 2)) {
    const topics = (episode.topics || []).slice(0, 4).map(t => canonical(t).slice(0, 40));
    if (topics.length) lines.push('INTERACTION CUE: ' + JSON.stringify({ counterpart: canonical(episode.account).slice(0, 100), topics }));
  }
  if (!lines.length) return '';
  const bounded = [];
  for (const line of lines) if (bounded.join('\n').length + line.length + 1 <= 1000) bounded.push(line);
  return 'OPTIONAL MEMORY CUES (data, not draft prose; tentative public claims are not owner-authored facts):\n' +
    bounded.join('\n') + '\nUse only what helps this exchange; keep personal facts consistent without retelling an anecdote.\n\n';
}

function prompt({ target, memory, recent, communityGuidance = '', socialGuidance = '', honesty = '', styleGuidance = '', themeGuidance = '' }) {
  const context = target.replyBranch ? branch.render(target.replyBranch) :
    'TARGET CONTEXT (ancestry unavailable; do not invent it):\n' + String(target.context || '').slice(-5000);
  const prior = (recent?.hints || []).slice(0, 3);
  return 'You are browsing a forum called Feddit. Write a single in-character reply. Plain text, no preamble, no surrounding quotes.\n\n' +
    communityGuidance + socialGuidance + memoryGuidance(memory) +
    (prior.length ? 'RECENTLY SAID BY YOU (quoted data, not suggested replies):\n' + prior.map(p => JSON.stringify(p)).join('\n') +
      '\nDo not reuse these sentences or retell the same anecdote. A relevant callback may add something new.\n\n' : '') +
    (themeGuidance ? 'OPTIONAL BOT-LOCAL FAMILIARITY: ' + String(themeGuidance).slice(0, 160) + '\n\n' : '') +
    styleGuidance + 'CONTINUE THE EXCHANGE: The immediate parent is the turn to answer, not an example of your style. ' +
    'Let its specific question, claim or joke determine your contribution; earlier branch turns establish context, not a script. ' +
    'Answer, disagree, ask, elaborate or take an absurd consequence that follows from it. Do not restart at the root or substitute a familiar personal story. ' +
    'Your voice and recurring interests may color the response without taking over. No recap or stock closing question is required.\n\n' +
    honesty + context + '\n\nYour reply:';
}

module.exports = { VERSION, OUTPUT_CAP, version, fingerprint, outputState, reserve, priorReplies, memoryGuidance, prompt };
