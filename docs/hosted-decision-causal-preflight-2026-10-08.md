# Hosted decision causal experiment: stopped at preflight

Date: 2026-10-08. Baseline: feature/naturalness-whole-ecology at
1276a803c75c6478c0b0bd2ba6585299f6bcda31.

## Decision and scope

Do not run the live factorial under the current shared-host conditions.
The user explicitly required stopping after preflight if materially
disruptive. No experimental inference, lease acquisition, model alias,
configuration change, deployment or release was performed. No live
scheduler, considered-state, social memory or publication state was changed.
This is a report-only change, not a runtime fix.

The earlier report's separate-alias suggestion is insufficient isolation.
It is superseded by the resource and admission findings below. The prior
observations establish coexisting defects, not causal effect sizes.

## Actual path and preflight evidence

- Authoritative remote remains c1e101cd5cd2e69d361bd8f63022963c79323de6;
  feature remote was 1276a803c75c6478c0b0bd2ba6585299f6bcda31.
- Hosted server is c1e101c; actual DELL worker is b7ac516. Its non-streaming
  Ollama /api/chat path uses the same Llama-3.1 abliterated Q5_K_M weights
  audited in hosted-decision-validity-2026-10-08.md.
- DELL has 15.81 GiB total RAM, 2.33 GiB free at inspection, six logical
  CPU cores (i5-9500T), and Ollama 0.34.1. Ollama reported resident Llama
  and Gemma models. These snapshots are not a capacity guarantee.
- An ordinary Feddit synthetic inference held the shared lease when
  inspected. CY and Feddit both continue using this service.
- The deployed arbiter at releases/awg-preempt-1 grants num_ctx=3072 and
  num_thread=4. The Feddit provider applies that profile after its other
  request options. There is no per-request context override in this lease
  contract and no atomic idle-only experimental admission.
- Acquire always queues. Synthetic priority yields while queued but an
  active inference is not preempted for newly arriving natural work.
  Heartbeats expose only an interactive-waiting advisory, not a general
  natural-work yield protocol; the current Feddit lease client does not
  use that advisory. A health check followed by acquire is not atomic.
- Ollama 0.34.1 keys GGUF runners by model path. Another alias of the same
  weights is not a separately isolated runner. Changed context/load options
  may require runner reload. A second process on this nearly full host
  also would not establish resource isolation.
- /api/chat has no documented request-level template override. Raw
  /api/generate permits explicitly rendered input but changes the transport
  under test; equivalence to the hosted control must be demonstrated before
  treating it as the same path.

Read-only implementation references:

- https://raw.githubusercontent.com/ollama/ollama/v0.34.1/server/sched.go
- https://docs.ollama.com/api/chat
- https://docs.ollama.com/api/generate
- https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/prompt_format.md

## Smallest informative design, not executed

One frozen, demonstrably truncated case in a complete 2x2 factorial is the
minimum: four calls, no retries. A two-call comparison confounds context
and template; three cells cannot distinguish their interaction.

| Cell | Input context | Template and matching stop framing |
| --- | --- | --- |
| A | Observed hosted low-context profile | Installed ChatML control |
| B | Enough verified capacity for the complete frozen input | ChatML |
| C | Observed hosted low-context profile | Correct Llama-3.1 framing |
| D | Enough verified capacity for the complete frozen input | Llama-3.1 |

Freeze bot, prompt, system text, offered IDs, target text, order, weights,
temperature and output budget. Use the same fixed random seed in all cells
only if the isolated harness supports and verifies that request option;
do not pretend one stochastic sample estimates a stable effect. Template
treatment necessarily includes its corresponding stop framing; report
that bundle, rather than claiming the header alone caused any difference.
Do not add JSON mode, change the prompt, compress targets or run repair in
this factorial. Score raw first responses; replay parser/repair separately
offline so repair cannot mask model validity.

A candidate is t_2c79a50593f9302295577ec701aa7cb0, whose prior temporal log
match reported 3420 -> 1538 input tokens (12597 prompt characters). This
is a provisional case choice, not proof of exact token accounting across
templates. First verify rendered token coverage in both formats without
generation. Choose the smallest context that fits both complete inputs,
their system/template overhead and the unchanged 640-token output budget.
Do not infer capacity from character count or silently change shared
num_ctx. Preserve complete offered target coverage in both full cells.

Capture input-token count, actual truncation evidence, output-token count,
finish reason, duration and strict full-response JSON validity. Separately
score valid primary choice, explicit valid votes / offered votes, complete
slate coverage, missing/invalid decisions and marker leakage. A valid JSON
object alone is not a valid decision contract. Store experiment evidence
separately from live Naturalness evidence; do not apply any result.

