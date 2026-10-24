'use strict';

const assert = require('node:assert/strict');
const theme = require('../lib/theme-interest');
const candidates = require('../lib/action-candidates');

let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejects(fn, code, message) { assert.throws(fn, (error) => error.code === code, message); checks++; }

const base = 1_800_000_000_000;
const hour = 60 * 60 * 1000;
const text = 'zircon lanterns orbit slowly; zircon lanterns orbit slowly.';
const subject = { community: 'fixture_sector', threadKey: 't3_42', text };
function receipt(id, options = {}) {
  return { id: 'receipt-' + id, at: base, kind: 'exposure', sourceKey: 't1_' + (id + 1),
    threadKey: 't3_42', community: 'fixture_sector', author: 'actor_' + id,
    features: theme.features(text), ...options };
}
function view(state, at = base, target = subject) { return theme.describe(state, target, { at }); }
function batches(events) {
  let state = theme.normalize();
  for (let i = 0; i < events.length; i += 32) state = theme.record(state, events.slice(i, i + 32));
  return state;
}

eq(theme.VERSION, 1, 'the contract is explicitly versioned');
eq(theme.version(undefined), 0, 'absent turn contracts retain legacy behavior');
eq(theme.version(null, 1), 1, 'an explicit fallback can select the new contract');
eq(theme.version(1), 1, 'version one is recognized');
rejects(() => theme.version(2), 'UNSUPPORTED_THEME_INTEREST', 'unknown turn contracts fail closed');
rejects(() => theme.version('1'), 'UNSUPPORTED_THEME_INTEREST', 'string versions are not silently coerced');
eq(theme.normalize(), { version: 1, events: [], floorAt: 0 }, 'absent state is empty rather than fabricated history');
eq(view(null).known, false, 'a new bot has no invented theme familiarity');
eq(view(null).summary, '', 'unknown themes have no hint');
eq(view(null).interest, 0, 'unknown themes receive no interest assertion');
eq(theme.features(text), theme.features(text), 'lexical features are deterministic');
ok(theme.features(text).length > 0 && theme.features(text).length <= 3, 'feature count is bounded');
ok(theme.features(text).every((pair) => pair.length === 2), 'each feature requires co-occurring terms');
eq(theme.features('post body comment https://example.invalid/zircon/lanterns @secret_actor'), [], 'metadata labels, URLs and usernames are not topics');
eq(theme.features('<script>zircon lanterns</script><style>secret metadata</style><img title="zircon lanterns">'), [], 'HTML metadata and executable blocks do not become themes');
eq(theme.features('<img title="zircon lanterns' + 'x'.repeat(1300)), [], 'an input-boundary cut through HTML attributes cannot expose metadata');
eq(theme.features('<script>zircon lanterns' + 'x'.repeat(1300)), [], 'an input-boundary cut through script text cannot expose script terms');
eq(theme.features('zircon zircon zircon'), [], 'one recurring word cannot fabricate a two-term feature');
eq(theme.features('x'.repeat(1200) + ' zircon lanterns'), [], 'text after the input bound is not observed');
eq(theme.features('&nbsp; &#123; &#xabc;'), [], 'HTML entity names are not themes');

const firstInput = receipt(1);
const firstSnapshot = JSON.stringify(firstInput);
const first = theme.record(undefined, [firstInput]);
const one = view(first);
ok(one.known && one.familiarity > 0 && one.interest > 0, 'an independent encounter builds limited positive familiarity');
eq(one.independentSources, 1, 'one encountered public source is counted once');
eq(one.independentAuthors, 1, 'one public author is counted once');
eq(one.uses, 0, 'exposure does not fabricate participation');
const several = theme.record(first, [receipt(2), receipt(3)]);
const many = view(several);
ok(many.familiarity > one.familiarity, 'new independent public sources raise familiarity');
eq(many.independentAuthors, 3, 'independent authors remain visible as evidence');
eq(view(null).known, false, 'another bot with its own empty state remains unfamiliar');
eq(JSON.stringify(firstInput), firstSnapshot, 'recording never mutates a supplied receipt');
eq(first.events.length, 1, 'a prior bot state is not mutated by later recording');
eq(theme.record(first, [firstInput]), first, 'the same frozen receipt is idempotent');
eq(theme.record(JSON.parse(JSON.stringify(first)), [firstInput]), first, 'restart/replay retains idempotence');

