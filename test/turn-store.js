'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTurnStore, TERMINAL_RETENTION_MS } = require('../lib/turn-store');

let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-turns-'));
  const file = path.join(dir, 'turns.json');
  let current = Date.UTC(2026, 8, 13, 12, 0, 0);
  let sequence = 0;
  const options = {
    file,
    now: () => current,
    random: () => (++sequence) / 1000,
  };
  return {
    file,
    options,
    turns: createTurnStore(options),
    advance: (ms) => { current += ms; },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function run() {
  const f = fixture();
  try {
    const created = f.turns.create({
      profileId: 'bot-one',
      botName: 'bot_one',
      rehearsal: true,
      input: { choices: [{ key: 'reply' }] },
      profile: { id: 'bot-one', persona: 'curious' },
    });
    ok(created.created, 'a new logical turn is created');
    eq(created.turn.status, 'created', 'new turn begins in the created state');
    eq(created.turn.rehearsal, true, 'rehearsal mode is frozen into the turn');

    const duplicate = f.turns.create({ profileId: 'bot-one' });
    eq(duplicate.created, false, 'a profile cannot acquire a second active turn');
    eq(duplicate.turn.id, created.turn.id, 'duplicate creation returns the existing active turn');

    f.turns.setCheckpoint(created.turn.id, 'reply-target', { key: 't3_20' });
    f.turns.generation(created.turn.id, 0, {
      status: 'waiting-for-dell',
      jobId: 'j_one',
      request: { prompt: 'write a reply' },
    });
    f.turns.publication(created.turn.id, { state: 'not-started', kind: 'comment' });
    f.turns.event(created.turn.id, 'waiting-for-dell', 'Generation queued.');
    ok(f.turns.markOnce(created.turn.id, 'decision-log'), 'a once marker is claimed the first time');
    eq(f.turns.markOnce(created.turn.id, 'decision-log'), false, 'a once marker cannot be claimed twice');

    const restarted = createTurnStore(f.options);
    const recovered = restarted.get(created.turn.id);
    eq(recovered.checkpoints['reply-target'].key, 't3_20', 'selected context survives store recreation');
    eq(recovered.generations[0].jobId, 'j_one', 'DELL job association survives store recreation');
    eq(recovered.publication.kind, 'comment', 'publication plan survives store recreation');
    eq(restarted.activeForProfile('bot-one').id, created.turn.id, 'active turn is found after recreation');

    restarted.update(created.turn.id, { status: 'completed', result: { ok: true } });
    eq(restarted.activeForProfile('bot-one'), null, 'terminal turn no longer keeps the profile busy');
    eq(restarted.get(created.turn.id).result.ok, true, 'terminal result remains available');

    const next = restarted.create({ profileId: 'bot-one', rehearsal: false });
    ok(next.created, 'a profile may start another turn after terminal completion');
    eq(next.turn.rehearsal, false, 'live mode is independently frozen into the later turn');

    restarted.update(next.turn.id, { status: 'failed', error: 'permanent failure' });
    f.advance(TERMINAL_RETENTION_MS + 1);
    const newer = restarted.create({ profileId: 'bot-two' });
    restarted.update(newer.turn.id, { status: 'completed' });
    eq(restarted.get(created.turn.id), null, 'expired terminal turns are pruned');
    eq(restarted.get(next.turn.id), null, 'all expired terminal turns are pruned');
    ok(restarted.get(newer.turn.id), 'recent terminal turn remains retained');
  } finally {
    f.cleanup();
  }

  console.log('turn store: ' + checks + ' checks passed');
}

run();
