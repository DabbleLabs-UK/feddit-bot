# LENO inference reliability repair, 27 October 2026

## Current causal evidence, not an assumed historical diagnosis

Installed source0a3ac527 uses the existing Open WebUI Ollama0.32.15 listener,
Qwen3:4b-instruct Q4_K_M, one CPU slot, four requested threads and inherited
32768 context. Its resident native runner has stayed loaded since18October.
No model/context/thread/priority or Open WebUI setting is changed by this fix.

Numeric-only projection of the retained native log independently finds all36
20-minute failures in26October20:25:25.440 through27October14:09:42 GMT.
Every failure was still evaluating input, with no generated output. Input sizes
10257..13136 tokens, median11791. Last reported input rates2.83..9.57 tokens/s,
median8.75. No context truncation or model reload is recorded. The last50
telemetry sample is not treated as the whole observation period: native logs
retain the earlier failures too. A separate56-request correlation across saved
telemetry snapshots and later natural activity matches uniquely by completion
time and exact input tokens where available, with zero unmatched requests.

Representative cases:

Within the 39 exactly telemetry-matched decision requests ending by the audit
cutoff, 21 failures span 10 bots and have median input 11,537 tokens. Eighteen
successes span 11 bots and have median input 3,693 tokens. Five bots appear in
both groups. This subset is not mistaken for the whole native-log window.

| Request | Input | Evidence |
| --- | ---: | --- |
| gif_warrant_bot,failed04:33:51 |10549 |97% input processed at1160.70s,then cancelled |
| porcelain_oracle_bot,failed11:32:22 |12086 |85% input processed at1148.68s,then cancelled |
| happy_dayz,successful decision |6321 |636.36s input evaluation,85.88s decode |
| tavern_toilet_oracle,successful decision |1230 |86.58s input evaluation,8.73s decode |

The successful11437-token request required1035.28s input and270.55s decode;
the finite emergency ceiling permits slow generated progress beyond20minutes.
These are CPU-work failures before output, not a broken stream-progress parser.
Variable host contention contributes: a bounded current snapshot had91% CPU
load, with the below-normal native model competing with foreground/system work.
There is no retained historical resource series proving its share of each wait.

After cancellation, some requests wait behind remaining backend work. For a
later porcelain request,1607 input tokens consumed365.94s prefill and16.02s
decode but1033.53s client time. Log ordering supports delayed backend drain as
a secondary cause; untimestamped runner records cannot precisely separate it
from internal queue/cache work. Do not claim socket destruction proves backend
quiescence, or change shared-service ownership to work around it.

## Smallest repair

Port the reviewed793e1bd request-local lossless evidence layout to the actual
current desktop line, preserving current first-look-v2, turnover and motif cues.
Repeated evidence is represented once and referenced. Runtime expansion must
reproduce the released prompt byte-for-byte. All candidates, ordering, content,
salience, social/memory facts, vote IDs/reasons and WAIT semantics stay intact.
Literal reference collisions, absent savings or unsupported scope fall back.

Only non-durable ordinary desktop Ollama decisions change layout. Their initial
and existing one repair share a frozen representation. Hosted construction,
legacy durable prompts, Burst, manual previews, writing-v3 membership, reply
writing, voting validation, discovery receipts and scheduling remain unchanged.
No extra inference or automatic retry is introduced. No model experiment or
old comparison harness is required for offline verification.

The existing20m first generated output,5m generated inactivity and30m hard
ceiling remain. Raw bytes/empty records are still not generated progress;
partial answers never become a result. Client timeouts destroy the request,
clear timers and Working state, and release application single-flight. This
repair reduces work before output; it does not pretend to cancel a shared
backend synchronously or fix machine contention by increasing process priority.

Port the already-tested content-free phase/request diagnostics as well. Keep
the50-event bound, missing counters null, no prose and no hidden reasoning.
These permit natural post-install verification without another inference harness.

## Compatibility and delivery boundary

No durable state migration or historical rewrite. Live/rehearsal receipts,
profiles, importer, credentials, quiet assistance, motif scope and exact three
writing-canary IDs must survive the normal safe local handover. Hosted/API/
worker/Ollama/Cy must remain untouched. No public desktop release is authorized.

Roll back future ephemeral requests through the normal idle update process;
already-admitted work finishes under its captured layout. Never restore an old
profile/data snapshot over later natural activity. External self-recovery was
absent at the checkpoint and remains a separate task, not added here.

