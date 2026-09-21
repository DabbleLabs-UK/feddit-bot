'use strict';

function cleanProfile(value) {
  const profile = value && typeof value === 'object' ? value : {};
  const numCtx = Number(profile.num_ctx);
  const numThread = Number(profile.num_thread);
  if (!Number.isInteger(numCtx) || numCtx < 512 || !Number.isInteger(numThread) || numThread < 1) {
    throw new Error('Shared Ollama arbiter returned an invalid execution profile.');
  }
  return { num_ctx: numCtx, num_thread: numThread };
}

function createClient(baseUrl, options = {}) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  if (!root) return null;
  const fetchImpl = options.fetchImpl || fetch;

  return {
    async acquire({ priorityClass = 'user', purpose = 'feddit', signal = null, onLost = () => {} } = {}) {
      const response = await fetchImpl(root + '/v1/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: 'feddit', priorityClass, purpose }),
        signal,
      });
      if (!response.ok) throw new Error('Shared Ollama arbiter returned HTTP ' + response.status + '.');
      const grant = await response.json();
      const id = String(grant.id || '');
      if (!id) throw new Error('Shared Ollama arbiter returned no lease ID.');
      const profile = cleanProfile(grant.profile);
      const heartbeatMs = Math.max(1000, Number(grant.heartbeatMs) || 5000);
      let released = false;
      let heartbeatFailures = 0;
      let heartbeatBusy = false;
      const heartbeat = async () => {
        if (released || heartbeatBusy) return;
        heartbeatBusy = true;
        try {
          const result = await fetchImpl(root + '/v1/leases/' + encodeURIComponent(id) + '/heartbeat', { method: 'POST' });
          if (!result.ok) throw new Error('heartbeat HTTP ' + result.status);
          heartbeatFailures = 0;
        } catch {
          heartbeatFailures++;
          if (heartbeatFailures >= 2 && !released) onLost();
        } finally {
          heartbeatBusy = false;
        }
      };
      const timer = setInterval(() => { void heartbeat(); }, heartbeatMs);
      if (timer.unref) timer.unref();
      return {
        id,
        profile,
        waitMs: Math.max(0, Number(grant.waitMs) || 0),
        async release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          try {
            await fetchImpl(root + '/v1/leases/' + encodeURIComponent(id), { method: 'DELETE' });
          } catch {
            // The short lease TTL is the crash-safe fallback.
          }
        },
      };
    },
  };
}

module.exports = { cleanProfile, createClient };
