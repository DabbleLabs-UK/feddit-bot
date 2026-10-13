'use strict';

// Actual scheduler, durable store and queue with deterministic Feddit/provider
// fixtures. No live network, timers, identities or publications.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
global.fetch = async () => { throw new Error('Unexpected live fetch in writing integration test'); };
const { harness, makeProfile, completeJob, queueContentGeneration, settle } = require('./durable-scheduler');
const publicWriting = require('../lib/public-writing');
const burst = require('../lib/burst');
const memory = require('../lib/autobiographical-memory');

const listing = (comments) => ({ data: { children: comments.map((data) => ({ data })) } });
const post = { id: 73, feddit: 'general', author: 'alice', title: 'The garden rota',
  selftext: 'Mara owns the greenhouse. The brass watering can is missing.', kind: 'text', created_utc: 8 };
const root = { id: 101, post_id: 73, parent_id: 't3_73', author: 'alice',
  body: 'Mara named the brass watering can Admiral Sprout.', created_utc: 8 };
const middle = { id: 102, post_id: 73, parent_id: 't1_101', author: 'bob',
  body: 'Admiral Sprout now demands a parking permit.', created_utc: 8 };
const target = { id: 103, post_id: 73, parent_id: 't1_102', author: 'carol',
  body: 'Would Mara accept a cucumber as the parking fee?', created_utc: 9 };
const sibling = { id: 104, post_id: 73, parent_id: 't3_73', author: 'dave',
  body: 'UNRELATED_SIBLING bicycle tyre advice.', created_utc: 9 };
const tree = listing([{ ...root, replies: listing([{ ...middle, replies: listing([target]) }]) }, sibling]);

function replyHarness(options = {}) {
  const profile = makeProfile('writing-fixture', false);
  Object.assign(profile, { canReply: true, canStartDiscussions: false, canVote: false,
    postsPerHour: 0, commentsPerHour: 1, temperature: 0.63, numPredict: 237 });
  Object.assign(profile.sched, { nextPostAt: null, nextCommentAt: 0 });
  const h = harness({ ...options, profiles: [profile] });
  h.reads = [];
  h.feddit.comments = async (id) => {
    h.reads.push(id);
    return { ok: true, data: { comments: structuredClone(tree) } };
  };
  return h;
}

function attention(h, complete = false) {
  h.feddit.attention = async () => ({ ok: true, data: {
    cursor: { comments: 103, posts: 0 }, has_more: false,
    events: [{ type: 'reply_to_own_comment', event_id: 't1_103', source_type: 'comment',
      comment_id: 103, post_id: 73, parent_comment_id: 102, author: target.author,
      body: target.body, community: 'general', created_utc: 9,
      context: { post: { ...post, post_id: 73, body: post.selftext },
        parent_chain: complete ? [root, middle] : [] } }],
  } });
}

function renewed(h, complete = false) {
  h.feddit.activeThreads = async () => ({ ok: true, data: { threads: [{
    event_id: 'active:t1_103', community: 'general', post,
    fresh_comment: complete ? { ...target, parent_id: 't1_101' } : target,
    parent_comment: complete ? root : middle,
  }] } });
}

async function begin(h, key) {
  const scheduler = h.scheduler();
  await scheduler.runTick();
  await settle();
  const turn = h.turnStore.activeForProfile(h.profiles[0].id);
  assert.ok(turn, 'scheduled reply accepts a durable turn');
  assert.equal(turn.input.publicWritingVersion, publicWriting.VERSION);
  assert.equal(turn.input.continuationVersion, 2);
  assert.equal(turn.input.decisionContractVersion, 2);
  const candidates = turn.checkpoints['opportunity-candidates'].candidates;
  const candidate = candidates.find((item) => item.target && item.target.key === key);
  assert.ok(candidate, 'requested target is present in the unchanged decision menu');
  assert.doesNotMatch(turn.generations[0].request.prompt, /PUBLIC WRITING:|REPLY TO THIS BRANCH:/,
    'public wording guidance does not enter candidate choice');
  return { scheduler, turn, candidate };
}

async function select(h, started) {
  completeJob(h.queue, started.turn.generations[0].jobId, JSON.stringify({
    choice: started.candidate.id, reason: 'This branch has a concrete question to answer.', votes: [],
  }));
  return queueContentGeneration({ scheduler: started.scheduler, turnStore: h.turnStore }, started.turn.id);
}

