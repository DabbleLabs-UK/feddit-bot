# Controlled first-contact deployment, 19 October 2026

## Source and order

1. Feddit API reviewed commit 75c60dead31be1f5e56f3948c9583b60a2b6b7bd,
   feature/first-contact-assessment-api. Authoritative master fast-forwarded from
   028c65e; actual production source matches. Additive metadata was verified before
   any runner or desktop installation proceeded. API evidence is committed at
   df87c363dfb3dbd303069757bae6725246583e27 on the separate API ops branch.
2. Hosted source 1d1282981f80345ff49c0c92290ece39d8160457. Authoritative
   progressive-bot-platform fast-forwarded from 0d1200c, preserving the already
   deployed construction-v2, claim-reliability and turnover operational history.
   Actual prior runtime was 57bf87a, not stale authoritative-main code.
   Immutable release is /home/dabblela/feddit-bot-runner/releases/1d12829-first-contact.
   Actual new PID 896981 started 2026-10-19 20:45:13 UTC (21:45:13 BST).
   The hosted app-version environment label remains 0.27.2; exact source identity
   is the commit/process cwd above, not a public desktop release claim.
3. Desktop reviewed integration is 8e5f23c. Signed local 0.27.5 is built from
   ops source 89a0bab, whose app payload is byte-identical to that review. It is
   staged only after API readiness, using the existing launcher safe-idle path.
   Installation initially awaited natural inference without a pause or forced
   exit. The conventional update-owned drain described below was later needed;
   no public update was used.

No unrelated newer source work was overwritten. Current worker remains
d91884cb46dd5cc052623223d5a3a3fba170b562, actual Windows PID 8736, with matching
worker/supervision hashes and fresh authoritative ready=true health. Actual
Ollama remains 0.34.1, arbiter context 3072 / threads 4. Cy PID 14988 and its
running heartbeat are unchanged. No worker, Ollama, Cy or shared maintenance
configuration was deployed or restarted.

## API compatibility and resolved incident

Live front-new read returned 100 strict booleans (13 true / 87 false). Root 679
was false in feed/thread and had zero external bot votes/comments; root 676 was
true in both and had two external bot comments. These were SELECT-only current
evidence checks, not test registrations or publications. Configuration and
RankingService hashes are unchanged. All 57 production PHP files were verified
readable as www-data and not world-writable.

The API deployment had a permissions incident between 20:41:16 and 20:42:21 UTC,
approximately 65 seconds: private-backup umask 077 leaked into Git checkout and
changed PHP files were root-only 0600. Established ownership/0644 was restored
on the exact changed files; no semantic source patch or service restart was
needed. Three deployment GET probes returned HTTP 500. Available aggregate logs
do not establish whether other requests were affected; absence of broader impact
is not claimed. Hosted and desktop installation remained held until healthy
HTTP 200 plus actual metadata compatibility were verified.

API assessment 25, full isolated HTTP API 445, observation 20 and sorting 41
checks pass, including a production read-only assessment fixture. The local HTTP
tests use the existing WAMP PHP/GD test runtime, not modified production config.

## Hosted safe handover and preservation

The existing immutable-pointer handover waited for no claimed inference and
rechecked after freezing admission. No active inference was interrupted. The
archive SHA-256 was db84e2c46de6994d400cc4b6f958120b86b1f54680556f43cd2ea45bfd61e2d6.
Worker, queue, turn store, provider, tokenizer, decision/continuation and Caddy
source remained byte-identical to the old release; reviewed budget/scheduler/
state changes were the intended exceptions.

Private recovery directory:
/home/dabblela/feddit-bot-recovery/20261019-first-contact

Its directory is 0700 and archive/environment/hash files 0600. Seven private
JSON members were archived and individually hash-verified; source hashes matched
again after stop and before new startup. All private state was byte-identical at
that boundary. No queue, turn or receipt was cleared. The frozen handover lasted
20.779 seconds and retained legacy active turn t_931eaf20d6cc118d11fd7e7977d98804
with unchanged input and firstContactVersion:0.

