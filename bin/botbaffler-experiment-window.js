'use strict';
// Private experiment coordination only; never imported by production services.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function checkHeld(directory, id, { now = Date.now, alive = pid => { process.kill(pid, 0); return true; }, pins = null } = {}) {
  assert.equal(read(path.join(directory, 'request.json')).id, id, 'Maintenance ownership changed');
  for (const name of ['cy', 'feddit']) {
    const status = read(path.join(directory, name + '-status.json'));
    const age = now() - Date.parse(status.updatedAt);
    assert.equal(status.version, 1); assert.equal(status.requestId, id);
    assert.equal(status.state, 'held'); assert.equal(status.active, 0);
    assert(Number.isInteger(status.pid) && status.pid > 0 && alive(status.pid));
    assert(Number.isFinite(age) && age >= 0 && age <= 15000, 'Stale ' + name + ' acknowledgement');
    if (pins) assert.equal(status.pid, pins[name], 'Live ' + name + ' process changed');
  }
}
function checkState(state, purpose = null) {
  assert(state && state.queued && Object.values(state.queued).every(n => n === 0), 'Unexpected queued inference');
  assert(state.active === null || (purpose && state.active.client === 'feddit'
    && state.active.purpose === purpose && state.active.priorityClass === 'synthetic'), 'Unexpected inference owner');
  assert.deepEqual(state.profile, { num_ctx: 3072, num_thread: 4 });
}
function createWindow({ directory, id, save, isBusy, state = async () => {
  const response = await fetch('http://127.0.0.1:11435/v1/state', { signal: AbortSignal.timeout(5000) });
  assert(response.ok); return response.json();
}, now = Date.now, sleep = delay, alive = pid => { process.kill(pid, 0); return true; } }) {
  const requestFile = path.join(directory, 'request.json');
  let owned = false, entered = false, monitor = null, monitoring = false, failure = null, lost = null, lease = null, admitting = false;
  const pins = {}, started = now(), deadline = started + 100 * 60 * 1000;
  const cancel = () => { failure = new Error('Experiment cancelled'); if (lost) lost(); };
  const held = () => checkHeld(directory, id, { now, alive, pins });
  const guard = async () => {
    assert(now() < deadline, 'Experiment window expired');
    if (failure) throw failure;
    held(); checkState(await state(), lease || admitting ? id : null);
  };
  return {
    async enter() {
      assert(!fs.existsSync(requestFile), 'Another operation owns maintenance');
      for (const name of ['cy', 'feddit']) {
        const s = read(path.join(directory, name + '-status.json'));
        const age = now() - Date.parse(s.updatedAt);
        assert(s.version === 1 && s.requestId === null && s.state === 'running' && alive(s.pid)
          && Number.isFinite(age) && age >= 0 && age <= 15000, 'Live gate unavailable: ' + name);
        pins[name] = s.pid;
      }
      const temporary = path.join(directory, id + '.prepared');
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, id }), { flag: 'wx' });
      try { fs.linkSync(temporary, requestFile); owned = true; } finally { fs.unlinkSync(temporary); }
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      save('hold-requested', { at: new Date(now()).toISOString(), id, pins });
      console.log('Maintenance requested: admitted natural work drains without cancellation.');
      const until = now() + 20 * 60 * 1000;
      let stable = 0;
      while (now() < until) {
        if (failure) throw failure;
        assert.equal(read(requestFile).id, id, 'Maintenance request changed during drain');
        try { held(); checkState(await state()); stable++; } catch { stable = 0; }
        if (stable >= 2) { entered = true; break; }
        await sleep(2000);
      }
      assert(entered, 'Safe drain did not finish; no experiment inference permitted');
      save('quiescent', { at: new Date(now()).toISOString(), id, pins });
      console.log('Both live gates held at zero work; arbiter repeatedly idle.');
      monitor = setInterval(async () => {
        if (monitoring || failure) return;
        monitoring = true;
        try { await guard(); } catch (error) { failure = error; if (lost) lost(); }
        finally { monitoring = false; }
      }, 3000);
      if (monitor.unref) monitor.unref();
    },
    guard,
    wrapLeaseClient(client) {
      return { async acquire(options) {
        await guard(); assert(!lease, 'No concurrent private inference');
        lost = options.onLost;
        admitting = true;
        let grant;
        try { grant = await client.acquire({ ...options, purpose: id }); lease = grant.id; }
        finally { admitting = false; }
        try { await guard(); } catch (error) { await grant.release(); lease = null; lost = null; throw error; }
        return { ...grant, async release() { try { await grant.release(); } finally { lease = null; lost = null; } } };
      } };
    },
    async close() {
      clearInterval(monitor);
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      while (monitoring) await sleep(100);
      if (!owned) return;
      // Never resume services while this process has a request/lease still active.
      assert(!isBusy() && !lease && !admitting, 'Owned experiment inference must stop before releasing hold');
      if (entered) {
        checkHeld(directory, id, { now, alive });
        checkState(await state());
      }
      assert.equal(read(requestFile).id, id, 'Do not release another operation hold');
      fs.unlinkSync(requestFile); owned = false;
      save('restored', { at: new Date(now()).toISOString(), id, drained: entered });
      console.log('Experiment requests/leases stopped; normal Cy/Feddit admission restored.');
    },
  };
}
module.exports = { checkHeld, checkState, createWindow };
