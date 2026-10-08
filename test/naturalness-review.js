'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReviewer, buildPacket, parseResult, LIMITS } = require('../lib/naturalness-review');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-naturalness-review-'));
const now = () => Date.parse('2026-10-08T12:00:00Z');
const ecology = { window: { since: '2026-10-07T12:00:00Z', until: '2026-10-08T12:00:00Z', hours: 24 },
  coverage: { sampleOnly: true, acceptedItems: 12, source: { available: true, fetchedPosts: 8 }, warnings: ['Small sample'] },
  overview: { posts: 8, comments: 4, lengths: { posts: { count: 8, mean: 90 } } },
  examples: [{ key: 'post:1', author: 'public_bot', community: 'garden', title: 'Planting advice', excerpt: 'Try compost.', path: '/f/garden/comments/1' }],
  anomalies: [{ code: 'short-sample', label: 'Short sample', minimumSample: 10, sampleSize: 12, value: 0.8 }] };
const subscription = { id: 'chatgpt-plan', state: 'ready', label: 'ChatGPT plan', creator: { eligible: true, autoPreferred: true, preference: 300 }, models: [{ id: 'account-model' }] };
const claude = { id: 'claude-plan', state: 'ready', label: 'Claude subscription', creator: { eligible: true, autoPreferred: true, preference: 290, preferredModels: ['opus', 'sonnet'] }, models: [{ id: 'sonnet' }, { id: 'opus' }] };
function answer(packet, extra = {}) {
  const evidenceIds = packet.evidence.length ? [packet.evidence[0].id] : [];
  return { patterns: evidenceIds.length ? [{ observedFact: 'This bounded sample contains a pattern.', inference: 'The observed pattern may recur.',
    hypothesis: 'Shared exposure may contribute.', confidence: 'low', alternatives: ['Sampling effects'], needsMoreObservation: true, evidenceIds,
    thinking: 'PRIVATE_THINKING', prompt: 'PRIVATE_PROMPT' }] : [],
  proposal: { problem: 'Coverage is limited.', hypothesis: 'More observations may clarify the pattern.', smallestChange: 'Observe one additional day.',
    expectedEffect: 'A larger sample.', risks: ['The additional sample may remain small.'], measurements: ['Compare the same diagnostic next day.'],
    rollback: 'Stop additional observation.', changes: { scheduler: false, prompt: false, ecologyPolicy: false, exposure: false, socialState: false, persona: false }, evidenceIds,
    raw: 'PRIVATE_RAW' }, thinking: 'PRIVATE_COT', ...extra };
}
function packetFrom(request) { return JSON.parse(request.prompt.split('EVIDENCE: ')[1]); }
function generated(request) { return { text: JSON.stringify(answer(packetFrom(request))), thinking: 'PRIVATE_REASONING' }; }
function options(name, extra = {}) { return { file: path.join(temporary, name + '.json'), providerStatuses: async () => [subscription], generate: async request => generated(request), now, ...extra }; }
let count = 0;
async function test(name, run) { await run(); count++; console.log('PASS ' + name); }

