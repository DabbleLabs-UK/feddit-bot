'use strict';

// Bounded, explainable telemetry for accelerated population rehearsal. This
// records only structured facts the ordinary behaviour stack already produces:
// opportunity menus, public candidate types, WAIT/action outcomes, public
// counterpart/thread identifiers, and bounded memory/conflict indicators. It
// never stores prompts, raw model reasoning, or hidden chain-of-thought.

const VERSION = 1;
const MAX_EVENTS = 240;
const MAX_TOPICS_PER_EVENT = 8;
const MAX_REASON_LENGTH = 360;

function text(value, max = 120) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function countMap(value, maxKeys = 24) {
  const out = {};
  for (const [rawKey, rawCount] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const key = text(rawKey, 60).toLowerCase();
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    if (!key || !count) continue;
    out[key] = count;
    if (Object.keys(out).length >= maxKeys) break;
  }
  return out;
}

function stringList(value, maxItems = MAX_TOPICS_PER_EVENT, maxLength = 80) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const item = text(raw, maxLength).toLowerCase();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function defaults() {
  return { version: VERSION, events: [], lastConflictCount: 0 };
}

function normalizeEvent(raw = {}) {
  const outcome = ['action', 'wait', 'failed', 'capacity-skip'].includes(raw.outcome)
    ? raw.outcome : 'failed';
  const event = {
    id: text(raw.id, 120),
    runId: text(raw.runId, 120),
    at: Math.max(0, Number(raw.at) || 0),
    virtualAt: Math.max(0, Number(raw.virtualAt) || Number(raw.at) || 0),
    profileId: text(raw.profileId, 120),
    botName: text(raw.botName, 80),
    outcome,
    action: text(raw.action, 40).toLowerCase(),
    consideredTypes: countMap(raw.consideredTypes),
    selectedType: text(raw.selectedType, 60).toLowerCase(),
    targetAccount: text(raw.targetAccount, 80).toLowerCase(),
    threadKey: text(raw.threadKey, 120),
    chainLength: Math.max(0, Math.floor(Number(raw.chainLength) || 0)),
    topics: stringList(raw.topics),
    memoryInfluenced: raw.memoryInfluenced === true,
    preoccupations: stringList(raw.preoccupations, 4, 80),
    memoryConflictCount: Math.max(0, Math.floor(Number(raw.memoryConflictCount) || 0)),
    conflictDelta: Math.max(0, Math.floor(Number(raw.conflictDelta) || 0)),
    reason: text(raw.reason, MAX_REASON_LENGTH),
  };
  if (!event.id) {
    event.id = [event.runId, event.profileId, event.virtualAt, event.outcome, event.action].join(':');
  }
  return event;
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const events = (Array.isArray(source.events) ? source.events : [])
    .map(normalizeEvent)
    .filter((event) => event.profileId && event.at > 0)
    .slice(-MAX_EVENTS);
  return {
    version: VERSION,
    events,
    lastConflictCount: Math.max(0, Math.floor(Number(source.lastConflictCount) || 0)),
  };
}

function record(raw, event) {
  const state = normalize(raw);
  const next = normalizeEvent(event);
  next.conflictDelta = Math.max(
    next.conflictDelta,
    next.memoryConflictCount - state.lastConflictCount,
    0,
  );
  state.lastConflictCount = next.memoryConflictCount;
  const duplicate = state.events.findIndex((item) => item.id && item.id === next.id);
  if (duplicate >= 0) state.events.splice(duplicate, 1);
  state.events.push(next);
  state.events = state.events.slice(-MAX_EVENTS);
  return state;
}

function ratio(value, total) {
  return total > 0 ? Number((value / total).toFixed(3)) : 0;
}

function increment(map, key, amount = 1) {
  const clean = text(key, 100).toLowerCase();
  if (!clean) return;
  map[clean] = (map[clean] || 0) + amount;
}

