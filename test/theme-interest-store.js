'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const themes = require('../lib/theme-interest');
const pack = require('../lib/profile-pack');

let checks = 0;
const eq = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const throws = (fn, expected) => { assert.throws(fn, expected); checks++; };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-theme-store-'));
const previousDirectory = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = directory;
const storePath = require.resolve('../lib/store');
delete require.cache[storePath];
const event = (id, at = 1000) => ({
  id, at, kind: 'exposure', sourceKey: 't3_123', threadKey: 't3_123',
  community: 'bookclub', author: 'some_bot', features: [['library', 'socks']],
});

try {
  let store = require(storePath);
  const profile = store.createProfile({ refName: 'theme-store-test', persona: 'Unchanged character' });
  const absent = (value, note) => eq(Object.hasOwn(value, 'themeInterestState'), false, note);
  absent(store.profileDefaults(), 'default-off profiles have no theme state');
  absent(store.simulationDefaults(), 'rehearsal defaults have no theme state');
  absent(profile, 'creation does not backfill optional state');
  absent(profile.simulationState, 'creation does not backfill rehearsal state');
  eq(store.getThemeInterestState(profile.id), themes.normalize(), 'absent reads are empty without writing');
  store.recordThemeInterest(profile.id, []);
  absent(store.getProfile(profile.id), 'empty receipt batch does not materialize optional state');
  store.updateProfile(profile.id, { themeInterestState: themes.normalize(), simulationState: { themeInterestState: themes.normalize() } }, { allowContinuity: true });
  absent(store.getProfile(profile.id), 'internal edit cannot create theme state');
  absent(store.getProfile(profile.id).simulationState, 'internal edit preserves absent rehearsal state');

  const live = store.recordThemeInterest(profile.id, [event('live')]);
  eq(live.events.length, 1, 'atomic mutator commits live receipt');
  eq(store.recordThemeInterest(profile.id, [event('live')]), live, 'same receipt replay is idempotent');
  eq(store.getThemeInterestState(profile.id, { simulation: true }).events, [], 'live receipts do not leak into rehearsal');
  const rehearsal = store.recordThemeInterest(profile.id, [event('rehearsal', 2000)], { simulation: true });
  eq(store.getThemeInterestState(profile.id), live, 'rehearsal receipts do not overwrite live');
  eq(rehearsal.events[0].id, 'rehearsal');

  const read = store.getThemeInterestState(profile.id);
  read.events[0].features[0][0] = 'changed';
  eq(store.getThemeInterestState(profile.id), live, 'state reads do not expose mutable cache');
  live.events[0].features[0][0] = 'changed';
  eq(store.getThemeInterestState(profile.id).events[0].features[0], ['library', 'socks'], 'mutator result is detached');
  const currentLive = store.getThemeInterestState(profile.id);
  const hydrated = store.getProfile(profile.id);
  hydrated.themeInterestState.events.length = 0;
  hydrated.simulationState.themeInterestState.events.length = 0;
  eq(store.getThemeInterestState(profile.id), currentLive, 'profile reads cannot mutate live theme cache');
  eq(store.getThemeInterestState(profile.id, { simulation: true }), rehearsal, 'profile reads cannot mutate rehearsal cache');
  const listed = store.listProfiles()[0];
  listed.themeInterestState.events.length = 0;
  eq(store.getThemeInterestState(profile.id), currentLive, 'profile list reads are detached');

  for (const allowContinuity of [false, true]) {
    store.updateProfile(profile.id, {
      themeInterestState: { version: 999 },
      simulationState: { themeInterestState: { version: 999 } },
    }, { allowContinuity });
    eq(store.getThemeInterestState(profile.id), currentLive, 'stale edits preserve current live receipts');
    eq(store.getThemeInterestState(profile.id, { simulation: true }), rehearsal, 'stale edits preserve current rehearsal receipts');
  }

  const staleProfile = store.getProfile(profile.id);
  const nextLive = store.recordThemeInterest(profile.id, [event('newer-live', 2500)]);
  const nextRehearsal = store.recordThemeInterest(profile.id, [event('newer-rehearsal', 2500)], { simulation: true });
  store.updateProfile(profile.id, staleProfile, { allowContinuity: true });
  eq(store.getThemeInterestState(profile.id), nextLive, 'actual stale profile snapshot cannot erase a later live receipt');
  eq(store.getThemeInterestState(profile.id, { simulation: true }), nextRehearsal, 'actual stale profile snapshot cannot erase a later rehearsal receipt');

  delete require.cache[storePath];
  store = require(storePath);
  eq(store.getThemeInterestState(profile.id), nextLive, 'restart reloads live receipts');
  eq(store.getThemeInterestState(profile.id, { simulation: true }), nextRehearsal, 'restart reloads rehearsal receipts');
  eq(JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8')).profiles[0].themeInterestState, nextLive, 'disk JSON preserves state');
  const exported = pack.exportProfile(store.getProfile(profile.id));
  eq(exported.runtime.themeInterestState, nextLive, 'explicit continuity export retains live state');
  eq(exported.runtime.simulationState.themeInterestState, nextRehearsal, 'continuity export retains rehearsal state');
  const moved = store.createProfile(pack.importPatch(exported));
  eq(store.getThemeInterestState(moved.id), nextLive, 'continuity import preserves live state');
  eq(store.getThemeInterestState(moved.id, { simulation: true }), nextRehearsal, 'continuity import preserves rehearsal state');
  eq(pack.exportProfile(store.getProfile(profile.id), { template: true }).runtime, undefined, 'reusable template excludes all runtime state');
  absent(pack.exportProfile(store.getProfile(profile.id), { template: true }).bot, 'template bot fields exclude theme state');

  const rename = fs.renameSync;
  const diskBefore = fs.readFileSync(store.DATA_FILE, 'utf8');
  try {
    fs.renameSync = (from, to) => {
      if (to === store.DATA_FILE) throw new Error('fixture atomic replacement failure');
      return rename(from, to);
    };
    throws(() => store.recordThemeInterest(profile.id, [event('failed-live', 3000)]), /fixture atomic replacement failure/);
    throws(() => store.recordThemeInterest(profile.id, [event('failed-rehearsal', 3000)], { simulation: true }), /fixture atomic replacement failure/);
  } finally { fs.renameSync = rename; }
  eq(store.getThemeInterestState(profile.id), nextLive, 'failed atomic write does not publish live cache');
  eq(store.getThemeInterestState(profile.id, { simulation: true }), nextRehearsal, 'failed atomic write does not publish rehearsal cache');
  eq(fs.readFileSync(store.DATA_FILE, 'utf8'), diskBefore, 'failed atomic replacement preserves previous disk snapshot');
  eq(store.recordThemeInterest(profile.id, [event('failed-live', 3000)]).events.length, 3, 'failed receipt remains safely retryable');
  eq(store.recordThemeInterest(profile.id, [event('failed-rehearsal', 3000)], { simulation: true }).events.length, 3, 'failed rehearsal receipt remains safely retryable');
  eq(store.getProfile(profile.id).persona, 'Unchanged character');
  throws(() => store.getThemeInterestState('missing'), /Profile not found/);
  throws(() => store.recordThemeInterest('missing', []), /Profile not found/);
  throws(() => store.createProfile({ themeInterestState: { version: 999 } }), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });
  throws(() => store.createProfile({ simulationState: { themeInterestState: { version: 999 } } }), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });

  const phrases = require('../lib/theme-phrase-motif');
  const phraseProfile = store.createProfile({ refName: 'phrase-store-test', persona: 'Same private character' });
  const phraseEvent = (id, at, author, sourceKey, kind = 'exposure') => ({
    id, at, kind, sourceKey, threadKey: 't3_501', community: 'shittyaskfeddit', author,
    features: [], identityVersion: 3, motifs: [], proposals: ['milt~gable'],
  });
  const historicalV2 = { ...event('historical-v2', 4000), identityVersion: 2, motifs: ['glopspray'] };
  store.recordThemeInterest(phraseProfile.id, [historicalV2]);
  const firstPhrase = phraseEvent('phrase-first', 4100, 'bot_a', 't3_501');
  const firstPhraseState = store.recordThemeInterest(phraseProfile.id, [firstPhrase]);
  eq(firstPhraseState.events.at(-1), firstPhrase, 'version-three proposals persist without being approved');
  eq(phrases.local(phrases.snapshot(firstPhraseState, 4100), 'shittyaskfeddit'), [], 'one independent encounter stays pending on disk');
  const stalePhraseProfile = store.getProfile(phraseProfile.id);
  const ownPhrase = phraseEvent('phrase-own', 4200, 'reader', 't1_503', 'participation');
  const ownPhraseState = store.recordThemeInterest(phraseProfile.id, [ownPhrase]);
  eq(phrases.local(phrases.snapshot(ownPhraseState, 4200), 'shittyaskfeddit'), [], 'own publication cannot provide second independent corroboration');
  eq(phrases.proposed(phrases.snapshot(ownPhraseState, 4200), 'shittyaskfeddit'), ['milt~gable'], 'own alias remains pending across storage');
  store.updateProfile(phraseProfile.id, stalePhraseProfile, { allowContinuity: true });
  eq(store.getThemeInterestState(phraseProfile.id), ownPhraseState, 'stale profile editing cannot overwrite later pending phrase evidence');
  const secondPhrase = phraseEvent('phrase-second', 4300, 'bot_b', 't1_502');
  const corroborated = store.recordThemeInterest(phraseProfile.id, [secondPhrase]);
  eq(phrases.local(phrases.snapshot(corroborated, 4300), 'shittyaskfeddit'), ['milt~gable'], 'two distinct external authors and public sources corroborate stored phrase');
  const approvedUse = { ...phraseEvent('phrase-approved-use', 4400, 'reader', 't1_504', 'participation'),
    motifs: ['milt~gable'], proposals: [] };
  const phraseLive = store.recordThemeInterest(phraseProfile.id, [approvedUse]);
  eq(phraseLive.events.at(-1).motifs, ['milt~gable'], 'approved phrase identity persists on subsequent own participation');
  eq(phraseLive.events.find(item => item.id === historicalV2.id), historicalV2, 'new phrase receipts never reinterpret historical version-two receipt');
  eq(store.getThemeInterestState(phraseProfile.id, { simulation: true }).events, [], 'live phrase discovery does not leak into rehearsal');
  const phrasePrivateKey = 'r3_' + 'b'.repeat(64);
  const phrasePrivate = { ...phraseEvent('phrase-private-own', 4500, 'reader', phrasePrivateKey, 'participation'),
    threadKey: phrasePrivateKey };
  throws(() => store.recordThemeInterest(phraseProfile.id, [phrasePrivate]), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });
  eq(store.getThemeInterestState(phraseProfile.id), phraseLive, 'rejected private source cannot mutate live phrase state');
  const phraseRehearsal = store.recordThemeInterest(phraseProfile.id, [phrasePrivate], { simulation: true });
  eq(phraseRehearsal.events, [phrasePrivate], 'private own phrase proposal remains valid only in rehearsal');
  eq(phrases.local(phrases.snapshot(phraseRehearsal, 4500), 'shittyaskfeddit'), [], 'private own publication cannot invent independent readership');
  eq(store.getThemeInterestState(phraseProfile.id), phraseLive, 'rehearsal phrase bookkeeping preserves live corroborated state');
  delete require.cache[storePath];
  store = require(storePath);
  eq(store.getThemeInterestState(phraseProfile.id), phraseLive, 'restart reloads version-three proposals and approved phrase receipts exactly');
  eq(store.getThemeInterestState(phraseProfile.id, { simulation: true }), phraseRehearsal, 'restart preserves isolated private rehearsal phrase state');
  eq(phrases.local(phrases.snapshot(store.getThemeInterestState(phraseProfile.id), 4500), 'shittyaskfeddit'),
    ['milt~gable'], 'restart reconstructs bot-local corroboration without backfill');
  eq(store.getThemeInterestState(phraseProfile.id).events.find(item => item.id === historicalV2.id), historicalV2,
    'restart leaves historical version-two identity and receipt payload unchanged');

  const privateKey = 'r3_' + 'a'.repeat(64);
  const privateEvent = { ...event('rehearsal-new-root', 4000), kind: 'participation', sourceKey: privateKey, threadKey: privateKey };
  const privateState = themes.record(undefined, [privateEvent]);
  eq(store.recordThemeInterest(profile.id, [privateEvent], { simulation: true }).events.at(-1), privateEvent, 'private new-root participation is rehearsal-only');
  throws(() => store.recordThemeInterest(profile.id, [privateEvent]), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });
  throws(() => store.createProfile({ themeInterestState: privateState }), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });
  const privateProfile = store.createProfile({ simulationState: { themeInterestState: privateState } });
  eq(store.getThemeInterestState(privateProfile.id, { simulation: true }), privateState, 'continuity import accepts validated private rehearsal evidence');
  const injected = JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8'));
  injected.profiles.find((item) => item.id === profile.id).themeInterestState = privateState;
  fs.writeFileSync(store.DATA_FILE, JSON.stringify(injected));
  delete require.cache[storePath];
  store = require(storePath);
  throws(() => store.getThemeInterestState(profile.id), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });
  throws(() => store.recordThemeInterest(profile.id, [event('cannot-hide-private', 5000)]), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });
  eq(JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8')).profiles[0].themeInterestState, privateState, 'injected private live evidence fails closed without rewriting it');

  // A future/corrupt optional state survives ordinary disabled-feature reads;
  // enabling its bookkeeping must fail closed, never silently reset history.
  const raw = JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8'));
  raw.profiles.find((item) => item.id === profile.id).themeInterestState = { version: 999 };
  fs.writeFileSync(store.DATA_FILE, JSON.stringify(raw));
  delete require.cache[storePath];
  store = require(storePath);
  eq(store.getProfile(profile.id).themeInterestState, { version: 999 }, 'ordinary loading preserves unknown state without normalization');
  throws(() => store.getThemeInterestState(profile.id), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });
  throws(() => store.recordThemeInterest(profile.id, [event('must-not-reset')]), { code: 'THEME_INTEREST_BOOKKEEPING_PENDING' });
  eq(JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8')).profiles[0].themeInterestState, { version: 999 }, 'invalid state is never overwritten');

  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /themeInterestEnabled: process\.env\.FEDDIT_THEME_INTEREST_V1 === '1'/); checks++;
  const listProjection = server.slice(server.indexOf('function safeProfile('), server.indexOf('function safeProfile(') + 900);
  assert.match(listProjection, /themeInterestState,[\s\S]*\.\.\.rest/); checks++;
  const editProjection = server.slice(server.indexOf('const biography = await currentFedditBiography(existing);'), server.indexOf('const biography = await currentFedditBiography(existing);') + 700);
  assert.match(editProjection, /themeInterestState,[\s\S]*\.\.\.rest/); checks++;
  eq((server.match(/delete body\.themeInterestState;/g) || []).length, 2, 'create/update client payloads strip private receipts');
  assert.match(server, /delete body\.simulationState\.themeInterestState;/); checks++;
} finally {
  delete require.cache[storePath];
  if (previousDirectory === undefined) delete process.env.FEDDIT_BOT_DATA_DIR;
  else process.env.FEDDIT_BOT_DATA_DIR = previousDirectory;
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('theme-interest store: ' + checks + ' checks passed');
