'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const tokenizer = require('../lib/desktop-tokenizer');
const { extract } = require('../bin/build-desktop-tokenizer');
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../lib/desktop-tokenizer-data.json.gz'))));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const show = { template: data.template, parameters: data.parameters, model_info: data.tokenizer };
const tags = { models: [{ name: tokenizer.MODEL, digest: tokenizer.DIGEST }] };
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }

equal(tokenizer.verifyModel(show, tags), true);
equal(tokenizer.verifyModel(show, 'sha256:' + tokenizer.DIGEST), true);
equal(extract(show, tags, data.unicode).tokenizerSha256, tokenizer.TOKENIZER_SHA256);
for (const [text, count] of [['', 0], ['hello', 1], ['hello world', 2], ['1234567890', 10],
  ['<|im_start|>', 1], ['<|im_end|>', 1], ['The quick brown fox jumps over the lazy dog.', 10]]) equal(tokenizer.countText(text), count);
equal(tokenizer.countRequest('s', 'p'), 15);
equal(tokenizer.renderRequest(' s ', 'p'), '<|im_start|>system\ns<|im_end|>\n<|im_start|>user\np<|im_end|>\n<|im_start|>assistant\n');
equal(tokenizer.renderRequest('', ''), '<|im_start|>user\n<|im_end|>\n<|im_start|>assistant\n');
for (const invalid of [null, {}, { ...show, template: show.template + ' ' }, { ...show, parameters: '' },
  { ...show, system: 'unreviewed system' }, { ...show, model_info: { ...data.tokenizer, 'tokenizer.ggml.pre': 'llama-bpe' } },
  { ...show, model_info: { ...data.tokenizer, 'tokenizer.ggml.add_bos_token': true } }]) {
  assert.throws(() => tokenizer.verifyModel(invalid, tags), { code: 'DESKTOP_TOKENIZER_MODEL_MISMATCH' }); checks++;
}
assert.throws(() => tokenizer.verifyModel(show, '0'.repeat(64)), { code: 'DESKTOP_TOKENIZER_MODEL_MISMATCH' }); checks++;
for (const invalid of ['\ud800', '\udc00', 'x\ud800y']) {
  assert.throws(() => tokenizer.countText(invalid), { code: 'DESKTOP_TOKENIZER_UNSUPPORTED_UNICODE' }); checks++;
}
assert.throws(() => tokenizer.countText(null), { code: 'DESKTOP_TOKENIZER_INPUT_INVALID' }); checks++;
assert.throws(() => tokenizer.countText('x'.repeat(tokenizer.MAX_INPUT_BYTES + 1)), { code: 'DESKTOP_TOKENIZER_INPUT_TOO_LARGE' }); checks++;
const referenceSplit = /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const alphabet = Array.from("aZStmrvel'123456 !?#\r\n\t\u00e9\u4e2d\u0301\ud83d\ude00\u200d");
const samples = ['', 'hello', '1234567890', 'hello world', 'caf\u00e9', '\ud83d\ude00', '\u4e2d\u6587',
  '\u0085\u0085a', '\ufeff\ufeffa', '\u001c\u001ca', '\u0378abc', '\u2160\u2161\u2162\u2163',
  ' \n \r \tA', 'hello\u200dworld', "'RE'S'll've", '<|im_start|>system\nhello<|im_end|>',
  'a'.repeat(2000), '!@#$%^&*'.repeat(200), '\ud83d\ude00'.repeat(100), "'\u017f 'S 's 'RE 're"];
let random = 314159;
for (let trial = 0; trial < 1000; trial++) {
  let text = '';
  for (let index = 0; index < 30; index++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; text += alphabet[random % alphabet.length]; }
  equal(tokenizer.splitText(text), text.match(referenceSplit));
  if (trial < 120) samples.push(text);
}
const specials = data.tokenizer['tokenizer.ggml.tokens'].filter((_, id) => [2, 3, 4].includes(data.tokenizer['tokenizer.ggml.token_type'][id]));
for (const special of specials) { equal(tokenizer.countText(special), 1); samples.push(special); }
// Exercise the pinned Unicode category boundaries without depending on Node's
// Unicode database. Native comparison reports only counts and hashes.
const boundarySamples = [];
for (const [point] of data.unicode.ranges) {
  if (point < 0x110000 && (point < 0xd800 || point > 0xdfff)) boundarySamples.push('x' + String.fromCodePoint(point) + 'y 12\n');
}
for (let index = 0; index < boundarySamples.length; index += 100) samples.push(boundarySamples.slice(index, index + 100).join(' '));

async function main() {
  // Optional metadata-only comparison, never a model inference or state write.
  if (process.env.FEDDIT_DESKTOP_TOKENIZER_NATIVE_URL) {
    const base = process.env.FEDDIT_DESKTOP_TOKENIZER_NATIVE_URL.replace(/\/$/, '');
    let compared = 0;
    for (const text of samples) {
      const response = await fetch(base + '/tokenize', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text, add_special: false, parse_special: true }), signal: AbortSignal.timeout(10000) });
      assert(response.ok, 'Native tokenizer unavailable.');
      const native = await response.json();
      assert.equal(tokenizer.countText(text), native.tokens.length, 'Native token count mismatch for SHA-256 ' + hash(text));
      compared++;
    }
    for (const [system, prompt] of [['s', 'p'], ['', 'hello'], [' system\n', '\n\u4e2d\u6587 \ud83d\ude00\n'], ['', '']]) {
      const messages = [];
      if (system.trim()) messages.push({ role: 'system', content: system.trim() });
      messages.push({ role: 'user', content: prompt });
      const response = await fetch(base + '/apply-template', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, add_generation_prompt: true }), signal: AbortSignal.timeout(10000) });
      assert(response.ok, 'Native template unavailable.');
      const rendered = await response.json();
      equal(tokenizer.renderRequest(system, prompt), rendered.prompt);
    }
    console.log('desktop-tokenizer: ' + compared + ' native metadata-only token counts matched; four request renderings matched');
  }
  if (process.env.FEDDIT_DESKTOP_TOKENIZER_FROZEN_CASES) {
    const frozen = JSON.parse(fs.readFileSync(process.env.FEDDIT_DESKTOP_TOKENIZER_FROZEN_CASES, 'utf8'));
    for (const item of frozen.cases) {
      for (const key of ['oldPrompt', 'prompt']) {
        if (typeof item[key] !== 'string') continue;
        const rendered = tokenizer.renderRequest(item.system, item[key]);
        const response = await fetch(process.env.FEDDIT_DESKTOP_TOKENIZER_NATIVE_URL.replace(/\/$/, '') + '/tokenize', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: rendered, add_special: false, parse_special: true }), signal: AbortSignal.timeout(10000) });
        assert(response.ok, 'Native tokenizer unavailable.');
        const native = await response.json();
        equal(tokenizer.countRequest(item.system, item[key]), native.tokens.length);
        console.log(JSON.stringify({ frozenCaseSha256: hash(item.label || ''), representation: key, tokens: native.tokens.length, renderSha256: hash(rendered) }));
      }
    }
  }
  console.log('desktop-tokenizer: ' + checks + ' checks passed');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
