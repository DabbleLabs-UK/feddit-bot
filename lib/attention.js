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

  const seenItems = [];
  if (Number(post.post_id) > 0 || postId > 0) {
    seenItems.push({
      targetType: 'post',
      targetId: Number(post.post_id) > 0 ? Number(post.post_id) : postId,
      author: clean(post.author, 128),
      label: (post.kind === 'link' ? 'Link post' : 'Post') + (post.title ? ': ' + clean(post.title, 300) : ''),
      content: contextLines.slice(0, 4).join('\n'),
    });
  }
  for (const parent of chain) {
    const id = Number(parent.comment_id);
    if (!(id > 0)) continue;
    seenItems.push({
      targetType: 'comment',
      targetId: id,
      author: clean(parent.author, 128),
      label: 'Comment by ' + (clean(parent.author, 128) || 'someone'),
      content: clean(parent.body, 2000),
    });
  }
  if (sourceType === 'comment' && Number.isFinite(commentId) && commentId > 0) {
    seenItems.push({
      targetType: 'comment',
      targetId: commentId,
      author: clean(raw.author, 128),
      label: 'Comment by ' + (clean(raw.author, 128) || 'someone'),
      content: clean(raw.body, 4000),
    });
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
    seenItems,
  };
}

function rank(candidates) {
  return [...candidates].sort((a, b) =>
    b.priority - a.priority || b.createdUtc - a.createdUtc || a.eventId.localeCompare(b.eventId)
  );
}

// A durable decision acknowledges only its handled targets. Every other valid
// event keeps its source cursor behind it so a later scan can offer it again.
function handledScan(scan, handledTargetKeys) {
  const current = scan && typeof scan === 'object' ? scan : {};
  const startCursor = {
    comments: Math.max(0, Number(current.startCursor && current.startCursor.comments) || 0),
    posts: Math.max(0, Number(current.startCursor && current.startCursor.posts) || 0),
  };
  const handled = new Set((Array.isArray(handledTargetKeys) || handledTargetKeys instanceof Set
    ? [...handledTargetKeys] : []).filter((key) => typeof key === 'string' && /^(?:t1|t3)_\d+$/.test(key)));
  const seenEventIds = Array.isArray(current.seenEventIds) ? current.seenEventIds : [];
  // Without the complete pending list, handled IDs prove only their own receipt.
  if (!Array.isArray(current.pendingEventIds)) {
    return {
      cursor: startCursor,
      seenEventIds: [...new Set(seenEventIds.filter((key) => handled.has(key)))],
    };
  }

  const pending = new Set(current.pendingEventIds);
  const cursor = {
    comments: Math.max(startCursor.comments, Number(current.cursor && current.cursor.comments) || 0),
    posts: Math.max(startCursor.posts, Number(current.cursor && current.cursor.posts) || 0),
  };
  for (const eventId of pending) {
    if (handled.has(eventId)) continue;
    const match = typeof eventId === 'string' && /^(t1|t3)_(\d+)$/.exec(eventId);
    if (!match) {
      cursor.comments = startCursor.comments;
      cursor.posts = startCursor.posts;
      continue;
    }
    const source = match[1] === 't1' ? 'comments' : 'posts';
    const id = Number(match[2]);
    cursor[source] = Number.isSafeInteger(id) && id > 0
      ? Math.max(startCursor[source], Math.min(cursor[source], id - 1))
      : startCursor[source];
  }
  return {
    cursor,
    seenEventIds: [...new Set([...seenEventIds, ...pending])]
      .filter((key) => !pending.has(key) || handled.has(key)),
  };
}

// Fetch bounded pages without mutating the store. nextState retains the legacy
// scan fields; new decisions derive selective receipts only after their durable
// target checkpoint is recorded, so selected actions can resume after a crash.
async function gather({ feddit, token, state, nowMs = Date.now(), maxPages = MAX_PAGES }) {
  if (!feddit || typeof feddit.attention !== 'function' || !token) {
    return { ok: false, unsupported: true, candidates: [], nextState: null, error: 'attention endpoint unavailable' };
  }
  const current = state && typeof state === 'object' ? state : {};
  const startCursor = {
    comments: Math.max(0, Number(current.cursor && current.cursor.comments) || 0),
    posts: Math.max(0, Number(current.cursor && current.cursor.posts) || 0),
  };
  let cursor = { ...startCursor };
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
    nextState: {
      cursor,
      seenEventIds: [...new Set(seenThisScan)],
      startCursor,
      pendingEventIds: candidates.map((candidate) => candidate.eventId),
    },
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
  handledScan,
  gather,
};
