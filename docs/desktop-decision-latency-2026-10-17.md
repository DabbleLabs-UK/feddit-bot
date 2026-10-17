# Desktop decision-stage latency diagnosis, 17 October 2026

## Scope and verified runtime

This is a diagnosis and instrumentation-only branch. No running application,
model, timeout, prompt, candidate selection or writing behavior was changed.
No inference call, publication, pause, provider retrieval or deployment was
performed. Hosted claim/reliability work and the native-schema investigation
were not revisited.

Port 8770 is Windows PID 20872, running desktop 0.27.3 from
`%LOCALAPPDATA%/Programs/Feddit Bots/versions/0.27.3/app/server.js`. SHA-256 of
installed `scheduler.js`, `action-candidates.js`, `providers/ollama.js` and
`local-generation-telemetry.js` matches reviewed commit
`a41b691b136e57a5faa9893c0fa949708fdeb818`. This branch starts there, not at the
older authoritative continuation branch or a newer hosted-only worker branch.
Concurrent worktrees were not edited or reset.

The actual local inference server is LENO's Open WebUI-owned native Ollama
0.32.15, PID 28600, listening on 127.0.0.1:11434. It is not DELL's verified
hosted Ollama. One continuously resident `qwen3:4b-instruct` Q4_K_M CPU runner
uses four threads, one parallel slot and 32,768 context tokens. Its model digest
is `0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0`.
The model's declared capacity is larger, but the actual running context is
32,768. Requests inherit that context; Feddit does not explicitly set num_ctx.
keep_alive remains -1. No model, context, thread or priority setting was changed.

The current host has 32 GB RAM and 12 logical processors; at the read-only
snapshot about 6 GB was available with zero page-input/page-read activity.
The model process had about 8.5 GB working set and 15.4 GB private bytes.
Below-normal priority/10-processor affinity is imposed by the existing local
CPU guardian; Feddit requests four threads. These are present facts, not proof
of overnight contention or permission to tune them. No DELL inference, Cy
restart, shared maintenance gate, or resource reservation was needed.

## Retained evidence and attribution

Use the prior fixed audit window, 16 October 22:41:38 UTC through 17 October
11:40:00 UTC. The last-50 telemetry snapshot remains frozen independently of
later natural work. It contains 49 requests finished by cutoff: 23 successful
decisions, seven decision timeouts and 19 writing calls. A successful decision
crosses cutoff and is excluded. An eighth earlier timeout remains in profile
history and the Ollama log after rolling off telemetry.

A read-only parser matched all 50 saved telemetry requests uniquely to native
Ollama task records using completion time within three seconds and exact input
token counts when available. Native GIN timestamps are BST; lifecycle offsets
and matching confirm conversion. Logs provide direct prompt/decode timings,
not merely a correlation between input size and wall time. Private ignored
`artifacts/decision-latency/` contains a content-free numeric projection and
parser; no prompt, persona, memory or generated text is committed.

### Representative same-bot decision and writing

| literal_loophole_bot | Decision | Subsequent writing |
| --- | ---: | ---: |
| Started UTC | 11:03:47.912 | 11:30:26.375 |
| Input tokens | 11,528 | 876 |
| Cached prefix | 3 | 240 |
| Prompt evaluation | 1,113.20 s | 37.96 s |
| Decoding | 484.32 s | 25.93 s |
| Client total | 1,597.75 s | 65.04 s |

For the large decision, approximately 18.55 minutes passed evaluating input
before generated output; another 8.07 minutes produced 296 tokens. The model
task itself accounts for all but about 234 ms of client wall time. This is not
a 26-minute scheduler or shared-arbiter wait.

Across 23 successful decisions, prompt evaluation totals 191.15 minutes and
decoding 45.39 minutes. Seven decisions at least 10k tokens have a median
18.55-minute prompt evaluation, only 3-6 cached prefix tokens, and median
decoding around 0.80 tokens/second. By contrast, writing has median 1,021 input
tokens, 41.90 seconds prompt evaluation, and about 4.74 decoded tokens/second.
Completed decisions below 4k input have median first output about 111 seconds;
those at least 10k have median first output about 1,113 seconds. Observed input
size/first-output correlation is r=0.993 across 23 successful decisions; it is
not a measured causal speedup for a proposed prompt change.

### The eight first-output failures

| Bot / end UTC | Input tokens | Last printed prefill |
| --- | ---: | ---: |
| what_who_where_why / 02:39:45 | 13,467 | 91% at 1,160 s |
| premise_gremlin_bot / 03:39:26 | 12,556 | 98% at 1,197 s |
| tavern_toilet_oracle / 03:59:29 | 13,714 | 82% at 1,075 s |
| dialup_tavern_bot / 05:23:24 | 13,411 | 84% at 1,060 s |
| dialup_tavern_bot / 06:29:50 | 13,398 | 92% at 1,151 s |
| porcelain_oracle_bot / 08:05:13 | 13,308 | 85% at 1,067 s |
| governmint_clerk_bot / 08:25:33 | 13,040 | 98% at 1,198 s |
| what_who_where_why / 09:56:55 | 13,659 | 90% at 1,188 s |

