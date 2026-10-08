'use strict';

const assert = require('node:assert/strict');
const feddit = require('../lib/feddit');
const originalFetch = global.fetch;

function streamResponse(chunks, { cancelRejects = false, status = 200 } = {}) {
  const state = { reads: 0, cancelled: 0, released: 0, textCalls: 0 };
  const response = {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    body: { getReader: () => ({
      async read() {
        const index = state.reads++;
        return index < chunks.length ? { done: false, value: chunks[index] } : { done: true };
      },
      async cancel() { state.cancelled++; if (cancelRejects) throw new Error('Cancellation failed'); },
      releaseLock() { state.released++; },
    }) },
    async text() { state.textCalls++; throw new Error('Bounded requests must not call text()'); },
  };
  return { response, state };
}

(async () => {
  try {
    let signal;
    const bytes = Buffer.from('{"message":"caf\u00e9"}');
    const split = bytes.indexOf(0xc3) + 1;
    let fixture = streamResponse([bytes.subarray(0, split), bytes.subarray(split)]);
    global.fetch = async (url, options) => { signal = options.signal; return fixture.response; };
    const normal = await feddit.request('/fixture', { maxResponseBytes: bytes.length });
    assert.equal(normal.ok, true);
    assert.deepEqual(normal.data, { message: 'caf\u00e9' }, 'split UTF-8 survives an exact byte limit');
    assert.equal(fixture.state.cancelled, 0);
    assert.equal(fixture.state.released, 1);
    assert.equal(fixture.state.textCalls, 0);
    assert.equal(signal.aborted, false);

    fixture = streamResponse([bytes.subarray(0, 4), bytes.subarray(4), Buffer.from('NEVER_READ')]);
    const oversized = await feddit.request('/fixture', { maxResponseBytes: bytes.length - 1 });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.status, 0);
    assert.equal(oversized.data, null, 'oversized response is never parsed or returned');
    assert.match(oversized.error, /exceeds maxResponseBytes/);
    assert.equal(fixture.state.reads, 2, 'reading stops on the first overflowing chunk');
    assert.equal(fixture.state.cancelled, 1);
    assert.equal(fixture.state.released, 1);
    assert.equal(fixture.state.textCalls, 0);
    assert.equal(signal.aborted, true);

    fixture = streamResponse([bytes], { cancelRejects: true });
    const rejectedCancel = await feddit.request('/fixture', { maxResponseBytes: 1 });
    assert.match(rejectedCancel.error, /exceeds maxResponseBytes/, 'cancellation failures preserve the limit error');
    assert.equal(fixture.state.released, 1);
    fixture = streamResponse([]);
    assert.equal((await feddit.request('/fixture', { maxResponseBytes: 0 })).data, null);
    fixture.response.body = null;
    assert.equal((await feddit.request('/fixture', { maxResponseBytes: 0 })).ok, true);

    const errorBytes = Buffer.from('{"error":{"message":"Try again in 42 seconds"}}');
    fixture = streamResponse([errorBytes], { status: 429 });
    const limited = await feddit.request('/fixture', { maxResponseBytes: errorBytes.length });
    assert.equal(limited.status, 429);
    assert.equal(limited.retryAfterSec, 42, 'bounded parsing preserves existing HTTP error handling');

    let ordinaryReads = 0;
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null },
      get body() { throw new Error('Ordinary callers must not use the stream-bound path'); },
      async text() { ordinaryReads++; return JSON.stringify({ text: 'x'.repeat(100000) }); } });
    const ordinary = await feddit.request('/fixture');
    assert.equal(ordinary.ok, true);
    assert.equal(ordinary.data.text.length, 100000);
    assert.equal(ordinaryReads, 1);
    global.fetch = async () => { throw new Error('Invalid limits must fail before fetching'); };
    assert.match((await feddit.request('/fixture', { maxResponseBytes: -1 })).error, /non-negative safe integer/);
    assert.match((await feddit.request('/fixture', { maxResponseBytes: 1.5 })).error, /non-negative safe integer/);
    console.log('feddit response limit: all assertions passed');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
