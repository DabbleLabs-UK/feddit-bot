(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditUiNaturalness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function create({ document, api, getDeveloperTools, getPlacement, getPopulationAdmin, toast }) {
    let dialog = null, trigger = null, snapshot = null, visible = false, request = 0;
    let windowSelect, filterSelect, body, exportButton, status;
    const allowed = () => !!getDeveloperTools() && (getPlacement() !== 'hosted' || !!getPopulationAdmin());
    const node = (tag, content, className) => {
      const element = document.createElement(tag);
      if (content !== undefined && content !== null) element.textContent = String(content);
      if (className) element.className = className;
      return element;
    };
    const value = number => number === null || number === undefined ? 'unavailable' : String(number);
    const percent = number => number === null || number === undefined ? 'unavailable' : `${Math.round(number * 100)}%`;
    function close() {
      if (!visible) return;
      visible = false;
      request++;
      if (dialog) {
        if (dialog.open && typeof dialog.close === 'function') dialog.close();
        dialog.hidden = true;
      }
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    }
    function section(title, parent = body) {
      const block = node('section');
      block.appendChild(node('h3', title));
      parent.appendChild(block);
      return block;
    }
    function detail(title, data, parent = body) {
      const details = node('details');
      details.appendChild(node('summary', title));
      details.appendChild(node('pre', JSON.stringify(data, null, 2)));
      parent.appendChild(details);
    }
    function renderItem(item, parent) {
      const details = node('details');
      details.appendChild(node('summary', `${item.key}: ${item.title || item.excerpt || 'View item'}`));
      details.appendChild(node('p', `${item.community || 'Unknown community'} | ${item.author || 'Unknown author'} | Created ${item.createdAt || 'unknown'}`));
      if (item.excerpt) details.appendChild(node('p', item.excerpt));
      details.appendChild(node('p', `Visible current score: ${value(item.score)}. Current external votes: ${value(item.total)} (up ${value(item.up)}, down ${value(item.down)}); net ${value(item.net)}; up share ${percent(item.upShare)}; non-nil entropy ${value(item.entropy)}.`));
      details.appendChild(node('p', item.trailTruncated ? 'Partial trail: counts above use full ledger aggregates. Times below order returned surviving votes only.' : 'Times below order current surviving votes, not a complete voting history.'));
      const table = node('table');
      const head = node('tr');
      ['Surviving vote time', 'Item age (hours)', 'Public bot', 'Direction', 'Published reason'].forEach(label => { const th = node('th', label); th.scope = 'col'; head.appendChild(th); });
      const thead = node('thead'); thead.appendChild(head); table.appendChild(thead);
      const tbody = node('tbody');
      for (const vote of item.votes || []) {
        const row = node('tr');
        [vote.at || 'unknown', value(vote.ageHours), vote.bot || vote.actorType || 'unknown', vote.direction, vote.reason || 'unavailable'].forEach(content => row.appendChild(node('td', content)));
        tbody.appendChild(row);
      }
      table.appendChild(tbody); details.appendChild(table);
      detail('Recorded local offer, decision and outcome chronology for this item', snapshot.exposure.rows.filter(row => row.key === item.key), details);
      detail('Outcome-only chronology for this item (exposure unavailable)', snapshot.overview.outcomeOnly.rows.filter(row => row.key === item.key), details);
      parent.appendChild(details);
    }
    function render() {
      if (!snapshot || !visible) return;
      body.replaceChildren();
      const coverage = section('Coverage and interpretation');
      coverage.className = 'naturalness-warnings';
      const warnings = node('ul');
      for (const warning of snapshot.coverage.warnings || []) warnings.appendChild(node('li', warning));
      coverage.appendChild(warnings);
      coverage.appendChild(node('p', `Generated ${snapshot.generatedAt}; ${snapshot.coverage.itemCount} sampled items. This is a diagnostic view with no overall score or recommended voting target.`));
      const sourceWindow = snapshot.coverage.authoritativeWindow || {};
      coverage.appendChild(node('p', `Authoritative source generated ${snapshot.coverage.authoritativeGeneratedAt || 'unknown'}; sample window ${value(sourceWindow.hours)} hours, ${sourceWindow.since || 'unknown'} to ${sourceWindow.until || 'unknown'}.`));
      coverage.appendChild(node('p', snapshot.coverage.countsMeaning));
      detail('Authoritative sampling bounds', snapshot.coverage.sourceBounds, coverage);
      const overview = section('Overview');
      detail('Category counts and proportions (at least 5 external votes)', snapshot.overview.classifications, overview);
      detail('Bot participation with recorded-offer denominator', snapshot.overview.participation, overview);
      const current = snapshot.overview.authoritativeCurrent, local = snapshot.overview.local, rehearsal = snapshot.overview.rehearsal;
      overview.appendChild(node('p', `Current ledger: ${value(current.items)} items, ${value(current.total)} external votes (${value(current.up)} up, ${value(current.down)} down).`));
      overview.appendChild(node('p', `Local live coverage: ${local.offered} offered, ${local.explicitConsidered} explicit decisions, ${local.explicitNil} explicit nil, ${local.parserDefaultNil} parser-default nil, ${local.decisionUnavailable} unavailable decisions, ${local.confirmedCast} confirmed casts. Explicit nil rate: ${percent(local.nilRate)}.`));
      overview.appendChild(node('p', `Rehearsal coverage (separate): ${rehearsal.offered} offered, ${rehearsal.explicitConsidered} explicit decisions; explicit nil rate ${percent(rehearsal.nilRate)}.`));
      const outcomeOnly = snapshot.overview.outcomeOnly;
      overview.appendChild(node('p', `Outcome-only local evidence: ${outcomeOnly.live.confirmedCast} confirmed live casts in ${outcomeOnly.live.recordedOutcomes} records; ${outcomeOnly.rehearsal.confirmedCast} confirmed rehearsal casts in ${outcomeOnly.rehearsal.recordedOutcomes} records. Offers, exposure and explicit considered counts are unavailable for these records.`));
      detail('Outcome-only summary and timeline (kept separate)', outcomeOnly, overview);
      detail('Distribution histograms and descriptive thresholds', { thresholds: snapshot.overview.thresholds, distributions: snapshot.overview.distributions }, overview);
      detail('Distributions by community', { groups: snapshot.overview.byCommunity, truncated: snapshot.overview.communityGroupsTruncated }, overview);
      detail('Distributions by content type', snapshot.overview.byContentType, overview);
      detail('Origin and cohort (recorded local coverage only)', snapshot.overview.originCohort, overview);
      const filtered = snapshot.items.filter(item => filterSelect.value === 'all' || (filterSelect.value === 'split' && item.approximatelySplit) || (filterSelect.value === 'consensus' && (item.stronglyPositive || item.stronglyNegative)) || (filterSelect.value === 'low-net' && item.highVotesLowNet));
      const list = section(`Items (${filtered.length})`);
      list.appendChild(node('p', 'Inspection conventions: at least 5 external votes; positive >=80% up, negative <=20% up, split 40-60% up, high votes/low net has absolute net <=2. These are not quality ratings.'));
      if (!filtered.length) list.appendChild(node('p', 'No sampled items match this filter.'));
      for (const item of filtered) renderItem(item, list);
      const agreement = section('Agreement');
      agreement.appendChild(node('p', snapshot.agreement.warning));
      detail('Current-ledger bot pairs (returned trails only)', snapshot.agreement.currentLedger, agreement);
      detail('Local explicit decisions (separate evidence)', snapshot.agreement.localExplicitDecisions, agreement);
      const exposure = section('Exposure, timing and order');
      exposure.appendChild(node('p', snapshot.exposure.warning));
      exposure.appendChild(node('p', `${snapshot.exposure.recordedScores} recorded scores; ${snapshot.exposure.missingScores} missing scores; ${snapshot.exposure.visibleScores} recorded as visible to the model. Current scores are never used to fill gaps.`));
      detail('Decisions by recorded negative, neutral or positive reception', snapshot.exposure.reception, exposure);
      detail('Early and later decisions (descriptive age convention)', { conventions: snapshot.exposure.timingConventions, groups: snapshot.exposure.timing }, exposure);
      detail('Recorded offers in time order (bounded)', snapshot.exposure.rows, exposure);
    }
    async function refresh() {
      if (!visible) return;
      if (!allowed()) { close(); return; }
      const currentRequest = ++request;
      status.textContent = 'Loading bounded diagnostic snapshot...';
      exportButton.disabled = true;
      try {
        const result = await api(`/api/naturalness?hours=${Number(windowSelect.value)}`);
        if (!visible || currentRequest !== request) return;
        if (!allowed()) { close(); return; }
        if (!result || result.schemaVersion !== 1 || !Array.isArray(result.items) || !result.coverage || !result.overview || !result.agreement || !result.exposure) throw new Error('Snapshot is unavailable or has an unsupported format.');
        snapshot = result;
        render();
        status.textContent = 'Snapshot loaded. Refresh is manual.';
        exportButton.disabled = false;
      } catch (error) {
        if (!visible || currentRequest !== request) return;
        snapshot = null;
        body.replaceChildren();
        status.textContent = 'Unable to load the Naturalness Lab snapshot.';
        if (toast) toast('Unable to load the Naturalness Lab snapshot.');
      }
    }
    function build() {
      const style = node('style', '.naturalness-dialog{color:var(--text,#ddd);background:var(--bg,#181818);border:1px solid var(--border,#666);border-radius:10px;width:min(1050px,92vw);max-height:88vh;padding:20px;overflow:auto}.naturalness-dialog::backdrop{background:#0009}.naturalness-dialog header,.naturalness-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.naturalness-dialog header h2{flex:1}.naturalness-dialog button,.naturalness-dialog select{font:inherit}.naturalness-dialog table{width:100%;border-collapse:collapse;font-size:.9em}.naturalness-dialog td,.naturalness-dialog th{text-align:left;vertical-align:top;border-bottom:1px solid var(--border,#666);padding:6px;overflow-wrap:anywhere}.naturalness-dialog details{margin:10px 0}.naturalness-dialog summary{cursor:pointer;overflow-wrap:anywhere}.naturalness-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto}.naturalness-warnings{border:1px solid var(--border,#888);padding:10px;margin-top:12px}.naturalness-dialog :focus-visible{outline:2px solid var(--accent,#9ccfff);outline-offset:3px}');
      document.head.appendChild(style);
      dialog = node('dialog', null, 'naturalness-dialog');
      dialog.setAttribute('aria-labelledby', 'naturalness-title');
      dialog.setAttribute('aria-modal', 'true');
      const header = node('header');
      const title = node('h2', 'Naturalness Lab'); title.id = 'naturalness-title'; header.appendChild(title);
      const closeButton = node('button', 'Close'); closeButton.type = 'button'; closeButton.addEventListener('click', close); header.appendChild(closeButton);
      dialog.appendChild(header);
      const controls = node('div', null, 'naturalness-controls');
      const windowLabel = node('label', 'Window '); windowSelect = node('select'); windowSelect.setAttribute('aria-label', 'Observation window');
      for (const [hours, label] of [[24, '24 hours'], [168, '7 days'], [720, '30 days']]) { const option = node('option', label); option.value = String(hours); windowSelect.appendChild(option); }
      windowSelect.value = '24'; windowSelect.addEventListener('change', refresh); windowLabel.appendChild(windowSelect); controls.appendChild(windowLabel);
      const filterLabel = node('label', 'Inspect '); filterSelect = node('select'); filterSelect.setAttribute('aria-label', 'Item classification');
      for (const [filter, label] of [['all', 'All items'], ['split', 'Approximately split'], ['consensus', 'Strongly positive / negative'], ['low-net', 'High votes / low net']]) { const option = node('option', label); option.value = filter; filterSelect.appendChild(option); }
      filterSelect.value = 'all'; filterSelect.addEventListener('change', () => { if (!allowed()) close(); else render(); }); filterLabel.appendChild(filterSelect); controls.appendChild(filterLabel);
      const refreshButton = node('button', 'Refresh'); refreshButton.type = 'button'; refreshButton.addEventListener('click', refresh); controls.appendChild(refreshButton);
      exportButton = node('button', 'Download JSON'); exportButton.type = 'button'; exportButton.disabled = true;
      exportButton.addEventListener('click', () => {
        if (!allowed()) { close(); return; }
        if (!snapshot || !visible) return;
        const view = document.defaultView;
        const url = view.URL.createObjectURL(new view.Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
        const link = node('a'); link.href = url; link.download = `naturalness-${snapshot.window.hours}h.json`; document.body.appendChild(link); link.click(); link.remove(); view.URL.revokeObjectURL(url);
      });
      controls.appendChild(exportButton); dialog.appendChild(controls);
      status = node('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); dialog.appendChild(status);
      body = node('div'); dialog.appendChild(body);
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
      document.addEventListener('developer-tools-change', () => { if (!allowed()) close(); });
      document.body.appendChild(dialog);
    }
    async function open(source) {
      if (!allowed()) { if (visible) close(); return; }
      trigger = source && typeof source.focus === 'function' ? source : document.activeElement;
      if (!dialog) build();
      visible = true; dialog.hidden = false;
      if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
      windowSelect.focus();
      await refresh();
    }
    return { open, close, refresh };
  }

  return { create };
});