const repeated = theme.record(several, Array.from({ length: 20 }, (_, i) => receipt(20 + i, {
  at: base + i + 1, kind: 'participation', author: 'self_actor',
})));
const full = view(repeated, base + 100);
ok(full.satiation > many.satiation, 'repeated own use produces greater satiation');
ok(full.interest < many.interest && full.interest < 0, 'use can lower interest without removing a choice');
ok(full.interest >= -1 && full.interest <= 1 && full.satiation <= 1 && full.familiarity <= 1, 'all scalars remain bounded');
ok(!('eligible' in full) && !('blocked' in full) && !('priority' in full), 'the evidence does not become an eligibility or queue rule');
const cool = view(repeated, base + 5 * 24 * hour);
ok(cool.satiation < full.satiation && cool.interest > full.interest, 'time away restores novelty rather than permanently banning a motif');
eq(view(repeated, base + 8 * 24 * hour).known, false, 'seven-day evidence expires');
const revived = theme.record(repeated, [receipt(80, { at: base + 8 * 24 * hour })]);
ok(view(revived, base + 8 * 24 * hour).interest > 0, 'a new independent encounter after absence can revive interest');
ok(many.interest > one.interest && full.interest < 0 && cool.interest > full.interest &&
  view(revived, base + 8 * 24 * hour).interest > cool.interest,
  'the numerical trajectory rises with independent encounters, falls with use, fades and revives');
eq(revived.events.length, 1, 'new activity prunes expired evidence without retaining unlimited history');

const repeats = theme.record(first, Array.from({ length: 12 }, (_, i) => receipt(100 + i, { sourceKey: firstInput.sourceKey, author: firstInput.author })));
eq(view(repeats).independentSources, 1, 'repeated sightings are not independent sources');
eq(view(repeats).independentAuthors, 1, 'repeated sightings are not independent authors');
eq(view(repeats).familiarity, one.familiarity, 'repeated identical sources do not inflate familiarity');
ok(view(repeats).satiation > one.satiation && view(repeats).satiation < full.satiation, 'repeated exposure is mild compared with own participation');
eq(view(first, base, { ...subject, text: 'cobalt badgers inspect velvet' }).known, false, 'unrelated text in the same busy thread has no fabricated theme');
eq(view(repeated, base + 100, { ...subject, text: 'cobalt badgers inspect velvet' }).interest, 0, 'a popular thread does not suppress all new material');
const paraphrase = { ...subject, text: 'crystalline beacons circle gently' };
eq(view(repeated, base + 100, paraphrase).known, false, 'different wording in the same busy thread does not fabricate semantic theme identity');
const freshMaterial = theme.record(repeated, [receipt(201, { at: base + 100, features: theme.features(paraphrase.text) })]);
ok(view(freshMaterial, base + 100, paraphrase).interest > 0, 'new material retains positive first-encounter evidence despite much own use in that thread');
eq(view(first, base, { ...subject, community: 'different_sector' }).known, false, 'lexical evidence is community scoped');
eq(view(first, base - 1).known, false, 'future receipts are never used');
ok(one.summary.length <= theme.LIMITS.hintChars, 'hints respect the strict character bound');
ok(!theme.features(text).flat().some((term) => one.summary.includes(term)), 'hints do not suggest extracted theme keywords');
const collision = theme.record(null, [receipt(200, { features: theme.features('lexical familiarity established') })]);
eq(view(collision, base, { ...subject, text: 'lexical familiarity established' }).summary, '', 'generic hint labels cannot leak a coincident theme either');

const menu = candidates.bound({ ordinary: [{ key: 'public', action: 'comment', candidateType: 'ordinary_post', context: text }] });
const wait = candidates.publicDecision(candidates.parseDecision('{"choice":"WAIT","reason":"I have nothing useful to add."}', menu), menu);
eq(wait.outcome, 'wait', 'existing WAIT remains valid even when evidence describes repeated use');

const packed = batches(Array.from({ length: 140 }, (_, i) => receipt(300 + i, { at: base + i })));
eq(packed.events.length, 96, 'the bot-local event ledger remains bounded at 96');
eq(packed.floorAt, base + 43, 'eviction advances a monotonic timestamp watermark');
eq(theme.record(packed, [receipt(300, { at: base })]), packed, 'replaying an evicted receipt cannot resurrect its count');
eq(theme.record(packed, [receipt(900, { at: packed.floorAt })]), packed, 'unseen equal-time old receipts conservatively undercount rather than resurrect');
const tied = batches(Array.from({ length: 110 }, (_, i) => receipt(1000 + i)));
eq(theme.record(tied, [receipt(1000)]), tied, 'same-timestamp eviction remains replay safe');
eq(theme.normalize(JSON.parse(JSON.stringify(packed))), packed, 'bounded state survives JSON restart exactly');
eq(theme.record(packed, []).floorAt, packed.floorAt, 'normalization never resets the eviction fence');
ok(!JSON.stringify(packed).includes('text') && !JSON.stringify(packed).includes('persona'), 'state contains no raw prose or persona fields');

