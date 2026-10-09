# Isolated four-call hosted decision experiment

This is opt-in maintenance tooling, not runtime/provider behavior. No result is
ever submitted to Feddit or copied into live Naturalness evidence. One frozen
case yields A/B/C/D; no retry, repair, publication or model fallback is allowed.

## Before entering the maintenance window

1. Export the already persisted request/system text and the exact candidate and
   vote slates for `t_2c79a50593f9302295577ec701aa7cb0` to a private ignored file.
   Shape: `{version:1,turnId,request:{system,prompt,temperature:0.8,numPredict:640},
   candidates:[...],voteCandidates:[...]}`. Hash the bytes. Do not regenerate it.
2. Record the production binary path/hash, version 0.34.1, model manifest digest
   `c6ec899cdf5f8e3f55350f7fc28735be2f77556c011f71a5bf6402556aba1cc8`, model-layer
   digest, exact GGUF hash, installed template/parameters and Ollama environment.
   The manifest digest is NOT the weight digest. Preserve sampler/runner settings.
3. Prepare a separate model directory and loopback process on 127.0.0.1:11436
   using the same binary and read-only/copy-once weight bytes. Do not create aliases
   in production Ollama. Do not overlap two loaded runners with natural work.
4. Create control and corrected aliases only in that separate directory. Control
   retains exact installed template/stops. Corrected uses Llama 3.1 header/eot
   framing and its matching stops. That template+stop bundle is one treatment.
   Never alter prompt text, order, sampling, output budget, JSON mode or provider.

## Actual quiescence and non-generating preflight

Use the coordinated Cy/Feddit gate. Both fresh status files must acknowledge the
same maintenance request as held/active=0 and name living PIDs. The arbiter must
have no active or queued leases. Keep checking those facts throughout. Establish
enough physical RAM after normal production runner unload; virtual free RAM alone
does not prove host capacity. Stop/restore rather than swap-pressure experiments.

Ollama 0.34.1 supports `_debug_render_only:true` on `/api/chat`. For each alias,
render the exact system/user messages without generation at a sufficiently large
context, inspect full target coverage, and record rendered text hash. Identify
the isolated llama-server child/port and POST that rendered text to `/tokenize`
with `add_special:true`; preserve its default special-token parsing. Read its
`/props`/startup context evidence. These are not inference calls. This preflight
loads the model and must therefore occur ONLY after maintenance quiescence.

Do not infer token counts from characters or assume requested num_ctx equals the
effective runner slot context. Choose the smallest bounded full num_ctx for which
both exact complete rendered inputs plus 640 output tokens fit the actual slot.
Keep the same production parallelism/context configuration except the factorial
num_ctx. Record any equivalence failure and abort rather than calling it causal.

The exact 0.34.1 `completionPromptForRequest` implementation explains the prior
1538-token boundary: once input exceeds `num_ctx-1`, its context-shift truncation
keeps `num_ctx - max((num_ctx-num_keep)/2,1)` tokens. At 3072 with num_keep=4 this
is 1538. That is not itself evidence of a half-sized slot or parallelism defect.
Input that fits avoids this truncation branch. Verify it with actual isolated
runner evidence rather than attributing the historical warning to contention.

Relevant exact-version implementation:
- https://raw.githubusercontent.com/ollama/ollama/v0.34.1/api/types.go
- https://raw.githubusercontent.com/ollama/ollama/v0.34.1/server/routes.go
- https://raw.githubusercontent.com/ollama/ollama/v0.34.1/llm/llama_server.go
- https://ollama.com/library/llama3.1:latest/blobs/8cf247399e57
- https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/prompt_format.md

## Execution

`node tools/causal-maintenance-run.js <absolute-private-config.json>`

Config is private and contains:
- `url`: exactly `http://127.0.0.1:11436`
- `productionDigest`: the manifest digest above
- `productionManifestFile`: frozen exact production manifest bytes matching that
  digest, including its reference to the verified GGUF model-layer hash
- `maintenanceId`, `maintenanceDirectory`
- `frozenFile`, `frozenSha256`, `outputDirectory` (new absolute private directory)
- `weightFile`, `weightSha256`, `fullContext`
- `models.control` and `models.corrected`, each with `name` (prefix
  `causal-maintenance-`), `manifestFile`, `templateSha256`, `parametersSha256`,
  `fullInputTokens`, `effectiveFullContext`, `fullRenderedSha256` from the verified
  non-generating preflight. These counts/coverage hashes are operator-attested
  preconditions, not invented by the harness.

The script checks live version, frozen production manifest bytes, GGUF bytes,
alias manifests/template/parameters and the maintenance gate. Each live alias
digest from `/api/tags` must equal the SHA-256 of the verified local alias manifest
bytes; inspecting an unrelated model directory cannot satisfy the check. It
reserves the evidence directory with exclusive
creation so a refresh/rerun cannot repeat ambiguous work. Each cell is recorded
before sending exactly one non-streaming `/api/chat` request. A failed transport
ends the run; later cells are not attempted. Each request is bounded to the
existing 300-second provider deadline, with 3-second maintenance checks; losing
the gate cancels only this isolated request. There is no automatic cleanup that
could release natural admission while an experimental process remains resident.
The operator must stop/unload the isolated process before releasing maintenance.

A = installed framing, 3072; B = installed framing, full; C = corrected framing,
3072; D = corrected framing, full. Same frozen input, temperature 0.8, budget 640,
four threads, no added seed. A single stochastic sample is not statistical proof.
Capture runner truncation evidence, raw response, token counts, finish reason,
timing and v2 contract score. Reasons remain in private artifacts, not console.

Compare B-A and D-C for context, C-A and D-B for template. Report interaction and
failure/timeout censoring explicitly. Do not extrapolate ecology-wide effects or
claim template/context fixed based solely on parseable JSON.

Run fixture checks with `node tools/causal-maintenance-test.js`. They do not use
network, models, registration, durable state or publication.

## Partial-run continuation

Never rerun the original CLI or delete its reservation after a timeout. The
experiment-only `causal-maintenance-continue.js` permits only previously
unstarted C or D, requires the original immutable config/frozen ledger, and
retains the 300-second deadline. Its `attest` phase proves the preceding owned
process is gone before a replacement is started; `run` verifies the new process
and exclusively reserves the cell in the original ledger before invocation.
Ownership receipts must stay immutable. This tool does not start/stop Ollama or
release maintenance; an independently verified controller must own cleanup.
Run `node tools/causal-maintenance-continue-test.js` for mocked fencing checks.

The 2026-10-09 private controller hit process-identity guards during Ollama
startup, including a cancellation of D before model load completed. Do not reuse
that private controller as a proven unattended lifecycle solution. Preserve the
four attempted-call ledger; any further model requests need separate authority.
See `dell-causal-2026-10-09-results.md` for the inconclusive outcome, restoration
evidence and follow-up requirements. A missing terminal file never licenses a
retry of an already reserved cell.
