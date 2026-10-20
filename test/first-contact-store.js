'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const first = require('../lib/first-contact');
const ordinary = require('../lib/ordinary-candidates');
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-first-contact-'));
const previousDataDir = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
const storePath = require.resolve('../lib/store');
const secretsPath = require.resolve('../lib/secrets');
try {
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    schemaVersion: 27, profiles: [{ id: 'legacy', fedditUsername: 'legacy_bot', repliedTo: ['t1_9'] }],
    settings: {}, groups: [],
  }));
  let store = require('../lib/store');
  eq(store.getOrdinaryCandidateState('legacy'), ordinary.defaults(), 'legacy profile invents no assessments');
  store.recordOrdinaryCandidateShortlist('legacy', ordinary.receipt([{ key: 't3_1' }], 50));
  const receipt = { version: 1, at: 100, keys: ['t3_1'] };
  const live = store.recordFirstContactAssessment('legacy', receipt);
  const rehearsalReceipt = { version: 1, at: 200, keys: ['t3_2'] };
  const rehearsal = store.recordFirstContactAssessment('legacy', rehearsalReceipt, { simulation: true });
  eq(live.entries, [{ key: 't3_1', at: 50 }], 'assessment does not rewrite shortlist timestamp');
  eq(store.getOrdinaryCandidateState('legacy'), live, 'rehearsal cannot alter live assessment');
  eq(rehearsal, first.record(null, rehearsalReceipt), 'rehearsal has an independent assessment ledger');
  eq(store.getProfile('legacy').repliedTo, ['t1_9'], 'assessment never changes reply dedupe');
  eq(store.getVoteState('legacy'), { considered: [] }, 'assessment never invents vote considered state');
  store.updateProfile('legacy', { ordinaryCandidateState: ordinary.defaults(), simulationState: {} });
  eq(store.getOrdinaryCandidateState('legacy'), live, 'browser edits cannot forge or clear live assessments');
  eq(store.getOrdinaryCandidateState('legacy', { simulation: true }), rehearsal, 'browser edits cannot clear rehearsal assessments');
  const hydrated = store.getProfile('legacy');
  hydrated.ordinaryCandidateState.assessed.length = 0;
  hydrated.simulationState.ordinaryCandidateState.assessed.length = 0;
  eq(store.getOrdinaryCandidateState('legacy'), live, 'hydration clones live assessments');
  eq(store.getOrdinaryCandidateState('legacy', { simulation: true }), rehearsal, 'hydration clones rehearsal assessments');
  let writes = 0;
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (...args) => { writes++; return originalWrite(...args); };
  try {
    store.recordFirstContactAssessment('legacy', receipt);
    store.recordFirstContactAssessment('legacy', { ...receipt, at: 80 });
  } finally { fs.writeFileSync = originalWrite; }
  eq(writes, 0, 'replay is idempotent and writes nothing');
  const originalRename = fs.renameSync;
  fs.renameSync = () => { const error = new Error('Injected atomic save failure'); error.code = 'EACCES'; throw error; };
  const nextReceipt = { version: 1, at: 300, keys: ['t3_3'] };
  try { assert.throws(() => store.recordFirstContactAssessment('legacy', nextReceipt), /Injected atomic save failure/); checks++; }
  finally { fs.renameSync = originalRename; }
  eq(store.getOrdinaryCandidateState('legacy'), live, 'failed save never publishes an in-memory assessment');
  const next = store.recordFirstContactAssessment('legacy', nextReceipt);
  eq(next.assessed.some((entry) => entry.key === 't3_3'), true, 'failed save remains explicitly retryable');
  delete require.cache[storePath];
  store = require('../lib/store');
  eq(store.getOrdinaryCandidateState('legacy'), next, 'backend restart restores confirmed assessments');
  eq(store.getOrdinaryCandidateState('legacy', { simulation: true }), rehearsal, 'restart preserves mode isolation');
  const imported = store.createProfile({ ordinaryCandidateState: next, simulationState: { ordinaryCandidateState: rehearsal } });
  eq(imported.ordinaryCandidateState, next, 'trusted profile movement retains bounded live state');
  eq(imported.simulationState.ordinaryCandidateState, rehearsal, 'trusted profile movement retains rehearsal state');
  const profilePack = require('../lib/profile-pack');
  eq(profilePack.exportProfile(imported).runtime.ordinaryCandidateState, next,
    'portable movement includes the existing continuity block with assessments');
  eq(JSON.stringify(profilePack.exportProfile(imported, { template: true })).includes('ordinaryCandidateState'), false,
    'reusable templates exclude assessment and presentation continuity');
  const rotated = store.recordOrdinaryCandidateShortlist('legacy', ordinary.receipt([{ key: 't3_8' }], 400));
  eq(rotated.assessed, next.assessed, 'subsequent turnover preserves assessment history');
  store.resetSimulation('legacy');
  eq(store.getOrdinaryCandidateState('legacy', { simulation: true }), ordinary.defaults(), 'rehearsal reset clears only rehearsal state');
  eq(store.getOrdinaryCandidateState('legacy'), rotated, 'rehearsal reset leaves live state intact');
  const secondBot = store.createProfile({ fedditUsername: 'independent_reader' });
  const publiclyEngaged = { kind: 'post', key: 't3_901', candidateType: 'ordinary_post', independentlyAssessed: true };
  const localReceipt = first.plan({ valid: true, candidates: [{ target: publiclyEngaged }], votes: [] }, 500, 2);
  eq(localReceipt.version, 2, 'new local first-look receipt freezes contract v2');
  store.recordFirstContactAssessment('legacy', localReceipt);
  eq(first.select([publiclyEngaged], store.getOrdinaryCandidateState('legacy'), store.getVoteState('legacy'), 2), null,
    'this bot retires its own genuinely handled root');
  eq(first.select([publiclyEngaged], store.getOrdinaryCandidateState(secondBot.id), store.getVoteState(secondBot.id), 2), publiclyEngaged,
    'another profile remains eligible despite public engagement and first-reader receipt');
  const nilReceipt = first.plan({ valid: false, candidates: [], votes: [
    { targetType: 'post', targetId: 901, decisionKind: 'explicit', status: 'no-vote', direction: 'nil' },
  ] }, 600, 2);
  store.recordFirstContactAssessment(secondBot.id, nilReceipt, { simulation: true });
  eq(store.getOrdinaryCandidateState(secondBot.id).assessed, undefined, 'rehearsal NIL cannot retire a live first look');
  eq(first.select([publiclyEngaged], store.getOrdinaryCandidateState(secondBot.id, { simulation: true }), null, 2), null,
    'valid rehearsal NIL retires only this rehearsal reader');
  for (let start = 1000; start < 1520; start += 20) {
    store.recordFirstContactAssessment(secondBot.id, {
      version: 2, at: start, keys: Array.from({ length: 20 }, (_, offset) => 't3_' + (start + offset)),
    });
  }
  eq(store.getOrdinaryCandidateState(secondBot.id).assessed.length, 512, 'v2 live assessment state remains bounded to 512 roots');
  const legacyAfterV2 = store.recordFirstContactAssessment('legacy', { version: 1, at: 700, keys: ['t3_902'] });
  eq(legacyAfterV2.assessed.some(entry => entry.key === 't3_901'), true, 'legacy receipt replay preserves newer local first looks');
  delete require.cache[storePath];
  store = require('../lib/store');
  eq(store.getOrdinaryCandidateState('legacy'), legacyAfterV2, 'mixed v1/v2 receipts survive backend restart unchanged');
  eq(store.getOrdinaryCandidateState(secondBot.id).assessed.length, 512, 'restart preserves the v2 bound');
  eq(store.getOrdinaryCandidateState(secondBot.id, { simulation: true }).assessed.map(entry => entry.key), ['t3_901'],
    'restart preserves independent rehearsal assessment');
  assert.throws(() => store.recordFirstContactAssessment('missing', receipt), /Profile not found/); checks++;
  assert.throws(() => store.recordFirstContactAssessment('legacy', { ...receipt, version: 99 }), { code: 'UNSUPPORTED_FIRST_CONTACT' }); checks++;
  console.log('first contact store: ' + checks + ' checks passed');
} finally {
  delete require.cache[storePath];
  delete require.cache[secretsPath];
  if (previousDataDir === undefined) delete process.env.FEDDIT_BOT_DATA_DIR;
  else process.env.FEDDIT_BOT_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
}
