# Hosted structured decision validity: implementation held for native validation

Date: 2026-10-15. No deployment, public release or experimental inference.

## Verified production and retained sample

Remote authoritative progressive-bot-platform remains 0d1200c. The actual hosted
runner is caa4c6d, whose retained construction-v2 source is the repair base
c29ace7. The separately supervised non-streaming DELL worker is 67950b5, with
recovery documentation at 7a1dd06. Read-only checks confirmed fresh readiness,
zero supervisor restarts, Ollama 0.34.1 and the existing shared 3072-context,
four-thread execution profile. No maintenance owner existed at inspection; Cy
and Feddit had ordinary admitted work. No gate was taken for this task.

The audit cohort is 38 reply-due turns admitted between 2026-10-14 14:14:19 UTC
and 2026-10-15 17:45:00 UTC with actual initial model results. There are 22
existing single repair calls. A second read-only classifier ran entirely on
VPS3; only IDs, JSON/contract categories, marker tokens, key types, token counts
and timing came back. Raw private prompts/responses were not transferred.
Ignored local evidence: artifacts/validity/taxonomy-metadata.json.

| Mutually exclusive response category | Initial | Repair | Final |
| --- | ---: | ---: | ---: |
| Complete valid primary and all offered votes explicit | 15 | 2 | 17 |
| Valid primary, incomplete votes | 1 | 0 | 1 |
| JSON object with surrounding template marker leakage | 9 | 9 | 9 |
| Malformed JSON syntax | 10 | 8 | 8 |
| JSON object with surrounding non-marker prose | 2 | 1 | 1 |
| Non-JSON prose | 1 | 1 | 1 |
| Parseable JSON with invalid primary choice | 0 | 1 | 1 |
| Total | 38 | 22 | 38 |

The final invalid-primary rate is 20/38 (52.6%), while full contract validity is
only 17/38 (44.7%), not 18/38. The remaining valid-primary turn omitted two of
three offered votes. Final responses contain 17 explicit decisions across 35
offered vote appearances; 16 invalid and two missing entries remain unresolved.
These are technical losses, not evidence of social abstention.

All 60 calls matched their exact frozen input counts: 849-2347 tokens, median
2214.5. Initial output counts are 8-172 (median 55.5); repair counts 25-138
(median 52), well below 640. Historical finish reasons were discarded, so output
truncation cannot be excluded categorically, but it is not supported as a
dominant explanation. Silent input overflow is not the cause of these cases.

Safe shape examples, not private response excerpts:

- A complete object followed by the literal marker fragment |im_end|>.
- A JSON-shaped object with invalid punctuation or quoting.
- A valid choice/reason/votes object that omits two offered vote IDs.
- A parseable object with an unoffered primary choice and a valid independent
  vote. The primary remains invalid while that vote retains existing semantics.

## Proven causes versus likely contributors

Proven: generation is unconstrained text. No native format/schema is requested.
The strict semantic parser correctly rejects malformed/wrapped output. Repair
repeats the same bounded prompt with a generic admonition; it receives neither
the failed response nor a specific validator error. Only an invalid primary
choice triggers repair. Consequently, a valid primary with missing votes is not
repaired. No extra repair calls are added by this change.

Proven: the current Llama model still has ChatML framing and ChatML stops. Twelve
final responses leak marker text (nine wrapping otherwise parseable JSON and
three also syntactically malformed). A causal template contribution remains
likely, not established by this taxonomy. Changing that verified template would
also change token rendering and shared Cy behavior, so it is not this fix.

Prompt examples still contain ellipsis placeholders, and vote reason guidance
says three words while validation also requires 15 characters. These are real
contract presentation weaknesses, but their individual contribution has not
been measured. The present change deliberately does not alter construction,
prompts, personas, temperature, output allowance, candidate order or model.

## Small response-format-only candidate fix

New hosted capability turns freeze hostedDecisionFormatVersion=1 independently
of decision-contract v2 and construction-v2. After unchanged packing, the runner
persists only {version:1,candidateIds:[...],voteIds:[...]} in the generation
request. IDs are unique and bounded to the actually offered C1-C12 and V1-V8
slates. Empty slates, additional fields and unknown versions fail closed.

