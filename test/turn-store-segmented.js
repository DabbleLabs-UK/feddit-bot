'use strict';

// Offline fixtures only: no live store, registration, inference or publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTurnStore, TERMINAL_RETENTION_MS, TERMINAL_CAP } = require('../lib/turn-store');

let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }
function throws(fn, pattern, message) { assert.throws(fn, pattern, message); checks++; }
const MARKER_PREFIX = 'FEDDIT_TURN_STORE_V2\n';
function readMarker(file) {
  const text = fs.readFileSync(file, 'utf8');
  ok(text.startsWith(MARKER_PREFIX), 'segmented marker rejects legacy JSON loaders');
  throws(() => JSON.parse(text), /JSON|Unexpected/i, 'legacy parser cannot mistake segmented authority for empty turns');
  return JSON.parse(text.slice(MARKER_PREFIX.length));
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-segmented-turn-test-'));
  const file = path.join(dir, 'turns.json');
  let current = Date.UTC(2026, 9, 22);
  let sequence = 0;
  const options = { file, segmented: true, now: () => current, random: () => (++sequence) / 100000 };
  return {
    dir, file, options, turns: createTurnStore(options),
    advance(ms) { current += ms; },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function recordPaths(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(root, entry.name);
    return entry.isDirectory() ? recordPaths(name) : [name];
  });
}

function injected(method, predicate, fn) {
  const original = fs[method];
  let fired = false;
  fs[method] = function (...args) {
    if (!fired && predicate(...args)) {
      fired = true;
      const error = new Error('Injected offline filesystem failure');
      error.code = 'EIO';
      throw error;
    }
    return original.apply(this, args);
  };
  try { fn(); } finally { fs[method] = original; }
  ok(fired, method + ' fault was actually exercised');
}

function preservation() {
  const f = fixture();
  try {
    const created = f.turns.create({ profileId: 'p_one', botName: 'fixture_bot', rehearsal: false,
      input: { continuationContractVersion: 2, firstContactContractVersion: 2, ordinaryPresentationVersion: 1 },
      profile: { id: 'p_one', settings: { cadence: 3 } } });
    ok(created.created, 'new segmented turn is created');
    const id = created.turn.id;
    eq(f.turns.create({ profileId: 'p_one' }).turn.id, id, 'active profile deduplication is preserved');
    eq(f.turns.create({ profileId: 'p_one' }).created, false, 'duplicate creation does not admit work');
    f.turns.setCheckpoint(id, 'decision', { version: 2, selected: 'C2', votes: [{ id: 'V1', direction: 'NIL' }] });
    f.turns.setCheckpoint(id, 'discovery', { offered: ['t3_701'], deferred: ['t3_702'] });
    f.turns.generation(id, 0, { jobId: 'j_one', attempt: 7, claimToken: 'fixture-only-fence',
      status: 'completed', request: { prompt: 'synthetic fixture prompt' }, response: { text: '{"action":"WAIT"}' } });
    f.turns.publication(id, { state: 'attempting', kind: 'comment', attemptId: 'fixture-attempt', body: 'fixture text' });
    f.turns.update(id, { publicationResponse: { ok: true, status: 201, id: 'fixture-comment' }, stage: 'publication' });
    ok(f.turns.markOnce(id, 'acknowledged'), 'once marker is durable');
    const frozen = f.turns.get(id);
    const restart = createTurnStore(f.options);
    eq(restart.get(id), frozen, 'all frozen contracts, requests, results, fences and publication evidence survive restart');
    eq(restart.markOnce(id, 'acknowledged'), false, 'restart cannot repeat once-only bookkeeping');
    eq(restart.activeForProfile('p_one').id, id, 'attempting publication stays recoverable rather than being discarded');
    restart.event(id, 'publication-uncertain', 'Fixture response cannot safely be retried.');
    const uncertain = restart.get(id);
    f.advance(TERMINAL_RETENTION_MS * 3);
    const next = restart.create({ profileId: 'p_two' });
    restart.update(next.turn.id, { status: 'completed' });
    eq(createTurnStore(f.options).get(id), uncertain, 'old publication uncertainty is never retention-pruned');
    eq(createTurnStore(f.options).listActive().some((turn) => turn.id === id), false,
      'publication uncertainty keeps existing terminal semantics and is not retried as an active turn');
    ok(fs.statSync(f.file).size < 4096, 'authority marker is small rather than an aggregate turn blob');
    readMarker(f.file);
    throws(() => createTurnStore({ ...f.options, segmented: false }).listActive(), /JSON|Unexpected|durable|segment/i,
      'legacy application loading segmented authority fails closed, never launches duplicate turns');
    ok(fs.existsSync(f.file + '.d'), 'per-record persistence exists');
  } finally { f.cleanup(); }
}