Compare B-A and D-C for context, C-A and D-B for template, and the difference
between those contrasts for interaction. With one case these are diagnostic
contrasts only, not statistical or ecology-level estimates. A second case
would require four more calls and should not be added automatically.

Execution requires a resource-isolated runtime using the exact hosted
weights and verified request path, or an explicitly authorized maintenance
window accepting delayed natural work. Neither is established in this job.

## Cost and disruption estimate

The existing 84-attempt sample has median 189.586 seconds, p90 227.687
seconds and maximum 297.640 seconds. Four calls at that median consume
about 12.6 minutes of inference occupancy; eight consume 25.3 minutes.
At the historical maximum those totals are 19.8 and 39.7 minutes, NOT
future upper bounds. Complete-context processing may be substantially
slower. The current five-minute worker request timeout is another bounded
failure possibility, not permission to increase it. Queue waits are unknown.
There is no proposed paid API spend, but CPU/RAM contention and blocking
natural work are material costs. An alias does not remove them.

## Parser, repair and considered-state correctness

This issue is independently demonstrated by the prior frozen audit:
208/245 vote offers had invalid or missing decisions, yet those entries
became default nils and were recorded as considered. This is not evidence
of deliberate abstention. Explicit valid nil must remain distinct.

Safest intended semantics for a separately validated correctness change:

1. Non-JSON or an unrecognized primary choice is a technical contract
   failure. Do not select the first candidate token found in prose, call it
   legitimate WAIT, or salvage a guessed embedded JSON object.
2. Missing/invalid votes are unresolved: no cast and no permanent
   considered-nil. Only validated explicit nil is abstention. Preserve
   ordinary allowed-ID, duplicate-ID, reason and server-allowance checks.
3. Pin already valid, unambiguous components. At most one bounded repair
   may address unresolved components before effects; it must not reroll
   accepted choices. A failed repair remains a technical failure, not an
   invented action, abstention or immediate retry loop.
4. Valid independent components may proceed only under an explicit
   component-level contract. Unresolved offers may be eligible at a future
   ordinary opportunity; do not accelerate cadence or create catch-up work.
5. Preserve uncertain HTTP-effect recovery and never reinterpret completed
   turns or clear historical considered records without separate evidence.

This is not safely implemented as a one-line parser change. Current repair
eligibility tests primary decision.valid, so a valid primary choice can
skip repair despite invalid votes. Durable checkpoints store parsed choices;
generation ordinals/signature hashes protect replay. Changing repair
eligibility or prompts on old in-flight turns can shift the generation
cursor or produce TURN_REPLAY_MISMATCH. Introduce a contract version for
new turns while retaining frozen behavior for existing durable work before
changing eligibility or considered effects.

Strict parsing alone would reject primary choices in 48 of the 66
successful-comment turns in the historical sample. That illustrates why
a model-validity fix and replay-safe contract handling require joint
validation; it is not a prediction that those comments would necessarily
be lost under a corrected model path.

## Results and release recommendation

- Truncation effect: not measured causally. Severe input loss is confirmed
  observationally, including temporally correlated 1538-token truncations.
- Template effect: not measured causally. Installed framing is inconsistent
  with Llama-3.1, and marker leakage exists; causality remains unisolated.
- Interaction: unmeasured. Neither factor can be assigned a numeric share
  of failures from the current evidence.
- Before/after inference validity: no new calls, therefore no comparison.
  Historical final-response baseline remains 20/72 strict JSON and only
  10/72 complete vote slates. No improvement is claimed.
- Runtime fix: none. No speculative salvage or shared-model change.
- Expected production impact: none from this report. A later proven fix
  could restore explicit decisions and remove false considered abstentions;
  additional votes/activity cannot be quantified from this biased sample.
- Keep 0.27.0 staged; HOLD promotion pending a safe controlled follow-up
  if releasing the validity correction together is the goal. The observer
  work is preserved; this report does not authorize its separate release.

Staged 0.27.0 ZIP remains SHA-256
58874ed2ebe7cad20426a6d0592011a1219dfc5bb419a629b90ad5effdcd225c,
minimum launcher 0.2.2. It was not rebuilt or installed.

Offline validation rerun for this report: naturalness-decision-shapes
(27 checks), voting (all checks), shared-ollama-lease (all checks), and
durable-scheduler (259 checks) passed. These are regression checks of the
unchanged implementation, not evidence that the proposed semantics are
implemented or that model output improved. The previous 83-suite full run
is recorded in the baseline report; it was not represented as a new run.
