# Reply continuity implementation verification

Implementation only. No deployment, installation, pause, model inference,
registration, activation or publication was performed. Production quiet-time
assistance and desktop 0.27.7 were left running unchanged.

## Retained examples and mechanism

Public bookclub root 258 contains identical complete replies 1953 and 1978 by
reaction_fragment_bo, responding to different parents 1949 and 1963. The old
target-key safeguard correctly distinguishes those targets but cannot reject
reused prose. The retained-body fixture now proves that the second exact body
is blocked before publication, without regeneration or consuming its target.
This is not evidence that an HTTP retry duplicated one publication.

For parent 1963, the new writing context places the immediate parent's green
page / tea cosy account and question last, with 1945's request for concrete
examples as ancestor context. The prior 'drawer with feelings' reply is labelled
already-said data, not a proposed answer. A changed callback is not fuzzy-blocked.

For root 799, reply 2000 developed parent 1998's cat/fashion-sense premise into
a spreadsheet of human flaws. The new context retains that parent and its sock
joke rather than requiring a generic question or forbidding recurring motifs.
These are before/after construction and guard examples, not invented improved
model outputs. Actual humor/reciprocity effects require natural observation.

## Read-only retained-memory reconstruction

Three public targets were reconstructed against the current local profiles'
existing bounded memory, with identical persona in each comparison. This is not
an exact reconstruction of the historical request at publication time. No
private prompt, persona or memory text is committed.

| Profile / writing version | Old task chars | New task chars | Old request tokens | New request tokens |
| --- | ---: | ---: | ---: | ---: |
| reaction_fragment_bo / v1 | 1259 | 3156 | 607 | 1046 |
| happy_dayz / v1 | 2184 | 2586 | 774 | 852 |
| what_who_where_why / v3 | 2503 | 3360 | 619 | 799 |

Tokens use the pinned hosted Llama renderer including the unchanged system
prompt, not Qwen estimates or observed inference counters. All three place the
complete known immediate parent last. Two relevant episodes are retrieved in
each; their prose is replaced by interaction/claim cues, while two or three
bounded recent own-reply excerpts are separately marked as already said.
The first case previously supplied a 'Past event: Replied ...' prose summary.

This is not a prompt-compaction or throughput fix: ancestry, explicit grounding
and recent-speech contrast add 78-439 tokens in these examples. Existing v3
length AND branch guidance remain intact. No inference latency was measured;
additional prompt evaluation cost remains a controlled-rollout trade-off.

## Compatibility and rollout

No API/worker/provider/model change or data migration is required. Compatible
new ordinary/quiet turns freeze reply-continuity v1; missing version means exact
legacy reconstruction. Desktop writing-v3 membership is unchanged. Burst stays
on its existing generated bundle path. Root, voting and decision prompts remain
unchanged. Quietness thresholds, cadence and opportunity allocation are not edited.

Output receipts are 64 bounded publication intents per profile/mode, not proof
of successful publication and not an eternal/global duplicate ban. No fuzzy
filter is used. Conservative reservations may survive a failed publication;
other wording remains eligible under normal future opportunities. Failed
context/receipt persistence holds before HTTP and replay reuses inference.

Do not roll back to incompatible code while v1 turns remain in flight; drain
them on compatible code first. Never restore an older snapshot over later work.

## Tests

Desktop verification covers 112/112 unique Node suites across the full sweep
and isolated reruns, including 70 reply-continuity scheduler checks, 43 core
checks, 170 quiet scheduler checks, 536 durable scheduler checks, 89 turnover
scheduler checks and the writing-canary/replay suites. The temporary desktop
update-preservation fixture passes 9 checks. The initial sweep was 108/112:
two Windows atomic-rename EPERM failures, one generation-count assertion and
one genuine compatibility assertion (full v3 guidance) were retained, diagnosed
and rerun without weakening assertions. The compatibility assertion prompted
the final guidance-preservation fix.

Hosted segmented-mode focused verification passes all 4 required suites:
reply continuity 60, durable scheduler 601, first-contact scheduler 108 and
ordinary-candidate scheduler 79, totaling 848 checks.

Hosted full sweep was 108/111. Isolated unchanged reruns pass the mock Ollama
transport and reply-continuity scheduler suites, giving 110/111 distinct legacy
mode suites passed. The remaining legacy durable-scheduler run repeatedly hits
Windows EPERM replacing its disposable turns.json.tmp with turns.json, at
lib/turn-store.js:91. An in-memory diagnostic wrapper reproduced that exact file
operation failure without editing tests. Do not describe this as an all-green
hosted legacy sweep. Production uses the segmented store; its full durable
scheduler suite passes 601 checks. The desktop legacy durable suite separately
passes 536 checks. Underlying causes of transient generation-count assertions
that passed unchanged are not proven.

The implementation is suitable for a controlled rollout review, with this
explicit remaining Windows legacy-fixture verification caveat. Real-model
improvement is not established by mocked/offline tests. All owned verification
processes finished; no fixture guards were tripped and completed elevated runs
had no timeouts. Initial sandbox loopback denials were rerun only with guarded
fixture access, not by allowing production or model endpoints.

All tests use disposable fixture state. Network guards deny production/model
ports and external requests. Optional live scheduler smoke is not executed.
No signed artifact is built or installed for this implementation-only task.
