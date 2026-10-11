'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const MODEL = 'hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M';
const MANIFEST_SHA256 = 'c6ec899cdf5f8e3f55350f7fc28735be2f77556c011f71a5bf6402556aba1cc8';
const TOKENIZER_SHA256 = '7403ff073b4c2dd6c391ab73befd498a60aff4ac388f70193139d0af1d15308a';
const TEMPLATE_SHA256 = '62fbfd9ed093d6e5ac83190c86eec5369317919f4b149598d2dbb38900e9faef';
const PARAMETERS_SHA256 = '8685c085645e701326881085cfd91cd1fa6f8aff42eba39a99ecf35a60be8eab';
const UNICODE_SHA256 = '6b0e91cfa8772399339904d920d4a3d63c363cd32eac5f4da66aed71212477f0';
const MAX_INPUT_BYTES = 128 * 1024;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
let state;

function failure(message, code = 'HOSTED_TOKENIZER_MODEL_MISMATCH') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function load() {
  if (state) return state;
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'hosted-tokenizer-data.json.gz'))));
  if (data.format !== 1 || data.model !== MODEL || data.manifestSha256 !== MANIFEST_SHA256 ||
      sha(JSON.stringify(data.tokenizer)) !== TOKENIZER_SHA256 || sha(data.template) !== TEMPLATE_SHA256 || data.parametersSha256 !== PARAMETERS_SHA256) {
    throw failure('Hosted tokenizer asset identity mismatch.');
  }
  const metadata = data.tokenizer;
  const vocab = new Map(metadata['tokenizer.ggml.tokens'].map((word, id) => [word, id]));
  const ranks = new Map(metadata['tokenizer.ggml.merges'].map((pair, rank) => [pair, rank]));
  // The byte alphabet used by GPT-2 BPE is a reversible mapping, not UTF-8 text.
  const alphabet = [];
  const visible = [];
  for (let byte = 0; byte < 256; byte++) if ((byte >= 33 && byte <= 126) || (byte >= 161 && byte <= 172) || byte >= 174) visible.push(byte);
  let extra = 0;
  for (let byte = 0; byte < 256; byte++) alphabet[byte] = String.fromCodePoint(visible.includes(byte) ? byte : 256 + extra++);
  const specials = metadata['tokenizer.ggml.tokens'].filter((_, id) => [2, 3, 4].includes(metadata['tokenizer.ggml.token_type'][id]));
  specials.sort((a, b) => b.length - a.length);
  const specialPattern = new RegExp(specials.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const unicodeBytes = fs.readFileSync(path.join(__dirname, 'hosted-tokenizer-unicode.json'));
  if (sha(unicodeBytes) !== UNICODE_SHA256) throw failure('Hosted Unicode table identity mismatch.');
  const unicode = JSON.parse(unicodeBytes);
  const flags = new Uint16Array(0x110000);
  for (let index = 0; index < unicode.ranges.length - 1; index++) flags.fill(unicode.ranges[index][1], unicode.ranges[index][0], unicode.ranges[index + 1][0]);
  for (const codepoint of unicode.whitespace) flags[codepoint] |= 256;
  state = { data, metadata, vocab, ranks, alphabet, specialPattern, flags, lowercase: new Map(unicode.contractionLowercase) };
  return state;
}

// A stable priority queue preserves llama.cpp's rank then left-position ordering.
function earlier(a, b) { return a.rank < b.rank || (a.rank === b.rank && a.left < b.left); }
function push(heap, item) {
  heap.push(item);
  let at = heap.length - 1;
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (!earlier(item, heap[parent])) break;
    heap[at] = heap[parent]; at = parent;
  }
  heap[at] = item;
}
function pop(heap) {
  const first = heap[0], last = heap.pop();
  if (heap.length) {
    let at = 0;
    while (at * 2 + 1 < heap.length) {
      let child = at * 2 + 1;
      if (child + 1 < heap.length && earlier(heap[child + 1], heap[child])) child++;
      if (!earlier(heap[child], last)) break;
      heap[at] = heap[child]; at = child;
    }
    heap[at] = last;
  }
  return first;
}

function countPiece(piece, context) {
  const bytes = Buffer.from(piece, 'utf8');
  let encoded = '';
  for (const byte of bytes) encoded += context.alphabet[byte];
  // llama-bpe sets ignore_merges: an entire known pretoken is already one token.
  if (context.vocab.has(encoded)) return 1;
  const nodes = Array.from(encoded, (text, index) => ({ text, previous: index - 1, next: index + 1, live: true }));
  nodes[nodes.length - 1].next = -1;
  const heap = [];
  function add(left) {
    if (left < 0 || !nodes[left].live) return;
    const right = nodes[left].next;
    if (right < 0) return;
    const rank = context.ranks.get(nodes[left].text + ' ' + nodes[right].text);
    if (rank !== undefined) push(heap, { left, right, rank, leftText: nodes[left].text, rightText: nodes[right].text });
  }
  for (let index = 0; index < nodes.length - 1; index++) add(index);
  let total = nodes.length;
  while (heap.length) {
    const pair = pop(heap), left = nodes[pair.left], right = nodes[pair.right];
    if (!left.live || !right.live || left.next !== pair.right || left.text !== pair.leftText || right.text !== pair.rightText) continue;
    left.text += right.text; left.next = right.next; right.live = false; total--;
    if (right.next >= 0) nodes[right.next].previous = pair.left;
    add(left.previous); add(pair.left);
  }
  // Every terminal merge must name a token; malformed assets fail closed.
  for (const node of nodes) if (node.live && !context.vocab.has(node.text)) throw failure('Unknown BPE terminal token.');
  return total;
}

