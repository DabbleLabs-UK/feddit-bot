'use strict';

// Presentation/receipt adapter only. Never rank, filter, admit, vote or publish.
const crypto = require('node:crypto');
const interest = require('./theme-interest');
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const key = value => /^t[13]_[1-9]\d*$/.test(String(value || '')) ? String(value) : '';
const community = value => /^[a-z0-9_-]{1,64}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';

function subject(candidate) {
  const target = candidate && candidate.target;
  if (!target || !key(target.key) || !key('t3_' + target.postId)) return null;
  const feddit = community(target.feddit);
  if (!feddit) return null;
  const fullContext = String(candidate.context || '').trim();
  const visible = clean(fullContext.slice(0, 2500));
  const branch = target.replyBranch;
  let text = '';
  if (target.commentId) {
    // A repeated root/ancestor embedded in a descendant's context must not be
    // credited as a fresh contribution by the descendant's author. If the
    // actual target was cut out of the existing decision excerpt, abstain.
    const source = (candidate.voteItems || []).find(item => item.targetType === 'comment' &&
      't1_' + item.targetId === target.key);
    const body = String(source ? source.content : branch && branch.target && branch.target.body || '').trim();
    // These existing builders put the actual comment last. Prove its exact
    // trailing range fits; a matching sentence in the root is not this source.
    const start = fullContext.length - body.length;
    if (body && fullContext.endsWith(body) && start >= 0 && start + body.length <= 2500) text = clean(body);
  } else {
    const post = branch && branch.post;
    text = [post && post.title, post && post.body, post && post.summary]
      .map(clean).filter(part => part && visible.includes(part)).join(' ');
  }
  if (!text || !target.author) return null;
  return { community: feddit, threadKey: 't3_' + target.postId,
    sourceKey: target.key, author: clean(target.author).slice(0, 128), text };
}

function decorate(snapshot, state, at, operationId) {
  const candidates = snapshot.candidates.map(candidate => {
    const item = subject(candidate);
    const view = item && interest.describe(state, item, { at });
    return view && view.known && view.summary ? { ...candidate,
      themeInterest: { version: interest.VERSION, summary: view.summary,
        familiarity: view.familiarity, satiation: view.satiation, offeredHint: false } } : candidate;
  });
  // At most two short hints in a decision. Candidate order, salience and packing
  // traversal are untouched. A selected candidate may retain its writing cue.
  let hints = 0;
  for (const candidate of candidates) if (candidate.themeInterest && hints++ < interest.LIMITS.hintsPerMenu) {
    candidate.themeInterest.offeredHint = true;
  }
  return { ...snapshot, candidates,
    themeInterestContext: { version: interest.VERSION, at, operationId } };
}

function event(operation, item, kind) {
  return { id: 'theme:' + crypto.createHash('sha256')
    .update(operation.operationId + ':' + kind + ':' + item.sourceKey).digest('hex'),
    at: operation.at, kind, sourceKey: item.sourceKey, threadKey: item.threadKey,
    community: item.community, author: item.author,
    features: interest.features(item.text) };
}

function exposure(snapshot, handled, self) {
  const operation = snapshot && snapshot.themeInterestContext;
  if (!operation) return [];
  interest.version(operation.version);
  const items = new Map();
  const add = item => {
    if (item && item.author.toLowerCase() !== String(self || '').toLowerCase() && !items.has(item.sourceKey)) {
      items.set(item.sourceKey, item);
    }
  };
  if (handled.valid) for (const candidate of handled.candidates || []) add(subject(candidate));
  for (const vote of handled.votes || []) {
    if (vote.decisionKind !== 'explicit' || vote.status === 'unresolved') continue;
    const offered = (handled.voteCandidates || []).find(item => item.id === vote.id);
    if (!offered) continue;
    const sourceKey = (offered.targetType === 'post' ? 't3_' : 't1_') + offered.targetId;
    const sources = [...(snapshot.candidates || []), ...(snapshot.observationCandidates || [])];
    const source = sources.find(candidate => (candidate.target || candidate.themeSource) && (candidate.voteItems || [])
      .some(item => (item.targetType === 'post' ? 't3_' : 't1_') + item.targetId === sourceKey));
    const target = source && (source.target || source.themeSource);
    const feddit = community(target && target.feddit);
    if (!feddit || !key(sourceKey) || !offered.author) continue;
    add({ sourceKey, threadKey: 't3_' + target.postId, community: feddit,
      author: clean(offered.author).slice(0, 128), text: String(offered.content || '').slice(0, 1800) });
  }
  return [...items.values()].map(item => event(operation, item, 'exposure')).filter(item => item.features.length);
}

function participation(operation, item) {
  const rehearsalPost = item && /^r3_[a-f0-9]{64}$/.test(item.sourceKey) && item.threadKey === item.sourceKey;
  if (!item || (!rehearsalPost && (!key(item.sourceKey) || !key(item.threadKey))) || !community(item.community)) return [];
  const receipt = event(operation, { ...item, community: community(item.community) }, 'participation');
  return receipt.features.length ? [receipt] : [];
}

function hint(candidate) {
  const value = candidate && candidate.themeInterest;
  return value && interest.version(value.version) && value.offeredHint
    ? 'OPTIONAL BOT-LOCAL FAMILIARITY: ' + clean(value.summary).slice(0, interest.LIMITS.hintChars) : '';
}

module.exports = { subject, decorate, exposure, participation, hint };
