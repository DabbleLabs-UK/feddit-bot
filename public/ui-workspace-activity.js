(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditUiWorkspaceActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLLAPSED_KEY = 'fedditBotCollapsedGroups';
  const TYPES = ['text', 'article', 'reply', 'vote'];
  let collapsedFallback = {};

  function collapsedGroups(storage) {
    try {
      const parsed = JSON.parse((storage || localStorage).getItem(COLLAPSED_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return collapsedFallback; }
  }

  function isCollapsed(id, storage) {
    return collapsedGroups(storage)[id || 'ungrouped'] === true;
  }

  function setCollapsed(id, collapsed, storage) {
    const values = { ...collapsedGroups(storage), [id || 'ungrouped']: collapsed === true };
    collapsedFallback = values;
    try { (storage || localStorage).setItem(COLLAPSED_KEY, JSON.stringify(values)); } catch { /* storage is optional */ }
  }

  function sidebarGroups(profiles, groups) {
    const known = new Set(groups.map((group) => group.id));
    return [...groups, { id: '', name: 'Ungrouped' }].map((group) => {
      const members = profiles.filter((profile) => group.id
        ? profile.groupId === group.id
        : !known.has(profile.groupId));
      return {
        ...group, profiles: members,
        live: members.filter((profile) => profile.dryRun === false).length,
        rehearsal: members.filter((profile) => profile.dryRun !== false).length,
      };
    }).filter((group) => group.id || group.profiles.length);
  }

  function forecastPath(filters) {
    const query = new URLSearchParams({ mode: filters.mode || 'live', zeroCadence: filters.zeroCadence || 'all' });
    if (filters.groupId !== null && filters.groupId !== undefined) query.set('groupId', filters.groupId);
    if (filters.type) query.set('type', filters.type);
    return '/api/activity-forecast?' + query;
  }

  function dueLabel(event, now) {
    if (Number(event.backoffUntil) > now) return 'Backoff until ' + new Date(event.backoffUntil).toLocaleTimeString();
    const remaining = Number(event.at) - now;
    if (remaining <= 0) return 'Due now - awaiting scheduler or capacity';
    const minutes = Math.ceil(remaining / 60000);
    if (minutes < 60) return 'In ' + minutes + 'm';
    if (minutes < 1440) return 'In ' + Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
    return 'In ' + Math.floor(minutes / 1440) + 'd ' + Math.floor(minutes % 1440 / 60) + 'h';
  }

  function number(value) {
    return (Number(value) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function breakdown(values) {
    return TYPES.map((type) => type + ' ' + number(values && values[type])).join(' / ');
  }

  function chartHtml(buckets, title, esc) {
    if (!buckets || !buckets.length) return '';
    const max = Math.max(1, ...buckets.map((bucket) => Number(bucket.total) || 0));
    const label = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return '<h3>' + esc(title) + '</h3><div class="forecast-chart" role="img" aria-label="' + esc(title + ': ' + buckets.map((bucket) => label(bucket.startAt) + ', ' + number(bucket.total)).join('; ')) + '">' +
      buckets.map((bucket) => '<div class="forecast-column" title="' + esc(label(bucket.startAt) + ' to ' + label(bucket.endAt) + ': ' + number(bucket.total) + ' projected opportunities; ' + breakdown(bucket.byType)) + '"><div class="forecast-bar" style="height:' + Math.max(0, (Number(bucket.total) || 0) / max * 100) + '%"></div></div>').join('') +
      '</div><div class="forecast-axis"><span>' + esc(label(buckets[0].startAt)) + '</span><span>' + esc(label(buckets[buckets.length - 1].endAt)) + '</span></div>';
  }

  function forecastHtml(data, esc, now) {
    const botButton = (bot) => '<button type="button" class="forecast-bot" data-forecast-profile="' + esc(bot.profileId) + '">' + esc(bot.botName || 'Unnamed bot') + '</button>';
    const eventHtml = (event) => botButton(event) + ' - ' + esc(event.groupName || 'Ungrouped') + ' - ' + esc(event.type) + ' - ' + esc(String(event.mode || '').toUpperCase()) +
      '<div class="hint">' + esc(dueLabel(event, now)) + ' <span title="Stored scheduler due time">(scheduled ' + esc(new Date(event.at).toLocaleString()) + ')</span></div>';
    const upcoming = data.upcoming || [];
    const idle = data.activeNoCadence || [];
    const projections = data.projections || {};
    let html = '<p class="hint">Stored scheduler due times are authoritative near-term opportunities. Future counts are estimates from effective cadence, including Speed where applicable, with jitter and population ecology. They are not guaranteed posts: bots may WAIT, and capacity or publication failures may delay work. Burst, manual and unpredictable event-driven work are excluded.</p>';
    if (data.paused || data.schedulerPaused) html += '<p class="warnbox">The workspace scheduler is paused. These opportunities will not run until it resumes; projections show potential activity after resuming.</p>';
    html += '<section class="forecast-card"><h3>Next up - stored schedule</h3>' + (upcoming.length ? eventHtml(upcoming[0]) : '<span class="hint">No stored scheduled opportunity matches these filters.</span>') + '</section>';
    if (upcoming.length > 1) html += '<ol class="forecast-list" start="2">' + upcoming.slice(1, 9).map((event) => '<li>' + eventHtml(event) + '</li>').join('') + '</ol>';
    html += '<h3>Projected opportunities</h3><div class="forecast-horizons">' + [['1h', 'Next 1 hour'], ['24h', 'Next 24 hours'], ['7d', 'Next 7 days']].map(([key, label]) => {
      const horizon = projections[key] || {};
      return '<section class="forecast-card"><h3>' + label + '</h3><div class="forecast-total">' + number(horizon.total) + '</div><div>' + number(horizon.botCount) + ' bots / ' + number(horizon.groupCount) + ' groups</div><div class="hint">' + breakdown(horizon.byType) + '</div></section>';
    }).join('') + '</div>';
    html += chartHtml(data.hourlyBuckets, 'Hourly - next 24 hours', esc) + chartHtml(data.dailyBuckets, 'Daily - next 7 days', esc);
    const groups = (projections['24h'] && projections['24h'].groups || []).slice().sort((a, b) => b.total - a.total);
    if (groups.length) html += '<h3>Group contributions - next 24 hours</h3><table class="forecast-table"><thead><tr><th>Group</th><th>Bots</th><th>Opportunities</th></tr></thead><tbody>' + groups.map((group) => '<tr><td>' + esc(group.name || 'Ungrouped') + '</td><td>' + number(group.botCount) + '</td><td>' + number(group.total) + '<div class="hint">' + breakdown(group.byType) + '</div></td></tr>').join('') + '</tbody></table>';
    html += '<h3><button type="button" id="forecastNoCadenceBtn">Active but no cadence: ' + idle.length + '</button></h3><p class="hint">Enabled bots with no effective scheduled activity rate in the selected mode and group. Abilities alone do not create a schedule.</p>';
    if (idle.length) html += '<ul class="forecast-list">' + idle.map((bot) => '<li>' + botButton(bot) + ' - ' + esc(bot.groupName || 'Ungrouped') + ' - ' + esc(String(bot.mode || '').toUpperCase()) + '</li>').join('') + '</ul>';
    if (data.assumptions && data.assumptions.length) html += '<details><summary>Forecast assumptions</summary><ul>' + data.assumptions.map((note) => '<li>' + esc(note) + '</li>').join('') + '</ul></details>';
    return html;
  }

  function createController(options) {
    const { api, getState, loadProfiles, selectProfile, openDialog, closeDialog, esc } = options;
    const doc = options.document || document;
    const find = (id) => doc.getElementById(id);
    const activityDialog = find('activityForecastDialog');
    const groupsDialog = find('groupsDialog');
    let forecastSequence = 0;
    let forecastData = null;
    let timer = null;
    let groupBusy = false;

    function fillGroupOptions(select, all) {
      const previous = select.value;
      select.innerHTML = (all ? '<option value="*">All groups</option>' : '') + '<option value="">Ungrouped</option>' +
        getState().groups.map((group) => '<option value="' + esc(group.id) + '">' + esc(group.name + (group.scope === 'population' ? ' (population)' : '')) + '</option>').join('');
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
      else select.value = all ? '*' : '';
    }

    function renderForecast() {
      if (!forecastData) return;
      find('forecastContent').innerHTML = forecastHtml({ ...forecastData, schedulerPaused: !!(getState().settings && getState().settings.paused) }, esc, Date.now());
      find('forecastNoCadenceBtn').onclick = () => {
        find('forecastCadence').value = 'only';
        refreshForecast();
      };
      find('forecastContent').querySelectorAll('[data-forecast-profile]').forEach((button) => {
        button.onclick = async () => {
          closeDialog(activityDialog);
          await selectProfile(button.dataset.forecastProfile);
        };
      });
    }

    async function refreshForecast() {
      const sequence = ++forecastSequence;
      find('forecastStatus').textContent = 'Loading forecast...';
      find('forecastContent').setAttribute('aria-busy', 'true');
      try {
        const data = await api(forecastPath({
          mode: find('forecastMode').value,
          groupId: find('forecastGroup').value === '*' ? null : find('forecastGroup').value,
          type: find('forecastType').value,
          zeroCadence: find('forecastCadence').value,
        }));
        if (sequence !== forecastSequence || !activityDialog.open) return;
        forecastData = data;
        renderForecast();
        find('forecastStatus').textContent = 'As of ' + new Date(data.generatedAt).toLocaleTimeString();
      } catch (error) {
        if (sequence !== forecastSequence) return;
        forecastData = null;
        find('forecastContent').textContent = '';
        find('forecastStatus').textContent = 'Could not load forecast: ' + error.message;
      } finally {
        if (sequence === forecastSequence) find('forecastContent').setAttribute('aria-busy', 'false');
      }
    }

    function renderGroups() {
      const state = getState();
      find('groupManagementList').innerHTML = state.groups.map((group) => '<form class="workspace-group-row" data-group-id="' + esc(group.id) + '"><input aria-label="Group name" maxlength="120" required value="' + esc(group.name) + '"><button type="submit">Rename</button><button type="button" class="danger" data-delete-group>Delete</button></form>').join('');
      find('groupManagementList').querySelectorAll('form').forEach((form) => {
        form.onsubmit = (event) => {
          event.preventDefault();
          const name = form.querySelector('input').value.trim();
          if (name) mutateGroup('/api/groups/' + encodeURIComponent(form.dataset.groupId), 'PUT', { name });
        };
        form.querySelector('[data-delete-group]').onclick = () => mutateGroup('/api/groups/' + encodeURIComponent(form.dataset.groupId), 'DELETE');
      });
      const priorBot = find('groupBot').value;
      find('groupBot').innerHTML = state.profiles.map((profile) => '<option value="' + esc(profile.id) + '">' + esc(profile.referenceName || 'Unnamed bot') + '</option>').join('');
      find('groupBot').value = state.profiles.some((profile) => profile.id === priorBot) ? priorBot : (state.selected || (state.profiles[0] && state.profiles[0].id) || '');
      fillGroupOptions(find('groupDestination'), false);
      syncBotGroup();
      find('assignGroupForm').querySelector('button').disabled = !state.profiles.length;
    }

    function syncBotGroup() {
      const state = getState();
      const profile = state.profiles.find((item) => item.id === find('groupBot').value);
      find('groupDestination').value = profile && state.groups.some((group) => group.id === profile.groupId) ? profile.groupId : '';
    }

    async function mutateGroup(path, method, body) {
      if (groupBusy) return;
      groupBusy = true;
      groupsDialog.querySelectorAll('button, input, select').forEach((element) => { element.disabled = true; });
      find('groupManagementStatus').textContent = 'Saving group change...';
      let saved = false;
      try {
        await api(path, { method, body });
        saved = true;
        await loadProfiles();
        renderGroups();
        if (method === 'POST') find('newGroupName').value = '';
        find('groupManagementStatus').textContent = 'Group change saved. Bot activity is unchanged.';
      } catch (error) {
        find('groupManagementStatus').textContent = (saved ? 'Group change saved, but refreshing failed: ' : 'Could not save group change: ') + error.message;
      } finally {
        groupBusy = false;
        groupsDialog.querySelectorAll('button, input, select').forEach((element) => { element.disabled = false; });
        find('assignGroupForm').querySelector('button').disabled = !getState().profiles.length;
      }
    }

    find('groupsBtn').onclick = () => {
      find('groupBot').value = getState().selected || '';
      renderGroups();
      openDialog(groupsDialog);
    };
    find('createGroupForm').onsubmit = (event) => {
      event.preventDefault();
      const name = find('newGroupName').value.trim();
      if (name) return mutateGroup('/api/groups', 'POST', { name, profileId: find('groupBot').value || undefined });
    };
    find('groupBot').onchange = syncBotGroup;
    find('assignGroupForm').onsubmit = (event) => {
      event.preventDefault();
      if (find('groupBot').value) return mutateGroup('/api/profiles/' + encodeURIComponent(find('groupBot').value) + '/group', 'PUT', { groupId: find('groupDestination').value });
    };
    find('activityForecastBtn').onclick = () => {
      fillGroupOptions(find('forecastGroup'), true);
      openDialog(activityDialog);
      refreshForecast();
      clearInterval(timer);
      timer = setInterval(() => { if (activityDialog.open) refreshForecast(); }, 30000);
    };
    activityDialog.addEventListener('close', () => {
      clearInterval(timer);
      timer = null;
      forecastSequence++;
    });
    for (const id of ['forecastMode', 'forecastGroup', 'forecastType', 'forecastCadence']) find(id).onchange = refreshForecast;
    find('forecastRefreshBtn').onclick = refreshForecast;
    // The initial all-groups sentinel differs from the empty Ungrouped ID.
    find('forecastGroup').innerHTML = '<option value="*">All groups</option>';
    return { refreshForecast, renderGroups };
  }

  return { sidebarGroups, isCollapsed, setCollapsed, forecastPath, dueLabel, forecastHtml, createController };
});
