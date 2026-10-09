# Hosted decision prompt budgeting

Implementation base: production 0.27.0, `a55ff9bf2925023772318b0070dcf718384a062b`.
This branch is not deployed or released. It imports no maintenance gate,
experimental runner or production model configuration.

## Construction and admission

The hosted candidate-decision path now has a request-construction version,
separate from decision contract v2. New durable turns freeze version 1 plus a
construction checkpoint. That checkpoint records complete initial/repair
prompts, stable offered/deferred IDs, token counts and request hashes. The
original gathered observation snapshot and its attention/social/memory effects
are unchanged. Only the actually offered slate is parsed and logged as offered
to Naturalness.

Counting uses the exact production GGUF vocabulary, ordered BPE merges, pinned
llama.cpp Unicode classification, BOS, and the currently installed ChatML
framing. This does not correct that framing. See
[tokenizer provenance](hosted-tokenizer-provenance.md). No character/token ratio,
inference call, model load or paid service is used for counting.

The existing execution context remains 3072. Each request reserves its unchanged
640 output tokens when voting is present, or 120 otherwise, plus 64 safety
tokens. Both the initial and repair prompts must fit. The scheduler does not
reduce output allowance to squeeze in more input.

On pressure, remove whole trailing action/vote blocks in reverse interleaved
order, preserving prefixes and IDs in each independently sourced slate. Keep
at least one item from each originally nonempty slate. Never substitute a later
smaller item ahead of an earlier larger one. Retained persona, tone, rules,
content, salience, social evidence and memory retain their existing serialization
and existing per-field bounds. No additional text slicing or summarization.
If that minimum complete request cannot fit, report an explicit technical
failure and send no inference. This is not WAIT or abstention.

DELL independently recomputes the count/hash after obtaining the existing
arbiter lease. It verifies the actual lease context is not smaller, and checks
Ollama 0.34.1, the exact model manifest, template, parameters and tokenizer
metadata through read-only local metadata endpoints before inference. Unknown
or changed configurations fail closed; operators must validate and deliberately
update the budget contract when changing them. No model, template, context,
threads, priority or timeout option is changed by this feature.

The worker guards both scheduled/manual candidate decisions and their repair
requests, including old unbudgeted queued decisions. A budget/model mismatch is
non-retryable. Existing provider cleanup releases the lease and Working state.
Other providers, desktop local generation, content generation, creator/importer
generation, legacy news-number selection and Burst are not repacked by this fix.

## Durable and decision safety

- Old turns without construction version keep their exact old request signatures
  and decision contract. Oversized not-yet-executed legacy decision jobs fail
  explicitly at the worker; their prompts are not silently rewritten. Completed
  legacy results retain their existing replay behavior.
- Future unknown construction versions remain blocked rather than being
  discarded or replaced by an older implementation.
- The checkpoint freezes the selected slate and both prompts across initial,
  repair, restart and missing-job recovery. No fresh feed or elapsed recency can
  change the request during replay.
- Deferred votes are neither offered, missing responses, abstentions nor
  considered. They remain eligible under ordinary existing future collection
  rules. Explicit valid nil and unresolved contract-v2 behavior are unchanged.
- There is no historical considered-state rewrite, immediate retry, catch-up
  demand or cadence change. Original observation bookkeeping is preserved.

## Historical offline validation

Read-only recovery used the same 72 turn IDs / 84 decision attempts examined by
Naturalness Phase 2B, from the existing pre-release durable backup. Backup SHA:
`82f847be29788471f1a8d501de134368f399b96a4bfc3335ac1f1f044c8130ef`.
Private prompts/slates remain gitignored; only counts and hashes are reported.
`bin/audit-hosted-decision-budget.js` reproducibly audits a bounded private export
without running the scheduler, retrieving feeds, invoking providers or applying
any effects.

| Check | Before | Budgeted construction |
| --- | --- | --- |
| Full input tokens | 1890 min, 4826 median, 11326 max | Fitted initial: 1594-2299 |
| Fits input + output + safety | 4/84 historical attempts | Every admitted initial and repair fits |
| Logical turns | 72 | 68 fitted; 4 explicit failures, zero inference |
| Largest admitted repair | Not budgeted | 2342 + 640 + 64 = 3046, below 3072 |
| Offered primary candidates | 316 | 72 across fitted turns |
| Offered vote targets | 245 | 68 across fitted turns |

All 72 unmodified initial serializations exactly reproduce the frozen historical
prompts before packing. All ten untruncated historical native input counts match
the offline tokenizer exactly. The other 74 historical responses reported 1538
input tokens after truncation. The earlier independent causal fixture's full
render hash and 3420-token native count also match exactly.

For that causal fixture, preserving the real daily vote-allowance wording, the
complete C1/V1 slate uses 2257 input tokens (2300 for repair), down from 3420;
C2/V2 are deferred rather than partly disappearing.
Across fitted historical turns, 224 primary candidates and 153 vote targets are
deliberately deferred. The four blocked minimum repair requests require 2382,
2389, 2459 and 2610 input tokens, exceeding the 2368-token reserved input budget.
Their 24 vote targets are unresolved/unoffered, never considered.

Previously Ollama could retain only the beginning and tail of an oversized
request. The full persona/context/slate could not be assumed visible; exact
target-by-target loss was not recovered. The new path makes the choice of
offered whole blocks explicit and durable instead of delegating it to truncation.

## Trade-offs and release recommendation

Final verification passed all 86 root Node suites, including 32 focused budget
checks, 531 scheduler checks and 476 durable-scheduler checks. Tokenizer checks
include the independent private 3420-token fixture, 4000 deterministic
pre-tokenizer differential cases, all 256 reserved tokens, Unicode edge cases,
and bounded adversarial inputs. The disposable signed-package test passed
21 checks, including extracted tokenizer execution and all required assets and
notices; packaged browser verification passed 90 checks plus Naturalness checks.
These use mocks/disposable test signing, not live inference or release signing.

This necessarily narrows per-opportunity choice and vote exposure. Prefix
preservation favors the existing ordering; lower-ranked candidates may age out
before a later opportunity. It does not promise that every deferred target will
eventually be seen, nor change attention/social/memory rules to force that.
Large mandatory contexts now fail visibly. In this historical sample, about
5.6% of turns would be rejected instead of receiving incomplete context.

The existing independent-vote source-slot labels may refer to C-number source
slots outside the offered primary slate; complete vote evidence is retained.
This predates packing in voting-only/independent-vote opportunities. No vote is
filtered by those potentially unrelated primary IDs.

This fixes prompt-fit correctness, not overall model decision validity. The
possible Llama template mismatch and missing/invalid structured output remain
open. Recommend a separately authorized, small non-publishing frozen validation
through the actual guarded worker before release: confirm admitted native token
counts and absence of truncation, with no social/scheduler/publication effects.
Do not claim a validity-rate improvement from this offline audit.

Deployment, when authorized, needs the hosted scheduler and DELL worker guard
together (worker first at a safe boundary). Preserve the separately maintained
maintenance-gate work during later integration; none is merged into this branch.
No production configuration, runtime state, installed desktop or public update
channel was changed here.
