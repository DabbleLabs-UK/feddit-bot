'use strict';

// Source context only: these bounds never trim a generated public reply.
const VERSION = 1;
const MAX_ANCESTORS = 3;
const MAX_CONTEXT_CHARS = 5000;
const MAX_TRAVERSAL = 64;
const MAX_COMMENTS = 1000;

function id(value) {
  const text = String(value == null ? '' : value).replace(/^t[13]_/, '');
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function excerpt(value, limit) {
  const text = String(value == null ? '' : value).trim();
  if (text.length <= limit) return text;
  const marker = ' [excerpt]';
  const head = text.slice(0, Math.max(0, limit - marker.length));
  const sentences = [...head.matchAll(/[.!?](?:["')\]]?)(?=\s|$)/g)];
  const last = sentences[sentences.length - 1];
  const end = last && last.index + last[0].length;
  const space = head.lastIndexOf(' ');
  return (end ? head.slice(0, end) : space > 0 ? head.slice(0, space) : head).trimEnd() + marker;
}

function normalizePost(raw) {
  const post = raw && typeof raw === 'object' ? raw : {};
  return {
    id: id(post.id == null ? post.post_id : post.id),
    title: excerpt(post.title || '', 500),
    headline: excerpt(post.headline || post.og_title || '', 500),
    body: excerpt(post.body == null ? post.selftext : post.body, 8000),
    kind: post.kind === 'link' || post.is_self === false ? 'link' : 'text',
    url: excerpt(post.url, 2048),
    summary: excerpt(post.summary == null ? post.og_description : post.summary, 2500),
  };
}

function commentId(raw) {
  return id(raw && (raw.id == null ? raw.comment_id : raw.id));
}

function parent(raw, postId) {
  if (!raw || typeof raw !== 'object') return { known: false, id: null, root: false };
  const key = ['parent_id', 'parent_comment_id', 'parentId'].find((name) =>
    Object.prototype.hasOwnProperty.call(raw, name));
  if (!key) return { known: false, id: null, root: false };
  const value = raw[key];
  if (value == null || value === '' || value === 0 || value === '0') {
    return { known: true, id: null, root: true };
  }
  if (String(value).startsWith('t3_')) {
    return { known: true, id: null, root: id(value) === postId };
  }
  return { known: true, id: id(value), root: false };
}

function samePost(raw, postId) {
  const value = raw && (raw.post_id == null ? raw.link_id : raw.post_id);
  return value == null || id(value) === postId;
}

function normalizeComment(raw) {
  return {
    id: commentId(raw),
    author: excerpt(raw && raw.author, 128),
    body: excerpt(raw && raw.body, 4000),
  };
}

function forPost(raw) {
  return { version: VERSION, post: normalizePost(raw), target: null, ancestors: [], complete: true };
}

function fromComment(rawPost, selected, flatComments) {
  const post = normalizePost(rawPost);
  if (!selected || typeof selected !== 'object') return forPost(rawPost);
  const relation = parent(selected, post.id);
  const branch = {
    version: VERSION,
    post,
    target: { ...normalizeComment(selected), parentId: relation.id },
    ancestors: [],
    complete: false,
  };
  if (!samePost(selected, post.id)) return branch;
  const comments = new Map();
  for (const item of Array.isArray(flatComments) ? flatComments.slice(0, MAX_COMMENTS) : []) {
    const key = commentId(item);
    if (key && samePost(item, post.id) && !comments.has(key)) comments.set(key, item);
  }
  const seen = new Set([branch.target.id]);
  let current = relation;
  let depth = 0;
  for (; depth < MAX_TRAVERSAL; depth++) {
    if (current.root) {
      branch.complete = depth <= MAX_ANCESTORS;
      break;
    }
    if (!current.known || !current.id || seen.has(current.id)) break;
    const item = comments.get(current.id);
    if (!item) break;
    const next = parent(item, post.id);
    // An explicit different root cannot belong to this post's branch.
    if (String(item.parent_id || '').startsWith('t3_') && !next.root) break;
    seen.add(current.id);
    if (branch.ancestors.length < MAX_ANCESTORS) branch.ancestors.unshift(normalizeComment(item));
    current = next;
  }
  return branch;
}

function fromAttention(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const context = source.context && typeof source.context === 'object' ? source.context : {};
  const rawPost = { ...context.post };
  if (rawPost.id == null && rawPost.post_id == null) rawPost.id = source.post_id;
  if (source.source_type === 'post') return forPost(rawPost);
  const post = normalizePost(rawPost);
  const relation = parent(source, post.id);
  const target = { ...normalizeComment({ ...source, id: source.comment_id || source.id }), parentId: relation.id };
  const chain = Array.isArray(context.parent_chain) ? context.parent_chain : [];
  const branch = { version: VERSION, post, target, ancestors: [], complete: false };
  if (!samePost(source, post.id)) return branch;
  if (relation.root) {
    branch.complete = true;
    return branch;
  }
  const seen = new Set([target.id]);
  let expected = relation.id;
  let omitted = false;
  for (let index = chain.length - 1; index >= Math.max(0, chain.length - MAX_TRAVERSAL); index--) {
    const item = chain[index];
    const key = commentId(item);
    if (!key || seen.has(key) || !samePost(item, post.id) || (expected && key !== expected)) {
      omitted = true;
      break;
    }
    const next = parent(item, post.id);
    if (String(item.parent_id || '').startsWith('t3_') && !next.root) {
      omitted = true;
      break;
    }
    seen.add(key);
    if (branch.ancestors.length < MAX_ANCESTORS) branch.ancestors.unshift(normalizeComment(item));
    else omitted = true;
    if (next.root) {
      branch.complete = !omitted;
      break;
    }
    expected = next.id;
  }
  return branch;
}

function fromRenewed(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const post = normalizePost(source.post);
  const fresh = source.fresh_comment || {};
  const nearby = source.parent_comment;
  const relation = parent(fresh, post.id);
  const branch = fromComment(source.post, fresh, nearby ? [nearby] : []);
  if (!branch.target) return branch;
  // This endpoint explicitly supplies the immediate parent, even when its
  // compact fresh-comment record omits the parent ID. Older ancestors remain unknown.
  if (!relation.known && nearby && commentId(nearby) && commentId(nearby) !== branch.target.id &&
      samePost(fresh, post.id) && samePost(nearby, post.id)) {
    const next = parent(nearby, post.id);
    if (!String(nearby.parent_id || '').startsWith('t3_') || next.root) {
      branch.target.parentId = commentId(nearby);
      branch.ancestors = [normalizeComment(nearby)];
      branch.complete = next.root;
    }
  }
  return branch;
}

function postLines(post, bodyLimit) {
  return [
    'TITLE: ' + excerpt(post.title, 500),
    post.kind === 'link' && post.headline && post.headline !== post.title ? 'SOURCE HEADLINE: ' + excerpt(post.headline, 300) : '',
    post.kind === 'link' && post.url ? 'URL: ' + excerpt(post.url, 300) : '',
    post.kind === 'link' && post.summary ? 'ARTICLE SUMMARY: ' + excerpt(post.summary, bodyLimit) : '',
    post.kind !== 'link' && post.body ? 'POST BODY: ' + excerpt(post.body, bodyLimit) : '',
  ].filter(Boolean).join('\n');
}

function render(raw) {
  const branch = raw && typeof raw === 'object' ? raw : {};
  const post = normalizePost(branch.post);
  if (!branch.target) {
    return 'POST YOU ARE REPLYING TO:\n' + postLines(post, 3300);
  }
  const target = normalizeComment(branch.target);
  const targetText = 'IMMEDIATE PARENT YOU ARE REPLYING TO (by ' + (target.author || 'someone') + '):\n' +
    excerpt(target.body, 2600);
  const ancestors = (Array.isArray(branch.ancestors) ? branch.ancestors : [])
    .filter((item) => commentId(item) && commentId(item) !== target.id).slice(-MAX_ANCESTORS)
    .map((item) => normalizeComment(item));
  const background = 'ORIGINAL POST - BACKGROUND:\n' + postLines(post, 850);
  let omitted = false;
  function join() {
    const history = ancestors.length ? 'ANCESTOR BRANCH (oldest to nearest):\n' + ancestors
      .map((item) => (item.author || 'someone') + ': ' + excerpt(item.body, 900)).join('\n\n') : '';
    const limited = omitted ? 'Some earlier branch context was omitted for space. Do not invent it.'
      : branch.complete !== true ? 'Some earlier branch context is unavailable. Do not invent it.' : '';
    return [background, history, limited, targetText].filter(Boolean).join('\n\n');
  }
  let text = join();
  while (text.length > MAX_CONTEXT_CHARS && ancestors.length) {
    ancestors.shift();
    omitted = true;
    text = join();
  }
  return text;
}

module.exports = { VERSION, MAX_ANCESTORS, MAX_CONTEXT_CHARS, fromAttention, fromRenewed, fromComment, forPost, render };
