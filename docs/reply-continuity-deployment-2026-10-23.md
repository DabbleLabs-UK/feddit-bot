# Controlled reply-continuity deployment - 23 October 2026

## Scope and source

Operator explicitly authorized deployment of hosted
`4f4d11e9a9c9dc28dfbf74b0a0e1698c43a66e0d` and desktop
`10d6c7afd38f4642d0c879d196889d5eafef0710`. No main promotion or public
desktop release is part of this delivery. Both reviewed payloads are used
unchanged. Operational evidence is on separate deployment branches.

Current authoritative main remains 633e808. Remote reviewed branch heads were
verified before delivery. Actual hosted base was 1c713d6, PID 1554145; all 280
tracked base files matched the reviewed source. Installed desktop was 0.27.7
from d90a466, Node PID 42912 / launcher 40816, unpaused, with the exact original
canary IDs. Active desktop inference was not interrupted.

Unchanged canary: p_swb8djuqg1y4 (what_who_where_why), p_7gc83gbxvjpc
(Sir_Ponsalot), p_e4l36dfw9wrl (porcelain_oracle_bot).

## Hosted handover

Hosted delivered first at **2026-10-23 20:55:54.837067 UTC**. New actual runner
PID **1928384** serves from
`/home/dabblela/feddit-bot-runner/releases/4f4d11e-reply-continuity`.
The source archive SHA-256 is
`5aae0d3843bb35dd01dfbc34eaf59b38c9411f97cf35be9e70d85762c691875e`.

The existing natural-idle handover checks no claimed inference or attempting
publication, positively freezes only the owned original process, verifies a
private backup and unchanged state, then stops and switches immutable source.
Concurrent source/environment changes fail closed; cleanup cannot resume or
restart an unknown runtime. Environment remained byte-identical, including
FEDDIT_QUIET_CONVERSATIONS=1. No API, worker, Cy, Ollama, arbiter or proxy restart.

The frozen boundary lasted **17.011 seconds**, with zero active turns or queued
jobs. Private verified recovery directory:
`/home/dabblela/feddit-bot-recovery/20261023-reply-continuity`.
Backup verified **1278 files / 556029226 bytes**, including all **1269 turns**
(1102 completed, 167 failed), the 89-byte marker, complete segmented directory,
private stores and restricted environment. No old snapshot was restored.
Post-start checks preserve all 15 profile IDs/protected fields, settings/groups,
secrets, owners, population, marker and every prior historical turn byte-for-byte.

Worker remains d91884cb46dd5cc052623223d5a3a3fba170b562. Its actual Windows
PID 8616 / supervisor 6234 remain ready with fresh heartbeat. Ollama API reports
0.34.1. First new natural hosted turn t_ad9874c077383ef26d85a77b830cc70f
(botbaffler_999) freezes reply-continuity v1; initial decision proceeds through
the unchanged worker queue. No inference was forced for verification.

## Desktop preparation and verification

Signed local-only **0.27.8**, exact reviewed desktop source, SHA-256:
`2f7a427d439cf39f75ef8540908325786ddafad324f47228682667ef784f1311`.
ECDSA verifies against the installed launcher public key; minimum launcher is
0.2.2. All 86 packaged app files match source byte-for-byte. Packaged reply
module checks pass 8 assertions; first-look fixture passes. Updater 13/13,
local update preservation 9/9 and no-overwrite operator staging 13/13 pass.

Existing Naturalness browser snapshot waits fail identically on the new 0.27.8
and previous signed 0.27.7 payload with the unchanged harness. No assertions or
runtime code were weakened to hide that baseline caveat. All fixture processes
exited. Prior implementation coverage is documented in
reply-continuity-verification-2026-10-23.md, including the accepted Windows
legacy-store EPERM caveat and green production segmented suites.

The local update uses the existing owned admission pause, private backup,
authenticated idle-safe shutdown and launcher pending/current activation.
An operator-only staging helper preserves that format while using exclusive
staging creation, ZIP-derived exact file hashes and no-replace target/pending
publication. Recovery/unpause requires verified owned process/current/pending,
old/new source hashes and exact canary. Shipped updater code is unchanged.