const badStates = [false, [], {}, { version: 2, floorAt: 0, events: [] },
  { version: 1, floorAt: -1, events: [] }, { version: 1, floorAt: 0, events: {} },
  { version: 1, floorAt: 0, events: Array(97).fill(firstInput) },
  { version: 1, floorAt: 0, events: [firstInput, firstInput] },
  { version: 1, floorAt: base + 1, events: [firstInput] },
  { ...first, rawBody: 'must not persist' }];
for (const raw of badStates) rejects(() => theme.normalize(raw), 'THEME_INTEREST_BOOKKEEPING_PENDING', 'corrupt or unknown state fails closed');
const badEvents = [receipt(1, { at: NaN }), receipt(1, { at: 1.5 }), receipt(1, { at: 0 }),
  receipt(1, { sourceKey: 't3_0' }), receipt(1, { threadKey: 't1_1' }),
  receipt(1, { sourceKey: 't3_' + '1'.repeat(10000) }), receipt(1, { threadKey: 't3_9007199254740992' }),
  receipt(1, { community: 'unsafe/slash' }), receipt(1, { author: 'unsafe username' }),
  receipt(1, { features: [['zircon', 'zircon']] }), receipt(1, { features: [['x', 'lanterns']] }),
  receipt(1, { kind: 'invented' }), { ...firstInput, body: 'private body' },
  receipt(1, { features: [['zircon', 'lanterns'], ['lanterns', 'zircon']] })];
for (const raw of badEvents) rejects(() => theme.record(null, [raw]), 'THEME_INTEREST_BOOKKEEPING_PENDING', 'invalid receipts fail closed');
rejects(() => theme.record(first, [receipt(1, { at: base + 1 })]), 'THEME_INTEREST_BOOKKEEPING_PENDING', 'a conflicting replay cannot rewrite frozen time');
rejects(() => theme.describe(first, subject, {}), 'THEME_INTEREST_BOOKKEEPING_PENDING', 'evaluation cannot invent a wall-clock time');
rejects(() => theme.record(first, null), 'THEME_INTEREST_BOOKKEEPING_PENDING', 'an invalid batch cannot silently discard work');
rejects(() => theme.record(first, Array.from({ length: 33 }, (_, i) => receipt(2000 + i))),
  'THEME_INTEREST_BOOKKEEPING_PENDING', 'receipt batches beyond the bounded decision menu fail closed');
eq(JSON.stringify(firstInput), firstSnapshot, 'all validation and descriptions preserve the original source');

const rehearsalKey = 'r3_' + 'a'.repeat(64);
const privateUse = receipt(3000, { kind: 'participation', sourceKey: rehearsalKey, threadKey: rehearsalKey });
const rehearsal = theme.record(null, [privateUse]);
eq(rehearsal.events[0].sourceKey, rehearsalKey, 'a private rehearsal publication retains its explicit non-public identity');
eq(view(rehearsal).uses, 1, 'a private rehearsal publication can record this bot own lexical use');
eq(view(rehearsal).independentSources, 0, 'private own use never fabricates an independent public encounter');
eq(theme.record(JSON.parse(JSON.stringify(rehearsal)), [privateUse]), rehearsal, 'private rehearsal receipts remain restart-idempotent');
for (const invalid of [
  { ...privateUse, kind: 'exposure' },
  { ...privateUse, threadKey: 't3_42' },
  { ...privateUse, sourceKey: 't3_42' },
  { ...privateUse, threadKey: 'r3_' + 'b'.repeat(64) },
  { ...privateUse, sourceKey: 'r3_' + 'x'.repeat(64) },
  { ...privateUse, sourceKey: 'r3_' + 'a'.repeat(65) },
]) rejects(() => theme.record(null, [invalid]), 'THEME_INTEREST_BOOKKEEPING_PENDING',
  'private rehearsal IDs cannot be exposure receipts or mixed with public/different thread identities');

console.log('theme-interest: ' + checks + ' checks passed');
