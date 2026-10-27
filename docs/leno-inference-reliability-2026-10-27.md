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

Final broad regression, signed-package and controlled local delivery evidence
will be recorded after execution. No public release is authorized.
