'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const actionCandidates = require('../lib/action-candidates');
const fixtures = require('./fixtures/decision-evidence');

let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}
function verify(menu, expectedCompact = true) {
  const before = JSON.stringify(menu);
  freeze(menu);
  const legacy = actionCandidates.prompt(menu.candidates, menu.nowMs, menu.options);
  const compact = actionCandidates.compactPrompt(menu.candidates, menu.nowMs, menu.options);
  eq(Buffer.from(compact.version ? actionCandidates.expandEvidence(compact.body, compact.entries) : compact.body), Buffer.from(legacy),
    menu.name + ': full byte-for-byte expansion preserves legacy instructions and evidence');
  eq(JSON.stringify(menu), before, menu.name + ': candidates, votes, metadata and settings are not mutated');
  eq(compact.originalCharacters, legacy.length, menu.name + ': original character count is exact');
  eq(compact.compactCharacters, compact.prompt.length, menu.name + ': compact character count is exact');
  const legacyRepair = actionCandidates.repairPrompt(menu.candidates, menu.nowMs, menu.options);
  eq(compact.repair, compact.prompt + legacyRepair.slice(legacy.length),
    menu.name + ': repair retains the identical existing one-repair suffix');
  eq(actionCandidates.compactPrompt(menu.candidates, menu.nowMs, menu.options), compact,
    menu.name + ': repeated construction is deterministic');
  eq(compact.version, expectedCompact ? actionCandidates.COMPACT_EVIDENCE_VERSION : 0,
    menu.name + ': only an actually useful compaction reports the compact version');
  if (expectedCompact) {
    ok(compact.compactCharacters < compact.originalCharacters, menu.name + ': table overhead still yields a smaller request');
    eq([...compact.body.matchAll(/^\[(C\d+)\]$/gm)].map(match => match[1]), menu.candidates.map(item => item.id),
      menu.name + ': action IDs and ordering remain exact');
    eq([...compact.body.matchAll(/^\[(V\d+)\] /gm)].map(match => match[1]), menu.options.voteCandidates.map(item => item.id),
      menu.name + ': vote IDs and ordering remain exact');
    for (const entry of compact.entries) {
      ok(!/\[\[E[1-9][0-9]*\]\]/.test(entry.text), menu.name + ': dictionary text does not recursively reference other evidence');
      ok(compact.body.includes('[[' + entry.id + ']]'), menu.name + ': every dictionary entry is actually referenced');
      ok(compact.prompt.includes(JSON.stringify(entry.text)), menu.name + ': literal evidence is encoded without interpretation');
    }
    const referenced = [...compact.body.matchAll(/\[\[(E[1-9][0-9]*)\]\]/g)].map(match => match[1]);
    ok(referenced.every(id => compact.entries.some(entry => entry.id === id)), menu.name + ': every reference resolves');
  } else {
    eq(compact.prompt, legacy, menu.name + ': fallback is the exact original prompt');
    eq(compact.entries, [], menu.name + ': fallback retains no active dictionary');
  }
  return compact;
}

for (const menu of fixtures.buildMenus()) {
  eq(crypto.createHash('sha256').update(actionCandidates.prompt(menu.candidates, menu.nowMs, menu.options)).digest('hex'),
    fixtures.LEGACY_PROMPT_SHA256[menu.name], menu.name + ': released legacy renderer remains byte-exact against pre-change source');
  eq(menu.candidates.length, 12, menu.name + ': realistic fixture reaches the existing action bound');
  eq(menu.options.voteCandidates.length, 8, menu.name + ': realistic fixture reaches the existing vote bound');
  const compact = verify(menu);
  ok(!compact.prompt.includes('fixture-only observational metadata'), menu.name + ': non-prompt metadata remains non-prompt metadata');
  for (const choice of ['C1', 'C12', 'WAIT']) {
    const text = JSON.stringify({ choice, reason: 'The retained content fits this reaction.',
      votes: menu.options.voteCandidates.map((vote, index) => ({ id: vote.id,
        direction: index % 3 === 0 ? 'up' : index % 3 === 1 ? 'down' : 'nil',
        reason: index % 3 === 2 ? '' : 'The contribution gives specific useful detail.' })) });
    const parsed = actionCandidates.parseDecision(text, menu.candidates, menu.options);
    ok(parsed.valid, menu.name + ': ordinary choice and explicit WAIT remain valid after representation change');
    eq(parsed.waited, choice === 'WAIT', menu.name + ': no writing is forced by secondary votes');
    eq(parsed.votes.map(item => item.direction), ['up', 'down', 'nil', 'up', 'down', 'nil', 'up', 'down'],
      menu.name + ': independent vote decisions retain their existing meaning');
  }
  const missing = actionCandidates.parseDecision('{"choice":"WAIT","reason":"No written response is needed."}', menu.candidates, menu.options);
  ok(missing.valid && missing.votes.every(item => item.status === 'unresolved' && item.direction === null),
    menu.name + ': missing votes remain unresolved rather than invented abstentions');
  const invalid = actionCandidates.parseDecision('{"choice":"E1","reason":"A reference is not an action.","votes":[]}', menu.candidates, menu.options);
  ok(!invalid.valid, menu.name + ': evidence IDs cannot become primary action IDs');
}

