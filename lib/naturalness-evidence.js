'use strict';

// Derived, content-free observations only. Never an input to bot decisions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_EVENTS = 5000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const WRITING_LIMITS = Object.freeze({ chars: 10000, tokens: 512, ancestors: 3, depth: 64 });
const publicId = (value) => (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const communitySlug = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(max, value) : null;
const clean = (value, limit = 128) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
const bool = (value) => typeof value === 'boolean' ? value : null;
function date(value) {
  if (value == null || value === '') return null;
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}
function reason(value) {
  return clean(value, 240).replace(/\b(?:Bearer\s+\S+|sk-[a-zA-Z0-9_-]+|(?:password|token|api[_ -]?key)\s*[:=]\s*\S+)/gi, '[redacted]');
}
function key(item) {
  const id = Number(item && item.targetId);
  return item && ['post', 'comment'].includes(item.targetType) && Number.isSafeInteger(id) && id > 0
    ? item.targetType + ':' + id : '';
}

function sanitizeWriting(raw) {
  if (!raw || ![1, 2, 3].includes(raw.contractVersion) || !['post', 'comment'].includes(raw.kind) ||
      !['scheduled', 'manual', 'burst'].includes(raw.trigger) || !['published', 'simulated'].includes(raw.status) ||
      ['words', 'titleWords', 'chars'].some((name) => integer(raw[name], WRITING_LIMITS.chars) === null) ||
      typeof raw.endsWithTerminalPunctuation !== 'boolean' || typeof raw.hasWritingMemory !== 'boolean') return null;
  const parentCommentId = raw.kind === 'comment' ? publicId(raw.parentCommentId) : null;
  const ancestorIds = [...new Set((Array.isArray(raw.ancestorIds) ? raw.ancestorIds.slice(0, WRITING_LIMITS.ancestors) : [])
    .map(publicId).filter((value) => value && value !== parentCommentId))];
  const branchComplete = raw.kind === 'comment' ? bool(raw.branchComplete) : null;
  const depth = raw.kind === 'comment' && branchComplete === true && integer(raw.depth, WRITING_LIMITS.depth) > 0
    ? integer(raw.depth, WRITING_LIMITS.depth) : null;
  const lower = raw.kind === 'comment' && integer(raw.depthLowerBound, WRITING_LIMITS.depth) > 0
    ? integer(raw.depthLowerBound, WRITING_LIMITS.depth) : null;
  return {
    contractVersion: raw.contractVersion, kind: raw.kind, trigger: raw.trigger, status: raw.status,
    postId: publicId(raw.postId), commentId: raw.kind === 'comment' ? publicId(raw.commentId) : null,
    parentCommentId, ancestorIds, depth, depthLowerBound: depth === null ? lower : depth, branchComplete,
    words: integer(raw.words, WRITING_LIMITS.chars), titleWords: integer(raw.titleWords, WRITING_LIMITS.chars),
    chars: integer(raw.chars, WRITING_LIMITS.chars), endsWithTerminalPunctuation: raw.endsWithTerminalPunctuation,
    outputLimitReached: bool(raw.outputLimitReached), hasWritingMemory: raw.hasWritingMemory,
    sourceOverlap: Object.fromEntries(['parent', 'ancestors', 'memory'].map((name) =>
      [name, integer(raw.sourceOverlap && raw.sourceOverlap[name], WRITING_LIMITS.tokens) || 0])),
  };
}

function writingText(value) { return typeof value === 'string' ? value.slice(0, WRITING_LIMITS.chars).trim() : ''; }
function words(value) { return writingText(value).toLowerCase().match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) || []; }
function sharedSequence(output, source) {
  const tokens = words(source).slice(0, WRITING_LIMITS.tokens);
  let previous = new Uint16Array(tokens.length + 1), longest = 0;
  for (const token of output) {
    const next = new Uint16Array(tokens.length + 1);
    for (let index = 0; index < tokens.length; index++) {
      if (token === tokens[index]) { next[index + 1] = previous[index] + 1; longest = Math.max(longest, next[index + 1]); }
    }
    previous = next;
  }
  return longest;
}