## Completed desktop delivery

Installed at **21:18:36.280151 UTC**; normal scheduling restored at
**21:18:38.327963 UTC**. The update-owned admission pause began at
20:57:36.070808 UTC and lasted **21m02.257155s**. The already-admitted
governmint_clerk_b_1 decision reached its existing 20-minute first-output timeout
normally; it was not cancelled for installation and no timeout was changed.
No new natural work was admitted while draining.

Actual new Node PID **55080**, launcher PID **22596**, serve 0.27.8 from
`versions/0.27.8/app/server.js`. All 86 installed files match the signed package
and reviewed source. build-source.json records exact 10d6c7a and the package hash.
The actual process retains FEDDIT_QUIET_CONVERSATIONS=1. Global pause is false;
the same three canary IDs are persisted. Natural what_who_where_why scheduled
decision 2448 resumed at **21:18:47.988 UTC**, without a forced call.

Verified private backup:
`C:/Users/jodyf/AppData/Local/DabbleLabs/FedditBots/backups/reply-continuity-20261023`.
It contains **10 files / 10765864 bytes**, with unchanged data hashes before
new-process start. Post-start checks retain all 27 profiles/protected fields,
settings/groups/providers/models/cadence/enablement, Speed/Burst/canary, secrets,
importer cache and work (ignoring only derived cache age), and the one existing
legacy durable turn with identical frozen input. No snapshot was restored.
An early read-only verification sampled settings before restoration completed
and correctly saw the owned pause; the post-controller verification passes.

The existing 43-assertion core regression was also run against the actual
installed libraries with disposable isolated data and no network. It verifies
fingerprint persistence through store reopen, exact-repeat rejection, same-owner
replay, live/rehearsal separation, bounds, history, identity moves and atomic-save
failure. It did not insert a receipt or duplicate probe into production state.

## First natural reply and final health

Hosted botboggle turn **t_bc433fd814c1648b556e48e642f89ab8** naturally replied
to **root 165**, receiving HTTP **201**. The frozen writing context contains one
recent-own-reply excerpt explicitly marked already said and factual memory cues;
the complete target block is last. This is a top-level reply, not live evidence
of a nested ancestor chain. Nested immediate-parent/ancestor ordering remains
covered by retained-case and installed-code tests, not forced social traffic.

Actual writing request: **659 input + 200 output + 64 safety = 923 / 3072**.
Its decision and existing repair requests used 2119/2162 input tokens with
640 output and 64 safety (2823/2866 total). All three distinct jobs completed
with exactly one attempt each. One live fingerprint is persisted in the actual
profile file. No natural duplicate-body rejection has occurred at this cutoff;
the pre-HTTP/no-regeneration boundary is fixture-verified, not live-probed.

One other natural post completed and an existing malformed-decision failure
occurred before writing. No claim, source-contract, persistence, duplicate-job or
publication-uncertainty regression was found. Final worker/queue is healthy with
one normal natural job active and no duplicate dedupe keys. All 1269 pre-handover
hosted turns remain intact and byte-identical; segmented storage is unchanged.
This small sample does not establish better conversation quality or reciprocity.

Public updater remains **0.27.2**, unchanged SHA-256
`863b165a312393820f985a270de5c2ca710258b92bfc071869d1e14864b802da`.
No public artifact/manifest/tag/release was published. Both installations are
left running under normal admission. No further tuning was started.

## Rollback constraints

Let admitted reply-continuity v1 turns finish on compatible code before reverting
to an incompatible binary. Do not reinterpret frozen legacy turns or restore
old data over later natural activity. Keep hosted segmented-store support,
claim fencing/outbox/publication uncertainty and the complete marker/directory.
The 64-entry per-profile/mode fingerprints are conservative publication intents,
not proof of successful posting; retain them with current profiles. No fuzzy
filter or automatic regeneration/retry was introduced.
