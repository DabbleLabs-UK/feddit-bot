# Conversation continuation correctness

This change is a correctness repair, not an engagement policy. Opportunities,
cadence, priority, personas, social salience and prompt budgets are unchanged.
WAIT is still valid. Nothing guarantees a reply or a minimum thread size.

## Previous defects

The live `settings.threadReplies` ledger counted every profile on a runner,
without timestamps or expiry. Once three replies were accounted in a thread,
unrelated bots could no longer continue it. The original intent was to prevent
two local profiles from ping-ponging indefinitely, not to cap the conversation
across all independent participants.

Attention and recently active-thread receipts were also committed by the
opportunity-observation effect before hosted prompt construction. Filtered or
budget-deferred candidates could therefore lose their discovery route without
ever reaching the model.

## Per-bot anti-loop boundary

New turns use continuation contract 2. Each bot may account at most three reply
attempts in one thread within a rolling hour. Live and rehearsal histories are
separate. Self-replies and existing exact-target dedupe remain prohibited.
The same admission check runs immediately before each comment action, including
actions from a frozen Burst menu, so one inference cannot bypass the boundary.
Different bots have independent allowances and there is no thread lifetime cap.

Successful simulated replies and live publication attempts with confirmed or
uncertain non-429 outcomes count. A server 429 does not count. Hard failures
continue to consume their exact target, avoiding repeated failed writes. The
guard never raises server/probation allowances or infrastructure priority.

The private guard retains at most 500 thread/target/timestamp records per bot and
mode. Expired records do not count, but their retained IDs prevent a replay from
refreshing an old attempt's timestamp. Durable replay freezes the original
publication-attempt time. This is a rolling safeguard, not a permanent quota:
later genuinely new targets in that thread become eligible again.

## Discovery receipts

Fetching is observation, not handling. A valid primary decision, including
WAIT, handles the exact candidate menu retained and offered to that model. A
resolved explicit vote handles only its exact public target. Voting on a root
post does not consume the fresh comment that renewed that post's thread.
Malformed/missing decisions, filtering, an admission hold and token-budget
deferral do not create new receipts for unoffered targets.

Attention cursors hold behind each source's oldest pending event, independently
for posts and comments, while acknowledged IDs remain deduplicated. Stale or
invalid non-candidates may advance normally. Renewed-thread ledgers receive only
matching handled event IDs. Existing exact-target reply dedupe can repair a
missed receipt without pinning discovery forever. No new full-content backlog,
background poller, catch-up inference or automatic publication is introduced.
The existing bounded scan, attention expiry and renewed-thread freshness limits
still apply; this change does not promise delivery of every old event.

Selective receipts and attempt timestamps are durable checkpoints. Their
profile merges are idempotent and are not marked complete before writing.
Checkpoint/profile-write failure holds the durable turn for recovery. Restart
reuses generation and publication checkpoints rather than resending a write.
Publication-uncertain outcomes remain uncertain, never blindly retried.

## Existing state and compatibility

Profile schema 27 adds empty per-profile guard state. Old aggregate counters
contain neither owner nor time, so they cannot be safely attributed or migrated
into the new rolling histories. They are preserved unchanged for legacy replay.
No profiles, groups, provider selections, cadence/deadlines, social/memory state,
attention cursors or historical considered keys are cleared or rewritten.
Historical prematurely consumed events are not reconstructed or mass-replayed.

Every new durable turn freezes `continuationVersion: 2`. Existing turns with no
version keep contract 1: their original guard and discovery effects continue
unchanged. Unknown versions block before execution. Reusable profile templates
exclude guard state; explicit identity continuity/handover includes it. Normal
profile-edit APIs cannot alter it and normal editor responses do not expose it.

Deployments must use the existing safe durable handover. A rollback to an older
binary that does not recognize continuation contract 2 requires draining all
v2 turns first; the old binary cannot enforce this new version boundary itself.
The new binary can replay either supported contract without reinterpreting
legacy checkpoints. This branch is not deployed or released automatically.

## Regression coverage

- Real-store mocked scheduling: twelve independent bots continue one thread;
  one bot's fourth rapid attempt is held and becomes eligible after expiry.
- Invalid/filtered/budget-deferred discovery remains pending; valid WAIT and
  matching explicit votes acknowledge only their actual targets.
- Durable hosted budget receipts survive restart; deferred renewed candidates
  reappear in later ordinary opportunities.
- Legacy replay, unknown-version blocking, partial checkpoint/profile-write
  failure, ambiguous publication and frozen Burst action admission are covered.
- Migration, separate rehearsal state, identity handover and unchanged groups,
  cadence, provider and server contracts are exercised by the existing suites.

Verification for this repair: all 89 Node test files passed (two stale schema
assertions were corrected and rerun), including 532 scheduler checks, 524 durable
scheduler checks, 135 guard checks, 37 real-store continuation checks and 37
desktop/hosted profile API checks. Desktop updater passed 13 checks, disposable
signed-package verification passed 23 checks, and local-update preservation
fixtures passed nine checks. The signed-package subset used disposable test
keys and executed the extracted guard/receipt modules; its separate real-browser
importer check was not run in this job. No installed application, production
state, public manifest or release artifact was changed.
