# Hosted structured-decision investigation, 2026-10-08

## Decision

Diagnosis only: do not release a purported decision-validity fix with 0.27.0
yet. Multiple verified defects coexist on the same path, and changing the shared
model configuration affects CY as well as Feddit. No runtime, provider,
prompt, parsing, scheduler, memory or considered-state behavior was changed.
The added test protects Naturalness's invalid/missing/explicit distinction.

The next step is an isolated, bounded model-template/context experiment,
not a permissive JSON salvage patch. Naturalness observation work can remain
separate; these measurements must not be interpreted as voting personality.

## Evidence and actual deployed path

- Investigation base: feature/naturalness-whole-ecology at
  2c461e2074d1cb8fb570cb509b3d7b14e172caea.
- Hosted server: c1e101cd5cd2e69d361bd8f63022963c79323de6, service active.
- Actual DELL worker symlink: /home/user/.local/lib/feddit-bot/releases/b7ac516.
  Its Ollama provider uses NON-STREAMING /api/chat, not the current source's
  streaming implementation. Current provider/worker source therefore cannot
  be substituted for the worker when explaining the historical sample.
- Actual worker.js SHA-256:
  1af61d2048f203133c7f04aaef6e15940dd7de91be1a25e6eaba241d2eef477a.
- Actual worker Ollama adapter SHA-256:
  d0637155ee1710ec774d0814aa9e573c6aa7bfd28e32098c98910b0832e0e598.
- Window: 2026-10-07 03:05:12 UTC through hosted evidence cutoff
  2026-10-08 12:38:32.018 UTC. Same 72 durable turns / 245 offers as Phase 2B.
- 84 decision generations including 12 repairs, all DELL -> Ollama ->
  hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M.
  All requested temperature 0.8 and output budget 640. No inference failures
  in this completed-turn sample; this is not an audit of all failed jobs.
- Read-only metadata capture, server-side parsing, bounded redacted shape
  inspection, and operational-log correlation. Full private system prompts,
  memories and generated reasons were not exported. The original Phase 2B
  evidence/review/reconciliation files are unchanged. New metadata is in
  ignored artifacts/phase2b/hosted-decisions-frozen.json and
  artifacts/phase2b/hosted-decisions-summary.json.
- Zero new model calls, publication calls, restarts, deployments or runtime
  state writes. Diagnostic computations did not run the scheduler.

## Findings and causal confidence

### 1. Input truncation is confirmed and extensive

Decision prompts: 7,148-45,513 characters, median 18,983.5; system text
985-1,133 characters. The actual arbiter and resident model report a 3,072
token context, four threads. Ollama version observed: 0.34.1.

74/84 recorded input-token counts are exactly 1,538. The other ten range
1,890-2,927. A streaming read of existing Ollama operational logs found 76
input-truncation warnings in the evidence window. 73/84 attempt timing
windows matched a warning within the recorded inference interval plus a
10-second start/1-second end tolerance; all 73 are in the 1,538-token set.
This is temporal correlation, not a request-ID join. The remaining one is
not asserted as independently matched.

Warnings report prompt=3104..11326, limit=1538, keep=4, new=1538. Example:
t_2538c715c76931fc022a36adabbdc88e attempt 0, at 12:31:39.840 UTC,
9,067 -> 1,538 tokens. The corresponding durable prompt is 34,928 characters.
The full offered slate cannot be assumed to have reached the model intact.
Exactly which individual targets/persona passages survived was not recovered.
Do not change the arbiter's context/thread settings as a speculative fix.

### 2. The resident model has a mismatched chat template

