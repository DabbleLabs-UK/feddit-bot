'use strict';

// The reply guard belongs to one profile and one live/rehearsal continuity.
// Old runner-wide counts have neither ownership nor time and cannot migrate.
const VERSION = 2;
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 60 * 60 * 1000;
const ATTEMPT_CAP = 500;

function defaults() {
  return { version: VERSION, attempts: [] };
}

function key(value, limit) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const result = String(value).trim();
  return result && result.length <= limit ? result : '';
}

function normalize(state) {
  const attempts = new Map();
  for (const raw of (state && Array.isArray(state.attempts) ? state.attempts : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const postId = key(raw.postId, 160);
    const targetKey = key(raw.targetKey, 512);
    const at = raw.at;
    if (!postId || !targetKey || !Number.isFinite(at) || at < 0) continue;
    const identity = JSON.stringify([postId, targetKey]);
    const previous = attempts.get(identity);
    // Malformed duplicate history must not shorten the guard's window.
    if (!previous || previous.at < at) attempts.set(identity, { postId, targetKey, at });
  }
  // Retain expired IDs within the same bound so a replay cannot refresh their
  // timestamps. Counting alone applies expiry; future times remain conservative.
  return { version: VERSION, attempts: [...attempts.values()].slice(-ATTEMPT_CAP) };
}

function requireNow(nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('A valid reply-guard timestamp is required.');
  return nowMs;
}

function count(state, postId, nowMs) {
  const cutoff = requireNow(nowMs) - WINDOW_MS;
  const postKey = key(postId, 160);
  return normalize(state).attempts.filter((attempt) =>
    attempt.postId === postKey && attempt.at > cutoff
  ).length;
}

// The caller records only accounted attempts, after excluding retryable 429s.
// Admission is separate: recording must preserve every confirmed attempt.
function record(state, postId, options = {}) {
  const nowMs = requireNow(options.nowMs);
  const postKey = key(postId, 160);
  const targetKey = key(options.targetKey, 512);
  if (!postKey || !targetKey) throw new Error('A post ID and stable reply-guard targetKey are required.');
  const next = normalize(state);
  const counted = !next.attempts.some((attempt) =>
    attempt.postId === postKey && attempt.targetKey === targetKey
  );
  if (counted) {
    next.attempts.push({ postId: postKey, targetKey, at: nowMs });
    next.attempts = next.attempts.slice(-ATTEMPT_CAP);
  }
  return { state: next, counted, count: count(next, postKey, nowMs) };
}

module.exports = { VERSION, MAX_ATTEMPTS, WINDOW_MS, ATTEMPT_CAP, defaults, normalize, count, record };
