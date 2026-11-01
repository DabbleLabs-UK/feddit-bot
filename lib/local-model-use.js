'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Private operational identities only. No prompts, outputs, tokens or profiles.
// Used-model identity is not an exclusive lease on another application's model.
function valid(record) {
  const process = value => value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.birth === 'string' && value.birth.length < 100 &&
    typeof value.executable === 'string' && value.executable.length < 1024;
  return record && process(record.service) && process(record.native) &&
    Number.isSafeInteger(record.native.port) && record.native.port > 0 && record.native.port < 65536 &&
    typeof record.model === 'string' && record.model.length > 0 && record.model.length < 512 &&
    typeof record.digest === 'string' && /^[a-f0-9]{64}$/.test(record.digest) &&
    (record.releasePending === undefined || typeof record.releasePending === 'boolean');
}

function createModelUseStore(file, files = fs) {
  let unavailable = false;
  let records = [];
  try {
    if (files.statSync(file).size > 32768) throw new Error('size');
    const value = JSON.parse(files.readFileSync(file, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.models) || value.models.length > 8 || !value.models.every(valid)) throw new Error('shape');
    records = value.models;
  } catch (error) { if (error.code !== 'ENOENT') unavailable = true; }
  function save(next) {
    if (unavailable) return false;
    const temp = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      files.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = files.openSync(temp, 'wx', 0o600);
      try { files.writeFileSync(fd, JSON.stringify({ version: 1, models: next }) + '\n'); files.fsyncSync(fd); }
      finally { files.closeSync(fd); }
      files.renameSync(temp, file);
      records = next;
      return true;
    } catch { unavailable = true; return false; }
  }
  return {
    list: () => unavailable ? null : records.map(record => structuredClone(record)),
    record(value) {
      if (!valid(value)) return false;
      return save([value, ...records.filter(item => item.model !== value.model)].slice(0, 8));
    },
    remove(value) { return save(records.filter(item => JSON.stringify(item) !== JSON.stringify(value))); },
  };
}

module.exports = { createModelUseStore, valid };
