'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants: bufferConstants } = require('node:buffer');

const SEGMENTED_VERSION = 2;
const SEGMENTED_FORMAT = 'per-record';
const SEGMENTED_MARKER_PREFIX = 'FEDDIT_TURN_STORE_V2\n';
const ARCHIVED = new Set(['completed', 'failed']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TEMP_FILE = /^\.[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json\.\d+\.[a-f0-9]+\.tmp$/;

function validateId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error('Invalid durable turn ID.');
  return id;
}

function validateTurn(turn, expectedId) {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new Error('Invalid durable turn record.');
  validateId(turn.id);
  if (expectedId != null && turn.id !== expectedId) throw new Error('Durable turn record ID does not match its file.');
  if (typeof turn.profileId !== 'string' || !turn.profileId || typeof turn.status !== 'string' || !turn.status) {
    throw new Error('Durable turn record requires profileId and status.');
  }
  return turn;
}

function recordShard(id) {
  return crypto.createHash('sha256').update(validateId(id)).digest('hex').slice(0, 2);
}

function syncDirectory(dir) {
  // Windows does not expose directory fsync through Node. Linux deployment must
  // confirm the rename's directory entry reached stable storage before success.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function requireDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid durable turn directory.');
}

function atomicJson(file, value, prefix = '') {
  const dir = path.dirname(file);
  const temp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, prefix + JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  syncDirectory(dir);
}

function createTurnRecordFiles(options = {}) {
  const file = path.resolve(options.file);
  const directory = file + '.d';
  const live = path.join(directory, 'live');
  const history = path.join(directory, 'history');
  let loaded = false;

  function marker() {
    return { version: SEGMENTED_VERSION, format: SEGMENTED_FORMAT, directory: path.basename(directory) };
  }

  function load() {
    if (loaded) return;
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (fs.existsSync(directory)) throw new Error('Durable turn directory exists without its marker; explicit recovery is required.');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.mkdirSync(live, { mode: 0o700 });
      fs.mkdirSync(history, { mode: 0o700 });
      syncDirectory(directory);
      syncDirectory(path.dirname(directory));
      atomicJson(file, marker(), SEGMENTED_MARKER_PREFIX);
      stat = fs.lstatSync(file);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid durable turn marker.');
    if (stat.size > 65536) throw new Error('Legacy durable turn store requires explicit migration before segmented loading.');
    const text = fs.readFileSync(file, 'utf8');
    if (!text.startsWith(SEGMENTED_MARKER_PREFIX)) throw new Error('Legacy durable turn store requires explicit migration.');
    let parsed;
    try { parsed = JSON.parse(text.slice(SEGMENTED_MARKER_PREFIX.length)); }
    catch { throw new Error('Invalid durable turn marker JSON.'); }
    if (!parsed || parsed.version !== SEGMENTED_VERSION || parsed.format !== SEGMENTED_FORMAT ||
        parsed.directory !== path.basename(directory) || Object.prototype.hasOwnProperty.call(parsed, 'turns')) {
      throw new Error('Unsupported durable turn version or format; explicit migration is required.');
    }
    requireDirectory(directory);
    requireDirectory(live);
    requireDirectory(history);
    for (const entry of fs.readdirSync(directory)) {
      if (entry === 'migration.json') {
        const migration = fs.lstatSync(path.join(directory, entry));
        if (!migration.isFile() || migration.isSymbolicLink()) throw new Error('Invalid durable turn migration evidence.');
      } else if (entry !== 'live' && entry !== 'history') {
        throw new Error('Unexpected durable turn directory entry.');
      }
    }
    for (const entry of fs.readdirSync(history)) {
      if (!/^[a-f0-9]{2}$/.test(entry)) throw new Error('Invalid durable turn history shard.');
      requireDirectory(path.join(history, entry));
    }
    loaded = true;
  }

  function readRecord(recordFile, id) {
    let stat;
    try { stat = fs.lstatSync(recordFile); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid durable turn record file.');
    if (stat.size > bufferConstants.MAX_STRING_LENGTH) throw new Error('Individual durable turn record exceeds the supported string size.');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(recordFile, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('Invalid durable turn record JSON.');
      throw error;
    }
    return validateTurn(parsed, id);
  }

  function listLive() {
    load();
    const turns = [];
    for (const entry of fs.readdirSync(live)) {
      if (TEMP_FILE.test(entry)) {
        if (!fs.lstatSync(path.join(live, entry)).isFile()) throw new Error('Invalid durable turn temporary file.');
        continue;
      }
      if (!entry.endsWith('.json')) throw new Error('Unexpected durable turn live entry.');
      const id = validateId(entry.slice(0, -5));
      const turn = readRecord(path.join(live, entry), id);
      if (!turn) throw new Error('Durable turn disappeared while loading.');
      turns.push(turn);
    }
    return turns;
  }

  function get(id) {
    load();
    validateId(id);
    return readRecord(path.join(live, id + '.json'), id) ||
      readRecord(path.join(history, recordShard(id), id + '.json'), id);
  }

  function save(turn) {
    load();
    validateTurn(turn);
    const liveFile = path.join(live, turn.id + '.json');
    // A committed live record always wins over an older archived copy, including
    // after a crash between this commit and the following archive rename.
    atomicJson(liveFile, turn);
    if (ARCHIVED.has(turn.status)) {
      const shard = path.join(history, recordShard(turn.id));
      if (!fs.existsSync(shard)) {
        fs.mkdirSync(shard, { mode: 0o700 });
        syncDirectory(history);
      }
      requireDirectory(shard);
      fs.renameSync(liveFile, path.join(shard, turn.id + '.json'));
      syncDirectory(shard);
      syncDirectory(live);
    }
  }

  function resetForTests() { loaded = false; }

  return { file, directory, listLive, get, save, resetForTests };
}

module.exports = { SEGMENTED_VERSION, SEGMENTED_FORMAT, SEGMENTED_MARKER_PREFIX, recordShard, validateTurn, createTurnRecordFiles };
