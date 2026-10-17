'use strict';

// Existing in-memory/temporary scheduler harness. Every endpoint is a mock.
global.fetch = async () => { throw new Error('No network in evidence scheduler tests'); };
const assert = require('node:assert/strict');
const { createScheduler } = require('../lib/scheduler');
const { harness, makeProfile } = require('./durable-scheduler');
const { createEvidenceStore } = require('../lib/naturalness-evidence');
let checks = 0;
const eq = (a,b) => { assert.deepEqual(a,b); checks++; };

async function runCase(placement, repair = false) {
  const p = makeProfile('evidence-bot', false);
  Object.assign(p, { provider: 'ollama', model: 'fixture-model', canReply: true,
    canStartDiscussions: false, canVote: true, postsPerHour: 0, commentsPerHour: 1, votesPerHour: 1 });
  Object.assign(p.sched, { nextPostAt: null, nextCommentAt: 0, nextVoteAt: 0 });
  const content = 'The cucumber office issued three conflicting permits. The blue permit covers the greenhouse, ' +
    'but the committee insists that the tomato is legally a fruit and cannot sign a vegetable form. ' +
    'How should we handle the missing signature without pretending that the earlier rules disappeared? ' +
    'Yesterday the clerk accepted a handwritten note, but only for plants outside the municipal boundary. ' +
    'The greenhouse straddles that boundary, so moving the desk would change which side authorizes the signature. ' +
    'Alice suggested signing on behalf of the trellis, while Bob wants the appeal heard by an independent gardener. ' +
    'The office cannot issue a replacement permit until the existing permit has been formally retired.';
  const posts = Array.from({ length: 3 }, (_, i) => ({ id: 40+i, feddit: 'general', author: 'alice',
    title: 'The cucumber office ' + i, selftext: content, created_utc: 9, kind: 'text' }));
  const requests = [];
  const h = harness({ profiles: [p], feedPosts: posts, providerGenerate: async request => {
    requests.push(structuredClone(request));
    if (repair && requests.length === 1) return { text: 'Unreadable initial choice',
      model: p.model, usage: { inputTokens: 10, outputTokens: 2 }, ms: 1 };
    return { text: JSON.stringify({ choice: 'WAIT', reason: 'The committee is already repeating itself.',
      votes: [1,2,3].map(i => ({ id:'V'+i, direction:'nil', reason:'' })) }),
      model: p.model, usage: { inputTokens: 10, outputTokens: 20 }, ms: 1 };
  } });
  try {
    h.store.getSettings().writingCanary = { version: 1, profileIds: [p.id] };
    const protectedBefore = JSON.stringify({ persona:p.persona, model:p.model, provider:p.provider,
      cadence:[p.postsPerHour,p.commentsPerHour,p.votesPerHour], canary:h.store.getSettings().writingCanary });
    const runtime = createScheduler({ placement, store:h.store, providers:h.providers, feddit:h.feddit,
      jobQueue:h.queue, turnStore:h.turnStore, now:h.now, random:()=>.5,
      about:{ fetchAbout:async()=>({ name:'general', over_18:false, post_format:'any', rules:[] }) } });
    await runtime.runTick();
    eq(requests.length, repair ? 2 : 1);
    eq(requests[0].kind, 'scheduled-decision');
    eq(requests[0].numPredict, 640);
    eq(requests[0].model, 'fixture-model');
    if (placement === 'desktop') {
      eq(requests[0].decisionEvidenceVersion, 1);
      assert.match(requests[0].prompt, /SHARED EVIDENCE v1/); checks++;
      if (repair) {
        eq(requests[1].decisionEvidenceVersion, 1);
        assert.ok(requests[1].prompt.startsWith(requests[0].prompt)); checks++;
        eq(requests[1].kind, 'scheduled-decision-retry');
      }
    } else {
      eq(requests[0].decisionEvidenceVersion, undefined);
      assert.doesNotMatch(requests[0].prompt, /SHARED EVIDENCE/); checks++;
    }
    eq(h.writes.filter(x=>x.type==='comment'||x.type==='submit').length, 0);
    eq(h.turnStore.listActive().length, 0);
    eq(JSON.stringify({ persona:p.persona, model:p.model, provider:p.provider,
      cadence:[p.postsPerHour,p.commentsPerHour,p.votesPerHour], canary:h.store.getSettings().writingCanary }), protectedBefore);
  } finally { h.cleanup(); }
}

(async()=>{
  await runCase('desktop');
  await runCase('desktop', true);
  await runCase('advanced');
  await runCase('hosted');
  console.log('decision-evidence-scheduler: '+checks+' checks passed');
})().catch(e=>{ console.error(e);process.exitCode=1; });
