'use strict';

const crypto = require('node:crypto');
const tokenizer = require('./hosted-tokenizer');
const actionCandidates = require('./action-candidates');

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
function construct({ model, system, candidates, voteCandidates, voteAllowance, decisionAt, decisionContractVersion }) {
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
