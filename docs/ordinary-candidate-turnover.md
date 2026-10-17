# Bounded ordinary reply-candidate turnover

Unreleased implementation on fix/ordinary-candidate-turnover, based on the
current hosted/shared operational line 1e5c0f8. It does not include the held
desktop prompt compaction or native-schema candidates. No runtime installation,
deployment, public release, model call or live scheduling write is part of this
job. The existing desktop writing-v3 branch remains separate and unchanged.

## Rule

Only ordinary scheduled opportunities that actually include a reply action use
presentation contract 1. The ordinary limit remains three, attention four,
renewed three, and total action candidates twelve. The model may choose any
offered candidate or WAIT; nothing here grants compute priority or publishes.

The gatherer keeps its existing configured best/new/etc feed reads: at most
four communities and 100 posts per community. It enumerates eligible root
alternatives from those already returned pages without new network requests.
Own-thread fallback discovery remains bounded to three alternatives; within an
already-fetched thread it rotates the eligible comments using presentation
history. Nearby ordinary comments fill only otherwise unused space, as before.

Roots and own-thread fallback comments alternate, starting with a root. When
both have enough candidates, the three slots are root / own-thread / root.
When either source is exhausted, the other can fill the remaining slots. There
is no reserved empty slot, post-age cutoff, fresh-post quota or reply obligation.
Established conversations retain fallback eligibility as well as their unchanged
direct-attention and renewed-thread routes.

Within each source, never-shortlisted targets precede previously shortlisted
targets; otherwise the least-recently-shortlisted target comes first. Configured
feed order breaks ties. This deliberately rotates presentation over successive
opportunities rather than pinning the same highest-ranked targets forever.
It does not change feed retrieval/ranking, inspect age, rewrite salience, or
declare a target irrelevant. Only eligible targets participate; existing self-
reply prevention, exact-target dedupe, link-context rules and continuation
guards remain authoritative.

## Representative before/after

With own-thread comments F1/F2/F3 and feed-ordered roots R1/R2/R3/R4:

| Opportunity | Old ordinary shortlist | New ordinary shortlist |
| --- | --- | --- |
| First | F1, F2, F3 | R1, F1, R2 |
| Next, all unchanged | F1, F2, F3 | R3, F2, R4 |
| Next, all unchanged | F1, F2, F3 | R1, F3, R2 |

A newly discovered eligible root R5, even if old or lower-ranked, has no
presentation timestamp and can enter ahead of recently shortlisted roots.
All previously presented roots remain eligible and return. These are offline
fixture examples, not reconstructed missing historical feed contents.

## State, receipts and provenance

Each profile has ordinaryCandidateState in profiles.json, with independent
live and rehearsal ledgers. Version 1 stores only up to 512 unique public
t1_/t3_ fullnames and positive last-shortlisted timestamps. No text, model
reasoning, credentials, social scores or publication outcomes are added.
Retention is bounded count, not an age-based eligibility rule. Missing legacy
state starts empty; no historical exposures or considered-state are invented.
Unknown future state versions fail closed. Rehearsal reset clears rehearsal
presentation only. Explicit profile moves preserve it; templates omit it.
Ordinary browser profile reads and edits neither expose nor set the ledger.

The opportunity-candidates snapshot freezes a separate
ordinaryCandidateReceipt {version, at, keys}, containing at most three raw
fullnames. After checkpoint success and before inference, the store merges
timestamps with max(existing, frozenAt). Replays reuse the frozen timestamp and
shortlist, not today's time or regenerated candidates. Duplicate receipts are
no-ops. A failed save does not advance the cached ledger; the hosted turn is
held before inference and can safely replay the same receipt after recovery.

The receipt means SHORTLISTED, not model-handled. Even if packing defers a
candidate, the next ordinary shortlist may rotate past it; that target remains
eligible and can return. The ledger never writes repliedTo, voting considered-
state, attention/renewal acknowledgements, social memory or scheduler deadlines.
Invalid/missing decisions remain unresolved, and valid WAIT remains legitimate.
Existing selective discovery receipts still act only under their own unchanged
handled/offered rules. No second inference or retry is introduced.

## Durable compatibility and exclusions

New hosted capability turns freeze ordinaryCandidateVersion:1 only for reply
opportunities. Missing version means exact legacy 0; existing in-flight legacy
turns keep their original gatherer/request reconstruction, even if their
candidate checkpoint has not been written. Unknown versions block rather than
being silently interpreted as legacy. Older advanced/custom store integrations
that lack both presentation methods retain legacy admission; an explicitly
frozen v1 turn never silently falls back if persistence is missing.

Scheduled local turns get an explicit non-durable presentation scope. Durable
helpers require a real turnId, so a local scope cannot accidentally enqueue
DELL jobs or create publication receipts. Actual durable turns retain existing
attempt fencing, request identity, publication uncertainty and queue semantics.

