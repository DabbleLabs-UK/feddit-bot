'use strict';

const fs = require('node:fs');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 1024;

function classify(message, key) {
  const text = typeof message === 'string' ? message.slice(0, 8192) : '';
  let event = 'unknown';
  let jobId;
  const patterns = [
    ['completed', /^Completed inference job (\S+)\.$/],
    ['inference_failed', /^Inference job (\S+) failed: /],
    ['renew_failed', /^Could not renew job (\S+): /],
    ['report_failed', /^Could not report failed job (\S+): /],
  ];
  for (const [name, pattern] of patterns) {
    const match = text.match(pattern);
    if (match) { event = name; jobId = match[1]; break; }
  }
  if (/^DELL worker .+ is polling /.test(text)) event = 'started';
  else if (/^Worker poll failed: /.test(text)) event = 'poll_failed';
  else if (/^Worker maintenance gate: /.test(text)) event = 'maintenance';

  let reason = 'unknown';
  const reasons = [
    ['render_version', /rendering version|OLLAMA_VERSION_MISMATCH/i],
    ['metadata', /metadata|tokenizer|MODEL_MISMATCH/i],
    ['budget', /budget|HOSTED_DECISION/i],
    ['timeout', /timeout|timed out|did not finish within/i],
    ['aborted', /aborted|AbortError/i],
    ['lease', /lease/i],
    ['auth', /unauthori[sz]ed|forbidden|HTTP (?:401|403)\b|FEDDIT_WORKER_KEY/i],
    ['http429', /HTTP 429\b/],
    ['http5xx', /HTTP 5\d\d\b/],
    ['connection', /fetch failed|ECONN|connection|socket|network/i],
  ];
  if (event !== 'started' && event !== 'completed') {
    for (const [name, pattern] of reasons) {
      if (pattern.test(text)) { reason = name; break; }
    }
  }
  const result = { event, reason };
  if (/^j_[a-f0-9]{32}$/.test(jobId || '') && !(key && (String(key).includes(jobId) || jobId.includes(String(key))))) result.jobId = jobId;
  return result;
}

function createLogger(file, key) {
  if (!file) return console;
  let reported = false;
  function write(severity, message) {
    try {
      const record = { timestamp: new Date().toISOString(), severity, ...classify(message, key) };
      const line = JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return;
      let size = 0;
      try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size >= MAX_FILE_BYTES || size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
        fs.renameSync(file, file + '.previous');
      }
      // Each append opens and closes the file, so rotation never races a held
      // writer handle. Logging failures must not affect claim/result delivery.
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      reported = false;
    } catch {
      if (!reported) console.error('Worker operational logging unavailable.');
      reported = true;
    }
  }
  return { log: (message) => write('info', message), warn: (message) => write('warn', message), error: (message) => write('error', message) };
}

module.exports = { createLogger, classify, MAX_FILE_BYTES, MAX_RECORD_BYTES };