function validateText(text) {
  if (typeof text !== 'string') throw failure('Hosted tokenizer requires text.', 'HOSTED_TOKENIZER_INPUT_INVALID');
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) throw failure('Hosted tokenizer input exceeds bounded work limit.', 'HOSTED_TOKENIZER_INPUT_TOO_LARGE');
  // Reject ill-formed UTF-16; every valid code point uses pinned C++ categories.
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw failure('Ill-formed Unicode in hosted prompt.', 'HOSTED_TOKENIZER_UNSUPPORTED_UNICODE');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw failure('Ill-formed Unicode in hosted prompt.', 'HOSTED_TOKENIZER_UNSUPPORTED_UNICODE');
  }
}

// Equivalent to llama.cpp b10864 unicode_regex_split_custom_llama3. Using its
// pinned tables avoids JS Unicode-version and regex-whitespace differences.
// Derived implementation: see third-party/llama31/llama.cpp-LICENSE.txt.
function splitText(text) {
  validateText(text);
  return splitOrdinary(text, load());
}
function splitOrdinary(text, context) {
  const characters = Array.from(text);
  const points = characters.map((character) => character.codePointAt(0));
  const kinds = points.map((point) => context.flags[point]);
  const kind = (index) => index < kinds.length ? kinds[index] : 0;
  const point = (index) => index < points.length ? points[index] : -1;
  const lower = (index) => context.lowercase.get(point(index)) ?? point(index);
  const newline = (index) => point(index) === 10 || point(index) === 13;
  const pieces = [];
  let position = 0;
  while (position < points.length) {
    const start = position;
    const current = point(position), flags = kind(position);
    if (current === 39 && position + 1 < points.length) {
      const next = lower(position + 1), after = lower(position + 2);
      if ([115, 116, 109, 100].includes(next)) position += 2;
      else if ((next === 114 || next === 118) && after === 101 || next === 108 && after === 108) position += 3;
    }
    if (position === start && !newline(position) && !(flags & 2) && (flags & 4 || kind(position + 1) & 4)) {
      position++;
      while (kind(position) & 4) position++;
    }
    if (position === start && flags & 2) {
      // The C++ numeric loop emits each complete group of three immediately.
      position++;
      while (position - start < 3 && kind(position) & 2) position++;
    }
    if (position === start) {
      let second = current === 32 ? kind(position + 1) : flags;
      if (!(second & 262) && flags) {
        if (current === 32) position++;
        while (second && !(second & 262)) second = kind(++position);
        while (newline(position)) position++;
      }
    }
    if (position === start) {
      let whitespaceEnd = position, lastNewlineEnd = -1;
      while (kind(whitespaceEnd) & 256) {
        if (newline(whitespaceEnd)) lastNewlineEnd = whitespaceEnd + 1;
        whitespaceEnd++;
      }
      if (lastNewlineEnd > position) position = lastNewlineEnd;
      else if (whitespaceEnd - position > 1 && whitespaceEnd < points.length) position = whitespaceEnd - 1;
      else if (whitespaceEnd > position) position = whitespaceEnd;
      else position++;
    }
    pieces.push(characters.slice(start, position).join(''));
  }
  return pieces;
}

function countText(text, { addSpecial = true } = {}) {
  validateText(text);
  const context = load();
  let count = addSpecial ? 1 : 0; // Verified llama-bpe default: BOS, no EOS.
  function ordinary(fragment) {
    for (const piece of splitOrdinary(fragment, context)) count += countPiece(piece, context);
  }
  let at = 0;
  for (const match of text.matchAll(context.specialPattern)) {
    ordinary(text.slice(at, match.index)); count++; at = match.index + match[0].length;
  }
  ordinary(text.slice(at));
  return count;
}

function renderRequest(system, prompt) {
  if (typeof system !== 'string' || typeof prompt !== 'string') throw failure('Hosted request requires system and prompt strings.', 'HOSTED_TOKENIZER_INPUT_INVALID');
  system = system.trim(); // Match the actual Ollama buildMessages boundary.
  return (system ? '<|im_start|>system\n' + system + '<|im_end|>\n' : '') +
    (prompt ? '<|im_start|>user\n' + prompt + '<|im_end|>\n' : '') + '<|im_start|>assistant\n';
}
function countRequest(system, prompt) { return countText(renderRequest(system, prompt)); }

function verifyModel(show, tagsOrDigest) {
  const context = load();
  const record = tagsOrDigest && typeof tagsOrDigest === 'object' ? tagsOrDigest.models?.find((item) => item.name === MODEL || item.model === MODEL) : null;
  const digest = typeof tagsOrDigest === 'string' ? tagsOrDigest : record?.digest;
  const info = show?.model_info;
  if (typeof digest !== 'string' || digest.replace(/^sha256:/, '') !== MANIFEST_SHA256 ||
      typeof show?.template !== 'string' || sha(show.template) !== TEMPLATE_SHA256 ||
      typeof show?.parameters !== 'string' || sha(show.parameters) !== PARAMETERS_SHA256 ||
      (show.system != null && show.system !== '') ||
      info?.['tokenizer.ggml.model'] !== 'gpt2' || info?.['tokenizer.ggml.pre'] !== 'llama-bpe' ||
      info?.['tokenizer.ggml.bos_token_id'] !== 128000 || info?.['tokenizer.ggml.eos_token_id'] !== 128009) {
    throw failure('Production model does not match the pinned hosted tokenizer.');
  }
  return true;
}

module.exports = { MODEL, MANIFEST_SHA256, TOKENIZER_SHA256, TEMPLATE_SHA256, PARAMETERS_SHA256, UNICODE_SHA256, MAX_INPUT_BYTES,
  countRequest, countText, splitText, renderRequest, verifyModel };