// The caller supplies confirmed publication/rehearsal status. No source prose
// survives this projection, and these screens never affect generation.
function analyzeWriting({ kind, text, title, target, version, trigger, postId, commentId, usage, outputLimit, memory } = {}) {
  if (!['post', 'comment'].includes(kind) || ![1, 2, 3].includes(version) || !['scheduled', 'manual', 'burst'].includes(trigger)) return null;
  const body = writingText(text), bodyWords = words(body), output = bodyWords.slice(0, WRITING_LIMITS.tokens);
  const resolvedPostId = publicId(postId) || publicId(target && target.postId);
  const parentCommentId = kind === 'comment' ? publicId(target && target.commentId) : null;
  const candidate = kind === 'comment' && target && target.replyBranch;
  const branch = candidate && candidate.version === 1 && publicId(candidate.post && candidate.post.id) === resolvedPostId &&
    (candidate.target ? publicId(candidate.target.id) === parentCommentId && parentCommentId !== null : parentCommentId === null)
    ? candidate : null;
  const seen = new Set([parentCommentId]);
  const ancestors = (Array.isArray(branch && branch.ancestors) ? branch.ancestors.slice(0, WRITING_LIMITS.ancestors) : [])
    .filter((item) => { const id = publicId(item && item.id); if (!id || seen.has(id)) return false; seen.add(id); return true; });
  const explicitRoot = kind === 'comment' && resolvedPostId && !parentCommentId &&
    (branch && branch.target === null || target && Object.hasOwn(target, 'commentId') && target.commentId === null);
  const complete = kind === 'comment' ? !!(explicitRoot || branch && branch.complete === true &&
    (branch.ancestors || []).length === ancestors.length) : null;
  const lower = kind === 'comment' ? (parentCommentId ? 2 + ancestors.length : 1) : null;
  const legacyMemory = memory && memory.prompt ? String(memory.prompt) : '';
  const memoryText = version >= 3 ? require('./public-writing').renderMemory(memory)
    : trigger === 'burst' ? legacyMemory.trim().slice(0, 800)
      : memory && memory.relevant ? legacyMemory.slice(0, 1600) : '';
  const outputTokens = usage && usage.outputTokens;
  const reliableLimit = Number.isSafeInteger(outputLimit) && outputLimit > 0 && Number.isSafeInteger(outputTokens) && outputTokens > 0;
  const parentText = branch ? branch.target ? writingText(branch.target.body)
    : [branch.post.title, branch.post.body, branch.post.summary].map(writingText).filter(Boolean).join('\n').slice(0, WRITING_LIMITS.chars) : '';
  return {
    contractVersion: version, kind, trigger, postId: resolvedPostId, commentId: kind === 'comment' ? publicId(commentId) : null,
    parentCommentId, ancestorIds: ancestors.map((item) => publicId(item.id)),
    depth: complete ? lower : null, depthLowerBound: lower, branchComplete: complete,
    words: bodyWords.length, titleWords: kind === 'post' ? words(title).length : 0, chars: body.length,
    endsWithTerminalPunctuation: /[.!?]["')\]}\u2019\u201d]*$/.test(body),
    outputLimitReached: reliableLimit ? outputTokens >= outputLimit : null,
    hasWritingMemory: !!memoryText,
    sourceOverlap: { parent: sharedSequence(output, parentText),
      ancestors: Math.max(0, ...ancestors.map((item) => sharedSequence(output, item.body))),
      memory: sharedSequence(output, memoryText) },
  };
}

function sanitizeEvent(raw, at) {
  if (!raw || !['offered', 'decision', 'outcome', 'writing'].includes(raw.stage)) return null;
  const opportunityId = clean(raw.opportunityId, 180);
  const profileId = clean(raw.profileId, 100);
  if (!opportunityId || !profileId || !['live', 'rehearsal'].includes(raw.mode)) return null;
  const writing = raw.stage === 'writing' ? sanitizeWriting(raw.writing) : null;
  if (raw.stage === 'writing' && (!writing || writing.status !== (raw.mode === 'live' ? 'published' : 'simulated'))) return null;
  const attempt = raw.stage === 'writing' ? 0 : Math.min(1, Math.max(0, Number(raw.attempt) || 0));
  const seen = new Set();
  const items = [];
  for (const value of raw.stage !== 'writing' && Array.isArray(raw.items) ? raw.items : []) {
    const target = key(value);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const item = {
      key: target, targetType: value.targetType, targetId: Number(value.targetId),
      postId: Number.isSafeInteger(Number(value.postId)) && Number(value.postId) > 0 ? Number(value.postId) : null,
      community: clean(value.community, 100) || null, author: clean(value.author, 100) || null,
      createdAt: date(value.createdAt), source: clean(value.source, 80) || 'unknown',
      scoreAtExposure: typeof value.scoreAtExposure === 'number' && Number.isFinite(value.scoreAtExposure) ? value.scoreAtExposure : null,
      scoreVisibleToModel: bool(value.scoreVisibleToModel), hasSocialContext: bool(value.hasSocialContext),
      hasMemoryContext: bool(value.hasMemoryContext),
    };
    if (raw.stage !== 'offered') {
      item.direction = ['up', 'down', 'nil'].includes(value.direction) ? value.direction : null;
      item.decisionKind = ['explicit', 'missing', 'invalid', 'unknown'].includes(value.decisionKind) ? value.decisionKind : 'unknown';
      item.status = ['decided', 'no-vote', 'cast', 'simulated', 'failed', 'uncertain', 'uncertain-not-retried',
        'capacity-exhausted', 'generation-failed', 'invalid-response', 'not-returned', 'unresolved'].includes(value.status) ? value.status : 'unknown';
      if (item.direction === 'up' || item.direction === 'down') item.reason = reason(value.reason);
    }
    items.push(item);
    if (items.length === 8) break;
  }
  if (!items.length && !writing) return null;
  return {
    schemaVersion: 1,
    id: crypto.createHash('sha256').update(profileId + '\n' + opportunityId + '\n' + raw.stage + '\n' + attempt).digest('hex'),
    at: date(raw.at) || date(at), stage: raw.stage, attempt, opportunityId, profileId,
    bot: clean(raw.bot, 100) || null, origin: clean(raw.origin, 64) || 'unknown',
    cohort: clean(raw.cohort, 100) || null, mode: raw.mode, items,
    ...(writing ? { community: communitySlug(raw.community), writing } : {}),
  };
}

function createEvidenceStore(options = {}) {
  const now = options.now || Date.now;
  const file = options.file;
  const maxEvents = Math.max(1, Math.min(MAX_EVENTS, Number(options.maxEvents) || MAX_EVENTS));
  const maxBytes = Math.max(1024, Math.min(MAX_BYTES, Number(options.maxBytes) || MAX_BYTES));
  const maxAgeMs = Math.max(1, Math.min(MAX_AGE_MS, Number(options.maxAgeMs) || MAX_AGE_MS));
  let events = [];
  let unavailable = false;
  let retentionCleanupPending = false;
  let pruned = 0;
  const warnings = new Set();
  const encode = (list) => JSON.stringify({ schemaVersion: 1, events: list });
  function prune(list) {
    const cutoff = now() - maxAgeMs;
    let retained = list.filter((event) => Date.parse(event.at) >= cutoff).slice(-maxEvents);
    let bytes = Buffer.byteLength(encode(retained));
    let remove = 0;
    while (remove < retained.length && bytes > maxBytes) {
      bytes -= Buffer.byteLength(JSON.stringify(retained[remove])) + (retained.length - remove > 1 ? 1 : 0);
      remove++;
    }
    retained = retained.slice(remove);
    pruned += list.length - retained.length;
    return retained;
  }
  function persist(list) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temporary, encode(list), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* best effort own temporary file */ }
      throw error;
    }
  }
  try {
    if (file && fs.existsSync(file)) {
      if (fs.statSync(file).size > MAX_BYTES) throw new Error('oversized');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.events)) throw new Error('invalid');
      const ids = new Set();
      events = prune(saved.events.map((event) => sanitizeEvent(event, now())).filter((event) => {
        if (!event || ids.has(event.id)) return false;
        ids.add(event.id); return true;
      }));
    }
  } catch {
    unavailable = true;
    warnings.add('Observer journal could not be read; existing evidence was left untouched.');
  }
  if (!unavailable && pruned > 0) {
    try { persist(events); }
    catch {
      retentionCleanupPending = true;
      warnings.add('Expired observer evidence is excluded, but disk retention cleanup could not be saved.');
    }
  }
  function record(raw) {
    try {
      if (unavailable) return false;
      const event = sanitizeEvent(raw, now());
      if (!event) return false;
      if (events.some((item) => item.id === event.id)) return false;
      const next = prune(events.concat(event));
      persist(next);
      retentionCleanupPending = false;
      events = next;
      return true;
    } catch {
      warnings.add('Some observer evidence could not be saved; bot operation was unaffected.');
      return false;
    }
  }
  function list(filter = {}) {
    const since = Math.max(now() - maxAgeMs, filter.since == null ? 0 : (typeof filter.since === 'number' ? filter.since : Date.parse(filter.since)));
    const until = filter.until == null ? now() : (typeof filter.until === 'number' ? filter.until : Date.parse(filter.until));
    return events.filter((event) => Date.parse(event.at) >= since && Date.parse(event.at) <= until &&
      (!filter.mode || event.mode === filter.mode)).map((event) => JSON.parse(JSON.stringify(event)));
  }
  return { record, list, coverage: () => ({ maxEvents, maxBytes, maxAgeMs, retainedEvents: events.length,
    prunedEvents: pruned, unavailable, retentionCleanupPending, warnings: [...warnings], oldestAt: events[0]?.at || null }) };
}

