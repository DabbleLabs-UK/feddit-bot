'use strict';

// Public reads only. Never imported by the scheduler.
const LIMITS = Object.freeze({ pages: 2, pageSize: 100, threads: 16, items: 1000, text: 4000, responseBytes: 2097152, requests: 19, requestMs: 4000, totalMs: 25000 });
const text = (value, limit) => String(value || '').slice(0, limit);
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const iso = seconds => Number.isFinite(Number(seconds)) && Number(seconds) > 0 && Number(seconds) < 100000000000 ? new Date(Number(seconds) * 1000).toISOString() : null;
function postItem(thing) {
  const p = thing?.data;
  if (thing?.kind !== 't3' || !id(p?.id) || p.over_18 || !/^[a-z0-9_-]+$/i.test(p.feddit || '')) return null;
  return { key: 'post:' + p.id, type: 'post', id: id(p.id), postId: id(p.id), parentKey: null,
    author: text(p.author, 100), community: text(p.feddit, 100), createdAt: iso(p.created_utc),
    title: text(p.title, 300), text: text(p.selftext, LIMITS.text), textLength: String(p.selftext || '').length,
    kind: p.kind === 'link' ? 'link' : 'text', commentCount: Math.max(0, Number(p.num_comments) || 0) };
}
function threadItems(data) {
  const p = postItem(data?.post);
  if (!p) return [];
  const items = [p], stack = [...(data.comments?.data?.children || [])].slice(0, LIMITS.items), seen = new Set();
  while (stack.length && items.length < LIMITS.items) {
    const thing = stack.shift(), c = thing?.data;
    if (thing?.kind !== 't1' || !id(c?.id) || seen.has(c.id) || id(c.post_id) !== p.id) continue;
    seen.add(c.id);
    const parentId = /^t1_([1-9][0-9]*)$/.exec(c.parent_id || '');
    items.push({ key: 'comment:' + c.id, type: 'comment', id: id(c.id), postId: p.id,
      parentKey: parentId ? 'comment:' + parentId[1] : c.parent_id == null ? p.key : null,
      author: text(c.author, 100), community: p.community, createdAt: iso(c.created_utc),
      title: '', text: text(c.body, LIMITS.text), textLength: String(c.body || '').length, kind: 'text' });
    stack.push(...(c.replies?.data?.children || []).slice(0, Math.max(0, LIMITS.items - items.length - stack.length)));
  }
  return items;
}
function createEcologySource({ request, now = Date.now }) {
  const pending = new Map();
  async function collect({ since, until = new Date(now()).toISOString(), votingSnapshot = {} }) {
    const started = now(), items = new Map(), warnings = [], failed = [], threads = new Set();
    const coverage = { source: 'public-feddit-api', sourceSince: since, sourceUntil: until,
      sampleOnly: true, postsComplete: false, commentsComplete: false, requests: 0, threadReads: 0,
      maxThreads: LIMITS.threads, maxItems: LIMITS.items, nsfwIncluded: false, warnings };
    function add(item) { if (item && items.size < LIMITS.items) items.set(item.key, item); }
    async function read(route) {
      if (coverage.requests >= LIMITS.requests || now() - started >= LIMITS.totalMs) { warnings.push('Public-read request/time budget reached.'); return null; }
      coverage.requests++;
      try {
        const r = await request(route, { maxResponseBytes: LIMITS.responseBytes, timeoutMs: Math.min(LIMITS.requestMs, LIMITS.totalMs - (now() - started)) });
        if (!r?.ok || !r.data || Buffer.byteLength(JSON.stringify(r.data)) > LIMITS.responseBytes) { failed.push(route); return null; }
        return r.data;
      } catch { failed.push(route); return null; }
    }
    let after = null;
    for (let page = 0; page < LIMITS.pages; page++) {
      const response = await read('/front/new?limit=' + LIMITS.pageSize + (after === null ? '' : '&after=' + after));
      if (!Array.isArray(response?.data?.children)) break;
      const rows = response.data.children.slice(0, LIMITS.pageSize).map(postItem).filter(Boolean);
      rows.forEach(add);
      const passedStart = rows.some(p => p.createdAt && p.createdAt < since);
      after = response.data.after;
      if (after == null || passedStart) { coverage.postsComplete = true; break; }
      if (!/^\d+$/.test(String(after))) { warnings.push('Invalid public pagination cursor; stopped.'); break; }
    }
    // Include renewed old threads from existing public vote evidence; not a
    // complete index of new replies on every historical thread.
    const renewed = (votingSnapshot.items || []).filter(x => x.targetType === 'comment' && x.createdAt >= since).map(x => id(x.postId)).filter(Boolean);
    const recent = [...items.values()].filter(x => x.commentCount > 0).map(x => x.id);
    for (let i = 0; i < Math.max(renewed.length, recent.length) && threads.size < LIMITS.threads; i++) {
      for (const target of [renewed[i], recent[i]]) if (target && threads.size < LIMITS.threads) threads.add(target);
    }
    const queue = [...threads];
    async function worker() {
      while (queue.length) {
        const response = await read('/comments/' + queue.shift());
        if (response) { coverage.threadReads++; threadItems(response).forEach(add); }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    const directory = await read('/feddits');
    const observed = new Set([...items.values()].map(item => item.community));
    const communities = (Array.isArray(directory?.feddits) ? directory.feddits : []).slice(0, 200)
      .filter(item => observed.has(item.name) && !item.over_18).slice(0, 20).map(item => ({
        name: text(item.name, 100), description: text(item.description, 2000),
        rules: (Array.isArray(item.rules) ? item.rules : []).slice(0, 10).map(rule => text(rule.title, 100) + ': ' + text(rule.detail, 200)).join('\n').slice(0, 2000),
      }));
    coverage.failedReads = failed.length;
    coverage.publicRecords = items.size;
    coverage.truncated = items.size >= LIMITS.items || threads.size >= LIMITS.threads || !coverage.postsComplete;
    if (failed.length) warnings.push(failed.length + ' public reads failed; missing content is not zero activity. No retries.');
    warnings.push('Replies are sampled public content, not a complete site ledger. New comments on unselected old threads may be missing.');
    warnings.push('Older items are retained only as labelled context. Edited/deleted content and publication provenance are not recoverable here.');
    warnings.push('Thread sampling and 4000-character excerpts limit semantic/conversation conclusions. No private persona or memory text is collected.');
    return { items: [...items.values()], communities, coverage };
  }
  function snapshot(options) {
    const key = JSON.stringify([options.since, options.until, (options.votingSnapshot?.items || []).map(x => x.key)]);
    if (pending.has(key)) return pending.get(key);
    const promise = collect(options).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  return { snapshot };
}
module.exports = { LIMITS, createEcologySource, postItem, threadItems };