for (const pressure of fixtures.buildPressureMenus()) {
  eq(pressure.candidates.length, 12, pressure.name + ': pressure fixture does not expand the action slate');
  eq(pressure.options.voteCandidates.length, 8, pressure.name + ': pressure fixture does not expand the vote slate');
  const original = fixtures.buildMenu('civic');
  eq(pressure.options.voteCandidates, original.options.voteCandidates,
    pressure.name + ': additional ancestors do not change vote-target content or identity');
  const compact = verify(pressure);
  const expanded = actionCandidates.expandEvidence(compact.body, compact.entries);
  for (const candidate of pressure.candidates) {
    ok(candidate.context.length <= 2500, candidate.id + ': all unique branch facts fit the established content bound');
    ok(candidate.memory.prompt.length <= 1600, candidate.id + ': all unique memories fit the established memory bound');
    ok(expanded.includes(candidate.context), candidate.id + ': no unique branch fact is lost through interning or truncation');
    ok(expanded.includes(candidate.memory.prompt.replace(/\s+/g, ' ').trim()),
      candidate.id + ': complete unique memory remains after unchanged legacy whitespace normalization');
  }
}

const votingOnly = fixtures.buildMenu('camera');
votingOnly.name = 'voting-only';
votingOnly.candidates = [];
const votingCompact = verify(votingOnly);
ok(votingCompact.prompt.includes('Do not create a post or comment'), 'voting-only publication prohibition is retained');
ok(votingCompact.prompt.includes('choice value must be exactly WAIT'), 'voting-only response remains WAIT');

const noDuplicates = { name: 'unique evidence', nowMs: fixtures.NOW_MS,
  candidates: [{ id: 'C1', candidateType: 'ordinary_post', context: 'One independent short observation.',
    social: { known: false, summary: 'No known counterpart.' } }], options: { voteCandidates: [], decisionContractVersion: 2 } };
verify(noDuplicates, false);
verify({ name: 'empty menu', nowMs: fixtures.NOW_MS, candidates: [], options: { voteCandidates: [] } }, false);

const marker = fixtures.buildMenu('civic');
marker.name = 'literal reference-like forum content';
marker.candidates[0].context += '\nA participant literally wrote [[E1]]; this must not become a reference.';
verify(marker, false);

const prefix = 'A retained observation about a repaired camera, with its original wording and uncertainty, must remain exactly as it appeared to the participant. ';
const special = { name: 'unicode multiline and partial overlap', nowMs: fixtures.NOW_MS,
  candidates: [
    { id: 'C1', candidateType: 'ordinary_post', context: prefix + '\nCaf\u00e9: \"lens\"; slash \\; emoji \ud83d\udcf7; tab\tend.',
      memory: { relevant: true, summary: 'One remembered observation.', prompt: prefix } },
    { id: 'C2', candidateType: 'ordinary_comment', context: prefix + '\nDifferent ending: \u65e5\u672c\u8a9e and \u0301 combining mark.',
      memory: { relevant: true, summary: 'Another remembered observation.', prompt: prefix } },
  ], options: { voteCandidates: [
    { id: 'V1', targetType: 'post', targetId: 42, author: 'synthetic_observer', label: 'Original observed post',
      content: prefix, memoryContext: prefix },
  ], decisionContractVersion: 2 } };
verify(special);

const tooShort = { name: 'short repetitions are not worth a dictionary', nowMs: fixtures.NOW_MS,
  candidates: [{ id: 'C1', candidateType: 'ordinary_post', context: 'Small repeated fact.', social: { summary: 'Small repeated fact.' } }],
  options: { voteCandidates: [{ id: 'V1', targetType: 'post', targetId: 43, content: 'Small repeated fact.', label: 'Small repeated fact.' }] } };
verify(tooShort, false);

assert.throws(() => actionCandidates.expandEvidence('[[E7]]', []), /Unknown compact decision evidence reference/);
checks++;
console.log('decision evidence: ' + checks + ' checks passed');
