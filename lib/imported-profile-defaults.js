'use strict';

// Organizational association and a one-time, evidence-checked repair. This does
// not participate in registration, recovery, activation, or importer persistence.
const crypto = require('node:crypto');
const SOURCE = 'subreddit-culture-importer';
const RATE_FIELDS = { post: 'postsPerHour', article: 'articlePostsPerHour', comment: 'commentsPerHour', vote: 'votesPerHour' };

function association(profile) {
  const p = profile && profile.populationProvenance;
  const a = p && p.externalAssociation;
  return profile && profile.botOrigin === 'system' && p && p.source === SOURCE && a && a.source === SOURCE && a.reference ? a : null;
}

function groupId(reference, ownerId = '') {
  return 'import_' + crypto.createHash('sha256').update(JSON.stringify([ownerId || '', SOURCE, reference])).digest('hex').slice(0, 24);
}

function ensureGroup(store, reference, name, ownerId) {
  if (!reference || typeof store.createGroup !== 'function') return null;
  return store.createGroup(name || 'Culture import ' + reference.slice(0, 8), { id: groupId(reference, ownerId), ownerId });
}

function ecologyRates(profile) {
  const { populationRate } = require('./scheduler');
  if (!profile.populationActivity || !(Number(profile.populationActivity.currentDailyOpportunities) > 0)) return null;
  return Object.fromEntries(Object.entries(RATE_FIELDS).map(([kind, field]) =>
    [field, populationRate(profile, kind, profile.populationActivity)]));
}

function applyStagingDefaults(patch, store, name) {
  const a = association(patch);
  if (!a) return patch; // Generic external seeds retain their existing contract.
  const rates = ecologyRates(patch);
  if (rates) Object.assign(patch, rates);
  const group = ensureGroup(store, a.reference, name, patch.ownerId);
  if (group) patch.groupId = group.id;
  return patch;
}

function repairPlan(profiles, session) {
  const reference = session && session.importResult && session.importResult.provenance && session.importResult.provenance.analysisId;
  if (!reference || session.staging && session.staging.destination === 'hosted') return [];
  const confirmed = new Map((session.staging && session.staging.results || [])
    .filter((r) => r.code === 'STAGED' && r.ok === true && r.profileId && r.importerCandidateId)
    .map((r) => [r.profileId, r]));
  return profiles.flatMap((p) => {
    const a = association(p);
    const result = confirmed.get(p.id);
    if (!a || a.reference !== reference || !result ||
        String(result.username || '').toLowerCase() !== String(p.fedditUsername || '').toLowerCase()) return [];
    const patch = {};
    // Only the demonstrated missing-default shape, never customized rates.
    if (p.populationCadenceMode !== 'custom' &&
        ['postsPerHour', 'articlePostsPerHour', 'commentsPerHour'].every((f) => Number(p[f]) === 0)) {
      const rates = ecologyRates(p);
      if (rates) for (const field of Object.values(RATE_FIELDS)) {
        if (Number(p[field]) === 0 && rates[field] > 0) patch[field] = rates[field];
      }
    }
    return [{ profileId: p.id, username: p.fedditUsername, ownerId: p.ownerId,
      reference, name: String(session.input && session.input.subreddit || 'Culture').replace(/^r\//, '') + ' import',
      needsGroup: !p.groupId, patch,
      before: Object.fromEntries(Object.values(RATE_FIELDS).map((f) => [f, p[f]])),
      after: Object.fromEntries(Object.values(RATE_FIELDS).map((f) => [f, patch[f] ?? p[f]])) }];
  });
}

function applyRepair(store, plan) {
  return plan.map((item) => {
    const current = store.getProfile(item.profileId);
    if (!current) throw new Error('Profile changed during repair.');
    if (Object.entries(item.before).some(([field, value]) => current[field] !== value) ||
        (item.needsGroup && current.groupId)) throw new Error('Profile changed during repair; inspect a fresh plan.');
    if (Object.keys(item.patch).length) store.updateProfile(item.profileId, item.patch);
    if (item.needsGroup) {
      const group = ensureGroup(store, item.reference, item.name, item.ownerId);
      store.assignProfileGroup(item.profileId, group.id, { ownerId: item.ownerId });
    }
    return { profileId: item.profileId, username: item.username, before: item.before, after: item.after,
      groupId: store.getProfile(item.profileId).groupId };
  });
}

module.exports = { SOURCE, RATE_FIELDS, association, groupId, ensureGroup, ecologyRates, applyStagingDefaults, repairPlan, applyRepair };
