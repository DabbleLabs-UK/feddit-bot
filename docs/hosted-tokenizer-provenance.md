# Hosted tokenizer provenance

`lib/hosted-tokenizer-data.json.gz` contains only the public GGUF tokenizer
metadata and framing identity for
`hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M`.
It contains no prompts, bot profiles, user content, credentials, or inference
outputs. It was exported on 2026-10-09 with the read-only `/api/show` endpoint
(`verbose:true`) and `/api/tags`, without loading a model or creating a runner.

Source model: https://huggingface.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF

## Built with Llama

The tokenizer data retains the upstream Llama 3.1 Community License; the
implementation includes a port of the MIT-licensed llama.cpp pre-tokenizer.
The complete official Llama agreement is
included in [LICENSE.txt](../lib/third-party/llama31/LICENSE.txt), with the exact
required attribution in [Notice.txt](../lib/third-party/llama31/Notice.txt).
[Bundled product documentation](../lib/third-party/llama31/README.md) prominently
identifies the Llama component. These files live under `lib` so the existing
desktop packaging includes them alongside the tokenizer asset.

Concrete redistribution requirements from sections 1.b.i, 1.b.iii, and 1.b.iv:

- Keep the full agreement and Notice text file with every distributed copy of
  the tokenizer data, including packaged desktop builds.
- Prominently display "Built with Llama" in related product documentation or one
  of the other locations the agreement lists. Preserve the bundled attribution
  and put the same phrase in public product documentation for a public release.
- Use must comply with applicable laws and Meta's incorporated
  [Acceptable Use Policy](https://llama.meta.com/llama3_1/use-policy).

Section 1.b.i separately requires a Llama-prefixed model name if these materials
or their outputs are used to create, train, fine tune, or improve an AI model
that is made available. Section 2 states additional terms for licensees above
its specified 700-million monthly-active-user threshold at the release date.
The full agreement remains authoritative; this list describes its explicit
requirements without making an eligibility determination.

Official agreement source (retrieved 2026-10-09):
https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/LICENSE

Pinned identities:

- Manifest: `c6ec899cdf5f8e3f55350f7fc28735be2f77556c011f71a5bf6402556aba1cc8`
- GGUF layer: `7afb333a43c3cd660e0a9720828ae963336796377dbf189c6a33a403527c6785`
- Tokenizer metadata: `7403ff073b4c2dd6c391ab73befd498a60aff4ac388f70193139d0af1d15308a`
- Raw installed template: `62fbfd9ed093d6e5ac83190c86eec5369317919f4b149598d2dbb38900e9faef`
- Installed parameters: `8685c085645e701326881085cfd91cd1fa6f8aff42eba39a99ecf35a60be8eab`

The tokenizer uses the ordered GGUF merge list, reversible GPT-2 byte alphabet,
the exact pinned Llama 3 pre-tokenizer, direct whole-pretoken lookup (`ignore_merges`), and
the installed vocabulary's special tokens. `llama-bpe` defaults to one added
BOS and no EOS. The renderer reproduces the installed legacy ChatML template
for one system message and one user message; Ollama cuts the template at the
final `.Response`, leaving the assistant prefix open.

Implementation references:

- https://raw.githubusercontent.com/ollama/ollama/v0.34.1/server/routes.go
- https://raw.githubusercontent.com/ollama/ollama/v0.34.1/template/template.go
- https://github.com/ollama/ollama/blob/v0.34.1/LLAMA_CPP_VERSION
- https://github.com/ggml-org/llama.cpp/blob/b10864/src/llama-vocab.cpp
- https://github.com/ggml-org/llama.cpp/blob/b10864/src/unicode.cpp
- https://github.com/ggml-org/llama.cpp/blob/b10864/src/unicode-data.cpp

The existing isolated-runner measurement is an independent private regression:
render SHA `f298bd0871669d54265b23009af773b07fddf5cf02b297e4f67c946e45d97181`,
full input 3420 tokens. The offline implementation reproduces both exactly.
Set `FEDDIT_TOKENIZER_FROZEN_FIXTURE` to the local private `frozen.json` when
running `node test/hosted-tokenizer.js` to exercise it without copying private
input into the repository or emitting its contents.

Ollama 0.34.1 pins llama.cpp `b10864`. That version uses the handwritten
`unicode_regex_split_custom_llama3` scanner, not a host regex implementation.
The local scanner reproduces its ordered rules with pinned number, letter,
whitespace, and contraction-lowercase data. No runtime JavaScript Unicode
property, case-conversion, or whitespace classification is used. Thus a Node
Unicode upgrade cannot silently change counts for newly assigned characters.
The 15,400-byte `lib/hosted-tokenizer-unicode.json` was derived from the exact
upstream Unicode source, SHA-256
`95170cd1c105a5b41a1b2dce73b0fae8ce8011ef7897600828bb2babe8b26e5d`.
The derived asset SHA-256 is
`6b0e91cfa8772399339904d920d4a3d63c363cd32eac5f4da66aed71212477f0`.
Its scanner and data are covered by the bundled
[llama.cpp MIT license](../lib/third-party/llama31/llama.cpp-LICENSE.txt).

Ill-formed UTF-16 fails closed. Valid but unassigned code points use the pinned
upstream undefined category. No general character-to-token ratio is used.
Input work is bounded to 128 KiB. The caller must retain output
headroom and a safety margin and verify the live model/template identity before
admitting a request. This module does not change inference options or templates.

`node bin/export-hosted-tokenizer.js --dell` is an explicit maintenance operation,
not a runtime dependency. Exporting a replacement does not automatically update
the pinned hashes in code: a changed model requires review and regression checks.
`node bin/export-hosted-tokenizer.js --unicode` regenerates the Unicode asset
from the pinned, hash-checked public source without model calls.
