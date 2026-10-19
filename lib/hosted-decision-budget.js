'use strict';

const crypto = require('node:crypto');
const tokenizer = require('./hosted-tokenizer');
const actionCandidates = require('./action-candidates');
const firstContact = require('./first-contact');

// A request construction contract, independent of the response/decision contract.
// This is the existing DELL execution profile, NOT a request to enlarge it.
const VERSION = 2;
const CONTEXT_TOKENS = 3072;
const SAFETY_TOKENS = 64;

function version(value) {
  if (value == null) return 0; // Legacy durable request construction.
  if (value === 0 || value === 1 || value === VERSION) return value;
  throw failure('Unsupported hosted decision construction version. The durable turn remains blocked.', 'UNSUPPORTED_HOSTED_DECISION_BUDGET');
}

function failure(message, code = 'HOSTED_DECISION_BUDGET') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requestHash(system, prompt, numPredict) {
  return crypto.createHash('sha256').update(JSON.stringify([system, prompt, numPredict])).digest('hex');
}

function measure(system, prompt, numPredict, constructionVersion = VERSION) {
  if (version(constructionVersion) === 0) throw failure('A measured hosted request requires a supported construction version.');
  if (!Number.isInteger(numPredict) || numPredict < 1 || numPredict > 4096) {
    throw failure('Hosted decision output reservation is invalid. No inference was sent.');
  }
  const inputTokens = tokenizer.countRequest(system, prompt);
  return { version: constructionVersion, contextTokens: CONTEXT_TOKENS, inputTokens,
    outputTokens: numPredict, safetyTokens: SAFETY_TOKENS,
    requestHash: requestHash(system, prompt, numPredict) };
}

function fits(budget) {
  return budget.inputTokens + budget.outputTokens + budget.safetyTokens <= budget.contextTokens;
}

// Preserve the complete existing serialization of every retained item. Remove
// only suffixes, alternating action and independent vote slates; never promote a
// later small item over an earlier large one. Both nonempty kinds retain at least
// one item, or the entire decision fails. Stable IDs are never renumbered.
function constructV1({ model, system, candidates, voteCandidates, voteAllowance, decisionAt, decisionContractVersion }) {
  if (model !== tokenizer.MODEL) throw failure('Hosted decision model has no verified token budget. No inference was sent.');
  const originalActions = candidates || [];
  const originalVotes = voteCandidates || [];
  const numPredict = originalVotes.length ? 640 : 120;
  const order = [];
  for (let i = 0; i < Math.max(originalActions.length, originalVotes.length); i++) {
    if (i < originalActions.length) order.push('action');
    if (i < originalVotes.length) order.push('vote');
  }
  let actionCount = originalActions.length;
  let voteCount = originalVotes.length;
  let originalInputTokens;
  let originalRepairTokens;
  for (;;) {
    const selectedActions = originalActions.slice(0, actionCount);
    const selectedVotes = originalVotes.slice(0, voteCount);
    const options = { voteCandidates: selectedVotes, voteAllowance, decisionContractVersion };
    const prompt = actionCandidates.prompt(selectedActions, decisionAt, options);
    const repair = actionCandidates.repairPrompt(selectedActions, decisionAt, options);
    const budget = measure(system, prompt, numPredict, 1);
    const repairBudget = measure(system, repair, numPredict, 1);
    if (originalInputTokens == null) {
      originalInputTokens = budget.inputTokens;
      originalRepairTokens = repairBudget.inputTokens;
    }
    if (fits(budget) && fits(repairBudget)) return {
      version: 1, prompt, repair, budget, repairBudget, numPredict,
      candidateIds: selectedActions.map((item) => item.id),
      voteIds: selectedVotes.map((item) => item.id),
      deferredCandidateIds: originalActions.slice(actionCount).map((item) => item.id),
      deferredVoteIds: originalVotes.slice(voteCount).map((item) => item.id),
      originalInputTokens, originalRepairTokens,
    };
    let removed = false;
    while (order.length && !removed) {
      const kind = order.pop();
      if (kind === 'action' && actionCount > 1) { actionCount--; removed = true; }
      if (kind === 'vote' && voteCount > 1) { voteCount--; removed = true; }
    }
    if (!removed) return {
      version: 1,
      failure: 'Hosted decision cannot fit a complete minimum slate, persona and response contract within the verified context budget. No inference was sent; omitted votes remain unconsidered.',
      originalInputTokens, originalRepairTokens,
      minimumInputTokens: budget.inputTokens, minimumRepairTokens: repairBudget.inputTokens,
      contextTokens: CONTEXT_TOKENS, outputTokens: numPredict, safetyTokens: SAFETY_TOKENS,
    };
  }
}