## Offline verification

The current port passes 629 exact-reconstruction checks, 39 scheduler routing
checks and 68 current first-look/theme compatibility checks. Independent review
found no material issue. These are offline/mock checks, not model generations.

Current fictional representative menus retain all 12 actions and eight votes:

| Fixture | Released characters | Compact characters | Reduction |
| --- | ---: | ---: | ---: |
| Civic | 43184 | 20400 | 53% |
| Camera | 43021 | 20409 | 53% |
| Uptime | 43283 | 20579 | 52% |
| Dense branch | 59295 | 38202 | 36% |

These are not retained production prompts or a throughput measurement. Prior
native Qwen tokenizer measurements of these representative layouts found about
31-46% input-token savings; current natural prompt_eval_count and phase timings
must establish the installed result. Byte preservation does not itself prove
identical model attention or comprehension. No synthetic inference campaign is
part of this repair.

## Final regression and package checks

All 46 affected offline suites pass on eb0a34234c8988bdec1806a7f2fbfd3150b01758:
3,958 explicitly counted checks, plus eight passing suites that omit counts.
They cover provider timeouts/cancellation, exact evidence reconstruction,
current themed first-look-v2 receipts, scheduler/durable replay, hosted budgets,
continuation, turnover, quiet assistance, writing-canary isolation, reply
continuity and Burst. All provider/network work in these fixtures is mocked.

The first local 0.27.11 handover loaded numeric diagnostics but natural telemetry
correctly exposed decisionEvidenceVersion=null. The production server had not
passed placement to scheduler.start, so the desktop-only gate could not select
compaction. The one-line startup wiring from the original reviewed change was
restored in eb0a342; its new source-wiring regression fails before the fix and
passes afterward. The real server-to-provider path was independently re-reviewed.
The intermediate signed artifact is retained, not overwritten or published.

The corrected local-only package is 0.27.12, built from eb0a342. Its SHA-256 is
eb1ad2930257b8c6cd9a036227758d2d7f509d267eaf218262b1bf8d360897d1.
ECDSA verification against the installed launcher's public key passes, minimum
launcher is 0.2.2, and all 93 packaged files match source. Packaged reconstruction,
reply-continuity, theme-scope and first-look fixtures pass. Local-update
preservation passes nine checks and no-overwrite staging passes 13 checks on
the final payload.

The combined packaged-browser fixture is not green: it stops at the unrelated
Naturalness snapshot-loading wait. The unchanged 0.27.10 package also fails to
complete that fixture (with an additional browser-profile cleanup EBUSY).
No UI/browser assertion was weakened and no claim of a full browser pass is made.

No synthetic/model experiment, paid call, hosted deployment or public release
is part of this repair. Controlled delivery and natural runtime evidence follow.

## Controlled local delivery

The corrected handover installed 0.27.12 from eb0a342 at
2026-10-27T16:54:45.861Z and restored normal scheduling at 16:54:46.474Z.
The original launcher/runner were replaced only after the entire active tick
became idle. No inference was killed. No update retry was required. The existing
pause is tick-boundary admission, not a per-profile stop: the running tick could
continue its already-captured sequence while pause was saved true. This explains
the 32m47s second drain; the bounded helper still completed before its 35m limit.
This maintenance limitation is not changed into another scheduler project here.

The final private backup contains 10 files / 11,331,183 bytes. Every backup hash
verifies. Post-start comparison retains all 27 profiles, protected profile
configuration, groups, importer work and credential bytes. All settings match
apart from the deliberately restored update-owned pause; historical theme
receipts and exact writing-v3 IDs survive. Fixed quiet assistance is ON,
population-aware quiet assistance remains OFF, and theme scope is unchanged.
New launcher PID47288 and runner PID68012 serve port8770 from the signed payload.
No hosted/API/worker/Cy or Ollama process/configuration was changed.

At 16:55:05.004Z a naturally admitted quiet-conversation decision for
am_i_gaybot2 reported decisionEvidenceVersion=1, proving the real corrected
entry point selected the compact representation. This admission is not yet
claimed as a completed or semantically valid decision; completion evidence is
recorded after it arrives. No request was forced for verification.

The 36 native timeout incidents also each match a retained timeout-classified
profile activity record uniquely within 15 seconds, across 12 bots. Thus the
full-window attribution is corroborated beyond the shorter 50-request telemetry.
The narrower request-ID/token correlation remains separately described above.

