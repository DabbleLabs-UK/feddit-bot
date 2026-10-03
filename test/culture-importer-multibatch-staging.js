'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ui = require('../public/ui-culture-importer');
const { createCultureImportUiSessions } = require('../lib/culture-importer/ui-sessions');

let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function seed(username) {
  return {
    username,
    biography: 'A bounded importer staging fixture.',
    temperament: 'curious',
    interests: ['fixtures'],
    dislikes: ['retries'],
    conversationalStyle: 'brief and specific',
    humourStyle: 'dry',
    curiosity: 'high',
    disagreementStyle: 'asks for evidence',
    sociability: 'balanced',
    initiative: 'balanced',
    breadth: 'mixed',
    fictionalBackground: 'Keeps a notebook of staging receipts.',
    values: ['safety'],
    persistence: 'steady',
    noveltySeeking: 'moderate',
    toneNotes: 'plain language',
    communities: ['botlife'],
    abilities: { reply: true, discuss: true, links: false },
  };
}

function candidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 'culture_candidate_' + String(index).padStart(20, '0'),
    seed: seed('fixture_' + String(index).padStart(2, '0')),
    importerMetadata: {},
  }));
}

function draftsFor(items) {
  return ui.createCandidateDrafts(items);
}

function stagingApi(options = {}) {
  const calls = [];
  const session = {
    id: 'multi-session',
    candidates: candidates(24),
    staging: { results: [] },
  };
  let postCount = 0;
  return {
    calls,
    session,
    async api(route, request) {
      calls.push({ route, request: structuredClone(request) });
      if (!request) return { session: structuredClone(session) };
      postCount++;
      if (options.throwOnPost === postCount) throw new Error('fixture response was lost');
      const batch = request.body.selected;
      const results = batch.map((candidateId, index) => ({
        index,
        importerCandidateId: candidateId,
        importerCandidateIndex: Number(candidateId.slice(-2)),
        username: 'fixture_' + candidateId.slice(-2),
        ok: !(options.failOnPost === postCount && index === 1),
        code: options.failOnPost === postCount && index === 1 ? 'REGISTRATION_UNCERTAIN' : 'STAGED',
        message: options.failOnPost === postCount && index === 1 ? 'Check the saved result before another explicit attempt.' : 'Staged.',
      }));
      for (const result of results) {
        const existing = session.staging.results.findIndex((item) => item.importerCandidateId === result.importerCandidateId);
        if (existing >= 0) session.staging.results[existing] = result;
        else session.staging.results.push(result);
      }
      session.staging.ok = session.staging.results.every((result) => result.ok === true);
      session.staging.destination = request.body.destination;
      if (typeof options.afterPost === 'function') options.afterPost(postCount, session);
      return { result: structuredClone(session.staging), session: structuredClone(session) };
    },
  };
}

function mockImporter() {
  let sequence = 0;
  return {
    source: { id: 'fixture-source' },
    async fetchCorpus(input) {
      return {
        corpus: {
          subreddit: input.subreddit,
          fetchedAt: '2026-10-03T12:00:00.000Z',
          window: {},
          posts: [{ id: 'post' }],
          comments: [{ id: 'comment' }],
        },
        cache: { key: 'fixture-cache', hit: true },
      };
    },
    async analyseCulture(input) {
      return {
        analysis: { id: 'analysis-fixture', culture: { summary: 'Fixture culture.' }, contributors: [] },
        provider: { provider: input.provider, model: input.model },
      };
    },
    async generateCandidates(input) {
      const offset = sequence * 6;
      sequence++;
      return {
        candidates: Array.from({ length: input.count }, (_, index) => ({ seed: seed('persist_' + String(offset + index).padStart(2, '0')) })),
        rejected: [],
        requestedCount: input.count,
        complete: true,
        warnings: [],
        provider: { provider: input.provider, model: input.model },
        repairProvider: null,
      };
    },
  };
}