// Packing is exposure, not a model decision or infrastructure priority. When
// the full slate fits it is unchanged. Under pressure, give candidate types a
// deterministic turn-seeded round-robin traversal instead of always privileging
// the first direct reply. Preserve order inside a type and in the final prompt.
// There is no extra persistent fairness/considered state and no live RNG.
function packingOrder(candidates, voteCandidates, decisionAt) {
  const groups = new Map();
  for (const item of candidates) {
    const key = 'action:' + String(item.candidateType || 'other');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ kind: 'action', item });
  }
  if (voteCandidates.length) groups.set('vote', voteCandidates.map((item) => ({ kind: 'vote', item })));
  const rank = (key) => crypto.createHash('sha256')
    .update('hosted-construction-v2:' + String(decisionAt) + ':' + key).digest('hex');
  const ordered = [...groups].map(([key, items]) => ({ key, items, rank: rank(key) }))
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.key.localeCompare(b.key));
  const result = [];
  const longest = Math.max(0, ...ordered.map((group) => group.items.length));
  for (let index = 0; index < longest; index++) {
    for (const group of ordered) if (group.items[index]) result.push(group.items[index]);
  }
  return result;
}

function constructV2({ model, system, candidates, voteCandidates, voteAllowance, decisionAt, decisionContractVersion,
  firstContactVersion = 0, firstContactKey }) {
  firstContact.version(firstContactVersion);
  if (model !== tokenizer.MODEL) throw failure('Hosted decision model has no verified token budget. No inference was sent.');
  const originalActions = candidates || [];
  const originalVotes = voteCandidates || [];
  // Keep the full reservation even if all independent votes are deferred.
  const numPredict = 640;
  function render(actions, votes) {
    const options = { voteCandidates: votes, voteAllowance, decisionContractVersion, hostedConstructionVersion: VERSION };
    const prompt = actionCandidates.prompt(actions, decisionAt, options);
    const repair = actionCandidates.repairPrompt(actions, decisionAt, options);
    try {
      return { prompt, repair, budget: measure(system, prompt, numPredict),
        repairBudget: measure(system, repair, numPredict) };
    } catch (error) {
      // An uncountably large full menu is not proof that every whole item is
      // impossible. Do not relax the tokenizer's bound or slice its text.
      if (error.code !== 'HOSTED_TOKENIZER_INPUT_TOO_LARGE') throw error;
      return { workLimitExceeded: true };
    }
  }
  const fitsBoth = (request) => !request.workLimitExceeded && fits(request.budget) && fits(request.repairBudget);
  const original = render(originalActions, originalVotes);
  const selectedActions = new Set();
  const selectedVotes = new Set();
  let packed = original;
  let minimum = null;
  const minimumSize = (request) => request.workLimitExceeded ? Infinity
    : Math.max(request.budget.inputTokens, request.repairBudget.inputTokens);
  function attempt(entry) {
    const chosen = entry.kind === 'action' ? selectedActions : selectedVotes;
    if (chosen.has(entry.item)) return;
    chosen.add(entry.item);
    const proposal = render(originalActions.filter((item) => selectedActions.has(item)),
      originalVotes.filter((item) => selectedVotes.has(item)));
    if (selectedActions.size + selectedVotes.size === 1 &&
        (!minimum || minimumSize(proposal) < minimumSize(minimum))) minimum = proposal;
    if (fitsBoth(proposal)) packed = proposal;
    else chosen.delete(entry.item);
  }
  if (fitsBoth(original)) {
    originalActions.forEach((item) => selectedActions.add(item));
    originalVotes.forEach((item) => selectedVotes.add(item));
  } else {
    const order = packingOrder(originalActions, originalVotes, decisionAt);
    // Orthogonal first-contact contract v1, frozen at admission. Legacy v2
    // construction is exact when it is absent. One complete root action and
    // its independent vote get a joint fit attempt BEFORE other blocks can
    // displace them. Neither is mandatory if the complete pair cannot fit.
    const contactAction = firstContactVersion === 1 && originalActions.find(item =>
      item.candidateType === 'ordinary_post' && item.target?.key === firstContactKey);
    const contactVote = firstContactVersion === 1 && originalVotes.find(item =>
      item.targetType === 'post' && 't3_' + item.targetId === firstContactKey);
    if (contactAction && contactVote) {
      const pair = render([contactAction], [contactVote]);
      if (fitsBoth(pair)) {
        selectedActions.add(contactAction);
        selectedVotes.add(contactVote);
        packed = pair;
      }
    }
    if (!selectedActions.size && contactAction) attempt({ kind: 'action', item: contactAction });
    // Keep a primary action where one fits. A root-only vote opportunity has
    // no actions and may anchor its first-contact vote directly.
    if (!originalActions.length && contactVote) attempt({ kind: 'vote', item: contactVote });
    // An independent vote must not evict every primary action when at least
    // one complete primary action fits. A later action can be the anchor.
    for (const entry of order) {
      if (selectedActions.size) break;
      if (entry.kind !== 'action') continue;
      attempt(entry);
      if (selectedActions.size) break;
    }
    if (contactVote) attempt({ kind: 'vote', item: contactVote });
    // Votes are optional, not a mandatory oversized companion to the anchor.
    // A rejected block never prevents trying later complete blocks.
    for (const entry of order) attempt(entry);
    if (!selectedActions.size && !selectedVotes.size) return {
      version: VERSION,
      failure: 'Hosted decision cannot fit any complete candidate, persona and response contract within the verified context budget. No inference was sent; omitted targets remain unresolved.',
      originalInputTokens: original.budget ? original.budget.inputTokens : null,
      originalRepairTokens: original.repairBudget ? original.repairBudget.inputTokens : null,
      ...(original.workLimitExceeded ? { originalWorkLimitExceeded: true } : {}),
      minimumInputTokens: minimum && minimum.budget ? minimum.budget.inputTokens : null,
      minimumRepairTokens: minimum && minimum.repairBudget ? minimum.repairBudget.inputTokens : null,
      contextTokens: CONTEXT_TOKENS, outputTokens: numPredict, safetyTokens: SAFETY_TOKENS,
    };
  }
  return { version: VERSION, ...packed, numPredict,
    candidateIds: originalActions.filter((item) => selectedActions.has(item)).map((item) => item.id),
    voteIds: originalVotes.filter((item) => selectedVotes.has(item)).map((item) => item.id),
    deferredCandidateIds: originalActions.filter((item) => !selectedActions.has(item)).map((item) => item.id),
    deferredVoteIds: originalVotes.filter((item) => !selectedVotes.has(item)).map((item) => item.id),
    originalInputTokens: original.budget ? original.budget.inputTokens : null,
    originalRepairTokens: original.repairBudget ? original.repairBudget.inputTokens : null,
    ...(original.workLimitExceeded ? { originalWorkLimitExceeded: true } : {}),
  };
}

