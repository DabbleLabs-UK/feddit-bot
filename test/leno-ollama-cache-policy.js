'use strict';
// Static deployment-policy regression. No server, model or provider is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = fs.readFileSync(path.join(__dirname, '../ops/leno-ollama/start-ollama.cmd'), 'utf8').replace(/\r\n/g, '\n');
const removed = policy.split('\n').filter(line => !line.includes('Bound reusable prompt snapshots') && !line.includes('LLAMA_ARG_CACHE_RAM')).join('\n');
const legacy = [
  '@echo off',
  'set "OLLAMA_HOST=127.0.0.1:11434"',
  'set "OLLAMA_MODELS=C:\\wamp\\www\\open-webui\\ollama-models"',
  'set "OLLAMA_LOAD_TIMEOUT=30m"',
  'set "OLLAMA_CONTEXT_LENGTH=32768"',
  'rem LENO has 12 logical processors. 0x3FF permits 10, reserving 2 for Windows.',
  'start "" /B /BELOWNORMAL powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\\wamp\\www\\open-webui\\ollama-cpu-guardian.ps1"',
  'start "" /B /BELOWNORMAL /AFFINITY 3FF /WAIT "C:\\wamp\\www\\open-webui\\ollama\\ollama.exe" serve >> "C:\\wamp\\www\\open-webui\\ollama.log" 2>&1',
  '',
].join('\n');
assert.equal(removed, legacy, 'Only the reusable snapshot-cache budget may change');
assert.equal((policy.match(/^set "LLAMA_ARG_CACHE_RAM=1024"$/gm) || []).length, 1);
assert(policy.indexOf('LLAMA_ARG_CACHE_RAM=1024') < policy.indexOf('ollama.exe" serve'));
assert(!/OLLAMA_NUM_|LLAMA_ARG_(?:CTX|BATCH|UBATCH|THREAD|CACHE_TYPE|REASONING)/.test(policy));
assert.equal(policy.split('\n').filter(line => line.startsWith('start ')).length, 2);
assert(!/^\s*(?:taskkill|Stop-Process|Remove-Item|del)\b/im.test(policy), 'Normal startup must not kill existing work or delete state');
console.log('LENO cache policy: 6 checks passed; legacy execution settings unchanged');