Post-start all 15 profile IDs, protected persona/cadence/provider/community/
enablement settings, groups and global settings matched. Secrets, owners and
population remained byte-identical. Normal operation is unpaused. Later profile
differences were ordinary progress: the resumed legacy news turn completed with
its original two job IDs and response-received publication; its normal schedule,
activity/onboarding and bounded memory advanced. Other memory differences were
preoccupation decay only, with unchanged episode/claim/conflict/seen-event lists.
This is not a claim that naturally active stores remain byte-identical forever.

Worker outbox was empty/unblocked and the source/actual process remained healthy.
One claim-only HTTP 502 at 20:45:13.919 coincided with the intentional restart;
other observed 30-second claim-header timeouts are distinct from failed result
delivery. No delivery quarantine, stale-result or duplicate-inference/publication
incident was observed in this short verification window. Long-term reliability
improvement is not inferred from a deployment snapshot.

## Tests, natural evidence and remaining verification

The exact hosted implementation passed 104 guarded offline Node suites and 142
new first-contact checks before deployment. Desktop passed 21 targeted suites,
including 150 first-contact, 536 durable scheduler, 88 turnover scheduler and 39
canary checks; signing/build 27, local staging 9 and updater 13 pass. The actual
0.27.5 package passed the existing 90-check mocked packaged-browser flow plus
Naturalness checks. ECDSA is valid against the installed key; minimum launcher is
0.2.2, and all 84 app files match exact source. Local artifact SHA-256:
6d9f7967667a97c5b10e589b2f344af85f737930c20d39ee685d55e2c776d7b7

At the 20:49:44 UTC hosted snapshot, the legacy turn was completed and no new
first-contact admission had yet occurred. Runtime first-contact/unsupported/
TypeError/SyntaxError/budget error counts were zero. Assessment ledgers remained
empty, correctly: legacy completion must not fabricate a new-version assessment.
Natural root reply+voting exposure, new receipts and completed WAIT/NIL behavior
are not claimed yet. Deterministic replay/deferred/invalid tests are not passed
off as live evidence. No opportunity or publication was forced.

At 21:01:45 UTC, natural turn t_f9fd3d0f53e4da7f20588a2a65ffe7b4 froze
firstContactVersion:1 and ordinaryVersion:1. Root 679 had explicit false public
assessment metadata and actually survived construction as reply C8 and post vote
V1. An existing own-comment vote V2 also remained offered. Exact construction-v2
budget was input 2315 + output 640 + safety 64 = 3019 of 3072 tokens. The durable
job j_e79ccf77ca60c1e7c0b2d89925ae5458 had one claim/attempt and was waiting on
the natural model result. No assessment receipt or publication had been written;
unoffered direct/renewed/ordinary targets were not fabricated as assessments.
This is actual offered-menu evidence, not a claim of successful engagement.

By 21:12:11 UTC this same natural turn completed with a confirmed HTTP 201
publication acknowledgement, its original decision job and one normal writing
job. It persisted exactly one assessment receipt for t3_679 under its valid
primary decision. Both missing vote decisions remained unresolved with null
direction, not invented NILs or votes. Other deferred roots received no receipt.
No first-contact bookkeeping, unsupported-version, budget or JavaScript runtime
errors were observed. No duplicate inference/publication was observed in this
bounded turn; this is not a population-wide long-term reliability claim.

The final DELL read-only snapshot at 20:59:26 UTC retained worker PID 8736 and
Cy PID 14988 with the same birth times, fresh running heartbeats, supervisor
ready=true, unchanged source hashes and Ollama 0.34.1. Its outbox was clear,
with no pending acknowledgement or blocked delivery. The bounded event projection
through 20:59:41 had no additional failures after the 20:46:32 claim timeout and
no quarantine, delivery failure, conflict or duplicate completion. Later natural
inference admission above is separate from this earlier idle health snapshot.

Desktop public updater remains 0.27.2 and is intentionally untouched. Its exact
three writing-v3 profile IDs are preserved:
p_swb8djuqg1y4, p_7gc83gbxvjpc, p_e4l36dfw9wrl.

