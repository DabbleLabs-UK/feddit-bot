'use strict';

// Bounded, content-free diagnostics for desktop/local Ollama generations.
// Prompts, source material and generated text must never be written here.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 50;

function cleanText(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeEvent(event) {
  return {
    id: finiteOrNull(event.id),
    status: event.status === 'completed' ? 'completed' : 'failed',
    startedAt: finiteOrNull(event.startedAt),
    finishedAt: finiteOrNull(event.finishedAt),
    durationMs: finiteOrNull(event.durationMs),
    profileId: cleanText(event.profileId, 100),
    botName: cleanText(event.botName, 100),
    kind: cleanText(event.kind, 80),
    action: cleanText(event.action, 120),
    trigger: cleanText(event.trigger, 120),
    target: cleanText(event.target, 160),
    model: cleanText(event.model, 300),
    totalTimeoutMs: Math.max(0, finiteOrNull(event.totalTimeoutMs) || 0),
    idleTimeoutMs: Math.max(0, finiteOrNull(event.idleTimeoutMs) || 0),
    outcome: cleanText(event.outcome, 80),
    failureClass: cleanText(event.failureClass, 80),
    failureCode: cleanText(event.failureCode, 100),
    transportCode: cleanText(event.transportCode, 100),
    httpStatus: finiteOrNull(event.httpStatus),
    phase: cleanText(event.phase, 80),
    responseStarted: event.responseStarted === true,
    streamStarted: event.streamStarted === true,
    bytesReceived: Math.max(0, finiteOrNull(event.bytesReceived) || 0),
    repairAttemptCount: Math.max(0, finiteOrNull(event.repairAttemptCount) || 0),
    published: false,
    schedulingContinues: true,
    // Free-form error text can originate outside this process. Persist only
    // structured classifications so an upstream service can never echo prompt
    // or generated content into the diagnostic file.
    error: '',
  };
}

function defaultFile() {
  const dataDir = process.env.FEDDIT_BOT_DATA_DIR
    ? path.resolve(process.env.FEDDIT_BOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');
  return path.join(dataDir, 'local-generation-telemetry.json');
}

function createLocalGenerationTelemetry(options = {}) {
  const file = path.resolve(options.file || defaultFile());
  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const events = Array.isArray(parsed && parsed.events) ? parsed.events : [];
      return events.map(safeEvent).slice(0, limit);
    } catch {
      return [];
    }
  }

  function write(events) {
    const safe = events.map(safeEvent).slice(0, limit);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: SCHEMA_VERSION, events: safe }, null, 2) + '\n');
    fs.renameSync(temporary, file);
    return safe;
  }

  function record(event) {
    return write([safeEvent(event), ...read()]);
  }

  return { file, limit, read, record };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_LIMIT,
  safeEvent,
  createLocalGenerationTelemetry,
};
