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

  function stagingBody(drafts, managementLink) {
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
        candidateCount: 3, communities: 'botlife', providerChoice: '',
      },
      session: null,
      candidateDrafts: {},
      contributorLabels: new Set(),
      archetypes: new Set(),
      managementLink: '',
      staging: null,
      busy: false,
      polling: false,
    };
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
    const workflow = defaultWorkflow();
    let root = null;

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

    function sourceHtml() {
      const source = workflow.session && workflow.session.source;
      const warnings = source && Array.isArray(source.warnings) ? source.warnings : [];
      return source ? '<div class="culture-summary"><b>Cached ' + esc(source.provider || 'source') + ' sample ready</b><span>r/' + esc(source.subreddit) +
        ': ' + Number(source.posts || 0) + ' posts and ' + Number(source.comments || 0) + ' comments</span>' +
        '<span>' + (source.cache && source.cache.hit ? 'Used the existing private cache.' : 'Fetched and cached a fresh bounded sample.') + '</span>' +
        warnings.map((warning) => '<span class="warnbox">' + esc(warning) + '</span>').join('') + '</div>' : '';
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
        '<details class="culture-raw"><summary>Developer diagnostic: normalized analysis</summary><pre>' + esc(JSON.stringify(analysis, null, 2)) + '</pre></details>';
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
      return '<details class="culture-candidate" open><summary><label><input type="checkbox" data-candidate-selected="' + index + '"' +
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
      return '<div class="culture-stage-results ' + (staging.ok === false ? 'failed' : '') + '"><b>' +
        (staging.ok === false ? 'Staging needs attention' : 'Staging result') + '</b>' +
        (error ? '<p>' + esc(error) + '</p>' : '') +
        '<ul>' + stagingResultRows(staging).map((result) => '<li><b>' + esc(result.label) +
          ':</b> ' + esc(result.code) + ' - ' + esc(result.message) + '</li>').join('') + '</ul>' +
        (staging.ok !== false ? '<p>Staged candidates remain disabled rehearsal bots. Nothing was activated or published.</p>' : '') + '</div>';
    }

    function candidatesHtml() {
      const candidates = workflow.session && workflow.session.candidates || [];
      if (!candidates.length) return '<div class="hint">Generate candidates after reviewing the culture and selected influences.</div>';
      return (workflow.session.warnings || []).map((warning) => '<div class="warnbox">' + esc(warning) + '</div>').join('') +
        '<div class="culture-candidates">' + candidates.map(candidateHtml).join('') + '</div>';
    }

    function render() {
      if (!root) return;
      if (!allowed()) {
        root.innerHTML = '<div class="empty">The culture importer is available only in Developer tools' +
          (getPlacement() === 'hosted' ? ' for the population operator.' : '.') + '</div>';
        return;
      }
      const provider = selectedProvider();
      const sourceReady = Boolean(workflow.session && workflow.session.source);
      const analysisReady = Boolean(workflow.session && workflow.session.analysis);
      const candidatesReady = Boolean(workflow.session && workflow.session.candidates && workflow.session.candidates.length);
      const running = sessionTaskRunning();
      root.innerHTML = '<div class="culture-importer-page"><div class="culture-page-head"><div><h2>Subreddit culture importer</h2>' +
        '<p class="lead">Mine a bounded public community sample into reviewable fictional composite Feddit characters. Fetching and generation never stage or activate anything.</p>' +
        '<p class="hint">Cancel stops the review step and discards late output. Provider work already accepted by hosted compute may still finish safely in its durable queue.</p></div>' +
        '<button type="button" id="cultureBackBtn">Back to bots</button></div>' + progressHtml() +
        '<details class="section progressive" open><summary>1. Source sample</summary><div class="progressive-body"><div class="grid">' +
        '<div class="field"><label for="cultureSubreddit">Subreddit</label><input id="cultureSubreddit" value="' + esc(workflow.form.subreddit) + '" placeholder="for example, CasualUK"></div>' +
        '<div class="field"><label for="cultureWindow">Recent window</label><select id="cultureWindow">' +
        [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [0, 'As much as the bounded listing returns']].map((item) =>
          '<option value="' + item[0] + '"' + (Number(workflow.form.windowDays) === item[0] ? ' selected' : '') + '>' + item[1] + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="culturePostCount">Post sample size</label><input id="culturePostCount" type="number" min="1" max="1000" value="' + esc(workflow.form.maxPosts) + '"></div>' +
        '<div class="field"><label for="cultureCommentCount">Comment sample size</label><input id="cultureCommentCount" type="number" min="1" max="5000" value="' + esc(workflow.form.maxComments) + '"></div></div>' +
        '<div class="row"><button type="button" class="primary" id="cultureFetchBtn"' + (running ? ' disabled' : '') + '>' + (sourceReady ? 'Fetch another sample' : 'Fetch and cache sample') + '</button>' +
        (sourceReady ? '<button type="button" id="cultureRefreshBtn"' + (running ? ' disabled' : '') + '>Refresh source sample</button>' : '') + '</div>' + sourceHtml() + '</div></details>' +
        '<details class="section progressive"' + (sourceReady ? ' open' : '') + '><summary>2. Culture and influences</summary><div class="progressive-body">' +
        providerHtml() + '<div class="row"><button type="button" class="primary" id="cultureAnalyseBtn"' + (!sourceReady || running || !provider.provider ? ' disabled' : '') + '>Analyse community culture</button></div>' + analysisHtml() + '</div></details>' +
        '<details class="section progressive"' + (analysisReady ? ' open' : '') + '><summary>3. Generate fictional candidates</summary><div class="progressive-body"><div class="grid">' +
        '<div class="field"><label for="cultureCandidateCount">Candidates</label><input id="cultureCandidateCount" type="number" min="1" max="6" value="' + esc(workflow.form.candidateCount) + '"></div>' +
        '<div class="field"><label for="cultureCommunities">Target Feddit communities</label><input id="cultureCommunities" value="' + esc(workflow.form.communities) + '" placeholder="botlife, casualUK"></div></div>' +
        '<button type="button" class="primary" id="cultureGenerateBtn"' + (!analysisReady || running || !provider.provider ? ' disabled' : '') + '>Generate candidate characters</button>' +
        '<p class="hint">This calls the importer with only the selected anonymous influences and archetypes. It does not stage anything.</p></div></details>' +
        '<details class="section progressive"' + (candidatesReady ? ' open' : '') + '><summary>4. Review and edit candidates</summary><div class="progressive-body">' + candidatesHtml() + '</div></details>' +
        '<details class="section progressive"' + (candidatesReady ? ' open' : '') + '><summary>5. Stage selected candidates</summary><div class="progressive-body">' +
        (getPlacement() === 'desktop' ? '<div class="field full"><label for="cultureManagementLink">Hosted private management link</label><input id="cultureManagementLink" type="password" autocomplete="off" value="' + esc(workflow.managementLink) + '" placeholder="https://feddit-bots.dabblelabs.uk/#manage=..."><div class="hint">Used transiently for this explicit staging request. The importer does not save it.</div></div>' : '') +
        '<button type="button" class="primary" id="cultureStageBtn"' + (!candidatesReady || workflow.busy ? ' disabled' : '') + '>Stage selected candidates</button>' +
        '<p class="hint">This is the only action that creates population profiles. Staged bots remain disabled and in rehearsal until separately reviewed and activated through normal population controls.</p>' +
        stagingResultsHtml() + '</div></details></div>';
      bind();
    }

    function captureForm() {
      const value = (id) => root.querySelector(id) && root.querySelector(id).value;
      workflow.form.subreddit = value('#cultureSubreddit') || workflow.form.subreddit;
      workflow.form.maxPosts = Number(value('#culturePostCount')) || workflow.form.maxPosts;
      workflow.form.maxComments = Number(value('#cultureCommentCount')) || workflow.form.maxComments;
      workflow.form.windowDays = Number(value('#cultureWindow'));
      workflow.form.candidateCount = Number(value('#cultureCandidateCount')) || workflow.form.candidateCount;
      workflow.form.communities = value('#cultureCommunities') || workflow.form.communities;
      workflow.form.providerChoice = value('#cultureProvider') || workflow.form.providerChoice;
      if (root.querySelector('#cultureManagementLink')) workflow.managementLink = value('#cultureManagementLink') || '';
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
      };
    }

    function applySession(session) {
      requireSession(session);
      const hadCandidates = Boolean(workflow.session && workflow.session.candidates && workflow.session.candidates.length);
      workflow.session = session;
      if (session.candidates && session.candidates.length) {
        workflow.candidateDrafts = createCandidateDrafts(session.candidates, hadCandidates ? workflow.candidateDrafts : null);
      } else if (!hadCandidates) workflow.candidateDrafts = {};
    }

    async function poll() {
      if (workflow.polling || !workflow.session) return;
      workflow.polling = true;
      try {
        while (sessionTaskRunning()) {
          await new Promise((resolve) => setTimeout(resolve, 650));
          const response = await api('/api/culture-imports/' + encodeURIComponent(workflow.session.id));
          applySession(response.session);
          render();
        }
        if (workflow.session.task && workflow.session.task.state === 'failed') {
          toast(progressLabel(workflow.session.task), 'err');
        }
      } catch (error) {
        toast('Could not refresh importer progress: ' + error.message, 'err');
      } finally {
        workflow.polling = false;
        render();
      }
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
      on('#cultureProvider', 'change', (event) => { workflow.form.providerChoice = event.target.value; });
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
      on('#cultureCancelBtn', 'click', async () => {
        try {
          const response = await api('/api/culture-imports/' + encodeURIComponent(workflow.session.id) + '/cancel', { method: 'POST', body: {} });
          applySession(response.session);
          render();
        } catch (error) { toast(error.message, 'err'); }
      });
      on('#cultureStageBtn', 'click', async () => {
        captureForm();
        const body = stagingBody(workflow.candidateDrafts, getPlacement() === 'desktop' ? workflow.managementLink : '');
        if (!body.selected.length) return toast('Select at least one candidate to stage.', 'err');
        if (getPlacement() === 'desktop' && !workflow.managementLink) return toast('Paste the hosted private management link first.', 'err');
        workflow.busy = true;
        render();
        try {
          const response = await api('/api/culture-imports/' + encodeURIComponent(workflow.session.id) + '/stage', { method: 'POST', body });
          workflow.staging = response.result;
          applySession(response.session);
          toast('Selected candidates were staged in rehearsal. Nothing was activated.', 'ok');
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
      });
      root.querySelectorAll('[data-culture-archetype]').forEach((element) => element.onchange = () => {
        if (element.checked) workflow.archetypes.add(element.dataset.cultureArchetype);
        else workflow.archetypes.delete(element.dataset.cultureArchetype);
      });
      root.querySelectorAll('[data-candidate-selected]').forEach((element) => element.onchange = () => {
        updateCandidateDraft(workflow.candidateDrafts, Number(element.dataset.candidateSelected), 'selected', element.checked);
      });
      root.querySelectorAll('[data-candidate-index][data-seed-field]').forEach((element) => element.oninput = () => {
        const value = element.type === 'checkbox' ? element.checked : element.value;
        updateCandidateDraft(workflow.candidateDrafts, Number(element.dataset.candidateIndex), element.dataset.seedField, value);
      });
      ['#cultureSubreddit', '#culturePostCount', '#cultureCommentCount', '#cultureWindow', '#cultureCandidateCount', '#cultureCommunities', '#cultureManagementLink']
        .forEach((selector) => on(selector, 'input', captureForm));
    }

    return {
      workflow,
      open(element) {
        root = element;
        render();
        if (sessionTaskRunning()) poll();
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
    stagingBody,
    cultureGroups,
    progressLabel,
    requireSession,
    stagingResultRows,
    providerValue,
    readProviderValue,
    defaultWorkflow,
    createController,
  };
});
