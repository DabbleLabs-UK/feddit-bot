'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const tokenizer = require('../lib/hosted-tokenizer');
const { extract } = require('../bin/export-hosted-tokenizer');
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../lib/hosted-tokenizer-data.json.gz'))));

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const show = {
  template: data.template,
  parameters: 'stop                           "<|im_start|>"\nstop                           "<|im_end|>"',
  model_info: data.tokenizer,
};
const tags = { models: [{ name: tokenizer.MODEL, digest: tokenizer.MANIFEST_SHA256 }] };

// Fixed vocabulary counts cover BOS, digits, byte alphabet, and literal control tokens.
for (const [input, expected] of [
  ['', 1], ['hello', 2], ['hello world', 3], ['Hello world!', 4], ['1234567890', 5],
  ['<|begin_of_text|>', 2], ['<|eot_id|>', 2], ['<|im_start|>', 7],
  ['The quick brown fox jumps over the lazy dog.', 11], ['a\n\nb', 4],
  ['caf\u00e9', 3], ['\ud83d\ude00', 3],
]) {
  assert.equal(tokenizer.countText(input), expected, JSON.stringify(input));
  assert.equal(tokenizer.countText(input, { addSpecial: false }), expected - 1);
}

assert.equal(tokenizer.renderRequest('s', 'p'), '<|im_start|>system\ns<|im_end|>\n<|im_start|>user\np<|im_end|>\n<|im_start|>assistant\n');
assert.equal(tokenizer.renderRequest('', ''), '<|im_start|>assistant\n');
assert.equal(tokenizer.countRequest('s', 'p'), tokenizer.countText(tokenizer.renderRequest('s', 'p')));
assert.equal(tokenizer.verifyModel(show, tags), true);
assert.equal(tokenizer.verifyModel(show, 'sha256:' + tokenizer.MANIFEST_SHA256), true);

const nonverbose = structuredClone(show);
nonverbose.model_info['tokenizer.ggml.tokens'] = [];
nonverbose.model_info['tokenizer.ggml.merges'] = [];
nonverbose.model_info['tokenizer.ggml.token_type'] = [];
assert.equal(tokenizer.verifyModel(nonverbose, tags), true);
for (const invalid of [
  { ...show, template: show.template + '\n' },
  { ...show, parameters: show.parameters + '\n' },
  { ...show, model_info: { ...show.model_info, 'tokenizer.ggml.pre': 'gpt2' } },
  { ...show, model_info: { ...show.model_info, 'tokenizer.ggml.bos_token_id': 0 } },
  {}, null,
]) assert.throws(() => tokenizer.verifyModel(invalid, tags), { code: 'HOSTED_TOKENIZER_MODEL_MISMATCH' });
assert.throws(() => tokenizer.verifyModel(show, { models: [] }), { code: 'HOSTED_TOKENIZER_MODEL_MISMATCH' });
assert.throws(() => tokenizer.verifyModel(show, '0'.repeat(64)), { code: 'HOSTED_TOKENIZER_MODEL_MISMATCH' });

for (const input of ['\ud800', '\udc00', 'x\ud800y']) {
  assert.throws(() => tokenizer.countText(input), { code: 'HOSTED_TOKENIZER_UNSUPPORTED_UNICODE' });
}
// Category and whitespace behavior comes from llama.cpp, including code points
// JS treats differently or may classify differently in a future Node version.
for (const [input, pieces] of [
  ['\u0085\u0085a', ['\u0085', '\u0085a']],
  ['\ufeff\ufeffa', ['\ufeff\ufeff', 'a']],
  ['\u001c\u001ca', ['\u001c\u001c', 'a']],
  ['\u0378abc', ['\u0378abc']],
  ['\u2160\u2161\u2162\u2163', ['\u2160\u2161\u2162', '\u2163']],
  [' \n \r \tA', [' \n \r', ' ', '\tA']],
  ['hello\u200dworld', ['hello', '\u200dworld']],
  ["'RE'S'll've", ["'RE", "'S", "'ll", "'ve"]],
]) assert.deepEqual(tokenizer.splitText(input), pieces);