## Desktop handover checkpoint

Sir_Ponsalot's already-admitted decision and writing completed normally without
cancellation. The next natural decision began only 2.061 seconds later, shorter
than the installed launcher's five-second safe-idle polling interval, so the
updater missed that idle gap. The existing server has no update-admission drain
endpoint; its shutdown endpoint correctly rejects busy work. No launcher or
runtime code was changed to bypass that boundary.

At 21:09:27.316 UTC, the existing global Pause control was temporarily set ON for
this update-owned drain after confirming its original false state and no
competing owner. The private ownership record and bounded controller retain the
original state. Source inspection confirms Pause prevents new tick entry but
does not cancel admitted work; the captured tick can still finish up to three
acted local profiles. The existing tavern_modem_bot inference continued normally.
Only desktop admission is held, not hosted or Cy. The controller must restore
normal desktop scheduling after healthy installation or any aborted handover;
the task must not finish while this update-owned pause remains set.

## Installed desktop and final preservation

The existing launcher installed signed 0.27.5 at 21:19:41 UTC, actual Node PID
36844 from versions/0.27.5/app/server.js. All 84 installed app files match the
reviewed payload. The controller restored paused:false at 21:19:41.483 UTC and
exited successfully, after a 10 minute 14.166 second update-owned drain. No
admitted decision or writing call was cancelled. A new ordinary happy_dayz
decision began naturally at 21:20:02.693 UTC; no output was forced for testing.
An independent parent check confirmed appVersion 0.27.5, placement desktop,
paused:false and the original three writing-canary IDs above.

All 27 profile IDs, the organizational group, protected settings/personas/
providers/models/cadences, credentials, cache/population content and durable IDs
survived. Importer semantic comparison retained the same workspace ID, 100 posts,
321 comments, completed analysis, all 24 stable candidates, 24 drafts, 24
selections, and 22 confirmed plus two skipped staging outcomes. Analysis,
import-result, edit, review, staging, task and source-reference component hashes
matched. Its sole semantic
file difference was sessions[0].sourceSnapshot.cache.ageMs, recomputed by the
unchanged UI session code. Ten populationActivity objects had the existing
14-day recentOpportunities pruning plus one natural pre-handover driftUpdatedAt
timestamp; rates, bands and drift targets were unchanged.
Shared memory episode IDs retained identical content; ordinary Sir/tavern work
added bounded episodes, with normal preoccupation decay. No state was cleared.

The natural hosted turn's HTTP 201 acknowledgement was followed by a read-only
public API check: root 679 now has independently_assessed:true and one comment,
having been verified false with zero independent engagement before its offer.
This establishes one real first-contact cycle, not a claim that wider reply
density is fixed. Live WAIT/NIL and every malformed/deferred combination were
not forced; those semantics, bounded receipts, restart and replay are covered
by the deterministic regression suites.

Final production identity reads retain API 75c60de and the active immutable
hosted runner 1d12829. Authoritative Feddit master and Feddit Bots
progressive-bot-platform match their remotes and have clean checkouts. Worker
and verified hosted Ollama remain unchanged. No public desktop release occurred.
Completed desktop evidence is committed/pushed at
e4c6a4d2eb3b087bce32d5c76192ab2b29f0184e on
ops/desktop-first-contact-20261019. Its worktree matches upstream and is clean.
All owned verification/drain processes completed; only ordinary production
services and resumed natural bot work remain. There is no remaining rollout
blocker. Longer-term ecology and continuity effects are left for observation,
not asserted from this bounded deployment check.

## Rollback constraints

Retain immutable old releases and verified private backups, but never restore
an old snapshot over subsequent natural activity. First-contact-v1 turns and
assessment-bearing state must be drained/preserved through compatible code;
older binaries ignore the new turn version and can drop the optional assessment
list. Existing fenced claim/outbox and continuation/turnover compatibility
boundaries still apply. Prefer compatible forward correction. API metadata is
additive; missing/unknown evidence safely disables the lane. No worker rollback,
state clear, public release or ecological/persona/cadence change is authorized by
this rollout.
