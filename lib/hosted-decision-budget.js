'use strict';

const crypto = require('node:crypto');
const tokenizer = require('./hosted-tokenizer');
const actionCandidates = require('./action-candidates');
const firstContact = require('./first-contact');

// A request construction contract, independent of the response/decision contract.
// This is the existing DELL execution profile, NOT a request to enlarge it.
const VERSION = 1;
const CONTEXT_TOKENS = 3072;
const SAFETY_TOKENS = 64;

function version(value) {
  if (value == null) return 0; // Legacy durable request construction.
  if (value === 0 || value === VERSION) return value;
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

function measure(system, prompt, numPredict) {
  if (!Number.isInteger(numPredict) || numPredict < 1 || numPredict > 4096) {
    throw failure('Hosted decision output reservation is invalid. No inference was sent.');
  }
  const inputTokens = tokenizer.countRequest(system, prompt);
  return { version: VERSION, contextTokens: CONTEXT_TOKENS, inputTokens,
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
function constructLegacy({ model, system, candidates, voteCandidates, voteAllowance, decisionAt, decisionContractVersion }) {
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
    const budget = measure(system, prompt, numPredict);
    const repairBudget = measure(system, repair, numPredict);
    if (originalInputTokens == null) {
      originalInputTokens = budget.inputTokens;
      originalRepairTokens = repairBudget.inputTokens;
    }
    if (fits(budget) && fits(repairBudget)) return {
      version: VERSION, prompt, repair, budget, repairBudget, numPredict,
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
      version: VERSION,
      failure: 'Hosted decision cannot fit a complete minimum slate, persona and response contract within the verified context budget. No inference was sent; omitted votes remain unconsidered.',
      originalInputTokens, originalRepairTokens,
      minimumInputTokens: budget.inputTokens, minimumRepairTokens: repairBudget.inputTokens,
      contextTokens: CONTEXT_TOKENS, outputTokens: numPredict, safetyTokens: SAFETY_TOKENS,
    };
  }
}

// Desktop DELL requests retain construction v1. Only a separately frozen
// first-contact contract selects atomic packing instead of legacy suffix cuts.
// Existing turns and all missing/v0 first-contact requests render exactly as
// before; the worker still verifies the same v1 token/hash metadata.
function constructFirstContact({ model, system, candidates, voteCandidates, voteAllowance, decisionAt,
  decisionContractVersion, firstContactVersion, firstContactKey, firstContactVoteKey }) {
  if (model !== tokenizer.MODEL) throw failure('Hosted decision model has no verified token budget. No inference was sent.');
  const actions = candidates || [], votes = voteCandidates || [];
  const numPredict = 640;
  function render(selectedActions, selectedVotes) {
    const options = { voteCandidates: selectedVotes, voteAllowance, decisionContractVersion,
      hostedConstructionVersion: 2 };
    const prompt = actionCandidates.prompt(selectedActions, decisionAt, options);
    const repair = actionCandidates.repairPrompt(selectedActions, decisionAt, options);
    try {
      return { prompt, repair, budget: measure(system, prompt, numPredict),
        repairBudget: measure(system, repair, numPredict) };
    } catch (error) {
      if (error.code !== 'HOSTED_TOKENIZER_INPUT_TOO_LARGE') throw error;
      return { workLimitExceeded: true };
    }
  }
  const fitsBoth = request => !request.workLimitExceeded && fits(request.budget) && fits(request.repairBudget);
  const original = render(actions, votes);
  const selectedActions = new Set(), selectedVotes = new Set();
  let packed = original, minimum = null;
  const size = request => request.workLimitExceeded ? Infinity
    : Math.max(request.budget.inputTokens, request.repairBudget.inputTokens);
  function attempt(item, kind) {
    const selected = kind === 'action' ? selectedActions : selectedVotes;
    if (selected.has(item)) return;
    selected.add(item);
    const proposal = render(actions.filter(candidate => selectedActions.has(candidate)),
      votes.filter(candidate => selectedVotes.has(candidate)));
    if (selectedActions.size + selectedVotes.size === 1 && (!minimum || size(proposal) < size(minimum))) minimum = proposal;
    if (fitsBoth(proposal)) packed = proposal;
    else selected.delete(item);
  }
  if (fitsBoth(original)) {
    actions.forEach(item => selectedActions.add(item));
    votes.forEach(item => selectedVotes.add(item));
  } else {
    const root = actions.find(item => item.candidateType === 'ordinary_post' && item.target?.key === firstContactKey);
    const vote = votes.find(item => item.targetType === 'post' && 't3_' + item.targetId === firstContactKey);
    const secondVote = firstContactVersion === 2 && firstContactVoteKey !== firstContactKey &&
      votes.find(item => item.targetType === 'post' && 't3_' + item.targetId === firstContactVoteKey);
    if (root && vote) {
      const pair = render([root], [vote]);
      if (fitsBoth(pair)) {
        selectedActions.add(root); selectedVotes.add(vote); packed = pair;
      }
    }
    if (root && !selectedActions.size) attempt(root, 'action');
    // Keep the primary action where possible before independent voting items.
    for (const item of actions) {
      if (selectedActions.size) break;
      attempt(item, 'action');
    }
    if (vote) attempt(vote, 'vote');
    // First-look v2 may additionally retain one complete lightweight root ballot.
    // This never evicts the primary or blocks later fitting alternatives.
    if (secondVote) attempt(secondVote, 'vote');
    for (let i = 0; i < Math.max(actions.length, votes.length); i++) {
      if (actions[i]) attempt(actions[i], 'action');
      if (votes[i]) attempt(votes[i], 'vote');
    }
    if (!selectedActions.size && !selectedVotes.size) return {
      version: VERSION,
      failure: 'Hosted decision cannot fit any complete candidate, persona and response contract within the verified context budget. No inference was sent; omitted targets remain unresolved.',
      originalInputTokens: original.budget?.inputTokens ?? null,
      originalRepairTokens: original.repairBudget?.inputTokens ?? null,
      ...(original.workLimitExceeded ? { originalWorkLimitExceeded: true } : {}),
      minimumInputTokens: minimum?.budget?.inputTokens ?? null,
      minimumRepairTokens: minimum?.repairBudget?.inputTokens ?? null,
      contextTokens: CONTEXT_TOKENS, outputTokens: numPredict, safetyTokens: SAFETY_TOKENS,
    };
  }
  return { version: VERSION, ...packed, numPredict,
    candidateIds: actions.filter(item => selectedActions.has(item)).map(item => item.id),
    voteIds: votes.filter(item => selectedVotes.has(item)).map(item => item.id),
    deferredCandidateIds: actions.filter(item => !selectedActions.has(item)).map(item => item.id),
    deferredVoteIds: votes.filter(item => !selectedVotes.has(item)).map(item => item.id),
    originalInputTokens: original.budget?.inputTokens ?? null,
    originalRepairTokens: original.repairBudget?.inputTokens ?? null,
    ...(original.workLimitExceeded ? { originalWorkLimitExceeded: true } : {}),
  };
}

function construct(options) {
  return firstContact.version(options.firstContactVersion, 0)
    ? constructFirstContact(options) : constructLegacy(options);
}

// Recompute on the worker, after acquiring the actual execution profile. Never
// trust an upstream token count and never let a smaller profile truncate input.
function verifyRequest({ model, system, prompt, numPredict, budget }, profile) {
  if (model !== tokenizer.MODEL) throw failure('Hosted decision model has no verified tokenizer.');
  const measured = measure(system, prompt, numPredict);
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