function offeredItems(snapshot, isBurst = false) {
  const sources = snapshot && (snapshot.observationCandidates || snapshot.candidates) || [];
  return (snapshot && snapshot.voteCandidates || []).slice(0, 8).map((vote) => {
    const candidate = sources.find((value) => value.id === vote.sourceCandidateId);
    const raw = candidate && (candidate.voteItems || []).find((value) => key(value) === key(vote));
    const metadata = raw && raw.observerMetadata || {};
    const target = candidate && candidate.target || {};
    const sameTarget = vote.targetType === 'comment' ? Number(target.commentId) === Number(vote.targetId)
      : target.commentId == null && Number(target.postId) === Number(vote.targetId);
    return {
      key: key(vote), targetType: vote.targetType, targetId: vote.targetId,
      postId: metadata.postId || target.postId || null, author: vote.author,
      community: metadata.community || target.feddit || null,
      createdAt: metadata.createdAt || (sameTarget && target.createdUtc > 0 ? target.createdUtc * 1000 : null),
      source: candidate && candidate.candidateType || 'unknown',
      scoreAtExposure: metadata.scoreAtExposure ?? null, scoreVisibleToModel: false,
      // Burst does not print these fields on its voting slate. Linked action
      // context can still exist, so absence of wider context is unknown there.
      hasSocialContext: isBurst ? null : !!vote.socialContext,
      hasMemoryContext: isBurst ? null : !!vote.memoryContext,
    };
  });
}