async function run() {
  const items = candidates(24);
  const plan = ui.stagingPlan(items, draftsFor(items), { destination: 'local' });
  eq(plan.candidateIds, items.map((candidate) => candidate.id),
    'the click snapshot uses all 24 stable candidate IDs in review order');
  eq(Object.keys(plan.editsById).length, 24, 'the click snapshot keeps one bounded edit per stable ID');

  const successful = stagingApi();
  const progress = [];
  const complete = await ui.runStagingBatches({
    api: successful.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan,
    session: successful.session,
    onProgress(value) { progress.push(structuredClone(value)); },
  });
  const successfulPosts = successful.calls.filter((call) => call.request);
  eq(successfulPosts.length, 4, '24 selected candidates produce four sequential staging calls');
  ok(successfulPosts.every((call) => call.request.body.selected.length === 6),
    'every internal staging call remains bounded to six candidates');
  ok(successfulPosts.every((call) => call.request.body.destination === 'local' && !call.request.body.managementLink),
    'local batches retain local routing and never carry a hosted credential');
  eq(complete.state, 'completed', 'the four-call coordinator reaches a completed state');
  eq(complete.completed, 24, 'overall progress confirms all 24 candidates');
  eq(complete.outcomes.length, 24, 'overall progress exposes a per-candidate outcome');
  ok(progress.some((item) => item.batch === 3 && item.completed === 12),
    'overall progress advances between bounded calls');

  const duplicateSession = {
    id: 'duplicate-sequence',
    candidates: items,
    staging: {
      selectionCandidateIds: items.map((candidate) => candidate.id),
      skippedCandidateIds: [],
      results: items.slice(0, 5).map((candidate, index) => ({
        importerCandidateId: candidate.id,
        importerCandidateIndex: index,
        username: candidate.seed.username,
        ok: true,
        code: 'STAGED',
        message: 'Staged.',
      })),
    },
  };
  const duplicateCalls = [];
  const duplicateId = items[5].id;
  async function duplicateApi(route, request) {
    if (!request) return { session: structuredClone(duplicateSession) };
    duplicateCalls.push(structuredClone(request.body.selected));
    const results = request.body.selected.map((candidateId) => {
      const index = items.findIndex((candidate) => candidate.id === candidateId);
      return {
        importerCandidateId: candidateId,
        importerCandidateIndex: index,
        username: items[index].seed.username,
        ok: candidateId !== duplicateId,
        code: candidateId === duplicateId ? 'DUPLICATE_SEED' : 'STAGED',
        message: candidateId === duplicateId ? 'Seed is already represented.' : 'Staged.',
      };
    });
    if (request.body.selected.includes(duplicateId)) {
      results.forEach((result) => {
        if (result.code !== 'DUPLICATE_SEED') {
          result.code = 'VALID';
          result.message = 'Validated, but the atomic batch was not registered.';
        }
      });
    }
    for (const result of results) {
      const offset = duplicateSession.staging.results.findIndex((item) => item.importerCandidateId === result.importerCandidateId);
      const existing = offset >= 0 ? duplicateSession.staging.results[offset] : null;
      if (!existing || existing.code !== 'STAGED') {
        if (offset >= 0) duplicateSession.staging.results[offset] = result;
        else duplicateSession.staging.results.push(result);
      }
    }
    return { session: structuredClone(duplicateSession) };
  }
  const blockedOnce = await ui.runStagingBatches({
    api: duplicateApi, sessionPath: '/api/culture-imports/duplicate-sequence', plan,
    session: duplicateSession,
  });
  eq(blockedOnce.completed, 5, 'VALID candidates in a duplicate-rejected batch are not counted as created');
  eq(blockedOnce.total, 24, 'partial staging keeps the original stable-ID denominator');
  eq(blockedOnce.remaining.length, 19, 'the duplicate and every merely VALID candidate remain pending');
  const blockedTwice = await ui.runStagingBatches({
    api: duplicateApi, sessionPath: '/api/culture-imports/duplicate-sequence', plan,
    session: duplicateSession,
  });
  eq(blockedTwice.completed, 5, 'a repeated continuation still reports only the five genuine registrations');
  eq(duplicateCalls[0], duplicateCalls[1], 'repeated continuation reproduces the same atomic duplicate block without losing selections');
  duplicateSession.staging.skippedCandidateIds = [duplicateId];
  const afterSkip = await ui.runStagingBatches({
    api: duplicateApi, sessionPath: '/api/culture-imports/duplicate-sequence', plan,
    session: duplicateSession,
  });
  eq(afterSkip.state, 'completed', 'explicit duplicate skip allows all eligible candidates to continue');
  eq(afterSkip.total, 24, 'the completed continuation retains the original 24-candidate denominator');
  eq(afterSkip.completed, 23, 'five earlier and eighteen later registrations are confirmed by STAGED evidence only');
  eq(ui.confirmedStagingCandidateIds(duplicateSession.staging).size, 23,
    'VALID evidence is replaced by later STAGED receipts and never treated as confirmation itself');
  ok(duplicateCalls.slice(2).every((batch) => !batch.includes(duplicateId)),
    'an explicitly skipped duplicate never enters a later registration batch');
  eq(new Set(duplicateCalls.slice(2).flat()).size, 18,
    'all eighteen eligible remaining stable candidate IDs are submitted once after the skip');

  const partialHarness = stagingApi({ failOnPost: 2 });
  const partial = await ui.runStagingBatches({
    api: partialHarness.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan,
    session: partialHarness.session,
  });
  eq(partialHarness.calls.filter((call) => call.request).length, 2,
    'a partial batch failure prevents later batches from starting');
  eq(partial.state, 'attention', 'partial failure is surfaced for explicit review');
  eq(partial.completed, 11, 'successful candidates in the partial batch remain confirmed');
  eq(partial.remaining.length, 13, 'the failed candidate and untouched later batches remain selected');
  ok(partial.outcomes.some((result) => result.code === 'REGISTRATION_UNCERTAIN'),
    'the per-candidate ambiguous registration result remains visible');

  let cancelRequested = false;
  const cancelledHarness = stagingApi({ afterPost() { cancelRequested = true; } });
  const cancelled = await ui.runStagingBatches({
    api: cancelledHarness.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan,
    session: cancelledHarness.session,
    shouldCancel: () => cancelRequested,
  });
  eq(cancelledHarness.calls.filter((call) => call.request).length, 1,
    'cancellation stops safely between registration batches');
  eq(cancelled.state, 'cancelled', 'between-batch cancellation has a distinct state');
  eq(cancelled.remaining.length, 18, 'cancellation preserves all unstarted selections');

  const ambiguousHarness = stagingApi({ throwOnPost: 2 });
  const ambiguous = await ui.runStagingBatches({
    api: ambiguousHarness.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan,
    session: ambiguousHarness.session,
  });
  eq(ambiguousHarness.calls.filter((call) => call.request).length, 2,
    'a lost response is never retried automatically');
  eq(ambiguousHarness.calls.filter((call) => !call.request).length, 1,
    'a lost response performs one read-only reconciliation');
  eq(ambiguous.ambiguousCandidateIds.length, 6,
    'the entire unanswered batch is identified as ambiguous');
  eq(ambiguous.remaining.length, 18,
    'confirmed earlier successes are excluded while ambiguous and untouched candidates remain');

  const hostedHarness = stagingApi();
  const hostedPlan = ui.stagingPlan(items.slice(0, 7), draftsFor(items.slice(0, 7)), { destination: 'hosted' });
  const hostedSecret = 'https://feddit-bots.dabblelabs.uk/#manage=fixture-secret';
  const hosted = await ui.runStagingBatches({
    api: hostedHarness.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan: hostedPlan,
    managementLink: hostedSecret,
    session: { id: 'multi-session', staging: { results: [] } },
  });
  const hostedPosts = hostedHarness.calls.filter((call) => call.request);
  eq(hostedPosts.length, 2, 'hosted selection is also split into bounded calls');
  ok(hostedPosts.every((call) => call.request.body.managementLink === hostedSecret),
    'the transient hosted capability is used only at each explicit hosted boundary');
  ok(!JSON.stringify(hosted).includes('fixture-secret'),
    'the hosted capability is absent from returned progress and persisted outcomes');

  const lock = { busy: false };
  eq(ui.beginExclusiveStaging(lock), true, 'the first staging submission acquires the exclusive UI lock');
  eq(ui.beginExclusiveStaging(lock), false, 'a duplicate concurrent submission is rejected');
  ui.endExclusiveStaging(lock);
  eq(ui.beginExclusiveStaging(lock), true, 'the lock is available after the prior operation ends');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-importer-multibatch-'));
  try {
    const workspaceFile = path.join(root, 'workspaces.json');
    const importer = mockImporter();
    const sessions = createCultureImportUiSessions({
      importer,
      workspaceFile,
      makeId: () => 'persistent-session',
      now: () => Date.parse('2026-10-03T12:00:00.000Z'),
    });
    let session = sessions.create('desktop', { subreddit: 'ExampleSub', maxPosts: 1, maxComments: 1 });
    session = await sessions.wait('desktop', session.id);
    sessions.analyse('desktop', session.id, { provider: 'fixture', model: 'fixture' });
    await sessions.wait('desktop', session.id);
    sessions.generate('desktop', session.id, { provider: 'fixture', model: 'fixture', count: 24 });
    session = await sessions.wait('desktop', session.id);
    eq(session.candidates.length, 24, 'the persistent fixture contains the supported 24-candidate collection');
    let boundaryCalls = 0;
    for (let offset = 0; offset < 24; offset += 6) {
      const ids = session.candidates.slice(offset, offset + 6).map((candidate) => candidate.id);
      await sessions.stage('desktop', session.id, { selected: ids, edits: [] }, async (input) => {
        boundaryCalls++;
        return {
          ok: true,
          destination: 'local',
          cohort: { id: 'cohort-' + boundaryCalls, status: 'staged' },
          results: input.populationSeeds.map((item, index) => ({ index, ok: true, code: 'STAGED', username: item.username })),
        };
      });
    }
    eq(boundaryCalls, 4, 'the durable backend received exactly four bounded calls');
    const restarted = createCultureImportUiSessions({
      importer,
      workspaceFile,
      makeId: () => 'unused',
      now: () => Date.parse('2026-10-03T12:00:00.000Z'),
    });
    const restored = restarted.get('desktop', 'persistent-session');
    eq(restored.staging.confirmedCandidateIds.length, 24,
      'backend restart restores every confirmed per-candidate staging result');
    eq(restored.staging.batches.length, 4, 'backend restart restores four bounded batch receipts');
    await restarted.stage('desktop', restored.id, {
      selected: restored.candidates.slice(0, 6).map((candidate) => candidate.id), edits: [],
    }, async () => {
      boundaryCalls++;
      throw new Error('confirmed candidates must never be registered again');
    });
    eq(boundaryCalls, 4, 'a duplicate explicit submission cannot repeat confirmed registrations');
    const saved = fs.readFileSync(workspaceFile, 'utf8');
    ok(!saved.includes('fixture-secret') && !saved.includes('managementLink'),
      'durable workspace evidence contains no hosted management credential');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-importer-staging-recovery-'));
  try {
    const workspaceFile = path.join(recoveryRoot, 'workspaces.json');
    const clock = { value: Date.parse('2026-10-03T18:00:00.000Z') };
    const importer = mockImporter();
    let sessions = createCultureImportUiSessions({
      importer, workspaceFile, makeId: () => 'recovery-session', now: () => clock.value,
    });
    let session = sessions.create('desktop', { subreddit: 'ExampleSub', maxPosts: 1, maxComments: 1 });
    session = await sessions.wait('desktop', session.id);
    sessions.analyse('desktop', session.id, { provider: 'fixture', model: 'fixture' });
    await sessions.wait('desktop', session.id);
    sessions.generate('desktop', session.id, { provider: 'fixture', model: 'fixture', count: 24 });
    session = await sessions.wait('desktop', session.id);
    sessions.saveReview('desktop', session.id, {
      drafts: session.candidates.map((candidate, index) => ({ id: candidate.id, index, selected: true, seed: candidate.seed })),
    });
    const allIds = session.candidates.map((candidate) => candidate.id);
    const rateError = Object.assign(new Error('Rate limited by Feddit (429), retry in 3600s.'), {
      code: 'EXTERNAL_STAGE_FAILED',
      results: allIds.slice(0, 6).map((candidateId, index) => ({
        index,
        importerCandidateId: candidateId,
        importerCandidateIndex: index,
        username: session.candidates[index].seed.username,
        ok: index < 5,
        code: index < 5 ? 'STAGED' : 'STAGE_FAILED',
        message: index < 5 ? 'Staged.' : 'Rate limited by Feddit (429), retry in 3600s.',
      })),
    });
    await assert.rejects(
      () => sessions.stage('desktop', session.id, { selected: allIds.slice(0, 6), edits: [] }, async () => { throw rateError; }),
      /Rate limited/,
    );
    checks++;
    let recovered = sessions.get('desktop', session.id);
    eq(recovered.staging.confirmedCandidateIds.length, 5, 'only five STAGED receipts survive the rate-limited partial result');
    eq(recovered.staging.cooldown.eligibleAt, '2026-10-03T19:00:00.000Z',
      'the registration cooldown is persisted as an absolute retry time');
    sessions = createCultureImportUiSessions({ importer, workspaceFile, now: () => clock.value });
    let guardedCalls = 0;
    recovered = sessions.get('desktop', session.id);
    const cooldownStatus = ui.stagingStatus(
      recovered, ui.durableCandidateDrafts(recovered.candidates, recovered.candidateReview), null, clock.value,
    );
    eq(cooldownStatus.state, 'cooldown', 'refresh restores a prominent cooldown next step');
    eq(ui.countdownLabel(cooldownStatus.cooldownRemainingMs), '1h 00m 00s',
      'the restored rate limit exposes a second-level countdown');
    eq(cooldownStatus.actionDisabled, true, 'continuation remains disabled during the saved cooldown');
    await assert.rejects(
      () => sessions.stage('desktop', session.id, { selected: allIds.slice(5, 11), edits: [] }, async () => { guardedCalls++; }),
      (error) => error.code === 'REGISTRATION_COOLDOWN',
    );
    checks++;
    eq(guardedCalls, 0, 'refresh and backend restart cannot submit registrations before the saved cooldown expires');
    clock.value += 3601000;
    const duplicateId = allIds[5];
    const duplicateError = Object.assign(new Error('One selected seed is already represented.'), {
      code: 'EXTERNAL_SEED_VALIDATION_FAILED',
      results: allIds.slice(5, 11).map((candidateId, offset) => ({
        index: offset,
        importerCandidateId: candidateId,
        importerCandidateIndex: offset + 5,
        ok: offset !== 0,
        code: offset === 0 ? 'DUPLICATE_SEED' : 'VALID',
        message: offset === 0 ? 'Seed is already represented.' : 'Validated but not registered.',
      })),
    });
    await assert.rejects(
      () => sessions.stage('desktop', session.id, { selected: allIds.slice(5, 11), edits: [] }, async () => { throw duplicateError; }),
      /already represented/,
    );
    checks++;
    const legacyWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
    legacyWorkspace.sessions[0].staging.confirmedCandidateIds = allIds.filter((candidateId) => candidateId !== duplicateId);
    legacyWorkspace.sessions[0].staging.selectionCandidateIds = allIds;
    legacyWorkspace.sessions[0].candidateReview.drafts.forEach((draft, index) => {
      if (index >= 6) draft.selected = false;
    });
    fs.writeFileSync(workspaceFile, JSON.stringify(legacyWorkspace, null, 2) + '\n');
    sessions = createCultureImportUiSessions({ importer, workspaceFile, now: () => clock.value });
    recovered = sessions.get('desktop', session.id);
    eq(recovered.staging.confirmedCandidateIds.length, 5,
      'restart repairs legacy confirmed IDs so VALID results remain pending');
    ok(recovered.candidateReview.drafts.slice(6, 11).every((draft) => draft.selected),
      'restart repairs legacy deselection and keeps every eligible VALID candidate selected');
    const duplicateStatus = ui.stagingStatus(
      recovered, ui.durableCandidateDrafts(recovered.candidates, recovered.candidateReview), null, clock.value,
    );
    eq(duplicateStatus.actionLabel, 'Skip duplicate and continue', 'the duplicate has one plain-language primary action');
    eq(duplicateStatus.duplicateName, session.candidates[5].seed.username,
      'the duplicate next step identifies the affected character by name');
    recovered = sessions.skipDuplicate('desktop', session.id, { candidateId: duplicateId });
    eq(recovered.staging.skippedCandidateIds, [duplicateId], 'the explicit duplicate skip is durable and stable-ID based');
    sessions = createCultureImportUiSessions({ importer, workspaceFile, now: () => clock.value });
    recovered = sessions.get('desktop', session.id);
    eq(recovered.staging.skippedCandidateIds, [duplicateId], 'backend restart restores the duplicate blocker resolution');
    const skippedDraft = recovered.candidateReview.drafts.find((draft) => draft.id === duplicateId);
    eq(skippedDraft.seed.username, session.candidates[5].seed.username,
      'the skipped duplicate character and its editable seed remain in the saved workspace');
    const recoveredDrafts = ui.durableCandidateDrafts(recovered.candidates, recovered.candidateReview);
    const status = ui.stagingStatus(recovered, recoveredDrafts, null, clock.value);
    eq({ total: status.total, confirmed: status.confirmed, skipped: status.skipped, eligible: status.eligible.length },
      { total: 24, confirmed: 5, skipped: 1, eligible: 18 },
      'stable IDs produce one consistent 24-candidate summary after refresh recovery');
    let continuedSeeds = [];
    await sessions.stage('desktop', session.id, { selected: allIds.slice(5, 11), edits: [] }, async (input) => {
      continuedSeeds = input.populationSeeds.map((item) => item.username);
      return {
        ok: true,
        destination: 'local',
        results: input.populationSeeds.map((item, index) => ({ index, ok: true, code: 'STAGED', username: item.username })),
      };
    });
    eq(continuedSeeds.length, 5, 'the skipped duplicate is omitted while all eligible candidates in the batch continue');
    ok(!continuedSeeds.includes(session.candidates[5].seed.username),
      'duplicate validation is not bypassed and the skipped character is not registered');
  } finally {
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }

  console.log('culture importer multi-batch staging: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