Read-only /api/show reports Llama architecture, EOS token 128009, but its
installed template uses <|im_start|> / <|im_end|> ChatML markers and only those
two stop strings. Llama 3.1's documented format uses header/eot markers:
[Meta prompt format](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/prompt_format.md)
and [Ollama's Llama 3.1 template](https://ollama.com/library/llama3.1:latest/blobs/8cf247399e57).

13/52 malformed final responses contain the incomplete literal marker
|im_end|>. This is consistent with the mismatch, not a controlled estimate
of its effect. The installed template was inspected now; durable jobs do
not pin a model-template hash. Historical causal attribution is therefore
not fully proven. The model's intrinsic ability cannot be fairly judged
from this configuration and truncated context alone.

### 3. The application accepts broken contracts without repairing them

lib/action-candidates.js parseDecision accepts the first C-number anywhere
in non-JSON text, leading WAIT, or a leading number. Its valid flag describes
recognition of the main choice, not JSON/schema completeness. Scheduler
repairs only when that flag is false. Missing or malformed secondary votes
therefore bypass repair when a main choice is recognizable.

Repair repeats the entire prompt with a generic correction, same persona,
temperature and 640-token budget. It does not receive the failed response
or a precise schema error. It remains exposed to the same input truncation.

There are also prompt-contract inconsistencies: literal ellipses inside
the JSON examples; a C1 example in voting-only prompts; a three-word reason
instruction despite validation additionally requiring 15 characters.
These are real inconsistencies, but their individual impact is not isolated.

### 4. No native structured output is requested

The scheduler, DELL payload, worker and native Ollama request contain no
format/schema setting. The provider layer's structuredOutput flag is
post-generation JSON validation, not native constrained generation. Do not
describe this as a requested live format being accidentally stripped.

Queue payloads/results are cloned without text rewriting. The deployed
adapter extracts message.content, not message.thinking. No evidence supports
a queue corruption or streaming assembly explanation for these failures.

### 5. Output truncation is not the observed dominant failure

All 84 output counts are below 640: min 32, median 89, max 392. Durations
range 14.2-297.6 seconds, median 189.6 seconds. The deployed adapter discards
done_reason on successful nonempty output, so historical finish reasons
are unknown. A mock demonstrates that nonempty length-truncated text would
be returned as successful; this is a real diagnostic gap, not proof these
52 responses hit the output limit.

worker.cleanPayload also changes explicit temperature 0 to 0.8. All sampled
requests already used 0.8, so that separate bug did not explain this sample.

## Final-response taxonomy and behavioral impact

| Final response | Turns | Effect |
| --- | ---: | --- |
| JSON parses | 20 | 63 offers: 37 accepted explicit reactions, 23 missing, 3 invalid reasons (too few words) |
| Non-JSON with a C-number | 48 | Main choice accepted; 165 offered votes defaulted to nil |
| Non-JSON without a recognized final choice | 4 | Invalid after repair; reported wait success; 17 offered votes defaulted to nil |

All 52 non-JSON outputs contain an opening brace; 46 contain a quoted votes
key. These are mostly malformed JSON-shaped responses, not just free prose.
Examples include valid JSON plus commentary or terminator fragments, missing
outer braces, broken punctuation/quotes and an unquoted votes key.

12 turns used a repair: four finished with JSON, four with non-JSON C-number
answers, four still without a valid main choice. Only ten of 72 final answers
cover every offered vote with an accepted explicit decision.

Overall: 185 invalid + 23 missing = 208/245 (84.9%) parser-default no-votes.
Only 13 explicit nil, 14 up and 10 down. Counting defaults as abstention would
produce 221/245 (90.2%) apparent no-votes; among the 37 accepted explicit
reactions, nil is 13/37 (35.1%). Neither fraction estimates the counterfactual
behavior of a repaired system; this is not missing-at-random evidence.

voting.parseDecisions converts bad/missing items into nil. applyVoteDecisions
records them as considered before casting anything. collect then excludes
those target keys until bounded-history eviction (capacity 1,000), or a
separate explicit state reset. Thus this affects future exposure as well as
observed voting totals. No historical keys were reset or re-offered here.

Durable results report 66 successful comments and six successful waits.
48 of those successful-comment turns had non-JSON final decisions. This
does not mean the comments themselves are invalid JSON: their text is made
in a subsequent generation. It means their target selection used the loose
fallback. Four invalid-choice waits are technical failures, not demonstrated
social disinterest. Two non-JSON answers mention multiple C-numbers.
Activity/topic/concentration observations therefore mix behavior with
contract failures and possibly incomplete target exposure.

Observed provider/model scope is the five hosted synthetic bots and one
Llama model above. The parser/repair/default-consideration mechanism is
shared by ordinary desktop/other-provider opportunities, but these rates
must not be extrapolated to Qwen, subscriptions, API models or Burst.

## Bounded offline before/after extraction experiment

Server-side only: take the substring from first { to last } and attempt
JSON.parse without altering original evidence or executing a decision.
This is NOT a proposed production parser and NOT a new inference.

| Metric | Actual parser input | Hypothetical extraction |
| --- | ---: | ---: |
| Parseable JSON objects | 20/72 | 51/72 |
| Accepted explicit vote entries | 37/245 | 100/245 |
| Turns covering the complete vote slate | 10/72 | 22/72 |

31 malformed responses contain an extractable JSON object: 19 have only
marker-like trailing material; 12 include other extra text. 21 remain
unparseable. Even extraction leaves 145 offers without accepted explicit
decisions. In one case the embedded main choice differs from the choice
actually selected by the fallback. Salvage must not be silently deployed:
it would create additional votes, sometimes change target selection, and
does not solve lost input context or establish intent in surrounding prose.

## Validation and next experiment

New offline synthetic-shape coverage checks that marker/commentary-wrapped
JSON, missing braces, malformed keys and token prose remain diagnostically
invalid; omitted votes remain missing; invalid reasons are not abstentions;
explicit nil stays explicit; input fixtures are unchanged. No private prompt
or reason is committed.

Provider probes: nine checks on current source, five on git-show b7ac516,
with native network blocked and transports/telemetry stubbed. Confirmed
actual old-worker request shape, temperature-zero substitution, no format,
content/thinking separation and discarded finish reason.

All 83 Node suites passed, including the new 27 diagnostic checks,
530 scheduler checks, 259 durable-scheduler checks, 22 DELL-provider checks,
22 worker checks, 55 queue checks, 26 deterministic Ollama timeout checks,
provider contracts, voting, and all Naturalness suites. Live smoke remained
disabled. No package was rebuilt: only this report and the offline test
changed, and no app payload or version changed.

Recommended next experiment, separately authorized and reported:

1. Verify a Llama-3.1-correct template/stop configuration in a separate
   non-serving alias/runtime; never overwrite the model shared with CY.
2. At most three representative frozen cases with control/template-only
   pairs (six calls initially), same weights/slate/order/temp/output budget,
   no state mutation, yield to natural work. Include one small complete-input
   case, one wrapper failure and one large/truncated case. Capture exact
   rendered-input coverage and allowlisted completion metadata.
3. If template-only still loses input, separately test context-budgeted
   serialization without silently dropping offered targets. Do not combine
   template, prompt compression and model replacement into one treatment.
4. Then test native JSON/schema output and contract-aware bounded repair,
   with versioned durable replay. Decide explicitly how unresolved votes
   should affect considered-state; never reinterpret old completed turns.

No claim is made that a new model run or a before/after generation-quality
improvement was demonstrated. No production correctness fix is ready for
co-release with Naturalness 0.27.0 on this evidence alone.
