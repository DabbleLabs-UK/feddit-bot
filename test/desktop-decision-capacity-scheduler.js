'use strict';

// Existing temporary scheduler harness, mocked feeds/provider only.
global.fetch = async () => { throw new Error('No network in desktop capacity tests'); };
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { harness, makeProfile } = require('./durable-scheduler');
const budget = require('../lib/desktop-decision-budget');
const tokenizer = require('../lib/desktop-tokenizer');
const ordinary = require('../lib/ordinary-candidates');
const firstContact = require('../lib/first-contact');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };
function profile(id, model = tokenizer.MODEL) {
  const p = makeProfile(id, false);
  Object.assign(p, { provider: 'ollama', model, canReply: true, canVote: true,
    canStartDiscussions: false, postsPerHour: 0, commentsPerHour: 1, votesPerHour: 1 });
  Object.assign(p.sched, { nextPostAt: null, nextCommentAt: 0, nextVoteAt: 0 });
  return p;
}
function posts(pressure = false) {
  return Array.from({ length: 6 }, (_, index) => ({ id: 80 + index, feddit: 'general',
    author: 'other', title: 'The reversible umbrella office ' + index, kind: 'text', created_utc: 9,
    selftext: index === 0 || !pressure ? 'A borrowed blue umbrella needs a removable strap; no glue or drilling.' :
      Array.from({ length: 80 }, (_, i) => 'Distinct branch fact ' + i + ': the keeper wants a reversible repair, not permanent council paperwork.').join(' ') }));
}
function wait(request) {
  const ids = [...new Set([...request.prompt.matchAll(/"id":"(V\d+)"/g)].map(match => match[1]))];
  return { text: JSON.stringify({ choice: 'WAIT', reason: 'The offered material does not need another reply.',
    votes: ids.map(id => ({ id, direction: 'nil', reason: '' })) }),
    model: request.model, ms: 1, usage: { inputTokens: 10, outputTokens: 10 } };
}
function attachReceipts(h) {
  const receipts = new Map();
  h.store.getOrdinaryCandidateState = id => ordinary.normalize(receipts.get(id));
  h.store.recordOrdinaryCandidateShortlist = (id, receipt) => {
    const next = ordinary.record(receipts.get(id), receipt);
    receipts.set(id, next); return next;
  };
  h.store.recordFirstContactAssessment = (id, receipt) => {
    const next = firstContact.record(receipts.get(id), receipt);
    receipts.set(id, next); return next;
  };
  return receipts;
}