function checkGeneration(h, generation) {
  assert.equal(generation.request.model, h.profiles[0].model, 'writing preserves the selected model');
  assert.equal(generation.request.temperature, 0.63, 'writing preserves temperature');
  assert.equal(generation.request.numPredict, 237, 'writing preserves the output token allowance');
  assert.equal(generation.request.priority, 'normal', 'writing preserves ordinary queue priority');
  assert.match(generation.request.prompt, /40-70 words/);
  assert.ok(generation.request.prompt.includes(publicWriting.contentGuidance('comment')));
  assert.ok(generation.request.prompt.endsWith('\n\nYour reply:'));
}

async function newPosts() {
  for (const mode of ['capabilities', 'legacy']) {
    const profile = makeProfile('writing-post', false);
    profile.canVote = false;
    if (mode === 'legacy') {
      for (const key of ['canReply', 'canStartDiscussions', 'canShareLinks', 'canVote']) delete profile[key];
      profile.mode = 'post';
    }
    const h = harness({ profiles: [profile] });
    try {
      const runtime = h.scheduler();
      await runtime.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile(profile.id);
      assert.equal(turn.input.mode, mode);
      assert.equal(turn.input.publicWritingVersion, publicWriting.VERSION, 'new turns freeze latest writing even for old profile shapes');
      let generation = turn.generations[0];
      if (mode === 'capabilities') {
        completeJob(h.queue, generation.jobId, '{"choice":"C1","reason":"A fitting discussion.","votes":[]}');
        generation = await queueContentGeneration({ scheduler: runtime, turnStore: h.turnStore }, turn.id);
      }
      assert.ok(generation.request.prompt.includes(publicWriting.guidance('post')));
      assert.doesNotMatch(generation.request.prompt, /REPLY TO THIS BRANCH:/);
      assert.equal(generation.request.temperature, profile.temperature);
      assert.equal(generation.request.numPredict, profile.numPredict);
      assert.equal(generation.request.model, profile.model);
      const body = Array(90).fill('seedling').join(' ') + '. A natural ending.';
      completeJob(h.queue, generation.jobId, 'The greenhouse rota\n\n' + body);
      runtime.reconcileDurableTurns();
      await settle();
      assert.equal(h.turnStore.get(turn.id).status, 'completed');
      assert.equal(h.writes[0].request.text, body, 'soft post guidance never truncates generated public text');
    } finally { h.cleanup(); }
  }
}

async function ordinary() {
  for (const key of ['t3_73', 't1_101', 't1_103']) {
    const h = replyHarness({ feedPosts: [post] });
    // The ordinary menu offers its first eligible nearby comment; ancestors
    // remain available in the same fetched tree even when already handled.
    if (key === 't1_103') h.profiles[0].repliedTo = ['t1_101', 't1_102'];
    try {
      const started = await begin(h, key);
      assert.deepEqual(h.reads, [73], 'ordinary discovery reads each thread once');
      const generation = await select(h, started);
      checkGeneration(h, generation);
      assert.deepEqual(h.reads, [73], 'complete ordinary ancestry reuses the fetched tree');
      const prompt = generation.request.prompt;
      assert.doesNotMatch(prompt, /UNRELATED_SIBLING/);
      if (key === 't3_73') {
        assert.match(prompt, /POST YOU ARE REPLYING TO:/);
        assert.doesNotMatch(prompt, /IMMEDIATE PARENT YOU ARE REPLYING TO/);
      } else {
        const expected = key === 't1_103' ? target.body : root.body;
        assert.ok(prompt.endsWith(expected + '\n\nYour reply:'), 'the selected immediate parent remains last');
        if (key === 't1_103') {
          assert.ok(prompt.indexOf(root.body) < prompt.indexOf(middle.body));
          assert.ok(prompt.indexOf(middle.body) < prompt.indexOf(target.body));
        } else assert.doesNotMatch(prompt, /ANCESTOR BRANCH|parking permit|parking fee/);
      }
    } finally { h.cleanup(); }
  }
}