Every one was still evaluating real input when cancelled, at about 10.25-10.70
tokens/second at its last printed checkpoint. None reached generated output;
none reports context truncation. Percentages are the last periodic checkpoint,
not an exact percentage at cancellation. The existing 20-minute policy counts
generated progress, not input processing, and behaved as designed.

There was one model load at startup, 16 October 22:46:49 UTC, and no subsequent
load/unload or runner restart in the retained interval. Persistent residency
does not imply useful prompt-prefix reuse: different per-bot system personas
usually diverge within the first 3-21 tokens. Cache maintenance for the seven
largest successful decisions was about 92 ms median, not minutes.

## Why decisions cost much more than writing

The decision menu contains up to 12 actions plus eight independent votes in
one call. Each action may include 2,500 content characters, 1,600 memory
characters, social evidence, recency, availability and salience. The decision
must genuinely compare multiple opportunities; that work is not all waste.

However, current presentation duplicates information: social summaries appear
in both salience reasoning and a social block; vote entries repeat their source
candidate's social/memory material and often content already shown. Writing
only sees the selected target and its selected context/memory. Persona-first
system messages also limit cross-bot prefix-cache reuse. The 640-token decision
allowance with voting is greater than normal writing's 200, but this cannot
explain eighteen minutes before the first generated token.

Exact original desktop decision prompts are not retained: ordinary local
decisions are not hosted durable generation jobs. Consequently the old menu's
per-field token contribution and the fraction safely deduplicatable cannot be
recovered exactly from existing state. Current profiles/public content are not
an exact replacement for that historical snapshot. No live gather/reconstruction
was invoked that might mutate attention/discovery state.

Normal local scheduling is sequential and provider BUSY rejects rather than
creating an application queue. Serialization multiplies the impact of each
expensive decision; it does not explain the measured model prefill itself.
Some requests immediately after a timeout have an extra 45-152 seconds before
their model task. Backend batch cancellation/drain is the leading explanation,
but untimestamped runner lines do not prove the division between drain, cache
work and internal Ollama queueing. This is secondary and remains separate.

The 0.91 TB write-byte clue came from the hosted VPS runner. It is not this
desktop process. Direct local model timings already explain the large calls;
there is no demonstrated connection justifying a persistence project here.

## Minimal repair and readiness

The smallest high-value behavioral candidate is a desktop-only lossless
evidence layout: retain every action/vote ID, order, complete existing bounded
content, salience and social/memory fact, but represent exactly repeated
evidence once and reference it from the relevant entries. Do not lower the
candidate limit, silently discard memory/ancestors, shrink context, split voting
into more inference calls, raise timeouts, or change persona/cache policy.
Keep the hosted renderer and legacy durable reconstruction byte-identical.

This is a proposal, not an implemented performance claim. Information-preserving
references are not automatically comprehension-equivalent for this 4B model.
Before enabling it, test exact field reconstruction and identical candidate,
vote, WAIT, validation and receipt semantics, then use one small bounded
non-publishing control/candidate check through the existing provider. No new
comparison harness or infrastructure is needed. Exact throughput savings are
not yet measurable; successful input reduction should save minutes and reduce
first-output deadline failures, not merely shorten output. There is no evidence
supporting a particular percentage or speedup factor yet.

Implemented on this branch: bounded content-free native timing diagnostics.
Ollama terminal load/prompt-evaluation/decoding/total nanoseconds become honest
millisecond fields. System/prompt character counts, requested output/context/
thread settings and shared-lease wait are retained in the existing 50-record
store. Missing terminal counters remain unknown, especially for a timeout.
No inferred token count, prompt content, hidden reasoning or new provider call
is added. Zero arbiter wait does not imply zero internal Ollama queueing.

This diagnostic patch has no expected throughput effect and is suitable for
controlled delivery after tests. It has NOT been installed or packaged. A
performance-changing prompt repair is not yet ready for production deployment;
the proven diagnosis does not justify silently changing model comprehension.

The existing 20m/5m/30m timeout, cancellation/no-retry behavior, candidate
selection, parser/partial-vote semantics, hosted budgets, writing-v3 allowlist,
cadence, personas, memories, models and provider selection remain untouched.
The prompt-representation proposal must remain separate from copying/tone,
fresh-root ecology and hosted structured-output validity investigations.

## Verification

27 relevant offline Node suites pass, including the new 50-check phase timing
suite, 26 deterministic timeout checks, provider request/response contracts,
shared lease and Working UI, 532 scheduler checks, 536 durable scheduler checks,
decision-contract and Naturalness decision shapes, continuation guards, hosted
budget reconstruction, writing-canary scheduling, writing integration/rollout,
Naturalness writing and desktop UI parity. No model inference was performed.
The optional real scheduler smoke was excluded in memory; an offline network
guard blocked external hosts and production ports 8770/11434/11435. One initial
Ollama fixture was blocked by sandbox loopback EACCES, then passed with the same
offline guard under narrow escalation. The phase suite likewise needed narrow
escalation for atomic Windows temporary telemetry writes. These were fixture
permission limitations, not ignored application failures. No tracked tests were
weakened or skipped to obtain a pass. An app-launching API fixture was not run.

Read-only review found no material instrumentation or interpretation defect.
No desktop build, stage, install, public release or hosted deployment occurred.
