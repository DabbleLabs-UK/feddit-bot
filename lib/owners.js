'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function formatRecovery(bytes) {
  return bytes.toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

function createOwnerStore(options = {}) {
  const file = path.resolve(options.file);
  const randomBytes = options.randomBytes || crypto.randomBytes;
  let cache = null;

  function empty() {
    return { version: VERSION, owners: [] };
  }

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = {
        version: VERSION,
        owners: Array.isArray(parsed && parsed.owners) ? parsed.owners : [],
      };
    } catch (err) {
      if (err && err.code === 'ENOENT') cache = empty();
      else throw new Error('Failed to read hosted owners: ' + err.message);
    }
    return cache;
  }

  function save(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
    fs.renameSync(tmp, file);
    cache = data;
  }

  function issue() {
    const accessToken = randomBytes(32).toString('base64url');
    const recoveryCode = formatRecovery(randomBytes(16));
    return { accessToken, recoveryCode };
  }

  function create() {
    const data = load();
    const issued = issue();
    const owner = {
      id: 'o_' + randomBytes(12).toString('hex'),
      accessHash: digest(issued.accessToken),
      recoveryHash: digest(issued.recoveryCode),
      createdAt: new Date().toISOString(),
      recoveredAt: null,
    };
    data.owners.push(owner);
    save(data);
    return { id: owner.id, ...issued };
  }

  function authorise(accessToken) {
    const hash = digest(accessToken);
    if (!accessToken) return null;
    return load().owners.find((owner) => owner.accessHash === hash) || null;
  }

  function recover(recoveryCode) {
    const normal = String(recoveryCode || '').trim().toUpperCase();
    if (!normal) return null;
    const data = load();
    const owner = data.owners.find((item) => item.recoveryHash === digest(normal));
    if (!owner) return null;
    const issued = issue();
    owner.accessHash = digest(issued.accessToken);
    owner.recoveryHash = digest(issued.recoveryCode);
    owner.recoveredAt = new Date().toISOString();
    save(data);
    return { id: owner.id, ...issued };
  }

  function resetForTests() {
    cache = null;
  }

  return { file, create, authorise, recover, resetForTests };
}

module.exports = { VERSION, digest, formatRecovery, createOwnerStore };

