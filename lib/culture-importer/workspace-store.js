'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_STORE_VERSION = 1;

function defaultWorkspaceFile() {
  const dataDir = process.env.FEDDIT_BOT_DATA_DIR
    ? path.resolve(process.env.FEDDIT_BOT_DATA_DIR)
    : path.resolve(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'culture-import-workspaces.json');
}

function createFileCultureWorkspaceStore(options = {}) {
  const file = path.resolve(options.file || defaultWorkspaceFile());

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || parsed.version !== WORKSPACE_STORE_VERSION || !Array.isArray(parsed.sessions)) {
        return { version: WORKSPACE_STORE_VERSION, sessions: [], state: 'invalid' };
      }
      return {
        version: WORKSPACE_STORE_VERSION,
        sessions: structuredClone(parsed.sessions),
        state: 'loaded',
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { version: WORKSPACE_STORE_VERSION, sessions: [], state: 'missing' };
      }
      return {
        version: WORKSPACE_STORE_VERSION,
        sessions: [],
        state: 'invalid',
        error: String(error && error.message || error),
      };
    }
  }

  function save(sessions) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp';
    const value = {
      version: WORKSPACE_STORE_VERSION,
      sessions: structuredClone(Array.isArray(sessions) ? sessions : []),
    };
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort on Windows */ }
    fs.renameSync(temporary, file);
    return { file, count: value.sessions.length };
  }

  return { file, load, save };
}

module.exports = {
  WORKSPACE_STORE_VERSION,
  defaultWorkspaceFile,
  createFileCultureWorkspaceStore,
};