async function selection(placement, model, mode = 'valid') {
  const p = profile('capacity-' + placement + '-' + model + '-' + mode, model);
  const calls = [], packed = [];
  const original = budget.construct;
  budget.construct = options => { const result = original(options); packed.push({ options, result }); return result; };
  const h = harness({ profiles: [p], placement, feedPosts: posts(mode !== 'manual'),
    providerGenerate: async request => {
      calls.push(structuredClone(request));
      if (mode === 'invalid' || mode === 'repair' && calls.length === 1) return { text: 'Not a valid decision.', ms: 1 };
      return wait(request);
    } });
  const receipts = attachReceipts(h);
  const canary = { version: 1, profileIds: [p.id] };
  h.store.getSettings().writingCanary = canary;
  const protectedBefore = JSON.stringify({ persona: p.persona, model: p.model, provider: p.provider,
    temperature: p.temperature, numPredict: p.numPredict, cadence: [p.postsPerHour, p.commentsPerHour, p.votesPerHour], canary });
  try {
    const result = mode === 'manual' ? await h.scheduler().simulateNow(p.id, 'comment') : await h.scheduler().runTick();
    eq(calls.length, mode === 'invalid' || mode === 'repair' ? 2 : 1, 'one inference plus only the existing semantic repair');
    eq(h.writes, [], 'WAIT/invalid decisions do not publish posts, comments or votes');
    eq(h.turnStore.listActive(), [], 'ordinary Ollama test creates no hosted durable generation');
    if (placement === 'desktop' && model === tokenizer.MODEL && mode !== 'manual') {
      eq(packed.length, 1, 'one immutable construction covers initial and repair');
      const { options, result: projection } = packed[0];
      ok(projection.candidates.length > 0, 'at least one full action fits');
      ok(projection.deferredCandidateIds.length > 0 || projection.deferredVoteIds.length > 0, 'real pressure fixture defers whole blocks');
      eq(calls[0].decisionEvidenceVersion, 2, 'Qwen desktop uses capacity representation v2');
      eq(calls[0].prompt, projection.prompt, 'initial request uses the frozen projection');
      for (const request of calls) {
        eq(request.desktopDecisionBudget.version, 2, 'request carries independent budget descriptor');
        eq(request.desktopDecisionBudget.inputTokens, tokenizer.countRequest(request.system, request.prompt), 'descriptor measures actual full system/request');
        eq(request.desktopDecisionBudget.inputLimit, 2400, 'input ceiling remains independently enforced');
        eq(request.desktopDecisionBudget.requestHash, crypto.createHash('sha256').update(JSON.stringify([
          request.system, request.prompt, request.numPredict,
        ])).digest('hex'), 'descriptor binds the exact request bytes and output allowance');
        ok(request.system.includes(p.persona), 'full persona stays in the system prompt');
        eq(request.model, p.model, 'runtime model unchanged');
        eq(request.temperature, p.temperature, 'sampling unchanged');
        eq(request.numPredict, projection.voteCandidates.length ? 640 : 120, 'existing decision output allowance unchanged');
      }
      if (calls.length > 1) eq(calls[1].prompt, projection.repair, 'repair never reconstructs or expands the candidate projection');
      const state = receipts.get(p.id) || {};
      const assessed = new Set((state.assessed || []).map(item => item.key));
      const considered = p.voteState.considered;
      const selectedKeys = new Set(projection.candidates.map(item => item.target && item.target.key));
      const selectedVoteKeys = new Set(projection.voteCandidates.map(item => (item.targetType === 'post' ? 't3_' : 't1_') + item.targetId));
      const deferredKeys = options.candidates.filter(item => projection.deferredCandidateIds.includes(item.id))
        .map(item => item.target && item.target.key).filter(key => !selectedKeys.has(key) && !selectedVoteKeys.has(key));
      for (const key of deferredKeys) {
        ok(!assessed.has(key), 'unoffered root stays locally first-look eligible');
        ok(!considered.includes('post:' + key.slice(3)), 'deferred root never becomes a considered NIL');
      }
      if (mode === 'invalid') {
        eq([...assessed], [], 'malformed primary and votes do not retire first-look claims');
        eq(considered, [], 'malformed votes remain unresolved');
      } else {
        ok(assessed.has('t3_80'), 'valid actual first-look WAIT assesses the offered primary root');
        for (const vote of projection.voteCandidates) ok(considered.includes(vote.targetType + ':' + vote.targetId), 'explicit offered NIL is considered');
      }
    } else {
      eq(packed.length, 0, 'other models/placements/manual requests retain released construction');
      eq(calls[0].desktopDecisionBudget, undefined, 'unaffected request has no desktop capacity descriptor');
      ok(!calls[0].prompt.includes('DESKTOP DECISION v2'), 'unaffected request does not receive new policy');
    }
    eq(JSON.stringify({ persona: p.persona, model: p.model, provider: p.provider,
      temperature: p.temperature, numPredict: p.numPredict, cadence: [p.postsPerHour, p.commentsPerHour, p.votesPerHour], canary }),
    protectedBefore, 'model/persona/cadence/canary settings are not rewritten');
    return result;
  } finally { budget.construct = original; h.cleanup(); }
}

async function gate(mode) {
  const a = profile('first-' + mode), b = profile('second-' + mode);
  let blocked = mode === 'initial-busy';
  const calls = [];
  const h = harness({ profiles: [a, b], placement: 'desktop', feedPosts: posts(),
    providerGenerate: async request => {
      calls.push(request);
      if (mode === 'draining') blocked = true;
      if (mode === 'paused') h.store.getSettings().paused = true;
      return wait(request);
    } });
  h.providers.ollamaBusy = () => blocked;
  const beforeB = JSON.stringify(b.sched);
  try {
    const scheduler = h.scheduler();
    await scheduler.runTick();
    eq(calls.length, mode === 'initial-busy' ? 0 : 1, 'provider drain/global pause stops additional profile admission');
    eq(JSON.stringify(b.sched), beforeB, 'blocked next profile keeps its due cadence untouched');
    eq(h.writes, [], 'busy/pause handling does not fabricate social activity');
    eq(scheduler.isBusy(), false, 'tick returns responsively instead of waiting inside the provider drain');
    blocked = false;
    h.store.getSettings().paused = false;
    await scheduler.runTick();
    ok(calls.length > (mode === 'initial-busy' ? 0 : 1), 'normal admission resumes after the existing gate clears');
  } finally { h.cleanup(); }
}