function scalableHistory() {
  const f = fixture();
  try {
    const ids = [];
    for (let n = 0; n < TERMINAL_CAP + 9; n++) {
      const turn = f.turns.create({ profileId: 'p_history_' + n }).turn;
      f.turns.update(turn.id, { status: n % 2 ? 'failed' : 'completed', result: { fixture: n } });
      ids.push(turn.id);
    }
    f.advance(TERMINAL_RETENTION_MS * 2);
    const active = f.turns.create({ profileId: 'p_active' }).turn;
    const originalRead = fs.readFileSync;
    const historyReads = [];
    fs.readFileSync = function (name, ...args) {
      if (String(name).includes(path.sep + 'history' + path.sep)) historyReads.push(String(name));
      return originalRead.call(this, name, ...args);
    };
    let restart;
    try {
      restart = createTurnStore(f.options);
      eq(restart.listActive().map((turn) => turn.id), [active.id], 'startup loads only recoverable working records');
      eq(historyReads.length, 0, 'startup never parses historical record payloads');
    } finally { fs.readFileSync = originalRead; }
    eq(restart.get(ids[0]).result.fixture, 0, 'history older than 30 days and beyond 1000 records remains addressable');
    eq(restart.get(ids[ids.length - 1]).result.fixture, ids.length - 1, 'last historical record is retained');
    const files = recordPaths(f.file + '.d');
    eq(files.filter((name) => name.endsWith('.json')).length, ids.length + 1,
      'one independently stored authoritative record survives for every historical and live turn');
    ok(files.some((name) => name.endsWith(ids[0] + '.json')), 'history uses independently addressable record files');
    ok(fs.statSync(f.file).size < 4096, 'marker size stays bounded while history grows');
    ok(files.every((name) => fs.statSync(name).size < 16384), 'no aggregate data file grows with total historical payload');
  } finally { f.cleanup(); }
}

function migrationAndCorruption() {
  const f = fixture();
  try {
    fs.writeFileSync(f.file, JSON.stringify({ version: 1, turns: [] }));
    throws(() => createTurnStore(f.options).listActive(), /migrat|legacy|segment/i,
      'legacy aggregate file requires explicit offline migration, never implicit lossy conversion');
    eq(JSON.parse(fs.readFileSync(f.file, 'utf8')), { version: 1, turns: [] }, 'legacy authority remains untouched on refusal');
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    g.turns.create({ profileId: 'p_corrupt' });
    const metadata = readMarker(g.file);
    fs.writeFileSync(g.file, MARKER_PREFIX + JSON.stringify({ ...metadata, version: 99999 }));
    throws(() => createTurnStore(g.options).listActive(), /version|format|segment|metadata|unsupported|incompatible|migration/i,
      'unknown metadata fails closed instead of presenting an empty queue');
  } finally { g.cleanup(); }
  const h = fixture();
  try {
    const id = h.turns.create({ profileId: 'p_broken' }).turn.id;
    const live = recordPaths(h.file + '.d').find((name) => name.endsWith(id + '.json'));
    fs.writeFileSync(live, '{"id":');
    throws(() => createTurnStore(h.options).listActive(), /turn|JSON|Unexpected|read|record/i,
      'corrupt live records fail closed rather than losing recoverable turns');
  } finally { h.cleanup(); }
  const j = fixture();
  try {
    j.turns.create({ profileId: 'p_bad_path' });
    const metadata = readMarker(j.file);
    fs.writeFileSync(j.file, MARKER_PREFIX + JSON.stringify({ ...metadata, directory: '../outside' }));
    throws(() => createTurnStore(j.options).listActive(), /directory|path|metadata|segment|format|incompatible|migration/i,
      'marker cannot redirect the store outside its fixed sibling directory');
  } finally { j.cleanup(); }
  const k = fixture();
  try {
    k.turns.create({ profileId: 'p_orphan' });
    fs.unlinkSync(k.file);
    throws(() => createTurnStore(k.options).listActive(), /marker|directory|exist|orphan|metadata|segment/i,
      'missing authority marker with existing records fails closed rather than silently creating an empty store');
  } finally { k.cleanup(); }
  const m = fixture();
  try {
    const id = m.turns.create({ profileId: 'p_mismatch' }).turn.id;
    const file = path.join(m.file + '.d', 'live', id + '.json');
    const turn = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...turn, id: 't_different' }));
    throws(() => createTurnStore(m.options).listActive(), /match|record|turn/i,
      'record identity cannot disagree with its authoritative filename');
  } finally { m.cleanup(); }
  const n = fixture();
  try {
    fs.writeFileSync(n.file, JSON.stringify({ version: 1, turns: [], padding: 'x'.repeat(100000) }));
    let aggregateReads = 0;
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (String(file) === n.file) { aggregateReads++; throw new Error('Aggregate legacy payload must not be read'); }
      return read.call(this, file, ...args);
    };
    try {
      throws(() => createTurnStore(n.options).listActive(), /migration/i,
        'oversized legacy aggregate is rejected explicitly before parsing');
      eq(aggregateReads, 0, 'startup never attempts to materialize the legacy aggregate blob');
    } finally { fs.readFileSync = read; }
  } finally { n.cleanup(); }
  const p = fixture();
  try {
    const id = p.turns.create({ profileId: 'p_record_size' }).turn.id;
    const file = path.join(p.file + '.d', 'live', id + '.json');
    const stat = fs.lstatSync;
    fs.lstatSync = function (name, ...args) {
      const result = stat.call(this, name, ...args);
      return String(name) === file ? Object.assign(Object.create(result), {
        size: require('node:buffer').constants.MAX_STRING_LENGTH + 1,
      }) : result;
    };
    try {
      throws(() => createTurnStore(p.options).listActive(), /individual|record|string|size/i,
        'an individually unsupported record is classified before allocating an enormous string');
    } finally { fs.lstatSync = stat; }
  } finally { p.cleanup(); }
}

