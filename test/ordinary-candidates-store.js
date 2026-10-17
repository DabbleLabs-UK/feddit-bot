'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ordinary = require('../lib/ordinary-candidates');
let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-ordinary-'));
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
  eq(store.getOrdinaryCandidateState('legacy'), ordinary.defaults(), 'old profiles have empty ordinary history without inventing exposure');
  eq(store.getProfile('legacy').repliedTo, ['t1_9'], 'additive normalization preserves reply dedupe');
  const liveReceipt = ordinary.receipt([{ key: 't3_1' }, { key: 't1_2' }], 100);
  const rehearsalReceipt = ordinary.receipt([{ key: 't3_3' }], 200);
  const live = store.recordOrdinaryCandidateShortlist('legacy', liveReceipt);
  store.recordOrdinaryCandidateShortlist('legacy', rehearsalReceipt, { simulation: true });
  eq(store.getOrdinaryCandidateState('legacy'), live, 'rehearsal presentation never mutates live history');
  const rehearsal = store.getOrdinaryCandidateState('legacy', { simulation: true });
  eq(rehearsal, ordinary.record(null, rehearsalReceipt), 'rehearsal has its own ledger');
  store.updateProfile('legacy', { ordinaryCandidateState: ordinary.defaults(), simulationState: {} });
  eq(store.getOrdinaryCandidateState('legacy'), live, 'ordinary profile edits cannot forge live history');
  eq(store.getOrdinaryCandidateState('legacy', { simulation: true }), rehearsal, 'ordinary profile edits cannot forge rehearsal history');
  const hydrated = store.getProfile('legacy');
  hydrated.ordinaryCandidateState.entries.length = 0;
  hydrated.simulationState.ordinaryCandidateState.entries.length = 0;
  eq(store.getOrdinaryCandidateState('legacy'), live, 'hydration does not expose mutable live entries');
  eq(store.getOrdinaryCandidateState('legacy', { simulation: true }), rehearsal, 'hydration does not expose mutable rehearsal entries');
  let writes = 0;
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (...args) => { writes++; return originalWrite(...args); };
  try {
    store.recordOrdinaryCandidateShortlist('legacy', liveReceipt);
    store.recordOrdinaryCandidateShortlist('legacy', { ...liveReceipt, at: 50 });
  } finally { fs.writeFileSync = originalWrite; }
  eq(writes, 0, 'duplicate and older receipt replay do not write profiles');
  const originalRename = fs.renameSync;
  fs.renameSync = () => { const error = new Error('Injected atomic save failure'); error.code = 'EACCES'; throw error; };
  const later = ordinary.receipt([{ key: 't3_4' }], 300);
  try { assert.throws(() => store.recordOrdinaryCandidateShortlist('legacy', later), /Injected atomic save failure/); checks++; }
  finally { fs.renameSync = originalRename; }
  eq(store.getOrdinaryCandidateState('legacy'), live, 'failed save never publishes an in-memory receipt');
  const updated = store.recordOrdinaryCandidateShortlist('legacy', later);
  eq(updated.entries.some((entry) => entry.key === 't3_4'), true, 'retry after failed save persists the same receipt');
  delete require.cache[storePath];
  store = require('../lib/store');
  eq(store.getOrdinaryCandidateState('legacy'), updated, 'backend restart restores live presentation');
  eq(store.getOrdinaryCandidateState('legacy', { simulation: true }), rehearsal, 'backend restart restores independent rehearsal presentation');
  store.resetSimulation('legacy');
  eq(store.getOrdinaryCandidateState('legacy', { simulation: true }), ordinary.defaults(), 'rehearsal reset clears only rehearsal presentation');
  eq(store.getOrdinaryCandidateState('legacy'), updated, 'rehearsal reset preserves live history');
  const imported = store.createProfile({ ordinaryCandidateState: updated,
    simulationState: { ordinaryCandidateState: rehearsal } });
  eq(imported.ordinaryCandidateState, updated, 'trusted profile import preserves bounded live continuity');
  eq(imported.simulationState.ordinaryCandidateState, rehearsal, 'trusted profile import preserves rehearsal continuity');
  store.updateProfile(imported.id, { ordinaryCandidateState: { entries: [{ key: 't3_8', at: 9 }, { key: 'bad', at: 9 }] } }, { allowContinuity: true });
  eq(store.getOrdinaryCandidateState(imported.id), { version: 1, entries: [{ key: 't3_8', at: 9 }] },
    'trusted continuity patches are normalized');
  assert.throws(() => store.recordOrdinaryCandidateShortlist('missing', liveReceipt), /Profile not found/); checks++;
  eq(store.getOrdinaryCandidateState('legacy').entries.every((entry) => Object.keys(entry).sort().join(',') === 'at,key'), true,
    'stored entries contain no text, secrets, considered or replied flags');
  console.log('ordinary candidate store: ' + checks + ' checks passed');
} finally {
  delete require.cache[storePath];
  delete require.cache[secretsPath];
  if (previousDataDir === undefined) delete process.env.FEDDIT_BOT_DATA_DIR;
  else process.env.FEDDIT_BOT_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
}
