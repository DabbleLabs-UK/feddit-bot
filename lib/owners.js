'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 2;
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;

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

  function ownerById(id) {
    return load().owners.find((owner) => owner.id === id) || null;
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
      activityHash: null,
      lastActiveAt: null,
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

  function authoriseActivity(activityToken) {
    if (!activityToken) return null;
    const hash = digest(activityToken);
    return load().owners.find((owner) => owner.activityHash === hash) || null;
  }

  function issueActivity(ownerId, at = Date.now()) {
    const data = load();
    const owner = data.owners.find((item) => item.id === ownerId);
    if (!owner) return null;
    const activityToken = randomBytes(32).toString('base64url');
    owner.activityHash = digest(activityToken);
    owner.lastActiveAt = new Date(at).toISOString();
    save(data);
    return { activityToken, lastActiveAt: owner.lastActiveAt };
  }

  function touchActivity(ownerId, at = Date.now()) {
    const data = load();
    const owner = data.owners.find((item) => item.id === ownerId);
    if (!owner) return false;
    const previous = Date.parse(String(owner.lastActiveAt || ''));
    if (Number.isFinite(previous) && at - previous < ACTIVITY_WRITE_INTERVAL_MS) return false;
    owner.lastActiveAt = new Date(at).toISOString();
    save(data);
    return true;
  }

  function lastActiveAt(ownerId) {
    const owner = ownerById(ownerId);
    return owner ? owner.lastActiveAt || null : null;
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
    owner.activityHash = null;
    save(data);
    return { id: owner.id, ...issued };
  }

  function resetForTests() {
    cache = null;
  }

  return {
    file,
    create,
    authorise,
    authoriseActivity,
    issueActivity,
    touchActivity,
    lastActiveAt,
    recover,
    resetForTests,
  };
}

module.exports = { VERSION, ACTIVITY_WRITE_INTERVAL_MS, digest, formatRecovery, createOwnerStore };
