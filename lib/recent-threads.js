'use strict';

// Normalises Feddit's bounded recent-comment endpoint into reply candidates.
// It performs no model call and owns no persistence. The scheduler checkpoints
// its result, then records considered event ids only after that durable snapshot
// exists, keeping retries safe.

const ENDPOINT_LIMIT = 10;
const MAX_EVENT_AGE_MS = 72 * 60 * 60 * 1000;

function clean(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalize(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const eventId = String(raw.event_id || '');
  const post = raw.post && typeof raw.post === 'object' ? raw.post : {};
  const fresh = raw.fresh_comment && typeof raw.fresh_comment === 'object' ? raw.fresh_comment : {};
  const parent = raw.parent_comment && typeof raw.parent_comment === 'object' ? raw.parent_comment : null;
  const postId = Number(post.id);
  const commentId = Number(fresh.id);
  const createdUtc = Number(fresh.created_utc) || 0;
  if (!/^active:t1_\d+$/.test(eventId) || !(postId > 0) || !(commentId > 0) || !(createdUtc > 0)) return null;
  const ageMs = Math.max(0, nowMs - createdUtc * 1000);
  if (ageMs > MAX_EVENT_AGE_MS) return null;
  const community = clean(raw.community || post.feddit, 128).replace(/^f\//i, '');
  if (!community) return null;

  const lines = [
    (post.kind === 'link' ? 'LINK POST' : 'POST') + ' in f/' + community,
    'TITLE: ' + clean(post.title, 500),
    post.kind === 'link' && post.url ? 'URL: ' + clean(post.url, 2048) : '',
    post.kind === 'link' && post.og_description ? 'ARTICLE SUMMARY: ' + clean(post.og_description, 2500) : '',
    post.kind !== 'link' && post.selftext ? 'POST BODY: ' + clean(post.selftext, 3500) : '',
    parent ? 'NEARBY PARENT COMMENT by ' + (clean(parent.author, 128) || 'someone') + ': ' + clean(parent.body, 2500) : '',
    'FRESH COMMENT by ' + (clean(fresh.author, 128) || 'someone') + ': ' + clean(fresh.body, 3500),
  ].filter(Boolean);
  const context = lines.join('\n').slice(0, 20_000);

  const voteItems = [{
    targetType: 'post',
    targetId: postId,
    author: clean(post.author, 128),
    label: (post.kind === 'link' ? 'Link post: ' : 'Post: ') + clean(post.title, 300),
    content: lines.slice(0, 5).join('\n'),
  }];
  if (parent && Number(parent.id) > 0) {
    voteItems.push({
      targetType: 'comment', targetId: Number(parent.id), author: clean(parent.author, 128),
      label: 'Comment by ' + (clean(parent.author, 128) || 'someone'), content: clean(parent.body, 2500),
    });
  }
  voteItems.push({
    targetType: 'comment', targetId: commentId, author: clean(fresh.author, 128),
    label: 'Fresh comment by ' + (clean(fresh.author, 128) || 'someone'), content: clean(fresh.body, 3500),
  });

  return {
    source: 'recent_comment_activity',
    eventId,
    key: 't1_' + commentId,
    postId,
    commentId,
    author: clean(fresh.author, 128),
    community,
    createdUtc,
    threadCreatedUtc: Number(post.created_utc) || 0,
    context,
    postKind: clean(post.kind, 16) || 'text',
    voteItems,
  };
}

async function gather({ feddit, token, communities, state, nowMs = Date.now() }) {
  if (!feddit || typeof feddit.activeThreads !== 'function' || !token) {
    return { ok: false, unsupported: true, candidates: [], nextState: null, error: 'active thread endpoint unavailable' };
  }
  const response = await feddit.activeThreads(token, { communities, limit: ENDPOINT_LIMIT });
  if (!response || !response.ok || !response.data || !Array.isArray(response.data.threads)) {
    return {
      ok: false,
      candidates: [],
      nextState: null,
      error: (response && response.error) || 'Could not read recently active Feddit threads.',
    };
  }
  const considered = new Set(Array.isArray(state && state.consideredEventIds)
    ? state.consideredEventIds.map(String)
    : []);
  const seenThisScan = [];
  const candidates = [];
  for (const raw of response.data.threads.slice(0, ENDPOINT_LIMIT)) {
    const candidate = normalize(raw, nowMs);
    if (!candidate) continue;
    seenThisScan.push(candidate.eventId);
    if (!considered.has(candidate.eventId)) candidates.push(candidate);
  }
  return {
    ok: true,
    candidates,
    nextState: { consideredEventIds: [...new Set(seenThisScan)] },
    source: response.data.source || 'recent_comment_activity',
    windowHours: Number(response.data.window_hours) || 72,
  };
}

module.exports = {
  ENDPOINT_LIMIT,
  MAX_EVENT_AGE_MS,
  normalize,
  gather,
};