async function discovery(mode) {
  const p = profile('renewed-capacity-' + mode);
  const calls = [], packed = [];
  const original = budget.construct;
  budget.construct = options => { const result = original(options); packed.push(result); return result; };
  const h = harness({ profiles: [p], placement: 'desktop', providerGenerate: async request => {
    calls.push(request);
    // Missing ballots remain unresolved; only the valid primary menu can
    // acknowledge renewed discovery in this fixture.
    return mode === 'invalid' ? { text: 'Malformed primary and ballots.', ms: 1 } : {
      text: JSON.stringify({ choice: 'WAIT', reason: 'No further contribution is useful.', votes: [] }), ms: 1,
    };
  } });
  attachReceipts(h);
  h.feddit.activeThreads = async () => ({ ok: true, data: { threads: [0, 1, 2].map(i => ({
    event_id: 'active:t1_' + (601 + i), community: 'general',
    post: { id: 173 + i, author: 'carol', feddit: 'general', title: 'Renewed complete branch ' + i,
      selftext: i === 0 ? 'The reversible repair must leave the umbrella intact.' :
        Array.from({ length: 200 }, (_, j) => 'Branch constraint ' + j + ' concerns a genuinely different reversible repair.').join(' '),
      kind: 'text', created_utc: 9 },
    fresh_comment: { id: 601 + i, author: 'carol', body: 'Would a removable strap preserve the borrowed handle?', created_utc: 9 },
  })) } });
  try {
    await h.scheduler().runTick();
    eq(packed.length, 1, 'renewed candidates use one frozen measured projection');
    ok(packed[0].deferredCandidateIds.length > 0, 'complete oversized renewed branches are deferred');
    const offered = packed[0].candidates.filter(c => c.target && c.target.activeThread).map(c => c.target.activeThread.eventId);
    const acknowledged = p.activeThreadState.consideredEventIds;
    if (mode === 'invalid') eq(acknowledged, [], 'malformed decisions do not consume any renewed-thread discovery');
    else eq(acknowledged, offered, 'valid WAIT acknowledges only actually offered renewed-thread targets');
    ok(acknowledged.length < 3, 'gathered but unoffered renewed events remain discoverable');
    eq(calls.length, mode === 'invalid' ? 2 : 1, 'discovery receipt handling adds no inference');
    eq(h.writes, [], 'renewed WAIT/invalid cases publish nothing');
  } finally { budget.construct = original; h.cleanup(); }
}

async function impossible() {
  const p = profile('persona-exceeds-capacity');
  p.persona = 'Complete unique identity and required owner instruction. '.repeat(600);
  let calls = 0;
  const h = harness({ profiles: [p], placement: 'desktop', feedPosts: posts(),
    providerGenerate: async request => { calls++; return wait(request); } });
  const receipts = attachReceipts(h);
  try {
    await h.scheduler().runTick();
    eq(calls, 0, 'impossible persona/complete item fails explicitly before any inference');
    eq(h.writes, [], 'impossible menu never publishes');
    eq(p.voteState.considered, [], 'impossible ballots are not interpreted as NIL');
    eq((receipts.get(p.id) || {}).assessed || [], [], 'impossible unoffered roots retain first-look eligibility');
  } finally { h.cleanup(); }
}

(async () => {
  for (const mode of ['valid', 'repair', 'invalid']) await selection('desktop', tokenizer.MODEL, mode);
  await selection('desktop', 'fixture-model');
  await selection('hosted', tokenizer.MODEL);
  await selection('advanced', tokenizer.MODEL);
  await selection('desktop', tokenizer.MODEL, 'manual');
  for (const mode of ['valid', 'invalid']) await discovery(mode);
  await impossible();
  for (const mode of ['initial-busy', 'draining', 'paused']) await gate(mode);
  console.log('desktop-decision-capacity-scheduler: ' + checks + ' checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
