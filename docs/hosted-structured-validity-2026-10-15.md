# Hosted structured decision validity: native validation completed, candidate held

Date: 2026-10-15. No deployment or public release. Six explicitly authorized
frozen inference calls were completed; the bounded results are below.

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
and timing came back. Jody subsequently explicitly approved private frozen-case
transfer: 38 cases were retained in an owner-protected ignored local file, and
only three selected cases were copied into an owner-protected DELL experiment
directory. Credentials were excluded by a field whitelist. Raw prompts and
responses remain outside Git and outside live Naturalness evidence.
Ignored local evidence: artifacts/validity/taxonomy-metadata.json and the
approved private-corpus/private-protocol/private-results files.

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

Five of the eight final syntax failures repeat a malformed separator/key
boundary before the vote array. The others include an unquoted votes key,
broken closing material and an incomplete outer object. These are model-output
syntax failures, not a license to reconstruct missing punctuation or intent.

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

## Tests

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
weakened; automated suites made no real model/retrieval/publication call. The
validation utility additionally passes 39 mocked checks, including URL-object
receipts, actual acquire cancellation, maintenance admission checks, exact native
schema attribution and refusal to retry or clear an existing ledger.

## Actual bounded native validation

The experiment used the exact non-streaming worker/provider from 5ddf99b,
the verified Ollama 0.34.1 model/template, 3072 context, 640 output, four threads,
temperature 0.8 and the original complete frozen system/prompt/slates. Only the
native format field differed within each pair. Order was control/schema,
schema/control, control/schema. No fixed seed was introduced. These are small
stochastic observations, not a rate estimate. Cold/warm cache and natural
admission waits mean durations must not be interpreted as a schema speed effect.

Protocol SHA-256:
7fbdd4e4ae99c135f5dafb9afb8135c0559c191bef537e970bb524ffa1b8f6a7.
DELL private directory: C:/dev/feddit-format-validation/20261015-six-call.
Original execution utility: daae5e7. Continuation utility: 170b143. Strict
post-rescoring uses d121a5f to reject Markdown wrappers as native conformance.
The application response-format implementation itself did not change mid-run.

| Frozen case | Current control | Native schema | Exact input | Native output |
| --- | --- | --- | ---: | ---: |
| Marker leakage, no votes | Unusable lost receipt; never repeated | Fully valid, 43.413s | 1850 | 117 |
| Syntax failure, two votes | Fully valid, 32.741s | Primary valid; one invalid reason, 251.948s | 2133 | 70 |
| Missing decisions, three votes | One explicit vote, two missing, 263.003s | Three explicit valid votes, 53.536s | 2302 | 139 |

The first control reached native HTTP 200 in 3m40s and an Ollama operational
record reported truncated=0, but a validation-only callback treated the URL
object as a string. Neither completion nor failure receipt survived. That arm
is unusable, not a presumed success/failure, and was not repeated. The callback
was fixed and regression-tested; only the five untouched arms continued in the
same frozen ledger, retaining the original clock and six-call maximum.

All five retained results match their exact frozen native input counts. All
three schema results are raw JSON with exactly the required keys/types, offered
choice enum, complete bounded ordered vote IDs and no extra entries. All ended
with stop, had no marker leakage and stayed below the output reserve. No silent
truncation, partial candidate inclusion or budget change occurred. Native schema
compatibility is demonstrated for zero-, two- and three-vote slates, not every
possible future schema feature or maximum-size slate.

However, full semantic validity is only 2/3 schema results. In the two complete
pairs, control is 1/2 and schema is 1/2: no net full-validity gain was established.
Explicit valid votes are 3/5 for control versus 4/5 for schema, while offered-ID
coverage improves from 3/5 to 5/5. Do not combine the unpaired marker result with
the two controls to manufacture a stronger paired comparison.

The unresolved schema vote is a downvote with a 17-character, TWO-word reason.
It passes structural schema checks but correctly fails the existing three-word
semantic rule. It stays invalid/unresolved, not nil or considered. The other
independently valid vote remains explicit. The final schema result repeats one
seven-word reason across all three votes: contract validity is not evidence of
good target-specific reasons, correct vote judgment or improved Naturalness.

Each arm was one inference; the existing repair condition would not trigger for
the five retained results because all primary choices were valid. No repair or
retry was added to make the measured results look better.

Total wall time from the first attempt: 23m23.185s, including 329.867s recorded
shared-lease waiting for the five retained calls and a brief harness repair.
All calls used ordinary synthetic-priority shared admission. No service was
paused/restarted, no maintenance hold was taken, no Cy process was interrupted,
and no live scheduler/profile/social/memory/Naturalness store was opened. The
local worker-completion adapter had no publication or registration route. Six
calls total, zero repeated calls, zero publication calls and zero live effects.

## Decision and next bounded step

HOLD: not ready for controlled hosted deployment under the requested full
decision-validity success criterion. Native framing is a viable minimal building
block, but structural schema enforcement alone is insufficient. The candidate
must first align non-nil vote-reason constraints with the existing validator,
without weakening it or imposing a reason on nil. Jody was asked whether to
authorize that exact constraint refinement and at most two targeted checks after
the completed six-call bound; no further inference is authorized by this report.

