(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditCultureImporterUi = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const SEED_FIELDS = Object.freeze([
    'username', 'biography', 'temperament', 'interests', 'dislikes',
    'conversationalStyle', 'humourStyle', 'curiosity', 'disagreementStyle',
    'sociability', 'initiative', 'breadth', 'fictionalBackground', 'values',
    'persistence', 'noveltySeeking', 'toneNotes', 'communities',
  ]);
  const LIST_FIELDS = new Set(['interests', 'dislikes', 'values', 'communities']);
  const CLIENT_FORM_FIELDS = Object.freeze([
    'subreddit', 'maxPosts', 'maxComments', 'windowDays',
    'candidateCount', 'communities', 'providerChoice', 'stagingDestination',
  ]);
  const CLIENT_STATE_VERSION = 1;
  const CLIENT_STATE_KEY = 'feddit.culture-importer.workspace.v1';
  const MAX_CANDIDATE_COLLECTION = 24;
  const STAGING_SELECTION_LIMIT = 6;

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function entryVisible(developerTools, placement, populationAdmin) {
    if (!developerTools) return false;
    return placement === 'desktop' || (placement === 'hosted' && populationAdmin === true);
  }

  function connectedProviderChoices(providers) {
    const choices = [];
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (!['ready', 'busy'].includes(String(provider.state || ''))) continue;
      const models = Array.isArray(provider.models) ? provider.models : [];
      if (models.length) {
        for (const model of models) {
          choices.push({
            provider: String(provider.id || ''),
            model: String(model.id || ''),
            label: String(provider.label || provider.id || '') + ' - ' + String(model.label || model.id || ''),
          });
        }
      } else {
        choices.push({
          provider: String(provider.id || ''),
          model: '',
          label: String(provider.label || provider.id || ''),
        });
      }
    }
    return choices.filter((choice) => choice.provider);
  }

  function parseList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  }

  function createCandidateDrafts(candidates, prior) {
    const existing = prior || {};
    const drafts = {};
    (Array.isArray(candidates) ? candidates : []).forEach((candidate, index) => {
      const saved = existing[index];
      drafts[index] = {
        selected: saved ? saved.selected !== false : true,
        seed: saved && saved.seed ? clone(saved.seed) : clone(candidate.seed || {}),
      };
    });
    return drafts;
  }

  function updateCandidateDraft(drafts, index, field, value) {
    const output = drafts;
    const draft = output[index];
    if (!draft) return output;
    if (field === 'selected') draft.selected = value === true;
    else if (field.startsWith('abilities.')) {
      const ability = field.split('.')[1];
      draft.seed.abilities = draft.seed.abilities || {};
      draft.seed.abilities[ability] = value === true;
    } else {
      draft.seed[field] = LIST_FIELDS.has(field) ? parseList(value) : String(value == null ? '' : value);
    }
    return output;
  }

  function compactSeed(seed) {
    const input = seed && typeof seed === 'object' ? seed : {};
    const output = {};
    for (const field of SEED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, field)) output[field] = clone(input[field]);
    }
    if (input.abilities && typeof input.abilities === 'object') {
      output.abilities = {};
      for (const field of ['reply', 'discuss', 'links']) {
        if (Object.prototype.hasOwnProperty.call(input.abilities, field)) output.abilities[field] = input.abilities[field] === true;
      }
    }
    return output;
  }

  function safeClientForm(form) {
    const input = form && typeof form === 'object' ? form : {};
    const output = {};
    for (const field of CLIENT_FORM_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, field)) output[field] = clone(input[field]);
    }
    return output;
  }

  function safeCandidateDrafts(drafts) {
    const output = {};
    for (const [key, draft] of Object.entries(drafts && typeof drafts === 'object' ? drafts : {})) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= MAX_CANDIDATE_COLLECTION || !draft || typeof draft !== 'object') continue;
      output[index] = {
        selected: draft.selected === true,
        seed: compactSeed(draft.seed),
      };
    }
    return output;
  }

  function normalizedStagingDestination(placement, requested) {
    if (placement === 'hosted') return 'hosted';
    return String(requested || '').toLowerCase() === 'hosted' ? 'hosted' : 'local';
  }

  function showsHostedManagementLink(placement, requested) {
    return placement === 'desktop' && normalizedStagingDestination(placement, requested) === 'hosted';
  }

  function stagingBody(drafts, options = {}) {
    const legacyManagementLink = typeof options === 'string' ? options : '';
    const destination = typeof options === 'string'
      ? (legacyManagementLink ? 'hosted' : 'local')
      : normalizedStagingDestination('desktop', options.destination);
    const managementLink = typeof options === 'string'
      ? legacyManagementLink
      : (destination === 'hosted' ? String(options.managementLink || '') : '');
    const selected = [];
    const edits = [];
    for (const [key, draft] of Object.entries(drafts || {})) {
      if (!draft || draft.selected !== true) continue;
      const index = Number(key);
      selected.push(index);
      edits.push({ index, seed: compactSeed(draft.seed) });
    }
    return {
      selected,
      edits,
      destination,
      ...(managementLink ? { managementLink: String(managementLink) } : {}),
    };
  }

  function cultureGroups(analysis) {
    const culture = analysis && analysis.culture || {};
    return [
      ['Recurring jokes', culture.recurringJokes],
      ['Running bits', culture.runningBits],
      ['Common formats', culture.postFormats],
      ['Humour and style', culture.humour],
      ['Recurring topics', culture.recurringTopics],
      ['Response conventions', culture.responseConventions],
      ['Interaction patterns', culture.interactionPatterns],
      ['Archetypes and social roles', [...(culture.archetypes || []), ...(culture.socialRoles || [])]],
    ].filter((entry) => Array.isArray(entry[1]) && entry[1].length);
  }

  function progressLabel(task) {
    if (!task) return '';
    const progress = task.progress || {};
    if (task.state === 'failed') return task.error && task.error.message || 'Importer action failed.';
    if (task.state === 'cancelled') return 'Importer action cancelled.';
    return String(progress.message || task.state || '');
  }

  function sessionRenderFingerprint(session) {
    const value = session && typeof session === 'object' ? session : {};
    return JSON.stringify({
      input: value.input,
      source: value.source,
      sourceStatus: value.sourceStatus,
      analysis: value.analysis,
      analysisProvider: value.analysisProvider,
      review: value.review,
      candidates: value.candidates,
      rejected: value.rejected,
      warnings: value.warnings,
      staging: value.staging,
      generationCapacity: value.generationCapacity,
      generationBatches: value.generationBatches,
    });
  }

  function requireSession(session) {
    if (!session || typeof session !== 'object' || !session.id) {
      throw new Error('The importer returned an invalid session.');
    }
    return session;
  }

  function stagingResultRows(staging) {
    return (staging && Array.isArray(staging.results) ? staging.results : []).map((result) => {
      const candidateIndex = result.importerCandidateIndex == null
        ? Number(result.index)
        : Number(result.importerCandidateIndex);
      return {
        label: String(result.username || 'Candidate ' + ((Number.isFinite(candidateIndex) ? candidateIndex : 0) + 1)),
        code: String(result.code || (result.ok ? 'STAGED' : 'FAILED')),
        message: String(result.message || ''),
        ok: result.ok === true,
      };
    });
  }

  function defaultWorkflow() {
    return {
      form: {
        subreddit: '', maxPosts: 100, maxComments: 600, windowDays: 30,
        candidateCount: 3, communities: 'botlife', providerChoice: '', stagingDestination: 'local',
      },
      session: null,
      candidateDrafts: {},
      contributorLabels: new Set(),
      archetypes: new Set(),
      managementLink: '',
      staging: null,
      busy: false,
      polling: false,
      restoring: false,
      restored: false,
      savedSessionId: '',
      disclosureState: {},
    };
  }

  function readClientState(storage, key = CLIENT_STATE_KEY) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      const parsed = JSON.parse(storage.getItem(key) || 'null');
      if (!parsed || parsed.version !== CLIENT_STATE_VERSION) return null;
      return {
        sessionId: String(parsed.sessionId || ''),
        form: safeClientForm(parsed.form),
        candidateDrafts: safeCandidateDrafts(parsed.candidateDrafts),
        contributorLabels: Array.isArray(parsed.contributorLabels) ? parsed.contributorLabels.map(String) : [],
        archetypes: Array.isArray(parsed.archetypes) ? parsed.archetypes.map(String) : [],
      };
    } catch {
      return null;
    }
  }

  function writeClientState(storage, state, key = CLIENT_STATE_KEY) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    const value = state && typeof state === 'object' ? state : {};
    const safe = {
      version: CLIENT_STATE_VERSION,
      sessionId: String(value.sessionId || ''),
      form: safeClientForm(value.form),
      candidateDrafts: safeCandidateDrafts(value.candidateDrafts),
      contributorLabels: Array.isArray(value.contributorLabels) ? value.contributorLabels.map(String) : [],
      archetypes: Array.isArray(value.archetypes) ? value.archetypes.map(String) : [],
    };
    try {
      storage.setItem(key, JSON.stringify(safe));
      return true;
    } catch {
      return false;
    }
  }

  function formatAge(milliseconds) {
    const value = Math.max(0, Number(milliseconds) || 0);
    if (value < 60_000) return 'less than a minute old';
    if (value < 3_600_000) return Math.floor(value / 60_000) + ' minute(s) old';
    if (value < 86_400_000) return Math.floor(value / 3_600_000) + ' hour(s) old';
    return Math.floor(value / 86_400_000) + ' day(s) old';
  }

  function providerValue(choice) {
    return encodeURIComponent(choice.provider) + '|' + encodeURIComponent(choice.model || '');
  }

  function readProviderValue(value) {
    const parts = String(value || '').split('|');
    try {
      return { provider: decodeURIComponent(parts[0] || ''), model: decodeURIComponent(parts[1] || '') };
    } catch {
      return { provider: '', model: '' };
    }
  }

  function createController(options = {}) {
    const api = options.api;
    const toast = options.toast || (() => {});
    const esc = options.escape || ((value) => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
    const getProviders = options.getProviders || (() => []);
    const getPlacement = options.getPlacement || (() => 'desktop');
    const getDeveloperTools = options.getDeveloperTools || (() => false);
    const getPopulationAdmin = options.getPopulationAdmin || (() => false);
    const storage = options.storage === undefined
      ? (typeof localStorage !== 'undefined' ? localStorage : null)
      : options.storage;
    const storageKey = String(options.storageKey || CLIENT_STATE_KEY);
    const pollWait = options.pollWait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const workflow = defaultWorkflow();
    const savedClientState = readClientState(storage, storageKey);
    if (savedClientState) {
      workflow.savedSessionId = savedClientState.sessionId;
      workflow.form = { ...workflow.form, ...savedClientState.form };
      workflow.candidateDrafts = savedClientState.candidateDrafts;
      workflow.contributorLabels = new Set(savedClientState.contributorLabels);
      workflow.archetypes = new Set(savedClientState.archetypes);
    }
    let root = null;
    let hasRenderedImporter = false;
    let lastRenderedSessionId = '';

    function persistClientState() {
      return writeClientState(storage, {
        sessionId: workflow.session && workflow.session.id || workflow.savedSessionId,
        form: workflow.form,
        candidateDrafts: workflow.candidateDrafts,
        contributorLabels: [...workflow.contributorLabels],
        archetypes: [...workflow.archetypes],
      }, storageKey);
    }

    function allowed() {
      return entryVisible(getDeveloperTools(), getPlacement(), getPopulationAdmin());
    }

    function choices() {
      return connectedProviderChoices(getProviders());
    }

    function selectedProvider() {
      const available = choices();
      const current = readProviderValue(workflow.form.providerChoice);
      if (available.some((choice) => choice.provider === current.provider && choice.model === current.model)) return current;
      const first = available[0] || { provider: '', model: '' };
      workflow.form.providerChoice = first.provider ? providerValue(first) : '';
      return first;
    }

    function sessionTaskRunning() {
      const state = workflow.session && workflow.session.task && workflow.session.task.state;
      return state === 'running' || state === 'cancelling';
    }

    function disclosureOpen(key, defaultOpen) {
      return Object.prototype.hasOwnProperty.call(workflow.disclosureState, key)
        ? workflow.disclosureState[key] === true
        : defaultOpen === true;
    }

    function disclosureAttribute(key, defaultOpen) {
      return disclosureOpen(key, defaultOpen) ? ' open' : '';
    }

    function sourceHtml() {
      const source = workflow.session && workflow.session.source;
      const status = workflow.session && workflow.session.sourceStatus || {};
      const warnings = source && Array.isArray(source.warnings) ? source.warnings : [];
      if (!source) {
        return status.message ? '<div class="warnbox">' + esc(status.message) + '</div>' : '';
      }
      const cache = source.cache || {};
      const unavailable = source.available === false;
      const age = cache.ageMs == null ? '' : formatAge(cache.ageMs);
      const freshness = cache.state === 'stale' ? 'Saved sample is past its freshness window.' : 'Saved sample is within its freshness window.';
      return '<div class="culture-summary"><b>' + (unavailable ? 'Saved source reference unavailable' : 'Saved ' + esc(source.provider || 'source') + ' sample ready') + '</b><span>r/' + esc(source.subreddit) +
        ': ' + Number(source.posts || 0) + ' posts and ' + Number(source.comments || 0) + ' comments</span>' +
        '<span>' + (source.complete ? 'Source marked complete.' : 'Source marked partial; review its warnings before analysis.') + '</span>' +
        (age ? '<span>' + esc(age) + '. ' + esc(freshness) + '</span>' : '') +
        '<span>' + esc(status.message || (cache.hit ? 'Used the existing private cache.' : 'Fetched and cached a fresh bounded sample.')) + '</span>' +
        warnings.map((warning) => '<span class="warnbox">' + esc(warning) + '</span>').join('') + '</div>';
    }

    function progressHtml() {
      const task = workflow.session && workflow.session.task;
      if (!task) return '';
      const failed = task.state === 'failed';
      return '<div class="culture-progress ' + (failed ? 'failed' : '') + '" role="status" aria-live="polite">' +
        '<span class="dot ' + (failed ? 'bad' : (sessionTaskRunning() ? 'warn' : 'good')) + '"></span>' +
        '<span>' + esc(progressLabel(task)) + '</span>' +
        (sessionTaskRunning() ? '<button type="button" id="cultureCancelBtn">Cancel</button>' : '') + '</div>';
    }

    function providerHtml() {
      const available = choices();
      selectedProvider();
      if (!available.length) {
        return '<div class="warnbox">No connected AI provider is ready. Connect one in Settings before analysing this sample.</div>';
      }
      return '<div class="field"><label for="cultureProvider">AI provider and model</label><select id="cultureProvider">' +
        available.map((choice) => '<option value="' + esc(providerValue(choice)) + '"' +
          (providerValue(choice) === workflow.form.providerChoice ? ' selected' : '') + '>' + esc(choice.label) + '</option>').join('') +
        '</select><div class="hint">The same connected AI is used for culture mining and fictional character generation. There is no silent provider fallback.</div></div>';
    }

    function listHtml(items) {
      return '<ul>' + (Array.isArray(items) ? items : []).map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>';
    }

    function analysisHtml() {
      const analysis = workflow.session && workflow.session.analysis;
      if (!analysis) return '<div class="hint">Fetch a source sample, choose a connected AI, then analyse it.</div>';
      const groups = cultureGroups(analysis);
      const culture = analysis.culture || {};
      const contributors = Array.isArray(analysis.contributors) ? analysis.contributors : [];
      const archetypes = [...new Set([...(culture.archetypes || []), ...(culture.socialRoles || [])])];
      return '<div class="culture-summary"><b>Observed culture</b><span>' + esc(culture.summary || 'No summary was returned.') + '</span></div>' +
        '<div class="culture-observations">' + groups.map((group) => '<section><h4>' + esc(group[0]) + '</h4>' + listHtml(group[1]) + '</section>').join('') + '</div>' +
        '<h3>Contributor influences</h3><p class="hint">These are anonymous evidence-linked sample roles, not identities. Select only the influences you want used in fictional composite characters.</p>' +
        '<div class="culture-influences">' + contributors.map((contributor) => {
          const label = String(contributor.label || 'anonymous contributor');
          return '<label class="culture-influence"><input type="checkbox" data-culture-contributor="' + esc(label) + '"' +
            (workflow.contributorLabels.has(label) ? ' checked' : '') + '><span><b>' + esc(label) + '</b>' +
            '<span>' + esc(contributor.voice || contributor.humour || 'Observed interaction pattern') + '</span>' +
            '<small>' + Number((contributor.evidenceSourceIds || []).length) + ' supporting sample item(s)</small></span></label>';
        }).join('') + '</div>' +
        (archetypes.length ? '<h3>Archetypes and social roles</h3><div class="culture-chip-list">' + archetypes.map((item) =>
          '<label><input type="checkbox" data-culture-archetype="' + esc(item) + '"' + (workflow.archetypes.has(item) ? ' checked' : '') + '> ' + esc(item) + '</label>').join('') + '</div>' : '') +
        '<details class="culture-raw" data-culture-disclosure="analysis-raw"' + disclosureAttribute('analysis-raw', false) + '><summary>Developer diagnostic: normalized analysis</summary><pre>' + esc(JSON.stringify(analysis, null, 2)) + '</pre></details>';
    }

    function fieldInput(index, seed, field, label, type) {
      const value = LIST_FIELDS.has(field) ? (seed[field] || []).join(', ') : String(seed[field] == null ? '' : seed[field]);
      if (type === 'textarea') {
        return '<div class="field full"><label>' + esc(label) + '</label><textarea data-candidate-index="' + index + '" data-seed-field="' + field + '">' + esc(value) + '</textarea></div>';
      }
      return '<div class="field"><label>' + esc(label) + '</label><input data-candidate-index="' + index + '" data-seed-field="' + field + '" value="' + esc(value) + '"></div>';
    }

    function candidateHtml(candidate, index) {
      const draft = workflow.candidateDrafts[index] || { selected: true, seed: clone(candidate.seed || {}) };
      const seed = draft.seed;
      const metadata = candidate.importerMetadata || {};
      const abilities = seed.abilities || {};
      const disclosureKey = 'candidate:' + String(candidate.id || index);
      return '<details class="culture-candidate" data-culture-disclosure="' + esc(disclosureKey) + '"' + disclosureAttribute(disclosureKey, true) + '><summary><label><input type="checkbox" data-candidate-selected="' + index + '"' +
        (draft.selected ? ' checked' : '') + '> Stage ' + esc(seed.username || 'candidate ' + (index + 1)) + '</label><span>' + esc(seed.biography || '') + '</span></summary>' +
        '<div class="culture-candidate-body"><div class="grid">' +
        fieldInput(index, seed, 'username', 'Feddit username') +
        fieldInput(index, seed, 'biography', 'Public biography', 'textarea') +
        fieldInput(index, seed, 'temperament', 'Temperament') +
        fieldInput(index, seed, 'interests', 'Interests (comma-separated)') +
        fieldInput(index, seed, 'dislikes', 'Dislikes (comma-separated)') +
        fieldInput(index, seed, 'conversationalStyle', 'Conversational style', 'textarea') +
        fieldInput(index, seed, 'humourStyle', 'Humour style') +
        fieldInput(index, seed, 'curiosity', 'Curiosity') +
        fieldInput(index, seed, 'disagreementStyle', 'Disagreement style', 'textarea') +
        fieldInput(index, seed, 'sociability', 'Sociability') +
        fieldInput(index, seed, 'initiative', 'Initiative') +
        fieldInput(index, seed, 'breadth', 'Breadth') +
        fieldInput(index, seed, 'fictionalBackground', 'Fictional background', 'textarea') +
        fieldInput(index, seed, 'values', 'Values (comma-separated)') +
        fieldInput(index, seed, 'persistence', 'Persistence') +
        fieldInput(index, seed, 'noveltySeeking', 'Novelty seeking') +
        fieldInput(index, seed, 'toneNotes', 'Tone notes', 'textarea') +
        fieldInput(index, seed, 'communities', 'Feddit communities (comma-separated)') + '</div>' +
        '<fieldset class="culture-abilities"><legend>Allowed actions</legend>' + ['reply', 'discuss', 'links'].map((ability) =>
          '<label><input type="checkbox" data-candidate-index="' + index + '" data-seed-field="abilities.' + ability + '"' +
          (abilities[ability] ? ' checked' : '') + '> ' + ({ reply: 'Reply to discussions', discuss: 'Start text discussions', links: 'Share article links' })[ability] + '</label>').join('') + '</fieldset>' +
        '<div class="culture-reference"><b>Review-only importer notes</b>' +
        (metadata.inspirationLabels && metadata.inspirationLabels.length ? '<div>Influences: ' + esc(metadata.inspirationLabels.join(', ')) + '</div>' : '') +
        (metadata.behaviourObservations && metadata.behaviourObservations.length ? listHtml(metadata.behaviourObservations) : '') +
        '<div class="hint">These notes are not included in the staged population seed or runtime persona.</div></div></div></details>';
    }

    function stagingResultsHtml() {
      const staging = workflow.staging || workflow.session && workflow.session.staging;
      if (!staging) return '';
      const error = staging.error && (staging.error.message || staging.error);
      const destination = normalizedStagingDestination(getPlacement(), staging.destination || workflow.form.stagingDestination);
      const destinationLabel = destination === 'local' ? 'this desktop app' : 'the hosted Feddit Bots workspace';
      return '<div class="culture-stage-results ' + (staging.ok === false ? 'failed' : '') + '"><b>' +
        (staging.ok === false ? 'Staging needs attention' : 'Staging result') + '</b>' +
        (error ? '<p>' + esc(error) + '</p>' : '') +
        '<ul>' + stagingResultRows(staging).map((result) => '<li><b>' + esc(result.label) +
          ':</b> ' + esc(result.code) + ' - ' + esc(result.message) + '</li>').join('') + '</ul>' +
        (staging.ok !== false ? '<p>Created in ' + esc(destinationLabel) + '. Staged candidates remain disabled rehearsal bots. Nothing was activated or published.</p>' : '') + '</div>';
    }

    function candidatesHtml() {
      const candidates = workflow.session && workflow.session.candidates || [];
      if (!candidates.length) return '<div class="hint">Generate candidates after reviewing the culture and selected influences.</div>';
      return (workflow.session.warnings || []).map((warning) => '<div class="warnbox">' + esc(warning) + '</div>').join('') +
        '<div class="culture-candidates">' + candidates.map(candidateHtml).join('') + '</div>';
    }

    function progressRegionHtml() {
      return progressHtml() +
        (workflow.restoring ? '<div class="culture-progress" role="status"><span class="dot warn"></span><span>Restoring saved importer work...</span></div>' : '');
    }

    function captureFocus() {
      if (!root || !root.ownerDocument) return null;
      const active = root.ownerDocument.activeElement;
      if (!active || (typeof root.contains === 'function' && !root.contains(active))) return null;
      let selector = '';
      if (active.id) selector = '#' + active.id;
      else if (active.dataset && active.dataset.candidateIndex != null && active.dataset.seedField) {
        selector = '[data-candidate-index="' + active.dataset.candidateIndex + '"][data-seed-field="' + active.dataset.seedField + '"]';
      } else if (active.dataset && active.dataset.candidateSelected != null) {
        selector = '[data-candidate-selected="' + active.dataset.candidateSelected + '"]';
      } else if (active.dataset && active.dataset.cultureContributor != null) {
        return { collection: '[data-culture-contributor]', key: 'cultureContributor', value: active.dataset.cultureContributor };
      } else if (active.dataset && active.dataset.cultureArchetype != null) {
        return { collection: '[data-culture-archetype]', key: 'cultureArchetype', value: active.dataset.cultureArchetype };
      }
      if (!selector) return null;
      return {
        selector,
        start: Number.isInteger(active.selectionStart) ? active.selectionStart : null,
        end: Number.isInteger(active.selectionEnd) ? active.selectionEnd : null,
        direction: active.selectionDirection || 'none',
      };
    }

    function restoreFocus(snapshot) {
      if (!snapshot || !root) return;
      const element = snapshot.collection
        ? [...root.querySelectorAll(snapshot.collection)].find((candidate) =>
          candidate.dataset && candidate.dataset[snapshot.key] === snapshot.value)
        : root.querySelector(snapshot.selector);
      if (!element || typeof element.focus !== 'function') return;
      try { element.focus({ preventScroll: true }); } catch { element.focus(); }
      if (snapshot.start != null && typeof element.setSelectionRange === 'function') {
        try { element.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction); } catch { /* unsupported input type */ }
      }
    }

    function captureInteractiveState() {
      if (!root) return null;
      const focus = captureFocus();
      captureForm(false);
      root.querySelectorAll('[data-culture-contributor]').forEach((element) => {
        if (element.checked) workflow.contributorLabels.add(element.dataset.cultureContributor);
        else workflow.contributorLabels.delete(element.dataset.cultureContributor);
      });
      root.querySelectorAll('[data-culture-archetype]').forEach((element) => {
        if (element.checked) workflow.archetypes.add(element.dataset.cultureArchetype);
        else workflow.archetypes.delete(element.dataset.cultureArchetype);
      });
      root.querySelectorAll('[data-candidate-selected]').forEach((element) => {
        updateCandidateDraft(workflow.candidateDrafts, Number(element.dataset.candidateSelected), 'selected', element.checked);
      });
      root.querySelectorAll('[data-candidate-index][data-seed-field]').forEach((element) => {
        const value = element.type === 'checkbox' ? element.checked : element.value;
        updateCandidateDraft(workflow.candidateDrafts, Number(element.dataset.candidateIndex), element.dataset.seedField, value);
      });
      persistClientState();
      return focus;
    }

    function render() {
      if (!root) return;
      const sessionId = workflow.session && workflow.session.id || '';
      const focus = hasRenderedImporter && sessionId === lastRenderedSessionId
        ? captureInteractiveState()
        : null;
      if (!allowed()) {
        root.innerHTML = '<div class="empty">The culture importer is available only in Developer tools' +
          (getPlacement() === 'hosted' ? ' for the population operator.' : '.') + '</div>';
        return;
      }
      const provider = selectedProvider();
      const sourceReady = Boolean(workflow.session && workflow.session.source && workflow.session.source.available !== false);
      const analysisReady = Boolean(workflow.session && workflow.session.analysis);
      const candidatesReady = Boolean(workflow.session && workflow.session.candidates && workflow.session.candidates.length);
      const generationCapacity = workflow.session && workflow.session.generationCapacity || {
        limit: MAX_CANDIDATE_COLLECTION,
        used: workflow.session && workflow.session.candidates ? workflow.session.candidates.length : 0,
        remaining: MAX_CANDIDATE_COLLECTION - (workflow.session && workflow.session.candidates ? workflow.session.candidates.length : 0),
      };
      const generationRemaining = Math.max(0, Number(generationCapacity.remaining));
      const generationValue = Math.min(
        Math.max(1, Number(workflow.form.candidateCount) || 1),
        Math.max(1, generationRemaining),
      );
      const running = sessionTaskRunning();
      const placement = getPlacement();
      const stagingDestination = normalizedStagingDestination(placement, workflow.form.stagingDestination);
      const showHostedLink = showsHostedManagementLink(placement, stagingDestination);
      root.innerHTML = '<div class="culture-importer-page"><div class="culture-page-head"><div><h2>Subreddit culture importer</h2>' +
        '<p class="lead">Mine a bounded public community sample into reviewable fictional composite Feddit characters. Fetching and generation never stage or activate anything.</p>' +
        '<p class="hint">Saved work is restored privately on reopen. Restoration never retrieves source data, calls an AI provider, or repeats staging.</p>' +
        '<p class="hint">Cancel stops the review step and discards late output. Provider work already accepted by hosted compute may still finish safely in its durable queue.</p></div>' +
        '<button type="button" id="cultureBackBtn">Back to bots</button></div><div id="cultureProgressRegion">' + progressRegionHtml() + '</div>' +
        '<details class="section progressive" data-culture-disclosure="source"' + disclosureAttribute('source', true) + '><summary>1. Source sample</summary><div class="progressive-body"><div class="grid">' +
        '<div class="field"><label for="cultureSubreddit">Subreddit</label><input id="cultureSubreddit" value="' + esc(workflow.form.subreddit) + '" placeholder="for example, CasualUK"></div>' +
        '<div class="field"><label for="cultureWindow">Recent window</label><select id="cultureWindow">' +
        [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [0, 'As much as the bounded listing returns']].map((item) =>
          '<option value="' + item[0] + '"' + (Number(workflow.form.windowDays) === item[0] ? ' selected' : '') + '>' + item[1] + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="culturePostCount">Post sample size</label><input id="culturePostCount" type="number" min="1" max="1000" value="' + esc(workflow.form.maxPosts) + '"></div>' +
        '<div class="field"><label for="cultureCommentCount">Comment sample size</label><input id="cultureCommentCount" type="number" min="1" max="5000" value="' + esc(workflow.form.maxComments) + '"></div></div>' +
        '<div class="row"><button type="button" class="primary" id="cultureFetchBtn"' + (running || workflow.restoring ? ' disabled' : '') + '>Use matching saved sample</button>' +
        '<button type="button" id="cultureRefreshBtn"' + (running || workflow.restoring ? ' disabled' : '') + '>Retrieve fresh source sample</button></div>' +
        '<p class="hint">The saved-cache action reuses a compatible private corpus where possible. Only Retrieve fresh source sample deliberately bypasses it and makes a new upstream request.</p>' + sourceHtml() + '</div></details>' +
        '<details class="section progressive" data-culture-disclosure="analysis"' + disclosureAttribute('analysis', sourceReady) + '><summary>2. Culture and influences</summary><div class="progressive-body">' +
        providerHtml() + '<div class="row"><button type="button" class="primary" id="cultureAnalyseBtn"' + (!sourceReady || running || !provider.provider ? ' disabled' : '') + '>Analyse community culture</button></div>' + analysisHtml() + '</div></details>' +
        '<details class="section progressive" data-culture-disclosure="generation"' + disclosureAttribute('generation', analysisReady) + '><summary>3. Generate fictional candidates</summary><div class="progressive-body"><div class="grid">' +
        '<div class="field"><label for="cultureCandidateCount">Characters to add</label><input id="cultureCandidateCount" type="number" min="1" max="' + Math.max(1, generationRemaining) + '" value="' + esc(generationValue) + '"' + (generationRemaining ? '' : ' disabled') + '></div>' +
        '<div class="field"><label for="cultureCommunities">Target Feddit communities</label><input id="cultureCommunities" value="' + esc(workflow.form.communities) + '" placeholder="botlife, casualUK"></div></div>' +
        '<button type="button" class="primary" id="cultureGenerateBtn"' + (!analysisReady || running || !provider.provider || !generationRemaining ? ' disabled' : '') + '>' + (candidatesReady ? 'Generate and append characters' : 'Generate candidate characters') + '</button>' +
        '<p class="hint">Collection: ' + Number(generationCapacity.used || 0) + ' of ' + Number(generationCapacity.limit || MAX_CANDIDATE_COLLECTION) + '. Requests are split into provider batches of at most 6 and each completed batch is saved. Existing analysis and candidates are reused; this action does not retrieve source data, re-analyse culture or stage anything.</p></div></details>' +
        '<details class="section progressive" data-culture-disclosure="review"' + disclosureAttribute('review', candidatesReady) + '><summary>4. Review and edit candidates</summary><div class="progressive-body">' + candidatesHtml() + '</div></details>' +
        '<details class="section progressive" data-culture-disclosure="staging"' + disclosureAttribute('staging', candidatesReady) + '><summary>5. Stage selected candidates</summary><div class="progressive-body">' +
        (placement === 'desktop' ? '<div class="field full"><label for="cultureStagingDestination">Create bots in</label><select id="cultureStagingDestination">' +
          '<option value="local"' + (stagingDestination === 'local' ? ' selected' : '') + '>This desktop app</option>' +
          '<option value="hosted"' + (stagingDestination === 'hosted' ? ' selected' : '') + '>Hosted Feddit Bots workspace</option></select>' +
          '<div class="hint">Desktop creates profiles in this installation. They appear under Background population, disabled and in rehearsal, until you explicitly start and switch them to LIVE.</div></div>' :
          '<p class="hint">Selected candidates will be created in this hosted Feddit Bots workspace.</p>') +
        (showHostedLink ? '<div class="field full"><label for="cultureManagementLink">Hosted private management link</label><input id="cultureManagementLink" type="password" autocomplete="off" value="' + esc(workflow.managementLink) + '" placeholder="https://feddit-bots.dabblelabs.uk/#manage=...">' +
          '<div class="hint">This private capability authorizes access to that hosted workspace, which must also be an authorized background-population operator. In the hosted dashboard, open Settings and choose Copy private management link. It is used only for this explicit request and is never saved, logged or sent to an AI model.</div></div>' : '') +
        '<button type="button" class="primary" id="cultureStageBtn"' + (!candidatesReady || workflow.busy ? ' disabled' : '') + '>Stage selected candidates</button>' +
        '<p class="hint">Select 1-' + STAGING_SELECTION_LIMIT + ' candidates per explicit staging action. Larger selections are rejected and never split automatically. Staged bots remain disabled and in rehearsal until separately reviewed and activated through normal population controls.</p>' +
        stagingResultsHtml() + '</div></details></div>';
      bind();
      restoreFocus(focus);
      hasRenderedImporter = true;
      lastRenderedSessionId = sessionId;
    }

    function captureForm(persist = true) {
      const assignText = (selector, field) => {
        const element = root && root.querySelector(selector);
        if (element) workflow.form[field] = element.value;
      };
      const assignNumber = (selector, field) => {
        const element = root && root.querySelector(selector);
        if (element) workflow.form[field] = element.value === '' ? '' : Number(element.value);
      };
      assignText('#cultureSubreddit', 'subreddit');
      assignNumber('#culturePostCount', 'maxPosts');
      assignNumber('#cultureCommentCount', 'maxComments');
      assignNumber('#cultureWindow', 'windowDays');
      assignNumber('#cultureCandidateCount', 'candidateCount');
      assignText('#cultureCommunities', 'communities');
      assignText('#cultureProvider', 'providerChoice');
      const destination = root && root.querySelector('#cultureStagingDestination');
      if (destination) workflow.form.stagingDestination = normalizedStagingDestination(getPlacement(), destination.value);
      const managementLink = root && root.querySelector('#cultureManagementLink');
      if (managementLink) workflow.managementLink = managementLink.value;
      if (persist) persistClientState();
    }

    function fetchBody(refresh) {
      captureForm();
      const days = Number(workflow.form.windowDays);
      const since = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : '';
      return {
        subreddit: workflow.form.subreddit,
        maxPosts: workflow.form.maxPosts,
        maxComments: workflow.form.maxComments,
        since,
        refresh: refresh === true,
        cacheOnly: refresh !== true,
      };
    }

    function applySession(session) {
      requireSession(session);
      const sameSession = Boolean((workflow.session && workflow.session.id === session.id) || workflow.savedSessionId === session.id);
      const hadCandidates = Boolean(sameSession && workflow.session && workflow.session.candidates && workflow.session.candidates.length);
      workflow.session = session;
      workflow.savedSessionId = session.id;
      if (!sameSession && session.input) {
        workflow.form.subreddit = session.input.subreddit || workflow.form.subreddit;
        workflow.form.maxPosts = Number(session.input.maxPosts) || workflow.form.maxPosts;
        workflow.form.maxComments = Number(session.input.maxComments) || workflow.form.maxComments;
        const since = Date.parse(session.input.since || '');
        if (Number.isFinite(since)) {
          const days = Math.max(0, Math.round((Date.now() - since) / 86400000));
          workflow.form.windowDays = [7, 30, 90].sort((left, right) => Math.abs(left - days) - Math.abs(right - days))[0];
        }
      }
      if (!sameSession && session.review) {
        workflow.form.candidateCount = Number(session.review.count) || workflow.form.candidateCount;
        workflow.form.communities = (session.review.targetCommunities || []).join(', ') || workflow.form.communities;
        workflow.form.providerChoice = providerValue(session.review);
        workflow.contributorLabels = new Set(session.review.contributorLabels || []);
        workflow.archetypes = new Set(session.review.archetypes || []);
      } else if (!sameSession && session.analysisProvider && session.analysisProvider.provider) {
        workflow.form.providerChoice = providerValue(session.analysisProvider);
      }
      if (session.candidates && session.candidates.length) {
        workflow.candidateDrafts = createCandidateDrafts(session.candidates, sameSession || hadCandidates ? workflow.candidateDrafts : null);
      } else if (!hadCandidates) workflow.candidateDrafts = {};
      workflow.staging = clone(session.staging);
      persistClientState();
    }

    async function restoreWorkspace() {
      if (workflow.restoring || workflow.restored || workflow.session) return;
      workflow.restoring = true;
      render();
      try {
        let response = null;
        if (workflow.savedSessionId) {
          try {
            response = await api('/api/culture-imports/' + encodeURIComponent(workflow.savedSessionId));
          } catch { /* the backend may have restarted or the saved workspace may have expired */ }
        }
        if (!response) {
          response = await api('/api/culture-imports', { method: 'POST', body: { restore: true } });
        }
        applySession(response.session);
        if (sessionTaskRunning()) poll();
      } catch (error) {
        toast('Could not restore saved importer work: ' + error.message, 'err');
      } finally {
        workflow.restoring = false;
        workflow.restored = true;
        render();
      }
    }

    async function poll() {
      if (workflow.polling || !workflow.session) return;
      workflow.polling = true;
      try {
        while (sessionTaskRunning()) {
          const previousFingerprint = sessionRenderFingerprint(workflow.session);
          const previouslyRunning = sessionTaskRunning();
          await pollWait(650);
          const response = await api('/api/culture-imports/' + encodeURIComponent(workflow.session.id));
          applySession(response.session);
          const needsFullRender = previousFingerprint !== sessionRenderFingerprint(workflow.session) ||
            previouslyRunning !== sessionTaskRunning();
          if (needsFullRender) render();
          else updateProgress();
        }
        if (workflow.session.task && workflow.session.task.state === 'failed') {
          toast(progressLabel(workflow.session.task), 'err');
        }
      } catch (error) {
        toast('Could not refresh importer progress: ' + error.message, 'err');
      } finally {
        workflow.polling = false;
        updateProgress();
      }
    }

    async function cancelTask() {
      try {
        const response = await api('/api/culture-imports/' + encodeURIComponent(workflow.session.id) + '/cancel', { method: 'POST', body: {} });
        applySession(response.session);
        render();
      } catch (error) { toast(error.message, 'err'); }
    }

    function bindProgress() {
      const cancel = root && root.querySelector('#cultureCancelBtn');
      if (cancel) cancel.addEventListener('click', cancelTask);
    }

    function updateProgress() {
      if (!root) return;
      const region = root.querySelector('#cultureProgressRegion');
      if (!region) return render();
      region.innerHTML = progressRegionHtml();
      bindProgress();
    }

    async function start(path, body) {
      workflow.busy = true;
      render();
      try {
        const response = await api(path, { method: 'POST', body });
        applySession(response.session);
        render();
        poll();
      } catch (error) {
        toast(error.message, 'err');
      } finally {
        workflow.busy = false;
        render();
      }
    }

    function bind() {
      const on = (selector, event, handler) => {
        const element = root.querySelector(selector);
        if (element) element.addEventListener(event, handler);
      };
      on('#cultureBackBtn', 'click', () => options.onBack && options.onBack());
      on('#cultureFetchBtn', 'click', () => start('/api/culture-imports', fetchBody(false)));
      on('#cultureRefreshBtn', 'click', () => start('/api/culture-imports', fetchBody(true)));
      on('#cultureProvider', 'change', (event) => {
        workflow.form.providerChoice = event.target.value;
        persistClientState();
      });
      on('#cultureStagingDestination', 'change', (event) => {
        workflow.form.stagingDestination = normalizedStagingDestination(getPlacement(), event.target.value);
        persistClientState();
        render();
      });
      on('#cultureAnalyseBtn', 'click', () => {
        captureForm();
        const selected = selectedProvider();
        start('/api/culture-imports/' + encodeURIComponent(workflow.session.id) + '/analyse', selected);
      });
      on('#cultureGenerateBtn', 'click', () => {
        captureForm();
        const selected = selectedProvider();
        start('/api/culture-imports/' + encodeURIComponent(workflow.session.id) + '/generate', {
          ...selected,
          count: workflow.form.candidateCount,
          targetCommunities: parseList(workflow.form.communities),
          contributorLabels: [...workflow.contributorLabels],
          archetypes: [...workflow.archetypes],
        });
      });
      bindProgress();
      on('#cultureStageBtn', 'click', async () => {
        captureForm();
        const destination = normalizedStagingDestination(getPlacement(), workflow.form.stagingDestination);
        const body = stagingBody(workflow.candidateDrafts, {
          destination,
          managementLink: workflow.managementLink,
        });
        if (!body.selected.length) return toast('Select at least one candidate to stage.', 'err');
        if (body.selected.length > STAGING_SELECTION_LIMIT) {
          return toast('Select at most ' + STAGING_SELECTION_LIMIT + ' candidates. Staging is never split automatically.', 'err');
        }
        if (showsHostedManagementLink(getPlacement(), destination) && !workflow.managementLink) {
          return toast('Paste the private management link for the hosted workspace first.', 'err');
        }
        workflow.busy = true;
        render();
        try {
          const response = await api('/api/culture-imports/' + encodeURIComponent(workflow.session.id) + '/stage', { method: 'POST', body });
          workflow.staging = response.result;
          applySession(response.session);
          toast('Selected candidates were created in ' + (destination === 'local' ? 'this desktop app' : 'the hosted workspace') + ' in rehearsal. Nothing was activated.', 'ok');
        } catch (error) {
          workflow.staging = error.data || { ok: false, error: { message: error.message }, results: [] };
          toast('Staging failed: ' + error.message, 'err');
        } finally {
          workflow.busy = false;
          render();
        }
      });
      root.querySelectorAll('[data-culture-contributor]').forEach((element) => element.onchange = () => {
        if (element.checked) workflow.contributorLabels.add(element.dataset.cultureContributor);
        else workflow.contributorLabels.delete(element.dataset.cultureContributor);
        persistClientState();
      });
      root.querySelectorAll('[data-culture-archetype]').forEach((element) => element.onchange = () => {
        if (element.checked) workflow.archetypes.add(element.dataset.cultureArchetype);
        else workflow.archetypes.delete(element.dataset.cultureArchetype);
        persistClientState();
      });
      root.querySelectorAll('[data-candidate-selected]').forEach((element) => element.onchange = () => {
        updateCandidateDraft(workflow.candidateDrafts, Number(element.dataset.candidateSelected), 'selected', element.checked);
        persistClientState();
      });
      root.querySelectorAll('[data-candidate-index][data-seed-field]').forEach((element) => element.oninput = () => {
        const value = element.type === 'checkbox' ? element.checked : element.value;
        updateCandidateDraft(workflow.candidateDrafts, Number(element.dataset.candidateIndex), element.dataset.seedField, value);
        persistClientState();
      });
      ['#cultureSubreddit', '#culturePostCount', '#cultureCommentCount', '#cultureWindow', '#cultureCandidateCount', '#cultureCommunities', '#cultureManagementLink']
        .forEach((selector) => on(selector, 'input', captureForm));
      root.querySelectorAll('details[data-culture-disclosure]').forEach((element) => {
        element.addEventListener('toggle', () => {
          workflow.disclosureState[element.dataset.cultureDisclosure] = element.open === true;
        });
      });
    }

    return {
      workflow,
      open(element) {
        root = element;
        render();
        if (sessionTaskRunning()) poll();
        else restoreWorkspace();
      },
      render,
      allowed,
      hasState() { return Boolean(workflow.session); },
    };
  }

  return {
    SEED_FIELDS,
    LIST_FIELDS,
    entryVisible,
    connectedProviderChoices,
    parseList,
    createCandidateDrafts,
    updateCandidateDraft,
    compactSeed,
    safeClientForm,
    safeCandidateDrafts,
    MAX_CANDIDATE_COLLECTION,
    STAGING_SELECTION_LIMIT,
    normalizedStagingDestination,
    showsHostedManagementLink,
    stagingBody,
    cultureGroups,
    progressLabel,
    sessionRenderFingerprint,
    requireSession,
    stagingResultRows,
    providerValue,
    readProviderValue,
    defaultWorkflow,
    CLIENT_STATE_VERSION,
    CLIENT_STATE_KEY,
    readClientState,
    writeClientState,
    formatAge,
    createController,
  };
});