function sortedCounts(map, max = 20) {
  return Object.entries(map || {})
    .map(([name, count]) => ({ name, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, max);
}

function profileDetails(profile) {
  const activity = profile && profile.simulationState && profile.simulationState.populationActivity;
  return {
    profileId: text(profile && profile.id, 120),
    botName: text(profile && (profile.fedditUsername || profile.refName || profile.id), 80),
    band: text(activity && activity.band, 30) || 'unknown',
    expectedDailyOpportunities: Number(activity && activity.currentDailyOpportunities) || 0,
  };
}

function warning(code, label, detail) {
  return { code, label, detail };
}

function summarize(profiles, options = {}) {
  const runId = text(options.runId, 120);
  const profileList = (Array.isArray(profiles) ? profiles : []).map(profileDetails);
  const byId = new Map(profileList.map((profile) => [profile.profileId, {
    ...profile, opportunities: 0, actions: 0, waits: 0, failures: 0, capacitySkips: 0,
  }]));
  const events = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const state = normalize(profile && profile.simulationState && profile.simulationState.telemetry);
    for (const event of state.events) {
      if (runId && event.runId !== runId) continue;
      events.push(event);
    }
  }
  events.sort((a, b) => a.virtualAt - b.virtualAt || a.at - b.at || a.id.localeCompare(b.id));

  const consideredTypes = {};
  const selectedTypes = {};
  const pairCounts = {};
  const topics = {};
  const virtualMinuteCounts = {};
  let actions = 0;
  let waits = 0;
  let failures = 0;
  let capacitySkips = 0;
  let memoryInfluencedChoices = 0;
  let preoccupationChoices = 0;
  let contradictionDetections = 0;
  let maxChainLength = 0;
  const chainLengths = [];

  for (const event of events) {
    const account = byId.get(event.profileId) || {
      profileId: event.profileId, botName: event.botName || event.profileId,
      band: 'unknown', expectedDailyOpportunities: 0,
      opportunities: 0, actions: 0, waits: 0, failures: 0, capacitySkips: 0,
    };
    byId.set(event.profileId, account);
    account.opportunities++;
    if (event.outcome === 'action') { account.actions++; actions++; }
    else if (event.outcome === 'wait') { account.waits++; waits++; }
    else if (event.outcome === 'capacity-skip') { account.capacitySkips++; capacitySkips++; }
    else { account.failures++; failures++; }

    for (const [type, count] of Object.entries(event.consideredTypes)) increment(consideredTypes, type, count);
    if (event.selectedType) increment(selectedTypes, event.selectedType);
    if (event.targetAccount) increment(pairCounts, event.profileId + ' -> ' + event.targetAccount);
    for (const topic of event.topics) increment(topics, topic);
    if (event.memoryInfluenced) memoryInfluencedChoices++;
    if (event.preoccupations.length) preoccupationChoices++;
    contradictionDetections += event.conflictDelta;
    if (event.chainLength > 0) {
      chainLengths.push(event.chainLength);
      maxChainLength = Math.max(maxChainLength, event.chainLength);
    }
    const minute = Math.floor(event.virtualAt / 60000);
    increment(virtualMinuteCounts, String(minute));
  }

  const accounts = [...byId.values()].map((account) => ({
    ...account,
    actionShare: ratio(account.actions, actions),
    opportunityShare: ratio(account.opportunities, events.length),
  })).sort((a, b) => b.actions - a.actions || b.opportunities - a.opportunities || a.botName.localeCompare(b.botName));
  const pairs = sortedCounts(pairCounts);
  const repeatedPairs = pairs.filter((pair) => pair.count > 1);
  const topicList = sortedCounts(topics);
  const selectedList = sortedCounts(selectedTypes);
  const expectedBands = {};
  const observedBands = {};
  for (const account of accounts) {
    increment(expectedBands, account.band);
    const observed = observedBands[account.band] || { opportunities: 0, actions: 0, bots: 0 };
    observed.bots++;
    observed.opportunities += account.opportunities;
    observed.actions += account.actions;
    observedBands[account.band] = observed;
  }

  const warnings = [];
  const topAccount = accounts[0];
  if (actions >= 6 && topAccount && topAccount.actionShare >= 0.5) {
    warnings.push(warning('account-domination', 'One account dominates visible activity',
      topAccount.botName + ' produced ' + Math.round(topAccount.actionShare * 100) + '% of visible actions.'));
  }
  const topPair = pairs[0];
  if (actions >= 6 && topPair && topPair.count >= 3 && ratio(topPair.count, actions) >= 0.4) {
    warnings.push(warning('repeated-pair', 'One conversation pairing repeats unusually often',
      topPair.name + ' accounts for ' + topPair.count + ' of ' + actions + ' visible actions.'));
  }
  if (maxChainLength >= 3) {
    warnings.push(warning('reply-loop', 'A reply chain reached the runner conversation cap',
      'The longest observed chain contained ' + maxChainLength + ' runner replies.'));
  }
  const visibleAccounts = accounts.filter((account) => account.actions > 0).length;
  if (events.length >= 8 && accounts.length >= 3 && visibleAccounts / accounts.length < 0.5) {
    warnings.push(warning('poor-participant-diversity', 'Many cohort members were invisible',
      visibleAccounts + ' of ' + accounts.length + ' bots produced a visible action.'));
  }
  if (actions >= 6 && (topicList.length < 2 || ratio(topicList[0] && topicList[0].count, actions) >= 0.85)) {
    warnings.push(warning('poor-topic-diversity', 'Visible activity concentrated on one topic',
      topicList.length ? topicList[0].name + ' appeared in ' + topicList[0].count + ' actions.' : 'No recurring public topic was available.'));
  }
  if (events.length >= 6 && ratio(waits, events.length) >= 0.7) {
    warnings.push(warning('excessive-wait', 'Most opportunities ended in WAIT',
      waits + ' of ' + events.length + ' opportunities ended without a visible action.'));
  }
  const topSelected = selectedList[0];
  if (actions >= 6 && topSelected && ratio(topSelected.count, actions) >= 0.85) {
    warnings.push(warning('candidate-type-domination', 'One candidate type dominated choices',
      topSelected.name + ' was selected for ' + topSelected.count + ' of ' + actions + ' visible actions.'));
  }
  const busiestMinute = sortedCounts(virtualMinuteCounts, 1)[0];
  if (events.length >= 8 && accounts.length >= 3 && busiestMinute && ratio(busiestMinute.count, events.length) >= 0.6) {
    warnings.push(warning('synchronized-activity', 'Opportunities are highly synchronized',
      busiestMinute.count + ' of ' + events.length + ' opportunities landed in one virtual minute.'));
  }
  if (events.length >= 8 && contradictionDetections >= 3 && ratio(contradictionDetections, events.length) >= 0.2) {
    warnings.push(warning('memory-conflicts', 'Autobiographical conflicts recur frequently',
      contradictionDetections + ' new bounded conflict records appeared during the run.'));
  }

  const virtualStartAt = events.length ? events[0].virtualAt : Number(options.virtualStartedAt) || 0;
  const virtualEndAt = events.length ? events[events.length - 1].virtualAt : Number(options.virtualNowAt) || virtualStartAt;
  const virtualDays = Math.max(1 / 24, (virtualEndAt - virtualStartAt) / (24 * 60 * 60 * 1000));
  const totalExpectedDaily = accounts.reduce((sum, account) => sum + account.expectedDailyOpportunities, 0);
  const observedDaily = events.length / virtualDays;
  if (events.length >= 20 && totalExpectedDaily > 0 && observedDaily > totalExpectedDaily * 2.25) {
    warnings.push(warning('excessive-activity', 'Observed opportunity volume exceeds the configured ecology',
      observedDaily.toFixed(1) + ' opportunities per virtual day versus about ' + totalExpectedDaily.toFixed(1) + ' expected.'));
  }
  if (events.length >= 20 && accounts.length >= 3) {
    const expectedTotal = accounts.reduce((sum, account) => sum + account.expectedDailyOpportunities, 0) || 1;
    const mismatch = accounts.find((account) => {
      const expectedShare = account.expectedDailyOpportunities / expectedTotal;
      return Math.abs(account.opportunityShare - expectedShare) >= 0.3;
    });
    if (mismatch) {
      warnings.push(warning('activity-band-mismatch', 'Observed opportunities diverge from activity bands',
        mismatch.botName + ' received ' + Math.round(mismatch.opportunityShare * 100) + '% of opportunities despite an expected share near ' +
        Math.round((mismatch.expectedDailyOpportunities / expectedTotal) * 100) + '%.'));
    }
  }

  return {
    runId,
    opportunities: events.length,
    actions,
    waits,
    failures,
    capacitySkips,
    actionRate: ratio(actions, events.length),
    waitRate: ratio(waits, events.length),
    accounts,
    invisibleAccounts: accounts.filter((account) => account.actions === 0).map((account) => account.botName),
    candidateTypes: {
      considered: sortedCounts(consideredTypes),
      selected: selectedList,
    },
    uniquePairs: pairs.length,
    repeatedPairs,
    chains: {
      observed: chainLengths.length,
      longest: maxChainLength,
      average: chainLengths.length
        ? Number((chainLengths.reduce((sum, length) => sum + length, 0) / chainLengths.length).toFixed(2))
        : 0,
    },
    topics: topicList,
    memory: {
      influencedChoices: memoryInfluencedChoices,
      preoccupationChoices,
      contradictionDetections,
    },
    activity: {
      expectedBands,
      observedBands,
      virtualDays: Number(virtualDays.toFixed(3)),
      expectedOpportunitiesPerDay: Number(totalExpectedDaily.toFixed(2)),
      observedOpportunitiesPerDay: Number(observedDaily.toFixed(2)),
    },
    warnings,
    notableEvents: events.slice(-40).reverse(),
  };
}

module.exports = {
  VERSION,
  MAX_EVENTS,
  defaults,
  normalize,
  record,
  summarize,
};
