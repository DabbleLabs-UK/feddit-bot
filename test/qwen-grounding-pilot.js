'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prompts, freeze, guardedTransport, nextNaturalAt, exclusiveRunLock, entryMinutes } = require('../scripts/qwen-grounding-pilot');
const actions = require('../lib/action-candidates');
async function main() {
  const snapshot = freeze({ candidates: [], voteAllowance: { remaining: 12 }, voteCandidates: [
    { id: 'V1', targetType: 'post', targetId: 1, author: 'one', label: 'First', content: 'First real item.', socialContext: 'Prior interaction.', memoryContext: 'A bounded memory.' },
    { id: 'V2', targetType: 'comment', targetId: 2, author: 'two', label: 'Second', content: 'Second real item.' },
  ] });
  const before = JSON.stringify(snapshot);
  const pair = prompts(snapshot, 1234567);
  assert.equal(pair.control, actions.prompt([], 1234567, snapshot));
  assert.equal(pair.treatment.replace(/^BEGIN TARGET V\d+\n|\nEND TARGET V\d+$/gm, ''), pair.control);
  assert.equal((pair.treatment.match(/BEGIN TARGET/g) || []).length, 2);
  assert(pair.treatment.indexOf('BEGIN TARGET V1') < pair.treatment.indexOf('BEGIN TARGET V2'));
  assert.equal(JSON.stringify(snapshot), before);
  let calls = 0;
  await assert.rejects(guardedTransport(async () => { calls++; }, {}, { signal: new AbortController().signal }, async () => ({ busy: true })), { code: 'PILOT_YIELD' });
  assert.equal(calls, 0);
  await assert.rejects(guardedTransport(async () => { calls++; }, {}, { signal: AbortSignal.abort() }, async () => ({ busy: false })), { name: 'AbortError' });
  assert.equal(calls, 0);
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qwen-pilot-lock-'));
  const release = exclusiveRunLock(temporary);
  assert.throws(() => exclusiveRunLock(temporary), { code: 'EEXIST' });
  release();
  assert(!fs.existsSync(path.join(temporary, 'run.lock')));
  fs.rmdirSync(temporary);
  let probes = 0;
  await assert.rejects(guardedTransport(async (body, opts) => {
    calls++;
    await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }, {}, { signal: new AbortController().signal }, async () => ({ busy: ++probes > 1 }), 2), { code: 'PILOT_YIELD' });
  assert.equal(calls, 1);
  await assert.rejects(guardedTransport(async (body, opts) => {
    await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }, {}, { signal: new AbortController().signal }, async () => { if (++probes > 3) throw new Error('offline'); return { busy: false }; }, 2), { code: 'PILOT_YIELD' });
  assert.equal(await guardedTransport(async () => 'result', {}, { signal: new AbortController().signal }, async () => ({ busy: false })), 'result');
  assert.equal(nextNaturalAt({ settings: {}, profiles: [{ enabled: true, sched: { nextVoteAt: 500 } }, { enabled: false, sched: { nextPostAt: 100 } }] }), 500);
  const large = { system: '', control: 'x'.repeat(14000) };
  assert.equal(entryMinutes(large, null, 1, 100000), 12);
  assert.equal(entryMinutes(large, { caseIndex: 1, status: 'completed', finishedAt: 99999 }, 1, 100000), 5);
  assert.equal(entryMinutes(large, { caseIndex: 0, status: 'completed', finishedAt: 99999 }, 1, 100000), 12);
  assert.equal(entryMinutes(large, { caseIndex: 1, status: 'completed', finishedAt: 1 }, 1, 100000), 12);
  const source = fs.readFileSync(path.join(__dirname, '../scripts/qwen-grounding-pilot.js'), 'utf8');
  assert(source.includes("'artifacts', 'qwen-two-pair'"));
  assert(source.includes('ledger.calls.length < 4'));
  assert(source.includes('Prior ambiguous/failed call: stop, never retry.'));
  assert(!/store\.(?:update|record|save)|feddit\.(?:vote|submit|register|comment)\(/.test(source));
  console.log('Qwen pilot: 24 checks passed; mocked transport only, zero model calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
