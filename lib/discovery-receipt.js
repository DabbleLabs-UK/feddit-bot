'use strict';

const attention = require('./attention');

// A fetched event is not a receipt. Only a handled primary menu or an explicit
// decision about the exact voting target acknowledges that discovery event.
function plan(snapshot, handled = {}) {
  const keys = new Set();
  // Existing dedupe is proof of a prior handled target, not a fresh model offer.
  // Let missed/outage receipts catch up without pinning a source cursor forever.
  for (const key of snapshot && snapshot.attentionScan && snapshot.attentionScan.alreadyHandledEventIds || []) keys.add(key);
  if (handled.valid) {
    for (const candidate of handled.candidates || []) {
      if (candidate && candidate.target && candidate.target.key) keys.add(candidate.target.key);
    }
  }
  for (const vote of handled.votes || []) {
    if (vote.decisionKind !== 'explicit' || vote.status === 'unresolved') continue;
    if (vote.targetType === 'post' && Number(vote.targetId) > 0) keys.add('t3_' + vote.targetId);
    if (vote.targetType === 'comment' && Number(vote.targetId) > 0) keys.add('t1_' + vote.targetId);
  }
  const attentionScan = snapshot && snapshot.attentionScan
    ? attention.handledScan(snapshot.attentionScan, keys) : null;
  const active = snapshot && snapshot.activeThreadScan;
  const activeThreadScan = active ? {
    consideredEventIds: [...new Set([
      ...(active.alreadyHandledEventIds || []),
      ...(active.consideredEventIds || []).filter((id) =>
        /^active:t1_\d+$/.test(id) && keys.has(String(id).slice('active:'.length))),
    ])],
  } : null;
  return { attentionScan, activeThreadScan };
}

module.exports = { plan };