async function hydration() {
  for (const source of [attention, renewed]) {
    for (const complete of [false, true]) {
      const h = replyHarness();
      source(h, complete);
      try {
        const started = await begin(h, 't1_103');
        assert.deepEqual(h.reads, [], 'candidate inspection does not hydrate unselected branches');
        const generation = await select(h, started);
        checkGeneration(h, generation);
        assert.deepEqual(h.reads, complete ? [] : [73], 'only missing selected ancestry adds a read');
        assert.ok(generation.request.prompt.includes(root.body));
        assert.ok(generation.request.prompt.endsWith(target.body + '\n\nYour reply:'));
        const frozen = h.turnStore.get(started.turn.id).checkpoints['comment-writing-context'];
        assert.equal(frozen.replyBranch.complete, true);
        assert.equal(frozen.replyBranch.target.body, target.body);
        assert.equal(started.candidate.target.replyBranch.complete, complete,
          'writing hydration does not rewrite the decision snapshot');
        h.feddit.comments = async () => { throw new Error('Replay must use frozen context'); };
        const restarted = h.restartRuntime();
        restarted.scheduler.reconcileDurableTurns();
        await settle();
        const replay = restarted.turnStore.get(started.turn.id);
        assert.equal(JSON.stringify(replay.generations[1].request), JSON.stringify(generation.request));
        assert.equal(replay.generations[1].signature, generation.signature);
        assert.deepEqual(replay.checkpoints['comment-writing-context'], frozen);
        const text = Array(90).fill('cucumber').join(' ') + '. A natural ending.';
        completeJob(restarted.queue, generation.jobId, text);
        restarted.scheduler.reconcileDurableTurns();
        await settle();
        assert.equal(restarted.turnStore.get(started.turn.id).status, 'completed');
        assert.equal(h.writes.filter((write) => write.type === 'comment').length, 1);
        assert.equal(h.writes[0].request.parentCommentId, 103, 'publication still addresses the chosen parent');
        assert.equal(h.writes[0].request.text, text, 'soft comment guidance never truncates generated public text');
      } finally { h.cleanup(); }
    }
  }

  for (const source of [attention, renewed]) {
    const h = replyHarness();
    source(h);
    h.feddit.comments = async () => { h.reads.push(73); throw new Error('Fixture read unavailable'); };
    try {
      const started = await begin(h, 't1_103');
      const generation = await select(h, started);
      assert.match(generation.request.prompt, /earlier branch context is unavailable/);
      assert.ok(generation.request.prompt.endsWith(target.body + '\n\nYour reply:'));
      assert.deepEqual(h.reads, [73]);
      h.restartRuntime().scheduler.reconcileDurableTurns();
      await settle();
      assert.deepEqual(h.reads, [73], 'a failed optional read is also frozen without retries');
    } finally { h.cleanup(); }
  }
}

async function legacy() {
  for (const action of ['post', 'comment']) {
    let previous;
    for (const version of [undefined, 1]) {
      const h = replyHarness();
      attention(h);
      try {
        const input = { mode: 'legacy', action, decisionContractVersion: 1, continuationVersion: 1 };
        if (version !== undefined) input.publicWritingVersion = version;
        const turn = h.turnStore.create({ profileId: h.profiles[0].id, profile: h.profiles[0],
          rehearsal: false, trigger: 'scheduled', input }).turn;
        const runtime = h.scheduler();
        runtime.reconcileDurableTurns();
        await settle();
        const saved = h.turnStore.get(turn.id);
        assert.equal(saved.generations.length, 1);
        const generation = saved.generations[0];
        const context = 'POST in f/general\nTITLE: The garden rota\nPOST BODY: ' + post.selftext +
          '\nNEW COMMENT by carol: ' + target.body;
        const social = 'SOCIAL CONTEXT FROM YOUR OWN PRIOR PUBLIC INTERACTIONS: A little previous interaction with @carol. ' +
          'Treat this as limited evidence of familiarity, not proof of friendship or a requirement to continue.\n\n';
        const memory = 'RELEVANT AUTOBIOGRAPHICAL MEMORY FROM YOUR OWN PRIOR PUBLIC ACTIVITY: ' +
          'Past event: @carol addressed the bot in f/general: ' + context.replace(/\n/g, ' ') +
          ' Current preoccupation: brass, garden. Use it naturally only when helpful. Do not force a reference to it. ' +
          'Tentative public self-claims are not owner-authored canon, and the owner-written persona remains stronger.\n\n';
        const expected = action === 'post'
          ? 'You are posting a NEW thread to the sub-feddit "general" on a forum called Feddit.\n' +
            'Write an original short post in character. Respond with the post TITLE on the first line, then a ' +
            'blank line, then the body. No preamble, no markdown headings.'
          : 'You are browsing a forum called Feddit. Write a single in-character reply. ' +
            'Plain text, no preamble, no surrounding quotes.\n\n' + social + memory + context + '\n\nYour reply:';
        assert.equal(generation.request.prompt, expected, 'legacy writing preserves exact old task bytes');
        const signature = crypto.createHash('sha256').update(JSON.stringify({
          ...generation.request, prompt: expected,
        })).digest('hex');
        assert.equal(generation.signature, signature, 'legacy exact task preserves its signed request');
        if (previous) {
          assert.deepEqual(generation.request, previous.request, 'missing and explicit v1 requests match');
          assert.equal(generation.signature, previous.signature, 'missing and explicit v1 signatures match');
        }
        previous = generation;
        assert.deepEqual(h.reads, [], 'legacy writing never adds an ancestry read');
        assert.equal(saved.checkpoints['comment-writing-context'], undefined);
        const restarted = h.restartRuntime();
        completeJob(restarted.queue, generation.jobId, action === 'post' ? 'Old title\n\nOld body.' : 'Old reply.');
        restarted.scheduler.reconcileDurableTurns();
        await settle();
        assert.equal(restarted.turnStore.get(turn.id).status, 'completed');
        assert.equal(restarted.turnStore.get(turn.id).generations[0].signature, signature);
        assert.equal(h.writes.length, 1);
        assert.deepEqual(h.reads, []);
      } finally { h.cleanup(); }
    }
  }
}