// Independent regex differential check on a stable subset. This verifies the
// scanner's control flow without deriving expected pieces from its algorithm.
const referenceSplit = /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const alphabet = Array.from("aZStmrvel'123456 !?#\r\n\t\u00e9\u4e2d\u0301\ud83d\ude00\u200d");
let random = 314159;
for (let trial = 0; trial < 4000; trial++) {
  let input = '';
  for (let index = 0; index < 30; index++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    input += alphabet[random % alphabet.length];
  }
  assert.deepEqual(tokenizer.splitText(input), input.match(referenceSplit));
}
const unicodeBytes = fs.readFileSync(path.join(__dirname, '../lib/hosted-tokenizer-unicode.json'));
assert.equal(hash(unicodeBytes), tokenizer.UNICODE_SHA256);
const unicode = JSON.parse(unicodeBytes);
assert.equal(unicode.upstream, 'llama.cpp/b10864');
assert.equal(unicode.sourceSha256, '95170cd1c105a5b41a1b2dce73b0fae8ce8011ef7897600828bb2babe8b26e5d');
assert.equal(unicode.ranges[0][0], 0);
assert.equal(unicode.ranges.at(-1)[0], 0x110000);
assert(unicode.ranges.every(([start, flags], index) => [1, 2, 4].includes(flags) && (!index || start > unicode.ranges[index - 1][0])));
// All reserved tokens are non-overlapping, so the longest-first literal matcher
// has the same partition as llama.cpp's special-token scan for this vocabulary.
const specials = data.tokenizer['tokenizer.ggml.tokens'].filter((_, id) => data.tokenizer['tokenizer.ggml.token_type'][id] === 3);
for (const token of specials) {
  assert.equal(tokenizer.countText(token), 2);
  for (const other of specials) if (other !== token) assert(!token.includes(other));
}
assert.throws(() => tokenizer.countText(null), { code: 'HOSTED_TOKENIZER_INPUT_INVALID' });
assert.throws(() => tokenizer.renderRequest(null, ''), { code: 'HOSTED_TOKENIZER_INPUT_INVALID' });
assert.throws(() => tokenizer.countText('x'.repeat(tokenizer.MAX_INPUT_BYTES + 1)), { code: 'HOSTED_TOKENIZER_INPUT_TOO_LARGE' });
// Long adversarial pretokens exercise bounded heap merging and Unicode byte handling.
for (const input of ['a'.repeat(12000), '!@#$%^&*'.repeat(1500), '\ud83d\ude00'.repeat(1000)]) {
  const count = tokenizer.countText(input);
  assert(count > 1 && count <= Buffer.byteLength(input) + 1);
  assert.equal(count, tokenizer.countText(input));
}

const exported = extract(show, tags);
assert.equal(exported.tokenizerSha256, tokenizer.TOKENIZER_SHA256);
assert.equal(exported.templateSha256, tokenizer.TEMPLATE_SHA256);
assert.throws(() => extract(show, { models: [] }), /digest mismatch/);
assert.throws(() => extract({ ...show, model_info: { ...show.model_info, 'tokenizer.ggml.tokens': [] } }, tags), /vocabulary size/);

// Optional private regression: reads input only, emits counts/hashes, never content.
// The 3420-token reference was independently measured by the isolated exact runner.
if (process.env.FEDDIT_TOKENIZER_FROZEN_FIXTURE) {
  const fixture = JSON.parse(fs.readFileSync(process.env.FEDDIT_TOKENIZER_FROZEN_FIXTURE, 'utf8'));
  const rendered = tokenizer.renderRequest(fixture.request.system, fixture.request.prompt);
  assert.equal(hash(rendered), 'f298bd0871669d54265b23009af773b07fddf5cf02b297e4f67c946e45d97181');
  assert.equal(tokenizer.countRequest(fixture.request.system, fixture.request.prompt), 3420);
  console.log('hosted-tokenizer: private frozen render hash and 3420-token count matched');
}
console.log('hosted-tokenizer: all checks passed');
