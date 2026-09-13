'use strict';

// Normalize Feddit's authenticated attention events into one representation the
// scheduler can later place alongside ordinary feed candidates. This module
// deliberately performs no personality inference and stores no relationship or
// memory model; it only turns reliable structural signals into bounded context.

const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 3;
const PAGE_LIMIT = 100;

const PRIORITY = Object.freeze({
  reply_to_own_comment: 500,
  reply_to_own_post: 450,
  nested_continuation: 400,
  mention_in_comment: 350,
  mention_in_post: 300,
});

function clean(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeEvent(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '');
  const eventId = String(raw.event_id || '');
  const postId = Number(raw.post_id);
  const createdUtc = Number(raw.created_utc) || 0;
  if (!(type in PRIORITY) || !/^(?:t1|t3)_\d+$/.test(eventId) || !Number.isFinite(postId) || postId <= 0) {
    return null;
  }
  const ageMs = createdUtc > 0 ? Math.max(0, nowMs - createdUtc * 1000) : Number.POSITIVE_INFINITY;
  if (ageMs > MAX_EVENT_AGE_MS) return null;

  const sourceType = raw.source_type === 'post' ? 'post' : 'comment';
  const commentId = raw.comment_id == null ? null : Number(raw.comment_id);
  const parentCommentId = raw.parent_comment_id == null ? null : Number(raw.parent_comment_id);
  const context = raw.context && typeof raw.context === 'object' ? raw.context : {};
  const post = context.post && typeof context.post === 'object' ? context.post : {};
  const chain = Array.isArray(context.parent_chain) ? context.parent_chain.slice(-4) : [];
  const community = clean(raw.community || post.community, 128).replace(/^f\//i, '');

  const contextLines = [
    (post.kind === 'link' ? 'LINK POST' : 'POST') + (community ? ' in f/' + community : ''),
    post.title ? 'TITLE: ' + clean(post.title, 500) : '',
    post.kind === 'link' && post.url ? 'URL: ' + clean(post.url, 2048) : '',
    post.body ? 'POST BODY: ' + clean(post.body, 4000) : '',
  ].filter(Boolean);
  if (chain.length) {
    contextLines.push('RECENT PARENT CHAIN:');
    for (const parent of chain) {
      contextLines.push((clean(parent.author, 128) || 'someone') + ': ' + clean(parent.body, 2000));
    }
  }
  if (sourceType === 'comment') {
    contextLines.push('NEW COMMENT by ' + (clean(raw.author, 128) || 'someone') + ': ' + clean(raw.body, 4000));
  } else {
    contextLines.push('THIS POST MENTIONS YOU.');
  }

  return {
    source: 'feddit_attention',
    sourceType,
    type,
    eventId,
    key: eventId,
    postId,
    commentId: Number.isFinite(commentId) && commentId > 0 ? commentId : null,
    parentCommentId: Number.isFinite(parentCommentId) && parentCommentId > 0 ? parentCommentId : null,
    author: clean(raw.author, 128),
    community,
    createdUtc,
    recencyMs: ageMs,
    directness: clean(raw.directness, 32) || 'indirect',
    directlyAddressesBot: raw.directly_addresses_bot === true,
    mentioned: raw.mentioned === true,
    seen: raw.seen === true,
    reason: clean(raw.reason, 500),
    context: contextLines.join('\n').slice(0, 20_000),
    postKind: clean(post.kind, 16) || 'text',
    postUrl: clean(post.url, 2048),
    priority: PRIORITY[type],
  };
}

function rank(candidates) {
  return [...candidates].sort((a, b) =>
    b.priority - a.priority || b.createdUtc - a.createdUtc || a.eventId.localeCompare(b.eventId)
  );
}

// Fetch bounded pages without mutating the store. The caller persists nextState
// only after its durable target checkpoint is recorded, preventing a crash from
// acknowledging an event before the selected action can be resumed.
async function gather({ feddit, token, state, nowMs = Date.now(), maxPages = MAX_PAGES }) {
  if (!feddit || typeof feddit.attention !== 'function' || !token) {
    return { ok: false, unsupported: true, candidates: [], nextState: null, error: 'attention endpoint unavailable' };
  }
  const current = state && typeof state === 'object' ? state : {};
  let cursor = {
    comments: Math.max(0, Number(current.cursor && current.cursor.comments) || 0),
    posts: Math.max(0, Number(current.cursor && current.cursor.posts) || 0),
  };
  const alreadySeen = new Set(Array.isArray(current.seenEventIds) ? current.seenEventIds.map(String) : []);
  const seenThisScan = [];
  const candidates = [];
  let pages = 0;

  while (pages < Math.max(1, maxPages)) {
    const response = await feddit.attention(token, {
      afterComment: cursor.comments,
      afterPost: cursor.posts,
      limit: PAGE_LIMIT,
    });
    if (!response || !response.ok || !response.data || typeof response.data !== 'object') {
      return {
        ok: false,
        candidates: [],
        nextState: null,
        error: (response && response.error) || 'Could not read Feddit attention events.',
      };
    }
    pages++;
    const data = response.data;
    for (const raw of (Array.isArray(data.events) ? data.events : [])) {
      const eventId = String(raw && raw.event_id || '');
      if (eventId && !alreadySeen.has(eventId)) seenThisScan.push(eventId);
      const candidate = normalizeEvent(raw, nowMs);
      if (candidate && !alreadySeen.has(candidate.eventId)) {
        candidates.push(candidate);
        alreadySeen.add(candidate.eventId);
      }
    }
    cursor = {
      comments: Math.max(cursor.comments, Number(data.cursor && data.cursor.comments) || 0),
      posts: Math.max(cursor.posts, Number(data.cursor && data.cursor.posts) || 0),
    };
    if (!data.has_more) break;
  }

  return {
    ok: true,
    candidates: rank(candidates),
    nextState: { cursor, seenEventIds: [...new Set(seenThisScan)] },
    pages,
  };
}

module.exports = {
  MAX_EVENT_AGE_MS,
  MAX_PAGES,
  PAGE_LIMIT,
  PRIORITY,
  normalizeEvent,
  rank,
  gather,
};
