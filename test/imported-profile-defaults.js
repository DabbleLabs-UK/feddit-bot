'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-import-defaults-'));
process.env.FEDDIT_BOT_DATA_DIR = root;
const store = require('../lib/store');
const defaults = require('../lib/imported-profile-defaults');
const scheduler = require('../lib/scheduler');
const ecology = require('../lib/population-activity');
let checks = 0;
function eq(a,b,label) { assert.deepEqual(a,b,label); checks++; }
const state = ecology.initialState({ nowMs: Date.now(), quantile: 0.7, random: () => 0.5 });
const base = { botOrigin: 'system', canStartDiscussions: true, canReply: true, canShareLinks: true, canVote: true,
  postsPerHour: 0, articlePostsPerHour: 0, commentsPerHour: 0, votesPerHour: 0,
  provider: 'ollama', model: 'runtime', persona: 'Untouched', enabled: false, dryRun: true,
  populationActivity: state, populationProvenance: { source: defaults.SOURCE,
    externalAssociation: { source: defaults.SOURCE, reference: 'stable-workspace' } } };
try {
  eq(defaults.association({ botOrigin: 'system', populationProvenance: null }), null, 'legacy system profile without provenance safely excluded');
  const staged = defaults.applyStagingDefaults(structuredClone(base), store, 'fixture import');
  eq(staged.enabled, false, 'staging stays disabled');
  eq(staged.dryRun, true, 'staging stays rehearsal');
  eq(staged.provider, base.provider, 'provider unchanged');
  eq(staged.model, base.model, 'model unchanged');
  eq(staged.persona, base.persona, 'persona unchanged');
  eq(staged.postsPerHour, scheduler.populationRate(base, 'post'), 'same established ecology text budget');
  eq(staged.commentsPerHour, scheduler.populationRate(base, 'comment'), 'same established ecology reply budget');
  eq(staged.votesPerHour, 0, 'repair/default does not invent standalone votes');
  const later = defaults.applyStagingDefaults({ ...base, populationProvenance: { ...base.populationProvenance, cohortId: 'second-batch' } }, store, 'fixture import');
  eq(later.groupId, staged.groupId, 'multiple batches share stable group');
  store.renameGroup(staged.groupId, 'Renamed');
  defaults.applyStagingDefaults(structuredClone(base), store, 'fixture import');
  eq(store.listGroups()[0].name, 'Renamed', 'later batch preserves operator rename');
  const generic = { ...base, populationProvenance: { source: 'other', externalAssociation: { source: 'other', reference: 'x' } } };
  eq(defaults.applyStagingDefaults(structuredClone(generic), store), generic, 'generic external seeds unchanged');
  const p = store.createProfile({ ...base, fedditUsername: 'fixture_one', enabled: true, dryRun: false,
    sched: { nextPostAt: 123456789, nextCommentAt: 987654321 }, memoryState: { episodes: [] } });
  const custom = store.createProfile({ ...base, fedditUsername: 'custom', populationCadenceMode: 'custom' });
  const nonzero = store.createProfile({ ...base, fedditUsername: 'nonzero', commentsPerHour: 0.25 });
  const manual = store.createProfile({ fedditUsername: 'manual', enabled: true, postsPerHour: 0, commentsPerHour: 0 });
  const unknown = store.createProfile({ ...base, fedditUsername: 'no_evidence' });
  const session = { input: { subreddit: 'fixture' }, importResult: { provenance: { analysisId: 'stable-workspace' } }, staging: {
    destination: 'local', results: [p, custom, nonzero, manual].map((x,i) => ({ code: 'STAGED', ok: true,
      profileId: x.id, username: x.fedditUsername, importerCandidateId: 'candidate-' + i })) } };
  const before = structuredClone(store.listProfiles());
  const plan = defaults.repairPlan(before, session);
  eq(plan.length, 3, 'only matched system importer identities, not manual or unconfirmed');
  eq(plan.find((x) => x.profileId === custom.id).patch, {}, 'explicit custom zero untouched');
  eq(plan.find((x) => x.profileId === nonzero.id).patch, {}, 'nonzero custom settings preserved');
  defaults.applyRepair(store, plan);
  const after = store.getProfile(p.id);
  for (const field of ['provider','model','persona','enabled','dryRun','sched','memoryState','populationActivity','populationProvenance','simulationState']) {
    eq(after[field], before.find((x) => x.id === p.id)[field], field + ' preserved exactly');
  }
  eq(store.getProfile(manual.id), before.find((x) => x.id === manual.id), 'unrelated manual profile unchanged');
  eq(store.getProfile(unknown.id), before.find((x) => x.id === unknown.id), 'unconfirmed profile unchanged');
  eq(defaults.repairPlan(store.listProfiles(), session).every((x) => !Object.keys(x.patch).length && !x.needsGroup), true, 'repair is idempotent');
  eq(defaults.repairPlan(before, { ...session, staging: { ...session.staging, destination: 'hosted' } }), [], 'remote destination never repairs local data');
  eq(defaults.groupId('same', 'owner-a') !== defaults.groupId('same', 'owner-b'), true, 'group IDs scoped to owner');
  console.log('Imported profile defaults: ' + checks + ' checks passed; no network or registration calls.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