The worker derives a deterministic native Ollama format schema. It constrains
choice to WAIT or an offered action, requires choice/reason/votes, and gives the
votes array one ordered tuple entry per offered ID. Each entry still lets the
model independently choose up, down or nil and write its own reason. There are
no fabricated defaults, filled decisions, direction heuristics or JSON salvage.
Existing reason validation, partial-valid-vote semantics, explicit WAIT and
unresolved/considered-state rules remain authoritative after generation.

The schema is a native request field, not extra prompt text. Existing model,
version, exact tokenizer and budget verification still run before inference.
Context 3072, output 640 and safety 64 are unchanged. Budget construction,
tokenizer, parser, voting, discovery receipts and continuation guards have no
source changes. Only formatted results gain stop/length/unknown finish metadata.

Ollama documents native schema output, but API documentation and mocked shape
tests do NOT prove tuple enforcement by this installed model/runtime:
https://docs.ollama.com/capabilities/structured-outputs
https://raw.githubusercontent.com/ollama/ollama/v0.34.1/api/types.go

## Durable compatibility and deployment boundary

Missing response-format versions mean legacy unformatted inference. Existing
request signatures and result shapes remain exact, including old construction-v2
turns and repairs across restart. Unknown future versions block profile ownership
rather than discarding the turn. No historical considered state is rewritten.
There is still at most one existing repair, not a new retry loop.

The runner branch uses the current streaming local adapter. A separate companion
worker branch, fix/hosted-structured-decision-worker, is based on 7a1dd06 and
ports only descriptor/native-format handling into the actual non-streaming
adapter. Do not deploy the runner tree wholesale as the DELL worker: that would
lose recovered transport/supervision. Shared format-module bytes match exactly.
Before any future deployment, validate the native schema, deploy the compatible
worker first, verify readiness, then deploy the runner. Rollback must retain a
format-aware runner/worker or drain all format-v1 turns first. Old deployed
binaries do not understand this new field. No desktop package is required here.

## Tests and outstanding validation gate

All 23 affected test suites passed, including the in-memory mocked scheduler
portion. Focused final checks: format 109, durable scheduler 598, budget 32,
budget-v2 239, frozen budget validation 26, decision contract 91, continuation
guard 135, continuation 37, Speed 44 and Burst 39. Additional passing suites
cover voting, action candidates, provider contracts, queue, DELL, worker,
tokenizer, attention, recent threads and Naturalness shapes/scheduling. The
separate production-worker port passes format 62, worker 20, maintenance 62 and
bounded operational logging 107.

Windows sandbox TEMP rename and a fake-loopback EACCES were harness constraints;
workspace TEMP and a narrow identical loopback test rerun passed. The legacy
scheduler suite's unconditional live smoke invocation was suppressed only in
memory, with unexpected live fetch fail-closed. No assertion or tracked test was
weakened; no model/retrieval/publication call was made.

Safety review blocked copying full private prompt/response cases from VPS3 into
local experiment files pending explicit approval. Metadata-only classification
was completed instead. Exact frozen native comparison is therefore outstanding.
Proposed bound: three representative pairs, six calls maximum, identical frozen
system/prompt/slate/settings within each pair; only native format differs. Use
the real compatible non-streaming adapter and existing shared admission/gates,
stop on any budget/native-enforcement problem, never publish/apply results, and
restore any owned hold in finally. No new bespoke inference system is needed.

Status: implementation and mock/replay coverage prepared, NOT ready for controlled
hosted deployment until actual 0.34.1 tuple enforcement, unchanged native input
counts and materially improved full contract validity are demonstrated. No
before/after real-model improvement is claimed.

The desktop canary still contains p_swb8djuqg1y4, p_7gc83gbxvjpc and
p_e4l36dfw9wrl. A read-only settings check found global pause ON again; this task
did not change it or establish ownership, and deliberately left it untouched.
Claim-response/HTTP 5xx/lease recovery and template causality remain separate.