function itemMetadata(item, post) {
  return { postId: post && post.id || null, community: post && post.feddit || null,
    createdAt: Number(item && (item.created_utc || item.createdUtc)) > 0
      ? Number(item.created_utc || item.createdUtc) * 1000 : null,
    scoreAtExposure: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : null };
}

function decisionItems(text, offered, slate, actualVotes, options = {}) {
  let parsed = null;
  let validJson = false;
  try {
    parsed = JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
    validJson = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch { /* diagnostics only; the production parser remains authoritative */ }
  const supplied = new Map();
  for (const raw of validJson && Array.isArray(parsed.votes) ? parsed.votes : []) {
    const id = options.burst ? String(raw && raw.id || '') : clean(raw && raw.id, 20).toUpperCase();
    if (!supplied.has(id)) supplied.set(id, raw);
  }
  return offered.map((item, index) => {
    const raw = supplied.get(slate[index] && slate[index].id);
    const actual = (actualVotes || []).find((vote) => key(vote) === item.key);
    // Versioned decisions carry authoritative component validity, including
    // accepted first-attempt votes pinned across a primary-choice repair.
    // Historical decisions without that field retain the observer's old rules.
    if (actual && (!options.failed || actual.decisionKind === 'explicit') &&
        ['explicit', 'missing', 'invalid'].includes(actual.decisionKind)) {
      return { ...item, direction: actual.direction, decisionKind: actual.decisionKind,
        status: actual.status, reason: actual.reason || '' };
    }
    let decisionKind = options.failed ? 'unknown' : (!validJson ? 'invalid' : (!raw ? 'missing' : 'invalid'));
    if (!options.failed && raw) {
      const direction = options.burst ? String(raw.direction || '') : clean(raw.direction, 12).toLowerCase();
      if (direction === 'nil' || (actual && actual.direction === direction && ['up', 'down'].includes(direction))) decisionKind = 'explicit';
    }
    return { ...item, direction: options.failed ? null : (actual && actual.direction || 'nil'), decisionKind,
      status: options.failed ? 'generation-failed' : (actual && actual.status || (!validJson ? 'invalid-response' : 'not-returned')),
      reason: actual && actual.reason || '' };
  });
}

module.exports = { createEvidenceStore, offeredItems, decisionItems, itemMetadata, sanitizeEvent, sanitizeWriting,
  analyzeWriting, communitySlug, WRITING_LIMITS, MAX_EVENTS, MAX_BYTES, MAX_AGE_MS };
