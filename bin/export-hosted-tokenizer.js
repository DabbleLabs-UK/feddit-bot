'use strict';

// Explicit maintenance utility: reads public model metadata, never loads a runner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const MODEL = 'hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M';
const DIGEST = 'c6ec899cdf5f8e3f55350f7fc28735be2f77556c011f71a5bf6402556aba1cc8';
const WEIGHT = '7afb333a43c3cd660e0a9720828ae963336796377dbf189c6a33a403527c6785';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function extract(show, tags) {
  const record = tags.models.find((item) => item.name === MODEL || item.model === MODEL);
  if (!record || record.digest.replace(/^sha256:/, '') !== DIGEST) throw new Error('Production model digest mismatch.');
  const info = show.model_info;
  if (info['tokenizer.ggml.model'] !== 'gpt2' || info['tokenizer.ggml.pre'] !== 'llama-bpe') throw new Error('Unsupported tokenizer.');
  const tokenizer = {};
  for (const key of Object.keys(info).filter((key) => key.startsWith('tokenizer.ggml.')).sort()) tokenizer[key] = info[key];
  if (tokenizer['tokenizer.ggml.tokens'].length !== 128256 || tokenizer['tokenizer.ggml.merges'].length !== 280147) throw new Error('Unexpected vocabulary size.');
  const data = {
    format: 1, model: MODEL, manifestSha256: DIGEST, weightSha256: WEIGHT,
    template: show.template, templateSha256: sha(show.template), parametersSha256: sha(show.parameters),
    tokenizerSha256: sha(JSON.stringify(tokenizer)), tokenizer,
    source: 'https://huggingface.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF',
    license: 'https://www.llama.com/llama3_1/license/',
    _note: 'Public GGUF tokenizer metadata exported via Ollama /api/show verbose:true. No prompts or inference output. llama-bpe defaults: add_bos=true, add_eos=false, ignore_merges=true.',
  };
  return data;
}

function extractUnicode(source) {
  const sourceSha256 = sha(source);
  if (sourceSha256 !== '95170cd1c105a5b41a1b2dce73b0fae8ce8011ef7897600828bb2babe8b26e5d') throw new Error('Pinned Unicode source hash mismatch.');
  function section(name) {
    const start = source.indexOf(name + ' = {');
    if (start < 0) throw new Error('Missing Unicode table.');
    return source.slice(start, source.indexOf('\n};', start));
  }
  function pairs(name) { return [...section(name).matchAll(/\{0x([0-9A-Fa-f]+), 0x([0-9A-Fa-f]+)\}/g)].map((match) => [parseInt(match[1], 16), parseInt(match[2], 16)]); }
  const ranges = [];
  for (const [start, flags] of pairs('unicode_ranges_flags')) {
    // Only number, letter, and nonzero-ness are needed by the Llama3 scanner.
    const relevant = flags & 6 || 1;
    if (!ranges.length || ranges.at(-1)[1] !== relevant || start === 0x110000) ranges.push([start, relevant]);
  }
  const whitespace = [...section('unicode_set_whitespace').matchAll(/0x([0-9A-Fa-f]+)/g)].map((match) => parseInt(match[1], 16));
  const contractionLetters = new Set(Array.from('stm drvel'.replaceAll(' ', ''), (letter) => letter.codePointAt(0)));
  const contractionLowercase = pairs('unicode_map_lowercase').filter(([, lower]) => contractionLetters.has(lower));
  if (ranges[0][0] !== 0 || ranges.at(-1)[0] !== 0x110000 || whitespace.length !== 25) throw new Error('Unexpected Unicode source structure.');
  return { format: 1, upstream: 'llama.cpp/b10864', sourceSha256, ranges, whitespace, contractionLowercase };
}

async function main() {
  if (process.argv[2] === '--unicode') {
    const url = 'https://raw.githubusercontent.com/ggml-org/llama.cpp/b10864/src/unicode-data.cpp';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Unicode source request failed: ' + response.status);
    const data = extractUnicode(await response.text());
    const bytes = Buffer.from(JSON.stringify(data));
    const output = path.resolve(__dirname, '../lib/hosted-tokenizer-unicode.json');
    fs.writeFileSync(output, bytes);
    console.log(JSON.stringify({ output, bytes: bytes.length, sha256: sha(bytes), ranges: data.ranges.length, whitespace: data.whitespace.length, contractionLowercase: data.contractionLowercase.length }));
    return;
  }
  if (process.argv[2] !== '--dell') throw new Error('Usage: node bin/export-hosted-tokenizer.js --dell [output.json.gz]');
  const ps = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
    '$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    `$s=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/show' -Method Post -ContentType 'application/json' -Body '${JSON.stringify({ model: MODEL, verbose: true })}'`,
    "$t=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags'",
    '@{show=$s;tags=$t}|ConvertTo-Json -Depth 30 -Compress',
  ].join(';');
  const raw = execFileSync('ssh', ['dell', 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  const response = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const data = extract(response.show, response.tags);
  const output = path.resolve(process.argv[3] || path.join(__dirname, '../lib/hosted-tokenizer-data.json.gz'));
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
  fs.writeFileSync(output, bytes);
  console.log(JSON.stringify({ output, bytes: bytes.length, tokenizerSha256: data.tokenizerSha256, templateSha256: data.templateSha256 }));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { extract, extractUnicode };
