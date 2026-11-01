'use strict';

// Scheduling's saved pause is the authority. This only releases idle resources;
// it never pauses, resumes, cancels or starts a generation.
function createPauseResources({ enabled, paused, busy, release, intervalMs = 5000 }) {
  let running = null;
  let revision = 0;
  let state = enabled ? 'running' : 'unsupported';
  let code = '';
  function view() { return { state, code }; }
  function changed() {
    revision++;
    state = paused() ? 'waiting' : 'running';
    code = '';
    void tick();
  }
  async function tick() {
    if (!enabled || running) return running;
    if (!paused()) { state = 'running'; code = ''; return; }
    if (busy()) { state = 'draining'; code = ''; return; }
    const current = revision;
    const allowed = () => current === revision && paused() && !busy();
    state = 'checking';
    const operation = (async () => {
      try {
        const result = await release(allowed);
        if (current !== revision || !paused()) return;
        state = result.state;
        code = result.code || '';
      } catch {
        if (current === revision && paused()) { state = 'held'; code = 'MODEL_RELEASE_UNAVAILABLE'; }
      }
    })();
    running = operation;
    try { await operation; } finally { if (running === operation) running = null; }
  }
  const timer = enabled ? setInterval(() => { void tick(); }, intervalMs) : null;
  timer?.unref();
  if (enabled) setImmediate(() => { void tick(); });
  return { changed, tick, view, close: () => { revision++; if (timer) clearInterval(timer); } };
}

module.exports = { createPauseResources };