(async () => {
  try {
    await test('construction, status, history and reload never generate automatically', async () => {
      let calls = 0;
      const config = options('manual', { generate: async request => { calls++; return generated(request); } });
      const reviewer = createReviewer(config);
      assert.equal((await reviewer.status()).available, true);
      assert.deepEqual(reviewer.list('owner-a'), []);
      assert.equal(calls, 0);
      assert.equal((await reviewer.review({ scope: 'owner-a', ecology })).status, 'completed');
      createReviewer(config).list('owner-a');
      assert.equal(calls, 1);
    });
    await test('AUTO follows connected subscription metadata, never API/runtime fallback', async () => {
      const api = { ...subscription, id: 'deepseek', creator: { eligible: true, autoPreferred: true, preference: 999 }, models: [{ id: 'deepseek-v4-pro' }] };
      const local = { ...api, id: 'ollama', models: [{ id: 'qwen' }] };
      const dell = { ...api, id: 'dell' };
      const disconnected = { ...subscription, state: 'auth_required' };
      let calls = 0;
      const noProvider = createReviewer(options('unavailable', { providerStatuses: async () => [api, local, dell, disconnected], generate: async () => { calls++; } }));
      assert.equal((await noProvider.status()).available, false);
      await assert.rejects(noProvider.review({ scope: 'owner-a', ecology }), { code: 'UNAVAILABLE' });
      assert.equal(calls, 0);
      let request;
      const reviewer = createReviewer(options('selected', { providerStatuses: async () => [api, disconnected, claude], generate: async value => { request = value; return generated(value); } }));
      const completed = await reviewer.review({ scope: 'owner-a', ecology });
      assert.equal(completed.provider, 'claude-plan');
      assert.equal(completed.model, 'opus');
      assert.equal(request.provider, 'claude-plan');
      assert.equal(request.numPredict, 2400);
      assert.equal(request.requestKind, 'naturalness-review');
      assert.ok(request.signal instanceof AbortSignal);
      assert.match(request.prompt, /untrusted data/);
    });
    await test('packet has stable evidence IDs, strict public allowlist, redaction and byte bounds', () => {
      const polluted = { ...ecology, profiles: ['PRIVATE_PROFILE'], prompt: 'PRIVATE_PROMPT', memory: 'PRIVATE_MEMORY',
        coverage: { ...ecology.coverage, source: { ...ecology.coverage.source, credential: 'PRIVATE_CREDENTIAL' } },
        overview: { posts: 8, memory: 999, private: { posts: 999 } },
        examples: Array.from({ length: 1000 }, (_, n) => ({ ...ecology.examples[0], key: 'post:' + (n + 1),
          excerpt: 'Bearer PRIVATE_BEARER token=PRIVATE_TOKEN someone@example.com ' + 'x'.repeat(10000), persona: 'PRIVATE_PERSONA' })) };
      const votes = { window: ecology.window, items: [{ key: 'post:1', up: 3, down: 2, total: 5,
        votes: [{ actorType: 'human', bot: 'PRIVATE_HUMAN', direction: 'up', reason: 'PRIVATE_HUMAN_REASON' },
          { actorType: 'bot', bot: 'voter', direction: 'down', reason: 'Not convincing api_key=PRIVATE_API' }] }] };
      const packet = buildPacket(polluted, votes);
      assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= LIMITS.packetBytes);
      assert.ok(packet.evidence.length <= LIMITS.evidence);
      assert.equal(packet.truncated, true);
      assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_|someone@example|"memory"/);
      assert.match(JSON.stringify(packet), /redacted/);
      assert.deepEqual(packet, buildPacket(polluted, votes));
      const original = buildPacket(ecology);
      const reordered = buildPacket({ ...ecology, examples: [...ecology.examples].reverse() });
      assert.deepEqual(original.evidence.map(row => row.id).sort(), reordered.evidence.map(row => row.id).sort());
    });
    await test('structured results strip unknown fields and reasoning, reject unsupported references and shape', () => {
      const packet = buildPacket(ecology);
      const result = parseResult(JSON.stringify(answer(packet)), packet);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|thinking|raw|prompt":"/);
      for (const change of [raw => { raw.patterns[0].evidenceIds = ['E-invented']; }, raw => { raw.proposal.changes.scheduler = 'yes'; },
        raw => { raw.patterns[0].observedFact = '<think>private reasoning</think>'; }, raw => { raw.patterns = Array(8).fill(raw.patterns[0]); },
        raw => { raw.proposal = [raw.proposal]; }]) {
        const raw = answer(packet); change(raw);
        assert.throws(() => parseResult(JSON.stringify(raw), packet), { code: 'INVALID_RESPONSE' });
      }
      assert.throws(() => parseResult('x'.repeat(LIMITS.outputBytes + 1), packet), { code: 'INVALID_RESPONSE' });
      assert.throws(() => parseResult('thinking... ' + JSON.stringify(answer(packet)), packet), { code: 'INVALID_RESPONSE' });
      const empty = buildPacket({});
      assert.deepEqual(parseResult(JSON.stringify(answer(empty)), empty).patterns, []);
    });
    await test('packet preserves invalid and missing decisions separately from explicit nil', () => {
      const packet = buildPacket({ ...ecology, voting: { live: { offered: 245, explicitConsidered: 37, explicitNil: 5,
        parserDefaultNil: 23, invalid: 185, decisionUnavailable: 0, nilShare: { numerator: 5, denominator: 37, ratio: 5 / 37 } } } });
      const values = Object.fromEntries(packet.evidence.filter(row => row.kind === 'diagnostics').flatMap(row => row.data.values.map(item => [item.name, item.value])));
      assert.equal(values['voting.live.invalid'], 185);
      assert.equal(values['voting.live.parserDefaultNil'], 23);
      assert.equal(values['voting.live.explicitNil'], 5);
      assert.equal(values['voting.live.nilShare.denominator'], 37);
    });
    await test('ecology and phase-1 observer voting retain distinct dimensions and windows', async () => {
      const input = { ...ecology, window: { ...ecology.window, hours: 33.57 }, voting: { live: { offered: 10 }, rehearsal: { offered: 3 } } };
      const votingSnapshot = { window: ecology.window, overview: { local: { offered: 7 }, rehearsal: { offered: 2 } } };
      const packet = buildPacket(input, votingSnapshot);
      const dimensions = Object.fromEntries(packet.evidence.filter(row => row.kind === 'diagnostics').map(row => [row.data.dimension, row.data.values]));
      assert.equal(packet.window.hours, 33.57);
      assert.equal(packet.votingWindow.hours, 24);
      assert.equal(dimensions['voting.live'][0].value, 10);
      assert.equal(dimensions['voting.observerLive'][0].value, 7);
      assert.equal(dimensions['voting.rehearsal'][0].value, 3);
      assert.equal(dimensions['voting.observerRehearsal'][0].value, 2);
      const config = options('observer-dimensions');
      const record = await createReviewer(config).review({ scope: 'owner-a', ecology: input, votingSnapshot });
      assert.deepEqual(createReviewer(config).list('owner-a')[0], record);
    });
    await test('balanced diagnostic groups retain public bot, timing, community and lexical evidence across reload', async () => {
      const { buildEcology } = require('../lib/naturalness-ecology-metrics');
      const items = Array.from({ length: 30 }, (_, n) => ({ key: (n ? 'comment:' : 'post:') + (n + 1), type: n ? 'comment' : 'post', id: n + 1, postId: 1,
        parentKey: n ? 'post:1' : null, author: 'public_bot_' + (n % 3), community: 'garden', createdAt: new Date(now() - (60 - n) * 60000).toISOString(),
        title: 'Garden observations', text: 'This shared repeated phrase has several useful words and a garden example.', kind: 'text' }));
      const actual = buildEcology({ items, now: now(), since: now() - 86400000, until: now() });
      actual.communityContext = [{ name: 'garden', description: 'Public gardening discussion', rules: 'Stay on topic.', private: 'PRIVATE_RULES' }];
      const config = options('balanced');
      const record = await createReviewer(config).review({ scope: 'owner-a', ecology: actual });
      const kinds = record.packet.evidence.map(row => row.kind);
      for (const kind of ['diagnostics', 'hourUtc', 'botSummary', 'community', 'repeatedPhrase', 'languageSummary', 'example']) assert.ok(kinds.includes(kind), kind);
      assert.ok(record.packet.evidence.filter(row => row.kind === 'diagnostics').some(row => row.data.dimension === 'timing'));
      assert.doesNotMatch(JSON.stringify(record), /PRIVATE_RULES/);
      const restarted = createReviewer(config);
      assert.equal((await restarted.status()).available, true);
      assert.deepEqual(restarted.list('owner-a')[0], record);
    });
    await test('pending is durable before invocation; completion records provenance without raw output', async () => {
      const config = options('durable');
      config.generate = async request => {
        const saved = JSON.parse(fs.readFileSync(config.file, 'utf8'));
        assert.equal(saved.reviews[0].status, 'pending');
        assert.equal(saved.reviews[0].packetHash, crypto.createHash('sha256').update(JSON.stringify(saved.reviews[0].packet)).digest('hex'));
        return generated(request);
      };
      const record = await createReviewer(config).review({ scope: 'owner-a', ecology });
      assert.equal(record.status, 'completed');
      assert.equal(record.createdAt, new Date(now()).toISOString());
      assert.equal(record.completedAt, record.createdAt);
      assert.doesNotMatch(fs.readFileSync(config.file, 'utf8'), /PRIVATE_|system|numPredict/);
      assert.equal(fs.readdirSync(temporary).some(name => name.endsWith('.tmp')), false);
    });
    await test('owner history is isolated, required scope cannot leak, and returned records are copies', async () => {
      const reviewer = createReviewer(options('owners'));
      const a = await reviewer.review({ scope: 'owner-a', ecology });
      const b = await reviewer.review({ scope: 'owner-b', ecology });
      assert.deepEqual(reviewer.list('owner-a').map(row => row.id), [a.id]);
      assert.deepEqual(reviewer.list('owner-b').map(row => row.id), [b.id]);
      assert.deepEqual(reviewer.list('owner-c'), []);
      assert.throws(() => reviewer.list(), { code: 'INVALID_SCOPE' });
      reviewer.list('owner-a')[0].packet.evidence.length = 0;
      assert.ok(reviewer.list('owner-a')[0].packet.evidence.length);
      assert.doesNotMatch(JSON.stringify(a.packet), /owner-a/);
    });
    await test('restart interrupts pending work and does not replay generation', async () => {
      let resolve;
      const config = options('restart', { generate: () => new Promise(done => { resolve = done; }) });
      const running = createReviewer(config).review({ scope: 'owner-a', ecology });
      await new Promise(done => setImmediate(done));
      const restarted = createReviewer({ ...config, generate: () => { throw new Error('must not replay'); } });
      assert.equal(restarted.list('owner-a')[0].status, 'interrupted');
      assert.equal(JSON.parse(fs.readFileSync(config.file)).reviews[0].status, 'interrupted');
      resolve({ text: JSON.stringify(answer(buildPacket(ecology))) });
      await running;
    });
    await test('exclusive in-flight scope begins before asynchronous provider selection', async () => {
      let release;
      let calls = 0;
      const reviewer = createReviewer(options('concurrent', { providerStatuses: () => new Promise(done => { release = done; }),
        generate: async request => { calls++; return generated(request); } }));
      const running = reviewer.review({ scope: 'owner-a', ecology });
      await assert.rejects(reviewer.review({ scope: 'owner-a', ecology }), { code: 'BUSY' });
      release([subscription]);
      await running;
      assert.equal(calls, 1);
    });
    await test('provider failures are persisted with safe messages and no retries or fallback', async () => {
      let calls = 0;
      const reviewer = createReviewer(options('failed', { generate: async () => { calls++; throw new Error('token=PRIVATE_TOKEN raw PRIVATE_RAW'); } }));
      const record = await reviewer.review({ scope: 'owner-a', ecology });
      assert.equal(record.status, 'failed');
      assert.equal(record.error.code, 'GENERATION_FAILED');
      assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(record), /PRIVATE_/);
      assert.equal(createReviewer(options('failed')).list('owner-a')[0].status, 'failed');
    });
    await test('bounded timeout aborts and preserves exclusivity until ignored cancellation settles', async () => {
      let release;
      let signal;
      const reviewer = createReviewer(options('timeout', { timeoutMs: 5, generate: request => { signal = request.signal; return new Promise(done => { release = done; }); } }));
      const record = await reviewer.review({ scope: 'owner-a', ecology });
      assert.equal(record.error.code, 'TIMEOUT');
      assert.equal(signal.aborted, true);
      await assert.rejects(reviewer.review({ scope: 'owner-a', ecology }), { code: 'BUSY' });
      release(generated({ prompt: 'EVIDENCE: ' + JSON.stringify(buildPacket(ecology)) }));
      await new Promise(done => setImmediate(done));
      assert.equal(reviewer.list('owner-a')[0].status, 'failed', 'late reply cannot overwrite timeout');
    });
    await test('history is bounded globally and survives restart', async () => {
      const config = options('retained');
      const reviewer = createReviewer(config);
      for (let n = 0; n < 23; n++) await reviewer.review({ scope: n % 2 ? 'owner-a' : 'owner-b', ecology });
      const saved = JSON.parse(fs.readFileSync(config.file));
      assert.equal(saved.reviews.length, LIMITS.history);
      const restarted = createReviewer(config);
      assert.equal(restarted.list('owner-a').length + restarted.list('owner-b').length, LIMITS.history);
    });
    await test('reloaded packets reject unknown private fields even when their hash was recomputed', async () => {
      const config = options('tampered');
      await createReviewer(config).review({ scope: 'owner-a', ecology });
      const saved = JSON.parse(fs.readFileSync(config.file));
      saved.reviews[0].packet.privatePrompt = 'PRIVATE_PROMPT';
      saved.reviews[0].packetHash = crypto.createHash('sha256').update(JSON.stringify(saved.reviews[0].packet)).digest('hex');
      fs.writeFileSync(config.file, JSON.stringify(saved));
      const restarted = createReviewer(config);
      assert.equal((await restarted.status()).available, false);
      assert.deepEqual(restarted.list('owner-a'), []);
    });
    await test('malformed generation persists a safe failed record and drops raw output', async () => {
      const config = options('malformed', { generate: async () => ({ text: 'PRIVATE_OUTPUT <think>PRIVATE_THINKING</think>' }) });
      const record = await createReviewer(config).review({ scope: 'owner-a', ecology });
      assert.equal(record.status, 'failed');
      assert.equal(record.error.code, 'INVALID_RESPONSE');
      assert.doesNotMatch(fs.readFileSync(config.file, 'utf8'), /PRIVATE_/);
    });
    await test('corrupt history and unavailable persistence fail closed before any provider invocation', async () => {
      const config = options('corrupt', { generate: () => { throw new Error('must not generate'); } });
      fs.writeFileSync(config.file, '{corrupt');
      const reviewer = createReviewer(config);
      assert.equal((await reviewer.status()).available, false);
      await assert.rejects(reviewer.review({ scope: 'owner-a', ecology }), { code: 'STORAGE' });
      assert.equal(fs.readFileSync(config.file, 'utf8'), '{corrupt');
      const noFile = createReviewer({ providerStatuses: async () => [subscription], generate: config.generate });
      await assert.rejects(noFile.review({ scope: 'owner-a', ecology }), { code: 'STORAGE' });
      const blocker = path.join(temporary, 'not-a-directory');
      fs.writeFileSync(blocker, 'sentinel');
      await assert.rejects(createReviewer({ ...config, file: path.join(blocker, 'review.json') }).review({ scope: 'owner-a', ecology }), { code: 'STORAGE' });
      assert.equal(fs.readFileSync(blocker, 'utf8'), 'sentinel');
    });
    console.log('naturalness-review: ' + count + ' checks passed');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
