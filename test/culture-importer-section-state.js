'use strict';

const assert = require('node:assert/strict');

const ui = require('../public/ui-culture-importer');

let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

class MockElement {
  constructor(root, values = {}) {
    this.root = root;
    this.listeners = {};
    this.dataset = {};
    Object.assign(this, values);
  }

  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }

  dispatch(name) {
    const handler = this.listeners[name];
    if (handler) handler({ target: this });
  }

  focus() {
    this.root.ownerDocument.activeElement = this;
  }

  setSelectionRange(start, end, direction) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}

class MockRoot {
  constructor() {
    this.ownerDocument = { activeElement: null };
    this.renderCount = 0;
    this.progressUpdates = [];
    this.details = new Map();
    this.subreddit = null;
    this.candidateSelection = null;
    this.progressRegion = null;
    this.cancelButton = null;
    this._innerHTML = '';
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.renderCount++;
    this.details = new Map();
    const detailPattern = /<details[^>]*data-culture-disclosure="([^"]+)"([^>]*)>/g;
    let detailMatch;
    while ((detailMatch = detailPattern.exec(this._innerHTML))) {
      const key = detailMatch[1];
      this.details.set(key, new MockElement(this, {
        dataset: { cultureDisclosure: key },
        open: /\sopen\b/.test(detailMatch[2]),
      }));
    }

    const subredditMatch = this._innerHTML.match(/id="cultureSubreddit" value="([^"]*)"/);
    this.subreddit = subredditMatch
      ? new MockElement(this, {
        id: 'cultureSubreddit',
        value: subredditMatch[1],
        selectionStart: 0,
        selectionEnd: 0,
        selectionDirection: 'none',
      })
      : null;

    const selectedMatch = this._innerHTML.match(/data-candidate-selected="0"([^>]*)>/);
    this.candidateSelection = selectedMatch
      ? new MockElement(this, {
        type: 'checkbox',
        dataset: { candidateSelected: '0' },
        checked: /\schecked\b/.test(selectedMatch[1]),
      })
      : null;

    const root = this;
    this.progressRegion = this._innerHTML.includes('id="cultureProgressRegion"')
      ? {
        get innerHTML() { return this.value || ''; },
        set innerHTML(progress) {
          this.value = String(progress);
          root.progressUpdates.push(this.value);
          root.cancelButton = this.value.includes('id="cultureCancelBtn"')
            ? new MockElement(root, { id: 'cultureCancelBtn' })
            : null;
        },
      }
      : null;
    this.cancelButton = this._innerHTML.includes('id="cultureCancelBtn"')
      ? new MockElement(this, { id: 'cultureCancelBtn' })
      : null;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  contains(element) {
    return element === this.subreddit || element === this.candidateSelection ||
      [...this.details.values()].includes(element);
  }

  querySelector(selector) {
    if (selector === '#cultureProgressRegion') return this.progressRegion;
    if (selector === '#cultureCancelBtn') return this.cancelButton;
    if (selector === '#cultureSubreddit') return this.subreddit;
    if (selector === '[data-candidate-selected="0"]') return this.candidateSelection;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === 'details[data-culture-disclosure]') return [...this.details.values()];
    if (selector === '[data-candidate-selected]') return this.candidateSelection ? [this.candidateSelection] : [];
    return [];
  }
}

function seed() {
  return {
    username: 'fixture_candidate',
    biography: 'A fictional importer polling fixture.',
    interests: ['progress'],
    dislikes: ['lost state'],
    values: ['review'],
    communities: ['botlife'],
    abilities: { reply: true, discuss: true, links: false },
  };
}

function session(task) {
  return {
    id: 'polling-session',
    input: { subreddit: 'ExampleSub', maxPosts: 5, maxComments: 20 },
    task,
    source: {
      available: true,
      provider: 'fixture',
      subreddit: 'ExampleSub',
      posts: 5,
      comments: 20,
      complete: true,
      warnings: [],
      cache: {},
    },
    sourceStatus: { state: 'available', message: 'Saved fixture sample.' },
    analysis: {
      id: 'analysis-fixture',
      culture: { summary: 'Fixture culture.', archetypes: [] },
      contributors: [],
    },
    analysisProvider: { provider: 'ollama', model: 'fixture' },
    review: {
      provider: 'ollama', model: 'fixture', count: 1,
      targetCommunities: ['botlife'], contributorLabels: [], archetypes: [],
    },
    candidates: [{ id: 'culture_candidate_fixture', seed: seed(), importerMetadata: {} }],
    warnings: [],
    staging: null,
    generationCapacity: { limit: 24, batchSize: 6, used: 1, remaining: 23 },
    generationBatches: [],
  };
}