async function memoryPresentation() {
  const h = replyHarness({ feedPosts: [post] });
  const oldProse = 'UNIQUE_OLD_PUBLIC_PROSE: The garden kettle sings three absurd verses instead of answering the cucumber question.';
  h.profiles[0].memoryState = memory.recordEvent(memory.defaults(), {
    id: 'past-garden', kind: 'reply', direction: 'outgoing', account: 'carol', threadKey: 't3_73',
    community: 'general', importance: 3, summary: oldProse, text: 'I hate garden.',
  }, { nowMs: h.now() }).state;
  h.profiles[0].repliedTo = ['t1_101', 't1_102'];
  try {
    const started = await begin(h, 't1_103');
    assert.match(started.turn.generations[0].request.prompt, /UNIQUE_OLD_PUBLIC_PROSE/,
      'candidate decision retains its existing full relevant memory');
    const generation = await select(h, started);
    assert.doesNotMatch(generation.request.prompt, /UNIQUE_OLD_PUBLIC_PROSE|Past event:/);
    assert.doesNotMatch(generation.request.prompt, /"kettle"|"sings"/,
      'same-thread memory does not introduce unmatched topic detours into public writing');
    assert.match(generation.request.prompt, /OPTIONAL REMEMBERED BACKGROUND/);
    assert.match(generation.request.prompt, /"polarity":"negative"/);
    assert.match(generation.request.prompt, /"status":"tentative"/);
    assert.match(generation.request.prompt, /Admiral Sprout now demands a parking permit/);
    assert.ok(generation.request.prompt.endsWith(target.body + '\n\nYour reply:'));
    const frozen = JSON.parse(JSON.stringify(generation.request));
    h.feddit.comments = async () => { throw new Error('No additional replay context fetch'); };
    const restarted = h.restartRuntime();
    restarted.scheduler.reconcileDurableTurns();
    await settle();
    assert.deepEqual(restarted.turnStore.get(started.turn.id).generations[1].request, frozen);
    completeJob(restarted.queue, generation.jobId, 'Admiral Sprout needs a permit, not a pickle sermon.');
    restarted.scheduler.reconcileDurableTurns();
    await settle();
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].request.parentCommentId, 103);
  } finally { h.cleanup(); }

  // Version 2 remains usable through restart, including its original quoted memory.
  const old = replyHarness();
  attention(old);
  try {
    const turn = old.turnStore.create({ profileId: old.profiles[0].id, profile: old.profiles[0],
      rehearsal: false, trigger: 'scheduled', input: { mode: 'legacy', action: 'comment',
        decisionContractVersion: 1, continuationVersion: 1, publicWritingVersion: 2 } }).turn;
    old.scheduler().reconcileDurableTurns();
    await settle();
    const generation = old.turnStore.get(turn.id).generations[0];
    assert.match(generation.request.prompt, /soft target, not a hard limit/);
    assert.match(generation.request.prompt, /RELEVANT AUTOBIOGRAPHICAL MEMORY/);
    assert.doesNotMatch(generation.request.prompt, /OPTIONAL REMEMBERED BACKGROUND|Default to one compact paragraph/);
    const restarted = old.restartRuntime();
    completeJob(restarted.queue, generation.jobId, 'A complete old-contract reply.');
    restarted.scheduler.reconcileDurableTurns();
    await settle();
    const saved = restarted.turnStore.get(turn.id);
    assert.equal(saved.status, 'completed');
    assert.equal(JSON.stringify(saved.generations[0].request), JSON.stringify(generation.request));
    assert.equal(saved.generations[0].signature, generation.signature);
  } finally { old.cleanup(); }
}

