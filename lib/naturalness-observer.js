'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const WINDOWS = [24, 168, 720];
function windowHours(value) { return WINDOWS.includes(Number(value)) ? Number(value) : 24; }
function authorised(placement, populationAdmin) { return placement !== 'hosted' || populationAdmin === true; }

// Old activity can prove an outcome, but cannot prove the offered slate or
// distinguish an explicit nil from a parser default. Never invent those facts.
function legacyEvents(profiles) {
  const events = [];
  for (const profile of profiles) {
    for (const [index, activity] of (profile.activity || []).slice(-50).entries()) {
      if (activity.kind !== 'vote' || !Array.isArray(activity.votes)) continue;
      const at = Date.parse(activity.at);
      if (!Number.isFinite(at)) continue;
      const opportunityId = 'legacy:' + crypto.createHash('sha256')
        .update(String(profile.id) + ':' + activity.at + ':' + index).digest('hex').slice(0, 24);
      events.push({
        schemaVersion: 1, id: opportunityId + ':outcome', opportunityId,
        at: new Date(at).toISOString(), stage: 'outcome', legacy: true,
        profileId: profile.id, bot: profile.fedditUsername || profile.name || '',
        origin: profile.botOrigin || 'unknown', cohort: profile.populationProvenance?.cohortId || '',
        mode: activity.dryRun === true ? 'rehearsal' : 'live',
        items: activity.votes.slice(0, 8).map((vote) => ({
          key: vote.targetType + ':' + Number(vote.targetId),
          targetType: vote.targetType, targetId: Number(vote.targetId),
          source: 'legacy-activity', community: null, author: null, createdAt: null,
          scoreAtExposure: null, scoreVisibleToModel: null,
          hasSocialContext: null, hasMemoryContext: null,
          direction: vote.direction, decisionKind: 'unknown', status: vote.status,
          reason: vote.reason,
        })),
      });
    }
  }
  return events;
}

function createObserver({ dataDir, request, evidenceStore, buildSnapshot, now = Date.now }) {
  const cachedFile = path.join(dataDir, 'naturalness-authoritative.json');
  const pending = new Map();
  function savedSnapshot() {
    try {
      if (fs.statSync(cachedFile).size > MAX_SNAPSHOT_BYTES) return null;
      const value = JSON.parse(fs.readFileSync(cachedFile, 'utf8'));
      return value.schemaVersion === 1 && value.source === 'feddit-current-votes' && Array.isArray(value.items)
        ? value : null;
    } catch { return null; }
  }
  async function snapshot({ hours, profiles }) {
    // Coalesce duplicate UI refreshes, never an automatic collection loop.
    const scopeKey = windowHours(hours) + ':' + profiles.map((profile) => profile.id).sort().join(',');
    if (pending.has(scopeKey)) return pending.get(scopeKey);
    const run = async () => {
      const warnings = [];
      const selectedHours = windowHours(hours);
      let authoritative = null;
      try {
        const response = await request('/evidence.json?window_hours=' + selectedHours + '&limit=100', { timeoutMs: 5000 });
        if (response?.ok && response.data?.schemaVersion === 1 && response.data?.source === 'feddit-current-votes') {
          authoritative = response.data;
        } else warnings.push('The live Feddit evidence endpoint is unavailable. No automatic retries were made.');
      } catch { warnings.push('The live Feddit evidence read failed. No automatic retries were made.'); }
      let capture = 'live-read';
      if (!authoritative) {
        authoritative = savedSnapshot();
        capture = authoritative ? 'operator-read-only-snapshot' : 'unavailable';
        if (authoritative) warnings.push('Authoritative values are from a saved read-only snapshot, not live scores.');
        else warnings.push('Authoritative vote data is unavailable; observer outcomes are not a replacement for the Feddit ledger.');
      }
      const allowed = new Set(profiles.map((profile) => profile.id));
      const recorded = evidenceStore.list({ since: now() - selectedHours * 3600000 })
        .filter((event) => allowed.has(event.profileId));
      // New observer activity can overlap the old activity list. Only use old
      // entries preceding the first instrumented event for that profile.
      const first = new Map();
      for (const event of recorded) first.set(event.profileId, Math.min(first.get(event.profileId) || Infinity, Date.parse(event.at)));
      const legacy = legacyEvents(profiles).filter((event) => Date.parse(event.at) < (first.get(event.profileId) || Infinity));
      const result = buildSnapshot({ authoritative, events: recorded.concat(legacy), profiles,
        hours: selectedHours, now: now() });
      result.coverage = { ...result.coverage, authoritativeCapture: capture,
        authoritativeCapturedAt: Number.isFinite(Date.parse(authoritative?.generatedAt))
          ? new Date(authoritative.generatedAt).toISOString() : null,
        observerJournal: evidenceStore.coverage ? evidenceStore.coverage() : null,
        warnings: [...(result.coverage?.warnings || []), ...warnings,
          'Older activity outcomes lack exposure and explicit-nil diagnostics. Only this observer\'s accessible profiles are represented.'],
      };
      return result;
    };
    // Coalescing is scoped by authorised profiles and requested time window.
    const promise = run();
    pending.set(scopeKey, promise);
    try { return await promise; } finally { pending.delete(scopeKey); }
  }
  return { snapshot, savedSnapshot };
}

module.exports = { createObserver, legacyEvents, windowHours, authorised, MAX_SNAPSHOT_BYTES };