External self-recovery/supervision remains absent from the related scheduled
task/service inventory. It was not implemented as part of this inference repair.

## Natural verification: reliability remains HOLD

Request2839 ended at 17:15:05.035Z after 1,200,031ms with
OLLAMA_FIRST_OUTPUT_TIMEOUT. Shared-evidence version1 was active: 32,462 user
prompt characters plus 397 system characters, unchanged Qwen model, four
requested threads, 640 output tokens, native input8178 and context32768.
No generated record arrived and no partial response was accepted. Terminal
native timing counters correctly remain null, not fabricated zeroes.

Native task110889 recorded input progress1024 at278.13s (3.68 tokens/s) and
2048 at547.71s (3.74 tokens/s). At17:18:25Z a numeric-only read of the actual
native /slots endpoint still showed task110889 processing, n_prompt_tokens3076,
after its HTTP client had timed out. The desktop had already cleared that
request and admitted request2840 for a different bot at17:15:31.037Z. This is
not a duplicate inference retry: it is obsolete backend work delaying a later
opportunity. Untimestamped native task records do not support an exact split
between server queueing, cache work, cancellation drain and current prefill.

The lossless representation demonstrably removes redundant input, but this
natural result does NOT establish successful model comprehension, a throughput
improvement or restored reliability. Smaller requests are still too slow under
the current shared-backend conditions. Do not call the next ecology window
clean yet or claim this was fully repaired merely because port8770 is healthy.

Read-only resource checks find the expected BelowNormal priority, affinity
0x3FF and the unchanged guardian policy, not a newly imposed single-core
affinity. Native private memory is about16GB with about6.2GB working set; CPU
allocation varies markedly (one short sample0.11 CPU-seconds/wall-second).
Earlier host load was91%; its historical share of each failure is unquantified.
The current runner had no measured read/write throughput during one sample;
store.load uses its cache and does not unconditionally rewrite on each read.
There is no demonstrated persistence-to-latency cause justifying a new storage
project. No host priority, affinity, model/runtime, context or batch setting was
changed. The native1024-token batch/ubatch may amplify cancellation delay under
contention, but changing it without a safe service-level validation is not
presented as a proven repair.

Remaining boundary: a focused shared Open WebUI/Ollama execution and
cancellation/drain repair, at an explicitly safe maintenance point. Do not
blindly increase deadlines, restart active useful work, or invent a native
quiescence acknowledgement from a closed client socket. Current local0.27.12
is unpaused and all canaries/state remain preserved; no further model call or
runtime change was forced to obtain a favorable result.

## Approved focused shared-backend maintenance

The owner approved focused Open WebUI/Ollama maintenance, including an idle-only
restart. Further read-only inspection identifies a concrete memory-pressure
amplifier: the native server retains 8,153.551 MiB of reusable prompt snapshots
under its default 8,192 MiB limit, separately from the active 4,608 MiB KV buffer.
The native process has about 16.28 GB private allocation. Host available memory
fell to 976 MiB, committed memory reached 67.59 GB on a 32 GB machine, and
multiple samples show sustained paging. This does not prove that every second
of prefill latency is paging; it establishes unnecessary large cache retention
under actual memory pressure. Independent host workloads are not modified.

The installed native binary explicitly documents --cache-ram and its
LLAMA_ARG_CACHE_RAM environment variable. The minimal source-controlled launch
policy in ops/leno-ollama/start-ollama.cmd caps reusable snapshots at 1,024 MiB.
It does not change model weights/digest, 32,768-token context, KV precision,
temperature, thread count, batch/ubatch, provider timeouts, priority or affinity.
Removing the new comment/environment line reproduces the original launcher
exactly after line-ending normalization. No application data or replay contract
changes. A cache miss may require recomputation, never omission of prompt facts.

The original launcher and unchanged guardian are privately backed up and hash
verified. The original launcher SHA-256 is
947457014e3025420ad7ffc2616a7b969a3f64d376cc85ca263d737ebd96f178.
The existing normal hidden startup path is retained. This is not a public
release, model upgrade, new supervisor or scheduled experiment.

Six static policy assertions pass; the native help/parser check starts no
server and loads no model. Actual cache activation, safe handover and natural
completion evidence remain to be recorded below; source presence is not proof
of a running repair.
