# Desktop lossless decision evidence v1

Implementation follows the desktop prefill diagnosis and numeric phase timing
instrumentation in 8c03fbe. This is an unreleased desktop-only change. It has
not been installed, deployed, publicly released, or applied to the hosted
runner/worker. Existing desktop 0.27.3 and writing-v3 membership remain intact.

## Representation

The released `actionCandidates.prompt` remains the default legacy renderer.
The compact path uses that same renderer with a transformation of evidence
values only. Instructions, action/vote identifiers, order, salience levels,
recency, vote allowances, response examples and validators are unchanged.

Exact repeated evidence values, whole context lines, and their labelled values
of at least 96 characters can be represented once in a shared table. Definitions
are JSON-quoted original strings, not summaries. `[[E1]]` in a candidate value
means that exact string; a field may contain a reference plus its untouched
unique surrounding text. Entries are never recursively substituted inside
other definitions. References do not create new action/vote IDs, merge targets,
or promote evidence to instructions. The prompt explains these distinctions.

Before inference, expansion of the reference-bearing body must reproduce the
entire released prompt exactly. This checks all evidence, instructions and
identifiers, not just field counts. A reconstruction mismatch fails before
inference. Existing literal `[[E-number]]` content uses the released format to
avoid ambiguity. No evidence sharing or no overall character saving also uses
the released format. Fewer characters alone is not a mathematical guarantee of
fewer tokens for every possible input; native-tokenizer measurements are below.

The same prepared prompt/table is used for initial decision and the existing
single repair suffix. The path introduces no call, retry or inference split.
All gathered candidates and independent votes remain offered as before; nothing
is deferred or acknowledged differently. WAIT, partial valid votes and invalid
or missing unresolved decisions retain existing parser/receipt behavior.

## Routing and compatibility

Server passes its placement explicitly to the scheduler. Compaction requires
desktop placement, the local Ollama provider, no durable turn ID and no hosted
construction. Advanced placement, hosted providers and any durable replay
retain the released renderer. Burst uses its own unchanged renderer. Public
writing, personas, memory stores, candidate selection, cadence and writing-v3
admission/allowlist logic are untouched.

This is a separate presentation version, not a new decision, continuation or
public-writing semantic contract. Ordinary local decisions are non-durable;
the fully prepared request stays frozen in the admitted call. Existing in-flight
calls cannot be reinterpreted by a later build. Hosted durable v1/v2 signatures
and replay remain exact. Old three-menu renderer hashes are frozen from the
actual pre-change 8c03fbe action and voting modules.

The existing bounded content-free telemetry records decisionEvidenceVersion:
1 for shared evidence, 0 for a released fallback, null when not applicable.
It uses the previously added native load/prefill/decode/total timings. No new
prompt store, provider, credential, publication authority or busy tracker exists.

## Offline preservation and token measurements

All fixtures are fictional reconstructed representative menus, not exact
historical desktop prompts. The three thematic menus each contain 12 actions
and eight votes. The pressure case adds coherent unique per-candidate branch
facts and memory, within unchanged existing limits: longest context 1550/2500
characters and memory 1457/1600. Those unique facts must survive, not be removed
to inflate the savings. Vote targets/content remain unchanged.

| Frozen menu | Released input tokens | Compact input tokens | Reduction |
| --- | ---: | ---: | ---: |
| Civic | 8363 | 4561 | 45.46% |
| Camera | 8450 | 4602 | 45.54% |
| Uptime | 8511 | 4629 | 45.61% |
| Dense civic branch | 11255 | 7774 | 30.93% |

Counts include the identical system and two-message generation framing. They
come from the already-resident actual Qwen GGUF's native apply-template and
tokenize endpoints, not character estimates or model generation. The rendered
two-message framing was checked against the installed ChatML template. Token
operations load no new model, invoke no sampler and consume zero of the two
authorized inference calls. Actual Ollama prompt_eval_count still needs to be
compared when the bounded live pair is admitted; these counts are not a live
throughput measurement.

## Tests and operational status

The guarded affected regression batch passes: 32 offline suites, including
exact hosted tokenizer/budget reconstruction, scheduler and durable replay,
continuation/discovery, voting, decision validation, Burst, writing-canary
isolation, provider contracts, timeout/cancellation and Working/UI behavior.
The final pressure additions pass 519 pure evidence checks; scheduler routing
and frozen one-repair integration pass 39 checks. Coverage includes exact byte
reconstruction, unchanged pre-change hashes, stable IDs/order, no mutation,
unique evidence retention, overlapping/prefix/multiline/Unicode evidence,
reference-like-content fallback, voting-only and no-saving fallback, invalid
E-ID rejection, and unresolved missing votes.

The user authorized one desktop-only admission pause of at most 20 minutes,
allowing already-admitted natural work to drain before at most two frozen
non-publishing calls. Protocol c6dda3b0-efa1-47ca-9d16-19e20e18e474 was frozen
with identical model/settings/content between arms; initial framed counts were
3241 released tokens and 2204 compact tokens. Its private ledger retains zero
calls: neither experimental arm was admitted.

The pause ran on 2026-10-17 from 13:51:05.845 to 14:00:09.953 UTC (544.108
seconds). While Sir_Ponsalot's already-admitted natural decision was draining,
the controller stopped with PAUSE_HEARTBEAT_STALE. In this controller that code
also covers a caught heartbeat atomic-write exception. A heartbeat temporary
file remains; the last committed heartbeat was only about two seconds old at
abort. Thus the retained evidence establishes heartbeat persistence failure,
not actual inference inactivity. The inner filesystem error was not retained,
so its specific cause is not established. No further protocol or retry ran.

The controller's finally path restored paused=false on its first attempt; the
independent watchdog recorded released and exited. Read-only verification of
port 8770 found desktop 0.27.3 and a naturally admitted scheduled-generation
request for Sir_Ponsalot writing a comment after restoration. Persisted settings
confirm normal scheduling and unchanged canary IDs p_swb8djuqg1y4,
p_7gc83gbxvjpc and p_e4l36dfw9wrl. Hosted Feddit and Cy were not paused or
restarted. No model settings, cadence, provider selections, memory, candidate
state or canary membership were edited, and no compaction build was installed.
The only runtime write was the explicitly authorized global admission pause
and its restoration. Natural work remained free to complete normally.

Lossless representation does not prove equal model comprehension/attention.
Offline implementation checks pass, but behavioral deployment readiness remains
held: this aborted check supplies no model comprehension, prompt_eval_count or
throughput comparison. No new comparison campaign, repeated attempts or
automatic production rollout is authorized. No timing speedup is claimed yet.
