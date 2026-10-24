'use strict';

// Scoped canaries may add optional evidence, never change baseline exposure.
const budget = require('./hosted-decision-budget');
const actions = require('./action-candidates');
const context = require('./theme-context');
const scopePolicy = require('./theme-scope');
const interest = require('./theme-interest');

function withoutHints(candidates) {
  return candidates.map(candidate => candidate.themeInterest
    ? { ...candidate, themeInterest: { ...candidate.themeInterest, offeredHint: false } } : candidate);
}

function construct(options, snapshot, rawScope) {
  const scope = scopePolicy.normalizeScope(rawScope);
  if (!scope) return budget.construct(options); // Exact reviewed legacy v1 replay.
  const baseline = budget.construct({ ...options, candidates: withoutHints(options.candidates) });
  const retained = options.candidates.filter(item => (baseline.candidateIds || []).includes(item.id));
  const votes = options.voteCandidates.filter(item => (baseline.voteIds || []).includes(item.id));
  const unchanged = reason => ({ ...baseline, themeHints: { scopeVersion: scope.version, included: false, reason } });
  if (baseline.failure) return unchanged('baseline-failure');
  if (!context.decisionMenuAllowed(snapshot, retained, votes, scope)) return unchanged('mixed-or-unknown-community');
  let count = 0;
  const hinted = retained.map(candidate => candidate.themeInterest ? { ...candidate,
    themeInterest: { ...candidate.themeInterest, offeredHint: count++ < interest.LIMITS.hintsPerMenu } } : candidate);
  if (!hinted.some(item => context.hint(item))) return unchanged('no-local-familiarity');
  const renderOptions = { voteCandidates: votes, voteAllowance: options.voteAllowance,
    decisionContractVersion: options.decisionContractVersion,
    ...(baseline.version >= 2 ? { hostedConstructionVersion: baseline.version } : {}) };
  const prompt = actions.prompt(hinted, options.decisionAt, renderOptions);
  const repair = actions.repairPrompt(hinted, options.decisionAt, renderOptions);
  try {
    const measured = budget.measure(options.system, prompt, baseline.numPredict, baseline.version);
    const repairBudget = budget.measure(options.system, repair, baseline.numPredict, baseline.version);
    if (!budget.fits(measured) || !budget.fits(repairBudget)) return unchanged('optional-cue-does-not-fit');
    return { ...baseline, prompt, repair, budget: measured, repairBudget,
      themeHints: { scopeVersion: scope.version, included: true,
        inputTokenDelta: measured.inputTokens - baseline.budget.inputTokens } };
  } catch { return unchanged('optional-cue-unmeasurable'); }
}

module.exports = { withoutHints, construct };
