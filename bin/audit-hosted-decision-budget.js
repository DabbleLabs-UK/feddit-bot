'use strict';

// Offline only. Input is a private, already-frozen export, never a live store.
// Output contains sizes, stable ID counts and hashes, not prompts or profiles.
const fs = require('node:fs');
const crypto = require('node:crypto');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const actions = require('../lib/action-candidates');

function audit(records) {
  return records.map((record) => {
    const first = record.generations[0].request;
    const options = { ...record.slate, decisionContractVersion: 2 };
    const rendered = actions.prompt(record.slate.candidates, record.createdAt, options);
    const originalCounts = record.generations.map(({ request }) => tokenizer.countRequest(request.system, request.prompt));
    const result = budget.construct({ model: first.model, system: first.system,
      ...record.slate, decisionAt: record.createdAt, decisionContractVersion: 2 });
    return {
      turnHash: crypto.createHash('sha256').update(record.id).digest('hex'),
      originalInputTokens: originalCounts,
      nativeInputTokens: record.generations.map((generation) => generation.usage?.inputTokens || null),
      originalFits: originalCounts.map((count, i) => count + record.generations[i].request.numPredict + budget.SAFETY_TOKENS <= budget.CONTEXT_TOKENS),
      exactInitialSerialization: rendered === first.prompt,
      originalCandidateCount: record.slate.candidates.length,
      originalVoteCount: record.slate.voteCandidates.length,
      outcome: result.failure ? 'explicit-failure' : 'fit',
      inputTokens: result.budget?.inputTokens || null,
      repairTokens: result.repairBudget?.inputTokens || null,
      minimumRepairTokens: result.minimumRepairTokens || null,
      offeredCandidates: result.candidateIds?.length || 0,
      offeredVotes: result.voteIds?.length || 0,
      deferredCandidates: result.deferredCandidateIds?.length || 0,
      deferredVotes: result.deferredVoteIds?.length || 0,
    };
  });
}

if (require.main === module) {
  try {
    const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    let records = input.records;
    if (process.argv[3]) {
      const ids = new Set(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).turns.map((turn) => turn.id));
      records = records.filter((record) => ids.has(record.id));
      if (records.length !== ids.size) throw new Error('Frozen historical coverage is incomplete.');
    }
    if (!Array.isArray(records) || records.length > 100) throw new Error('A bounded frozen export is required.');
    const results = audit(records);
    const counts = results.flatMap((result) => result.originalInputTokens).sort((a,b) => a-b);
    const fitting = results.filter((result) => result.outcome === 'fit');
    console.log(JSON.stringify({
      sourceBackupSha256: input.backupSha256,
      turns: results.length, attempts: counts.length,
      originalInput: { min: counts[0], median: counts[Math.floor(counts.length / 2)], max: counts.at(-1) },
      originalFits: results.reduce((n,r) => n + r.originalFits.filter(Boolean).length, 0),
      nativeFullCountMatches: results.reduce((n,r) => n + r.originalInputTokens.filter((count,i) => count === r.nativeInputTokens[i]).length, 0),
      exactInitialSerializations: results.filter((r) => r.exactInitialSerialization).length,
      fittedTurns: fitting.length, explicitFailures: results.length - fitting.length,
      fittedMaximumInitial: Math.max(0, ...fitting.map((r) => r.inputTokens)),
      fittedMaximumRepair: Math.max(0, ...fitting.map((r) => r.repairTokens)),
      originalVotes: results.reduce((n,r) => n+r.originalVoteCount,0),
      offeredVotes: results.reduce((n,r) => n+r.offeredVotes,0),
      deferredVotesOnFittingTurns: results.reduce((n,r) => n+r.deferredVotes,0),
      results,
    }, null, 2));
  } catch (error) {
    console.error('Offline hosted budget audit failed: ' + (String(error.code || '').startsWith('HOSTED_') ? error.message : 'invalid or unavailable frozen input'));
    process.exitCode = 1;
  }
}

module.exports = { audit };