function crashBoundaries() {
  const f = fixture();
  try {
    const id = f.turns.create({ profileId: 'p_fault' }).turn.id;
    const prior = f.turns.get(id);
    injected('renameSync', (_from, to) => String(to) === path.join(f.file + '.d', 'live', id + '.json'), () => {
      throws(() => f.turns.markOnce(id, 'must-not-advance'), /Injected|write|persist|durable/i,
        'failed atomic commit reports failure rather than returning a once claim');
    });
    throws(() => f.turns.get(id), /fail|poison|restart|write|persist/i,
      'write failure poisons the current instance rather than exposing uncommitted cache state');
    const restart = createTurnStore(f.options);
    eq(restart.get(id), prior, 'failure before commit leaves the exact prior durable record');
    ok(restart.markOnce(id, 'must-not-advance'), 'uncommitted once marker remains legitimately claimable after restart');
    restart.setCheckpoint(id, 'committed', { generationJob: 'j_no_retry', offered: ['C1'] });
    injected('renameSync', (from, to) => String(from) === path.join(f.file + '.d', 'live', id + '.json') &&
      String(to).includes(path.sep + 'history' + path.sep), () => {
      throws(() => restart.update(id, { status: 'completed', result: { ok: true } }), /Injected|write|persist|archive|durable/i,
        'archive move failure after live commit is surfaced');
    });
    const recovered = createTurnStore(f.options);
    eq(recovered.get(id).status, 'completed', 'terminal live commit remains authoritative after interrupted archival');
    eq(recovered.get(id).checkpoints.committed.generationJob, 'j_no_retry', 'interrupted archive preserves inference association');
    eq(recovered.listActive(), [], 'completed live commit cannot be replayed as unfinished work');
    eq(recovered.markOnce(id, 'must-not-advance'), false, 'once evidence survives terminal archive recovery');
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    const id = g.turns.create({ profileId: 'p_stale_history' }).turn.id;
    g.turns.setCheckpoint(id, 'authority', { value: 'current' });
    const authoritative = g.turns.get(id);
    const shard = require('node:crypto').createHash('sha256').update(id).digest('hex').slice(0, 2);
    const history = path.join(g.file + '.d', 'history', shard);
    fs.mkdirSync(history, { recursive: true });
    fs.writeFileSync(path.join(history, id + '.json'), JSON.stringify({ ...authoritative,
      status: 'completed', checkpoints: { authority: { value: 'stale' } } }));
    const restart = createTurnStore(g.options);
    eq(restart.get(id), authoritative, 'live authority wins over conflicting stale historical record');
    eq(restart.listActive().map((turn) => turn.id), [id], 'stale history cannot hide recoverable live state');
    throws(() => restart.get('../escape'), /id|invalid|path|turn/i, 'caller cannot traverse outside segmented storage');
  } finally { g.cleanup(); }
}

preservation();
scalableHistory();
migrationAndCorruption();
crashBoundaries();
console.log('segmented turn store: ' + checks + ' checks passed');