Burst, its inspections, manual simulation/preview and voting-only selection
retain legacy gathering and do not advance this ledger. Voting parser, reason
requirements, allowance, dedupe and unresolved semantics are unchanged. Mixed
reply turns naturally expose votes associated with their newly selected reply
menu, so the exact incidental vote targets may change; this is not a promise
that voting exposure stays byte-identical after reply-source mixing.

Do not roll back to a binary unaware of this version while v1 turns are active
or bookkeeping-blocked. Use compatible code to stop new admission and drain
those turns first; do not clear jobs or presentation/discovery state. On later
reconciliation with the separately installed writing-v3 line, preserve that
line's writing admission wrapper, publicWritingVersion scope, canary controls
and local/durable turnId safeguards. No change to its membership is required.

## Historical estimate and limits

The diagnosed fixed window had 42 completed hosted reply turns. Nineteen filled
all three ordinary slots with own-thread fallback comments. Contract 1 makes
that monopolization impossible whenever an eligible root exists in the same
scanned feed: normally two root slots would then be available. Across those
nineteen turns this is at most 38 potential root positions, NOT 38 proven fresh
root exposures or publications.

The retained checkpoints contain only already-shortlisted candidates, not the
raw historical feeds/eligible root pools excluded by those nineteen turns.
Consequently the number of recovered fresh roots, actual post-budget offers,
or selected replies cannot be honestly reconstructed. The six known fresh-root
appearances and one actual offer remain the measured baseline, not a fabricated
before/after improvement rate. No live gather or inference was run to fill gaps.

## Runtime pause inspection

A separate local Cy isolation record had paused_by_isolation=true and later
phase=RESTORED, restored_by="one-call controller finally", at
2026-10-17 15:14:54 UTC. Read-only desktop verification at 16:58:49 UTC found
paused=false and unchanged writing-canary IDs p_swb8djuqg1y4,
p_7gc83gbxvjpc and p_e4l36dfw9wrl. This job never set or cleared a pause and
did not interfere with Cy. Offline tests use isolated files and mocks only.

## Verification

Focused offline checks pass: 38 pure selection/receipt checks, 21 real-store
checks, 78 real-store scheduler integration checks, 601 existing durable
scheduler checks and 532 existing scheduler checks. Coverage includes restart,
max-timestamp replay, failed-save retry before inference, exact legacy request
reconstruction, unknown versions held, deferred candidates remaining unhandled,
WAIT/invalid no-publication, unchanged direct/renewed routes, local scopes with
turn stores, rehearsal/live separation, configured feed sort and original
link/guard/dedupe filters. Profile packs preserve moves and exclude templates.

The wider regression batch runs behind a guard that blocks external services
and production ports, with isolated per-suite data. The optional existing live
smoke is excluded by that offline orchestrator, not by weakening tracked tests.
No model validation experiment is required for deterministic source mixing.
Actual fresh-post replies and ecology improvement remain unmeasured until an
explicitly approved controlled deployment and natural observation window.

## Controlled desktop integration, 2026-10-17

The integration/desktop-turnover-canary line applies implementation 14e9148
to the exact installed desktop writing-canary source a41b691. Four overlapping
files were reconciled using the previously reviewed compatibility resolution:
scheduler, profile store, data-handling manifest and durable test harness.
Writing admission wrappers, frozen writing contracts and Burst/manual v1 are
preserved. Hosted-only claim-delivery, budget-construction-v2, native-schema
and held desktop compaction implementation are not imported into this line.

The turnover test uses this line's existing hosted-budget construction version
rather than assuming the separately deployed hosted version. Its budget fixture
defers a later complete oversized candidate, retaining the desktop line's
existing refusal of an oversized required first candidate. No runtime budget
or candidate semantics were changed for test compatibility.

The tracked joint regression also proves writing-v3/ordinary-v1 admission,
frozen v3 across restart and membership removal, released writing on future
turns after removal, and independent continuing presentation turnover. The
separate mocked canary probe observes three joint admissions, two released
Burst admissions and 22 presentation receipts without publication or inference.
Only isolated fixture state is changed by these checks. Runtime handover,
package signing and preservation verification remain separate deployment steps.

Integration verification passed all 44 applicable offline suites, including
all 12 writing-canary/public-writing/UI compatibility suites. The focused
turnover scheduler suite additionally passes 88 checks after the joint-canary
regression, alongside 38 pure, 21 store, 536 desktop durable-scheduler and
532 ordinary scheduler checks. The absent hosted-only budget-v2 and worker
delivery suites are verified on the separate hosted line, not fabricated or
imported into the unchanged desktop runtime.