function construct(options) {
  const constructionVersion = version(options.constructionVersion == null ? VERSION : options.constructionVersion);
  if (constructionVersion === 1) return constructV1(options);
  if (constructionVersion === VERSION) return constructV2(options);
  throw failure('Legacy unbudgeted construction cannot be upgraded implicitly.');
}

// Recompute on the worker, after acquiring the actual execution profile. Never
// trust an upstream token count and never let a smaller profile truncate input.
function verifyRequest({ model, system, prompt, numPredict, budget }, profile) {
  if (model !== tokenizer.MODEL) throw failure('Hosted decision model has no verified tokenizer.');
  const measured = measure(system, prompt, numPredict, budget ? budget.version : VERSION);
  if (budget && Object.keys(measured).some((key) => budget[key] !== measured[key])) {
    throw failure('Hosted decision budget does not match the frozen request.');
  }
  const actualContext = Number(profile && profile.num_ctx);
  if (!Number.isInteger(actualContext) || actualContext < measured.contextTokens) {
    throw failure('Hosted decision execution context is smaller than, or missing from, the verified budget.');
  }
  if (!fits(measured)) throw failure('Hosted decision exceeds its verified input/output token budget. No inference was sent.');
  return measured;
}

module.exports = { VERSION, CONTEXT_TOKENS, SAFETY_TOKENS, version, construct, measure, fits, verifyRequest, failure };
