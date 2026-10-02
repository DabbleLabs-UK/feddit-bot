'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../public/ui-culture-importer');
const {
  createCultureImportUiSessions,
} = require('../lib/culture-importer/ui-sessions');
const {
  parseHostedManagementLink,
  createDesktopCultureStager,
} = require('../lib/culture-importer/desktop-staging');

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
    biography: 'A fictional culture import candidate.',
    temperament: 'dry and curious',
    interests: ['community jokes'],
    dislikes: ['needless certainty'],
    conversationalStyle: 'responds to one concrete detail',
    humourStyle: 'dry callbacks',
    curiosity: 'high',
    disagreementStyle: 'asks a pointed question',
    sociability: 'selective',
    initiative: 'balanced',
    breadth: 'mixed',
    fictionalBackground: 'Keeps a fictional drawer of community notes.',
    values: ['specificity'],
    persistence: 'steady',
    noveltySeeking: 'moderate',
    toneNotes: 'concise and distinct',
    communities: ['shittyaskfeddit'],
    abilities: { reply: true, discuss: true, links: false },
  };
}

function mockImporter(options = {}) {
  const calls = [];
  return {
    calls,
    source: { id: 'fixture-source' },
    async fetchCorpus(input, runtime) {
      calls.push({ action: 'fetch', input: structuredClone(input) });
      runtime.onProgress({ phase: 'fetch', state: 'running', current: 1, total: 2, message: 'Fetching comments.' });
      if (options.fetchFailure) throw Object.assign(new Error('fixture fetch failed'), { code: 'SOURCE_FAILED', phase: 'fetch' });
      return {
        corpus: {
          subreddit: input.subreddit,
          fetchedAt: '2026-10-02T12:00:00.000Z',
          window: { since: input.since || '' },
          posts: [{ id: 'post-1', author: 'source-user', title: 'Question' }],
          comments: [{ id: 'comment-1', author: 'other-user', body: 'Reply' }],
        },
        cache: { key: 'fixture-cache', hit: input.refresh !== true },
      };
    },
    async analyseCulture(input, runtime) {
      calls.push({ action: 'analyse', input: structuredClone(input) });
      runtime.onProgress({ phase: 'analyse', state: 'provider-started', current: 0, total: 1, message: 'Analysing.' });
      return {
        analysis: {
          id: 'analysis-fixture',
          subreddit: 'ExampleSub',
          culture: {
            summary: 'Dry literal replies build on deliberately odd questions.',
            recurringJokes: ['ceremonial objects'],
            runningBits: ['increasingly unnecessary detail'],
            postFormats: ['oddly specific questions'],
            humour: ['dry escalation'],
            recurringTopics: ['ceremonies'],
            responseConventions: ['answer before complicating'],
            interactionPatterns: ['literal challenge'],
            archetypes: ['confident absurdist'],
            socialRoles: ['detail escalator'],
          },
          contributors: [{
            label: 'contributor-1',
            voice: 'Dry and specific.',
            evidenceSourceIds: ['comment-1'],
          }],
        },
        provider: { provider: input.provider, model: input.model },
      };
    },
    async generateCandidates(input, runtime) {
      calls.push({ action: 'generate', input: structuredClone(input) });
      runtime.onProgress({ phase: 'generate', state: 'provider-started', current: 0, total: 1, message: 'Generating.' });
      return {
        candidates: [
          {
            seed: seed('ceremony_clerk'),
            importerMetadata: {
              inspirationLabels: ['contributor-1'],
              behaviourObservations: ['continues a joke with a precise detail'],
              privateEvidence: 'review-only',
            },
          },
          {
            seed: seed('diagram_oracle'),
            importerMetadata: { inspirationLabels: ['confident absurdist'] },
          },
        ],
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

async function capture(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to fail.');
}

async function run() {
  eq(ui.entryVisible(false, 'desktop', false), false,
    'desktop importer entry is hidden while Developer tools is off');
  eq(ui.entryVisible(true, 'desktop', false), true,
    'desktop importer entry appears when Developer tools is on');
  eq(ui.entryVisible(true, 'hosted', false), false,
    'ordinary hosted owners never receive the population importer entry');
  eq(ui.entryVisible(true, 'hosted', true), true,
    'the existing hosted population operator receives the importer entry');

  const providers = ui.connectedProviderChoices([
    { id: 'ollama', label: 'Local Ollama', state: 'ready', models: [{ id: 'qwen', label: 'Qwen' }] },
    { id: 'dell', label: 'Feddit hosted compute', state: 'busy', models: [] },
    { id: 'deepseek', label: 'DeepSeek', state: 'auth-required', models: [{ id: 'deepseek-chat' }] },
  ]);
  eq(providers, [
    { provider: 'ollama', model: 'qwen', label: 'Local Ollama - Qwen' },
    { provider: 'dell', model: '', label: 'Feddit hosted compute' },
  ], 'provider picker includes connected provider/model pairs without offering disconnected providers');

  const analysisGroups = ui.cultureGroups({ culture: {
    recurringJokes: ['one joke'], runningBits: ['one bit'], postFormats: ['questions'],
    humour: ['dry'], recurringTopics: ['objects'], responseConventions: ['answer first'],
    interactionPatterns: ['callbacks'], archetypes: ['clerk'], socialRoles: ['escalator'],
  } });
  eq(analysisGroups.map((group) => group[0]), [
    'Recurring jokes', 'Running bits', 'Common formats', 'Humour and style',
    'Recurring topics', 'Response conventions', 'Interaction patterns',
    'Archetypes and social roles',
  ], 'review model exposes each required culture category');
  assert.throws(() => ui.requireSession({}), /invalid session/,
    'malformed importer responses are rejected before replacing review state');
  checks++;
  eq(ui.stagingResultRows({ results: [
    { index: 0, importerCandidateIndex: 0, ok: true, code: 'STAGED', username: 'first_bot' },
    { index: 1, importerCandidateIndex: 2, ok: false, code: 'REGISTRATION_UNCERTAIN', message: 'Check before retrying.' },
  ] }), [
    { label: 'first_bot', code: 'STAGED', message: '', ok: true },
    { label: 'Candidate 3', code: 'REGISTRATION_UNCERTAIN', message: 'Check before retrying.', ok: false },
  ], 'staging review renders a distinct candidate association and result code for partial outcomes');

  const drafts = ui.createCandidateDrafts([{ seed: seed('first') }]);
  ui.updateCandidateDraft(drafts, 0, 'biography', 'Edited biography');
  ui.updateCandidateDraft(drafts, 0, 'communities', 'shittyaskfeddit, casualUK');
  ui.updateCandidateDraft(drafts, 0, 'abilities.links', true);
  const rerendered = ui.createCandidateDrafts([{ seed: seed('server-copy') }], drafts);
  eq(rerendered[0].seed.biography, 'Edited biography',
    'candidate edits survive disclosure rerenders and navigation within the page');
  eq(rerendered[0].seed.communities, ['shittyaskfeddit', 'casualUK'],
    'edited list fields survive rerenders');
  eq(rerendered[0].seed.abilities.links, true,
    'edited abilities survive rerenders');
  const stageBody = ui.stagingBody(rerendered, 'https://example.test/#manage=secret');
  ok(!JSON.stringify(stageBody).includes('importerMetadata'),
    'browser staging body contains edits to compact seed fields, never rich review metadata');
  eq(stageBody.selected, [0], 'only selected candidate indexes enter the staging request');

  const importer = mockImporter();
  let now = Date.parse('2026-10-02T12:00:00.000Z');
  const sessions = createCultureImportUiSessions({
    importer,
    now: () => now,
    makeId: () => 'culture-session-1',
    existingSeeds: () => [seed('existing_bot')],
  });
  let session = sessions.create('operator-1', {
    subreddit: 'ExampleSub', maxPosts: 25, maxComments: 100, since: '2026-09-01T00:00:00.000Z',
  });
  eq(session.task.state, 'running', 'source fetch starts as a non-blocking importer task');
  session = await sessions.wait('operator-1', session.id);
  eq(session.task.state, 'completed', 'source fetch reaches a durable reviewable session state');
  eq(session.source, {
    subreddit: 'ExampleSub',
    fetchedAt: '2026-10-02T12:00:00.000Z',
    window: { since: '2026-09-01T00:00:00.000Z' },
    posts: 1,
    comments: 1,
    provider: '',
    complete: true,
    warnings: [],
    cache: { key: 'fixture-cache', hit: true },
  }, 'browser session receives bounded source counts and provenance rather than the raw corpus');
  ok(!Object.hasOwn(session, 'corpus'), 'raw source corpus is never exposed by the UI session');

  session = sessions.analyse('operator-1', session.id, { provider: 'ollama', model: 'qwen' });
  session = await sessions.wait('operator-1', session.id);
  eq(session.analysis.culture.recurringJokes, ['ceremonial objects'],
    'culture analysis remains reviewable by category');
  eq(session.analysis.contributors[0].label, 'contributor-1',
    'anonymous contributor evidence remains reviewable');
  eq(importer.calls.find((call) => call.action === 'analyse').input.model, 'qwen',
    'the selected connected model reaches analysis unchanged');

  session = sessions.generate('operator-1', session.id, {
    provider: 'ollama', model: 'qwen', count: 99,
    targetCommunities: ['shittyaskfeddit'],
    contributorLabels: ['contributor-1'],
    archetypes: ['confident absurdist'],
  });
  session = await sessions.wait('operator-1', session.id);
  const generationCall = importer.calls.find((call) => call.action === 'generate');
  eq(generationCall.input.contributorLabels, ['contributor-1'],
    'selected anonymous contributors reach candidate generation');
  eq(generationCall.input.archetypes, ['confident absurdist'],
    'selected archetypes reach candidate generation');
  eq(generationCall.input.count, 6,
    'UI integration caps a candidate request to the existing cohort capacity');
  eq(generationCall.input.existingSeeds[0].username, 'existing_bot',
    'candidate generation receives existing population seeds for duplicate protection');
  eq(session.candidates.length, 2, 'bounded candidate batch remains available for review');

  let stageCalls = 0;
  let stagedRequest = null;
  const stageResult = await sessions.stage('operator-1', session.id, {
    selected: [1],
    edits: [{ index: 1, seed: { ...seed('edited_oracle'), privateEvidence: 'must-not-cross' } }],
  }, async (input) => {
    stageCalls++;
    stagedRequest = structuredClone(input);
    return {
      ok: true,
      cohort: { id: 'cohort-1', status: 'staged' },
      results: [{ index: 0, ok: true, code: 'STAGED', username: 'edited_oracle' }],
    };
  });
  eq(stageCalls, 1, 'explicit staging crosses the frozen boundary exactly once');
  eq(stagedRequest.populationSeeds.map((item) => item.username), ['edited_oracle'],
    'explicit staging sends only the selected edited seed');
  ok(!JSON.stringify(stagedRequest).includes('review-only') &&
    !JSON.stringify(stagedRequest).includes('privateEvidence'),
  'review-only importer evidence never crosses into population runtime data');
  eq(stageResult.cohort.status, 'staged', 'successful staging stops at the staged lifecycle');
  eq(stageResult.results[0].importerCandidateIndex, 1,
    'per-seed staging outcomes retain the review candidate association');

  const failure = Object.assign(new Error('registration fixture failed'), {
    code: 'EXTERNAL_STAGE_FAILED', statusCode: 409,
    results: [{ index: 0, ok: false, code: 'STAGE_FAILED', message: 'registration fixture failed' }],
  });
  const stageError = await capture(() => sessions.stage('operator-1', session.id, {
    selected: [0], edits: [],
  }, async () => { throw failure; }));
  eq(stageError.code, 'EXTERNAL_STAGE_FAILED', 'staging failures retain the frozen boundary error code');
  const failedSession = sessions.get('operator-1', session.id);
  eq(failedSession.staging.results[0].code, 'STAGE_FAILED',
    'per-seed staging failure remains available for review after the request');

  const failingSessions = createCultureImportUiSessions({
    importer: mockImporter({ fetchFailure: true }),
    makeId: () => 'failing-session',
  });
  failingSessions.create('operator-1', { subreddit: 'ExampleSub' });
  const failedFetch = await failingSessions.wait('operator-1', 'failing-session');
  eq(failedFetch.task.state, 'failed', 'provider/source failures end in a stable failed task state');
  eq(failedFetch.task.error.code, 'SOURCE_FAILED', 'failed task exposes a stable error code');

  let cancellationObserved = false;
  const cancellingImporter = mockImporter();
  cancellingImporter.fetchCorpus = (_input, runtime) => new Promise((_resolve, reject) => {
    runtime.signal.addEventListener('abort', () => {
      cancellationObserved = true;
      const error = new Error('cancelled');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const cancellingSessions = createCultureImportUiSessions({
    importer: cancellingImporter,
    makeId: () => 'cancelling-session',
  });
  cancellingSessions.create('operator-1', { subreddit: 'ExampleSub' });
  await new Promise((resolve) => setImmediate(resolve));
  cancellingSessions.cancel('operator-1', 'cancelling-session');
  const cancelled = await cancellingSessions.wait('operator-1', 'cancelling-session');
  eq(cancellationObserved, true, 'cancel action reaches the active source/provider signal');
  eq(cancelled.task.state, 'cancelled', 'cancelled work reaches a stable terminal state');

  let finishLateFetch;
  const lateImporter = mockImporter();
  lateImporter.fetchCorpus = () => new Promise((resolve) => {
    finishLateFetch = () => resolve({
      corpus: {
        subreddit: 'LateSub', fetchedAt: '2026-10-02T13:00:00.000Z', window: {}, posts: [], comments: [],
      },
      cache: { key: 'late-cache', hit: false },
    });
  });
  const lateSessions = createCultureImportUiSessions({
    importer: lateImporter,
    makeId: () => 'late-session',
  });
  lateSessions.create('operator-1', { subreddit: 'LateSub' });
  await new Promise((resolve) => setImmediate(resolve));
  lateSessions.cancel('operator-1', 'late-session');
  const promptlyCancelled = await lateSessions.wait('operator-1', 'late-session');
  eq(promptlyCancelled.task.state, 'cancelled',
    'cancel returns promptly even when an already-accepted provider does not abort its work');
  finishLateFetch();
  await new Promise((resolve) => setImmediate(resolve));
  eq(lateSessions.get('operator-1', 'late-session').source, null,
    'late provider output is discarded after cancellation instead of replacing review state');

  const parsedLink = parseHostedManagementLink('https://feddit-bots.dabblelabs.uk/#manage=private%20capability');
  eq(parsedLink, {
    serverUrl: 'https://feddit-bots.dabblelabs.uk',
    ownerToken: 'private capability',
  }, 'desktop staging extracts the existing hosted capability only at the explicit boundary');
  const invalidLink = await capture(async () => parseHostedManagementLink('http://feddit-bots.dabblelabs.uk/#manage=secret'));
  eq(invalidLink.code, 'INVALID_MANAGEMENT_LINK', 'non-loopback desktop staging destinations require HTTPS');
  const wrongHost = await capture(async () => parseHostedManagementLink('https://example.test/#manage=secret'));
  eq(wrongHost.code, 'INVALID_MANAGEMENT_LINK',
    'desktop staging cannot forward a private capability to an arbitrary HTTPS origin');

  let httpRequest = null;
  const desktopStage = createDesktopCultureStager('https://feddit-bots.dabblelabs.uk/#manage=private-capability', {
    async fetch(url, options) {
      httpRequest = { url, options };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, cohort: { status: 'staged' }, results: [] });
        },
      };
    },
  });
  await desktopStage({ populationSeeds: [seed('desktop_candidate')], provenance: { source: 'fixture' } });
  eq(new URL(httpRequest.url).pathname, '/api/population/external-seeds/stage',
    'desktop staging reuses the frozen external-seed endpoint');
  eq(httpRequest.options.headers['X-Feddit-Bot-Owner'], 'private-capability',
    'desktop staging reuses the existing hosted operator capability');

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok(html.includes('<script src="/ui-culture-importer.js"></script>'),
    'ordinary workspace loads the isolated importer UI module');
  ok(html.includes('id="cultureImporterBtn" style="display:none"'),
    'importer entry is hidden by default before Developer-tools placement checks');
  ok(html.includes('cultureImporterUi.entryVisible('),
    'workspace applies the shared Developer-tools and operator visibility contract');
  ok(html.includes('const cultureWorkWouldBeLost = cultureImporterController.hasState();'),
    'leaving the page warns about meaningful importer state even after returning to the bot editor');
  ok(html.includes('id="developerToolsToggle"') && html.includes('id="providerCards"'),
    'ordinary Developer-tools and provider settings remain present');
  ok(html.includes('id="cultureSourceSettings"') && html.includes('id="fetchLayerKeyState"'),
    'desktop Developer tools includes the separate FetchLayer credential control');
  ok(html.includes("'/api/culture-imports/source-credential'") && html.includes("'configured' : 'not configured'"),
    'FetchLayer settings use a presence-only server credential contract');
  ok(html.includes('id="populationBtn"') && html.includes('function renderEditor('),
    'ordinary population and bot editor paths remain present');

  console.log('culture importer UI: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