function task(state, message, current) {
  return {
    state,
    progress: { phase: 'generate', state, current, total: 3, message },
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for ' + message);
}

async function run() {
  const waits = [];
  const responses = [
    session(task('running', 'Provider progress one.', 1)),
    session(task('running', 'Provider progress two.', 2)),
    session(task('completed', 'Generation completed.', 3)),
  ];
  let apiCalls = 0;
  const controller = ui.createController({
    storage: { getItem() { return null; }, setItem() {} },
    getDeveloperTools: () => true,
    getPlacement: () => 'desktop',
    getProviders: () => [{ id: 'ollama', label: 'Ollama', state: 'ready', models: [{ id: 'fixture', label: 'Fixture' }] }],
    toast() {},
    pollWait() {
      return new Promise((resolve) => waits.push(resolve));
    },
    async api(route) {
      eq(route, '/api/culture-imports/polling-session', 'polling reads only the active importer workspace');
      return { session: structuredClone(responses[apiCalls++]) };
    },
  });
  controller.workflow.session = session(task('running', 'Provider started.', 0));
  controller.workflow.savedSessionId = 'polling-session';
  controller.workflow.candidateDrafts = ui.createCandidateDrafts(controller.workflow.session.candidates);

  const root = new MockRoot();
  controller.open(root);
  await waitUntil(() => waits.length === 1, 'the first polling wait');
  eq(root.renderCount, 1, 'opening the active workspace performs one full render');

  const collapsedSource = root.details.get('source');
  collapsedSource.open = false;
  collapsedSource.dispatch('toggle');
  root.subreddit.value = 'Unsaved subreddit edit';
  root.subreddit.dispatch('input');
  root.subreddit.focus();
  root.subreddit.setSelectionRange(3, 10, 'forward');
  root.candidateSelection.checked = false;
  root.candidateSelection.onchange();
  const focusedInput = root.subreddit;

  waits.shift()();
  await waitUntil(() => apiCalls === 1 && waits.length === 1, 'the first progress update');
  eq(root.renderCount, 1, 'a progress-only poll does not rebuild importer sections');
  eq(root.details.get('source'), collapsedSource, 'the manually collapsed section is not replaced');
  eq(root.details.get('source').open, false, 'the manually collapsed section stays collapsed');
  eq(root.ownerDocument.activeElement, focusedInput, 'input focus survives a progress-only poll');
  eq(root.subreddit.value, 'Unsaved subreddit edit', 'an unsaved input edit survives a progress-only poll');
  eq(root.candidateSelection.checked, false, 'a candidate selection survives a progress-only poll');
  ok(root.progressUpdates.at(-1).includes('Provider progress one.'), 'the progress message still updates in place');

  waits.shift()();
  await waitUntil(() => apiCalls === 2 && waits.length === 1, 'the second progress update');
  eq(root.renderCount, 1, 'several progress updates still avoid full rerenders');
  eq(root.details.get('source').open, false, 'the collapsed choice remains stable across several polls');
  eq(root.ownerDocument.activeElement, focusedInput, 'focus remains on the same DOM input across several polls');
  ok(root.progressUpdates.at(-1).includes('Provider progress two.'), 'later progress also updates in place');

  waits.shift()();
  await waitUntil(() => controller.workflow.polling === false, 'the terminal polling state');
  eq(apiCalls, 3, 'the mocked active operation reached its terminal update');
  eq(root.renderCount, 2, 'the terminal state performs one necessary full render');
  eq(root.details.get('source').open, false, 'a necessary terminal rerender restores the collapsed choice');
  eq(root.subreddit.value, 'Unsaved subreddit edit', 'a necessary terminal rerender restores the unsaved edit');
  eq(root.ownerDocument.activeElement, root.subreddit, 'a necessary terminal rerender restores input focus');
  eq([root.subreddit.selectionStart, root.subreddit.selectionEnd, root.subreddit.selectionDirection], [3, 10, 'forward'],
    'a necessary terminal rerender restores the text selection');
  eq(root.candidateSelection.checked, false, 'a necessary terminal rerender restores candidate selection');
  ok(root.progressUpdates.at(-1).includes('Generation completed.'), 'the terminal progress message is visible');

  console.log('culture importer section state: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
