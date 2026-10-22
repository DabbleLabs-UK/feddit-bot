'use strict';

// Read-only verification of an already prepared authority marker and all records.
// Never import server.js: verification must not schedule, infer or publish.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function ensure(condition, message) { if (!condition) throw new Error(message); }
const { createTurnStore } = require('../lib/turn-store');
const { recordShard, SEGMENTED_MARKER_PREFIX } = require('../lib/turn-record-files');
const file = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.readFileSync(file, 'utf8').startsWith(SEGMENTED_MARKER_PREFIX)) {
  throw new Error('An existing segmented marker is required; verifier never initializes a store.');
}
const directory = file + '.d';
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'migration.json'), 'utf8'));
const began = performance.now();
const store = createTurnStore({ file, segmented: true });
const active = store.listActive();
const startupMs = performance.now() - began;
let count = 0;
let signatures = 0;
let maxRecordBytes = 0;
let totalRecordBytes = 0;
const statuses = {};
for (const [id, expected] of Object.entries(manifest.records)) {
  const live = path.join(directory, 'live', id + '.json');
  const history = path.join(directory, 'history', recordShard(id), id + '.json');
  const bytes = fs.readFileSync(fs.existsSync(live) ? live : history);
  const digest = crypto.createHash('sha256').update(bytes.subarray(0, bytes.length - 1)).digest('hex');
  ensure(digest === expected.orderedSha256, 'Order-sensitive record content differs from the verified source.');
  const raw = JSON.parse(bytes);
  const loaded = store.get(id);
  ensure(JSON.stringify(loaded) === JSON.stringify(raw), 'Complete record data or nested property order changed.');
  for (const generation of loaded.generations || []) {
    if (!generation || !generation.request || !generation.signature) continue;
    ensure(crypto.createHash('sha256').update(JSON.stringify(generation.request)).digest('hex') === generation.signature,
      'Existing generation request signatures must remain valid.');
    signatures++;
  }
  statuses[loaded.status] = (statuses[loaded.status] || 0) + 1;
  maxRecordBytes = Math.max(maxRecordBytes, bytes.length);
  totalRecordBytes += bytes.length;
  count++;
}
ensure(count === manifest.count, 'Record count differs from the migration manifest.');
ensure(Object.keys(statuses).length === Object.keys(manifest.statuses).length &&
  Object.entries(statuses).every(([key, value]) => manifest.statuses[key] === value), 'State counts differ from the migration manifest.');
console.log(JSON.stringify({ count, statuses, active: active.map(t => ({ id: t.id, status: t.status,
  generations: t.generations.length, firstContactVersion: t.input.firstContactVersion })),
  signaturesVerified: signatures, startupMs: Math.round(startupMs * 100) / 100,
  markerBytes: fs.statSync(file).size, maxRecordBytes, totalRecordBytes,
  rssBytes: process.memoryUsage().rss, sourceSha256: manifest.sourceSha256 }));
