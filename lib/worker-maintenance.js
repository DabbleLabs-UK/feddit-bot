'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Maintenance admission only: an admitted claim owns its complete/fail delivery.
// Never interrupt that work or turn a telemetry failure into a generation failure.
function createMaintenanceGate(options = {}) {
  const directory = String(options.directory || '').trim();
  if (!directory) return { begin: () => true, end() {}, refresh() {}, close() {} };

  const files = options.fsImpl || fs;
  const logger = options.logger || console;
  const pid = process.pid;
  const requestPath = path.join(directory, 'request.json');
  const statusPath = path.join(directory, 'feddit-status.json');
  const temporaryPath = statusPath + '.' + pid + '.tmp';
  let active = 0;
  let lastError = '';

  function refresh() {
    let requestId = null;
    let error = '';
    try {
      // Missing request means release; an inaccessible/missing gate directory does not.
      if (!files.statSync(directory).isDirectory()) throw new Error('directory');
      let raw;
      try { raw = files.readFileSync(requestPath, 'utf8'); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (raw !== undefined) {
        const request = JSON.parse(raw);
        if (request.version !== 1 || typeof request.id !== 'string'
            || !/^[A-Za-z0-9._-]{1,128}$/.test(request.id)) throw new Error('request');
        requestId = request.id;
      }
    } catch {
      error = 'MAINTENANCE_REQUEST_UNREADABLE';
    }
    const status = {
      version: 1, pid, requestId,
      state: error ? 'error' : requestId ? (active ? 'draining' : 'held') : 'running',
      active, updatedAt: new Date().toISOString(),
    };
    try {
      files.writeFileSync(temporaryPath, JSON.stringify(status) + '\n', { mode: 0o600 });
      files.renameSync(temporaryPath, statusPath);
    } catch {
      error = 'MAINTENANCE_STATUS_UNWRITABLE';
    }
    if (error && error !== lastError) logger.error('Worker maintenance gate: ' + error + '. New claims are blocked.');
    lastError = error;
    return { ...status, state: error ? 'error' : status.state };
  }

  function begin() {
    const status = refresh();
    if (status.state !== 'running') return false;
    active++;
    // No await between admission and recording activity. A request arriving here
    // drains this already admitted unit instead of cancelling it.
    const admitted = refresh();
    if (admitted.state === 'error') {
      active--;
      refresh();
      return false;
    }
    return true;
  }

  function end() {
    active = Math.max(0, active - 1);
    refresh();
  }

  refresh();
  const timer = setInterval(refresh, options.pollMs || 1000);
  if (timer.unref) timer.unref();
  return { begin, end, refresh, close: () => clearInterval(timer) };
}

module.exports = { createMaintenanceGate };