async function burstWriting() {
  const oldCandidate = { id: 'C1', action: 'comment', candidateType: 'renewed_thread',
    structuralReason: 'A new reply.', context: 'POST TITLE: A garden\nFRESH COMMENT: Keep the gate closed.',
    social: { summary: 'A familiar gardener.' }, memory: { prompt: 'The latch was repaired.' } };
  const oldVote = { id: 'V1', targetType: 'comment', targetId: 103, label: 'A reply', content: 'Close the gate.' };
  const oldPrompt = 'This is one accelerated Feddit session for one bot. Decide what is genuinely worth doing now. ' +
    'WAIT is normal. Return one JSON object only. You may choose zero to 3 ordered actions. ' +
    'Use each C-number at most once. For a comment action provide text. For a new discussion provide title and body. ' +
    'For an article provide an original in-character title that is not the publisher headline or a close paraphrase. ' +
    'Do not invent facts beyond the supplied context. Votes are independent secondary reactions and may be up, down or nil.\n\n' +
    'JSON shape: {"wait":false,"reason":"...","actions":[{"candidate":"C1","text":"...","reason":"..."},{"candidate":"C2","title":"...","body":"...","reason":"..."}],"votes":[{"id":"V1","direction":"up|down|nil","reason":"..."}]}\n\n' +
    'ACTION CANDIDATES:\nC1 [comment / renewed_thread]\nWHY IT IS HERE: A new reply.\n' +
    'POST TITLE: A garden\nFRESH COMMENT: Keep the gate closed.\nSOCIAL CONTEXT: A familiar gardener.\n' +
    'MEMORY: The latch was repaired.\n\nVOTE CANDIDATES:\nV1 [comment] A reply\nClose the gate.';
  assert.equal(burst.prompt([oldCandidate], [oldVote], { publicWritingVersion: 1 }), oldPrompt,
    'legacy Burst preserves exact old prompt, memory placement, action cap and vote wording');
  assert.equal(crypto.createHash('sha256').update(burst.prompt([oldCandidate], [oldVote],
    { publicWritingVersion: 2 })).digest('hex'),
  '623cd3ed476ffb20af11a798561795e38acc3db7b74bcebfe20b7c7de8adcbc3',
  'Burst v2 matches the exact historical builder at 831727c');
  const rawMemory = 'DO NOT REUSE THIS OLD ANSWER PROSE.';
  const typed = { ...oldCandidate, memory: { relevant: true, prompt: rawMemory, writingContext: {
    version: 1, claims: [], episodes: [{ kind: 'reply', direction: 'incoming', account: 'alice',
      community: 'general', topics: ['gate'] }], preoccupations: [] } } };
  const compact = burst.prompt([typed], [oldVote], { publicWritingVersion: 3 });
  assert.doesNotMatch(compact, /DO NOT REUSE THIS OLD ANSWER PROSE/);
  assert.match(compact, /OPTIONAL REMEMBERED BACKGROUND/);
  assert.match(compact, /zero to 3 ordered actions/);
  assert.match(compact, /Votes are independent secondary reactions/);
  assert.ok(compact.endsWith('V1 [comment] A reply\nClose the gate.'), 'offered vote evidence remains unchanged');

  for (const version of [undefined, 1, 2, 3]) {
    let calls = 0;
    const requests = [];
    const h = replyHarness({ providerGenerate: async (request) => {
      requests.push(structuredClone(request));
      if (++calls === 1) throw Object.assign(new Error('Fixture restart before the response'), { code: 'TURN_SUSPENDED' });
      return { text: JSON.stringify({ wait: true, reason: 'Nothing needs adding.', actions: [], votes: [] }),
        provider: 'claude-plan', model: 'sonnet', usage: { inputTokens: 10, outputTokens: 10 }, ms: 1 };
    } });
    renewed(h);
    const readRenewed = h.feddit.activeThreads;
    h.feddit.activeThreads = async () => {
      const response = await readRenewed();
      response.data.threads.push({ ...response.data.threads[0], event_id: 'active:t1_105',
        fresh_comment: { ...target, id: 105, body: 'Should the permit have a cucumber portrait?' } });
      return response;
    };
    h.feddit.comments = async (id) => {
      h.reads.push(id);
      const comments = structuredClone(tree);
      comments.data.children[0].data.replies.data.children[0].data.replies.data.children.push({
        data: { ...target, id: 105, body: 'Should the permit have a cucumber portrait?' },
      });
      return { ok: true, data: { comments } };
    };
    try {
      const input = { mode: 'burst', provider: 'claude-plan', decisionContractVersion: 2, continuationVersion: 2 };
      if (version !== undefined) input.publicWritingVersion = version;
      const turn = h.turnStore.create({ profileId: h.profiles[0].id, profile: h.profiles[0],
        rehearsal: false, trigger: 'burst', input }).turn;
      h.scheduler().reconcileDurableTurns();
      await settle();
      assert.equal(calls, 1);
      const snapshot = h.turnStore.get(turn.id).checkpoints['burst-candidates'];
      assert.equal(snapshot.candidates.length, 2);
      if (version >= 2) {
        assert.deepEqual(h.reads, [73], 'Burst shares one ancestry read across candidates in the same thread');
        assert.ok(requests[0].prompt.includes(publicWriting.contentGuidance('comment', version)));
        assert.ok(requests[0].prompt.includes(root.body));
        assert.ok(requests[0].prompt.includes(target.body));
        assert.doesNotMatch(requests[0].prompt, /UNRELATED_SIBLING/);
        assert.equal(snapshot.candidates[0].target.replyBranch.complete, false,
          'Burst candidate-choice and voting snapshot remain unchanged');
      } else {
        assert.deepEqual(h.reads, [], 'legacy Burst adds no ancestry read');
        assert.equal(h.turnStore.get(turn.id).checkpoints['burst-writing-context'], undefined);
        assert.equal(requests[0].prompt, burst.prompt(snapshot.candidates, snapshot.voteCandidates,
          { publicWritingVersion: 1 }));
        assert.doesNotMatch(requests[0].prompt, /PUBLIC WRITING:|IMMEDIATE PARENT YOU ARE REPLYING TO/);
      }
      assert.equal(requests[0].providerOverride, 'claude-plan');
      assert.equal(requests[0].priority, 'interactive');
      assert.equal(requests[0].numPredict, 1200);
      assert.equal(requests[0].temperature, 0.63);
      h.feddit.comments = async () => { throw new Error('Burst replay must use frozen context'); };
      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      assert.equal(calls, 2);
      assert.deepEqual(requests[1], requests[0], 'Burst context stays byte-stable over restart');
      assert.equal(restarted.turnStore.get(turn.id).status, 'completed');
      assert.equal(restarted.turnStore.get(turn.id).result.waited, true, 'WAIT still completes without actions');
      assert.deepEqual(h.writes, []);
    } finally { h.cleanup(); }
  }

  const h = replyHarness({ providerGenerate: async (request) => {
    assert.match(request.prompt, /earlier branch context is unavailable/);
    assert.ok(request.prompt.includes(target.body));
    return { text: '{"wait":true,"reason":"Wait.","actions":[],"votes":[]}',
      usage: { inputTokens: 10, outputTokens: 10 }, model: 'sonnet', ms: 1 };
  } });
  renewed(h);
  h.feddit.comments = async () => { throw new Error('Fixture Burst ancestry unavailable'); };
  try {
    const started = h.scheduler().startBurstSession(h.profiles[0].id, 'claude-plan');
    await settle();
    assert.equal(h.turnStore.get(started.turnId).status, 'completed', 'Burst read failure preserves usable known context');
    assert.deepEqual(h.writes, []);
  } finally { h.cleanup(); }
}

(async () => {
  await newPosts();
  await ordinary();
  await hydration();
  await legacy();
  await memoryPresentation();
  await burstWriting();
  console.log('writing-integration: ordinary branch reuse, selected hydration, frozen replay, legacy compatibility and Burst checks passed');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
