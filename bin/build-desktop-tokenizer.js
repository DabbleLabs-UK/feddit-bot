'use strict';

// Explicit metadata-only export. This never submits an inference request.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MODEL = 'qwen3:4b-instruct';
const DIGEST = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function extract(show, tags, unicode) {
  const model = tags.models?.find(item => item.name === MODEL || item.model === MODEL);
  if (model?.digest?.replace(/^sha256:/, '') !== DIGEST) throw new Error('Desktop model digest mismatch.');
  const tokenizer = {};
  for (const key of Object.keys(show.model_info || {}).filter(key => key.startsWith('tokenizer.ggml.')).sort()) tokenizer[key] = show.model_info[key];
  if (tokenizer['tokenizer.ggml.pre'] !== 'qwen2' || tokenizer['tokenizer.ggml.model'] !== 'gpt2' ||
      tokenizer['tokenizer.ggml.add_bos_token'] !== false || tokenizer['tokenizer.ggml.tokens']?.length !== 151936 ||
      tokenizer['tokenizer.ggml.merges']?.length !== 151387) throw new Error('Unsupported desktop tokenizer.');
  return { format: 1, model: MODEL, digest: DIGEST, tokenizer, template: show.template, parameters: show.parameters,
    tokenizerSha256: hash(JSON.stringify(tokenizer)), templateSha256: hash(show.template),
    parametersSha256: hash(show.parameters), unicode, unicodeSha256: hash(JSON.stringify(unicode)),
    source: 'https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507',
    _note: 'Public tokenizer metadata only; Qwen2 byte BPE, no BOS/EOS insertion. Unicode categories reuse the pinned llama.cpp b10864 tables.' };
}

async function main() {
  if (process.argv[2] !== '--local-metadata') throw new Error('Usage: node bin/build-desktop-tokenizer.js --local-metadata');
  const base = 'http://127.0.0.1:11434';
  const [showResponse, tagsResponse] = await Promise.all([
    fetch(base + '/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, verbose: true }) }),
    fetch(base + '/api/tags'),
  ]);
  if (!showResponse.ok || !tagsResponse.ok) throw new Error('Model metadata unavailable.');
  const unicode = JSON.parse(fs.readFileSync(path.join(__dirname, '../lib/hosted-tokenizer-unicode.json'), 'utf8'));
  const show = await showResponse.json();
  const data = extract(show, await tagsResponse.json(), unicode);
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
  fs.writeFileSync(path.join(__dirname, '../lib/desktop-tokenizer-data.json.gz'), bytes);
  fs.mkdirSync(path.join(__dirname, '../lib/third-party/qwen3'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../lib/third-party/qwen3/LICENSE.txt'), show.license);
  console.log(JSON.stringify({ bytes: bytes.length, tokenizerSha256: data.tokenizerSha256,
    templateSha256: data.templateSha256, parametersSha256: data.parametersSha256, unicodeSha256: data.unicodeSha256 }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { MODEL, DIGEST, extract };