The audited llama.cpp b10864 converter source prioritizes pattern over minLength
and does not support lookaround on that conversion path. This does not by itself
prove which converter/build options the installed binary uses. Do not blindly
assume a JSON-schema pattern plus length keyword enforces their conjunction, or
use unsupported regex shortcuts. Preserve application validation and confirm any
refined constraint on the actual runtime:
https://raw.githubusercontent.com/ggml-org/llama.cpp/b10864/common/json-schema-to-grammar.cpp

The template contribution remains unresolved. No change to model/template,
context, personas, cadence, ecology, memory, candidate packing or repair demand
has been made. No inference-result rate or ecology improvement is claimed.

The desktop canary still contains p_swb8djuqg1y4, p_7gc83gbxvjpc and
p_e4l36dfw9wrl. An earlier read-only settings check found global pause ON; a
final read at 21:22 UTC found paused=false. This task issued no settings writes
and did not establish who changed it. Canary membership remained exact.
Claim-response/HTTP 5xx/lease recovery and template causality remain separate.
Final checks retained the same Cy PID 14988 and Windows worker PID 7836, fresh
running/ready acknowledgements, zero worker-supervisor restarts and no maintenance
owner. The final continuation process exited normally and released its synthetic
lease; the first failed utility invocation is documented above.
At 21:22 UTC the shared arbiter had no active or queued lease, privileged native
inventory found zero remaining validation processes, both original production
PIDs were alive, and the hosted source pointer still resolved to
/home/dabblela/feddit-bot-runner/releases/caa4c6d-budget-v2.

## Approved reason refinement: first targeted check failed, stop without retry

Jody subsequently authorized the exact existing non-nil reason constraint and
at most two targeted checks. Runner implementation c3033b0 and compatible
non-streaming worker 212ceec introduce independent response-format v2. Up/down
uses a three-word canonical single-space pattern and formal minLength 15; nil
may retain an empty reason. Whitespace characters are excluded explicitly,
without unsupported lookaround/shorthand. The unchanged application validator
still controls acceptance. The native converter's pattern/minLength conjunction
remains a limitation; this is not a claim that native length is guaranteed.

Format v0 stays unformatted. Frozen v1 schemas retain their exact serialization,
while new ordinary hosted turns freeze v2. Replay, restart and the single
existing repair preserve their original format version. Construction-v2,
decision-contract v2, voting, parsing, tokenization and provider transport are
unchanged. The worker must be compatible BEFORE a runner emits either native
format version; keep compatible binaries while such turns remain active.

The fresh private reason-refinement protocol has SHA-256
635592bebc6169acaa01499283d75365e5639d7c96f851e04223637442672062.
It contains only the unchanged two- and three-vote requests from the first run,
schema-only, maxCalls 2, and cannot continue/reuse a ledger. It stops on the first
failed native-schema or semantic check. All earlier evidence and its protocol
hash remain unchanged. Raw v2 schema attribution additionally checks the actual
canonical pattern/length, separately from semantic whitespace normalization.

Exactly ONE additional inference occurred, through the actual compatible
non-streaming worker module and verified model/runtime with mocked private
completion delivery. It used normal background/synthetic shared admission:

| Case | Input | Output | Queue | Inference | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| syntax-two-votes, format v2 | 2133 | 56 | 54.445s | 21.606s | valid primary; V1 explicit; V2 missing |

The returned raw JSON has exactly choice/reason/votes, but its votes array has
only V1, not the required V1,V2 tuple. V1 is down with a 29-character, five-word
reason. Thus the old two-word reason failure was absent in this sample, but full
contract validity is 0/1 and native-schema exactness is 0/1. V2 remains missing,
unresolved and unconsidered. No missing nil was invented. Native finish was stop,
not length, and the input exactly matches the frozen request. With output 640
reserved plus safety 64, 2837 tokens fit inside the unchanged 3072 context.
The worker/provider passed the v2 schema; the native result nevertheless violated
its tuple cardinality. The evidence establishes this refined schema is not
reliable on this runtime, not which native conversion detail caused that breach.
Do not attribute this to truncation or claim oneOf causality from one sample.

The validation process exited with failure immediately; the second approved call
was NOT made, no new ledger was created, and there was no retry. Private result
and summary remain owner-protected/ignored, separate from Naturalness evidence.
There was no live-store access, publication, registration, settings write,
maintenance hold, deployment, desktop update, release or Cy restart.

Regression checks: runner format 157, validation 84, durable scheduler 631;
worker format 105, worker 20, maintenance 62, operational logging 107. Additional
voting, decision-contract 91, candidates 48, budget 32, packing-v2 239, frozen
budget 26, continuation 37, anti-loop 135, provider-contract, tokenizer, attention,
DELL 22, runner worker 22, queue 55, Naturalness decision shapes 27 and scheduler,
Speed 44 and Burst 39 checks pass. Temp-file suites were rerun successfully with
an owned writable TEMP after Windows sandbox rename errors; no assertion was
weakened. A content-free missing-second-vote regression preserves fail-closed
schema attribution and independent valid-vote semantics.

At 21:38:59 UTC production worker PID 7836 and Cy PID 14988 remained alive with
fresh ready/running acknowledgements, supervisor PID 28346 and zero restarts,
Ollama 0.34.1, no maintenance owner, no remaining validation processes and no
active or queued arbiter lease. Desktop pause was false and the same three-bot
canary was retained on read-only checks. Production code was not changed.

Final decision: HOLD. Formal reason alignment alone did not establish robust
native full-contract validity. Do not deploy or claim the hosted failure problem
is fixed. Any further native compatibility investigation or inference needs a
separately bounded plan; the template question also remains unresolved.
