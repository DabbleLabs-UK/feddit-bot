# Decision contract v2: unresolved votes are not abstentions

This correctness change is on feature/naturalness-whole-ecology. It is not
deployed. Naturalness 0.27.0 remains held; the earlier signed artifact has
not been rebuilt and does not yet contain this change.

## New-turn semantics

- A complete JSON object is required. The existing complete Markdown fence
  wrapper remains accepted. There is no prose-token fallback or embedded
  JSON salvage. Duplicate JSON member names make the object ambiguous.
- Explicit valid up/down decisions retain the existing reason requirements
  and server allowance checks. An explicit valid nil is real abstention.
- Missing entries, malformed fields, invalid directions/reasons, malformed
  envelopes and conflicting duplicates are unresolved technical failures.
  They have direction null, not nil. No vote is cast and no considered key
  is written for them. Unknown IDs cannot select targets outside the slate.
- Identical repeated entries deduplicate. Conflicting entries do not choose
  an arbitrary first/last direction or reason. The slate remains bounded;
  Burst's three top-level action cap and existing reason rule are unchanged.
- Valid independent vote components may execute even if siblings fail.
  Main-action success remains separately observable. Reports retain both
  visible actions and technical failures instead of turning failures into
  apparent abstention or hiding a real action.

## Repair and scheduling

The existing at-most-one primary-choice repair remains. Missing votes alone
do not trigger another model call. A repair may resolve previously invalid
components but cannot change a previously validated vote, including nil.
Original and repair checkpoints remain immutable; their merge is replayable.
If the final primary choice is unreadable it is reported as a technical
failure, not a personality WAIT. Invalid votes never fabricate a primary
action. There is no inferred vote or automatic JSON salvage.

Normal opportunity deadlines advance after a completed invalid decision,
just as after other consumed opportunities; no immediate catch-up/repair
loop is introduced. Unresolved targets remain eligible for ordinary future
discovery subject to the normal feed, allowance and scheduler conditions.
This does not guarantee they will be offered again or that the bot will vote.
Existing infrastructure/transport failure recovery and uncertain HTTP vote
attempt suppression remain separate and unchanged.

## Durable and backward compatibility

New turns freeze input.decisionContractVersion=2 at creation, including
Burst. Non-durable local/manual calls use v2. Existing turns with no version
or version 1 keep the original parsing, repair eligibility, checkpoint and
generation-ordinal semantics. Loading a turn does not upgrade it. This
bounded legacy drain can still produce old-style outcomes; changing those
mid-turn risks replay mismatch or duplicate effects.

Unsupported future versions are blocked nonterminally before effects. They
keep the profile occupied rather than being discarded in favor of a fresh
turn. A compatible runtime or explicit operator investigation is required.
The turn-store file version remains unchanged; its loader is not a semantic
migration boundary. Completed turns are not replayed or rewritten.

Historical considered ledgers retain every key. They do not have sufficient
provenance to separate genuine abstentions, votes, uncertain external writes
and parser-default nils reliably. No automatic cleanup, migration or re-vote
is attempted. Targeted historical recovery would require a separately
authorized evidence-backed procedure, especially around uncertain writes.
No user workspace or live ledger was modified during implementation.

## Naturalness and unresolved model issue

Phase 2B remains intact. New observer evidence uses the authoritative
per-vote classification, including valid components pinned across repair;
historical evidence is not reclassified. No observer output becomes a
scheduler input. The data-handling manifest documents the added bounded
contract/classification metadata.

This fix prevents false considered abstentions but does not improve model
JSON generation. Context truncation and template mismatch remain unresolved.
Strict v2 primary parsing may reduce visible activity that previously relied
on malformed prose fallback. Do not interpret the changed technical-failure
or vote counts as improved personality or causal model-validity evidence.
The controlled causal experiment was not run in this job.

## Validation

All checks are offline mocks/fixtures. Focused tests cover strict object
validation, duplicate members/IDs, valid nil, missing/invalid votes, no
salvage, retained reason alignment, partial success, bounded Burst decisions,
immutable repair checkpoints, historical v1 replay at initial/repair/content
boundaries, new-turn restart, uncertain external votes, future eligibility,
normal cadence advancement, and unsupported-version blocking. Full Node
suite results are recorded in the completion report.

The source change can accompany Naturalness 0.27.0 after review and final
package verification. It is not authorization to deploy or release, and the
held artifact must be rebuilt from the final approved combined source first.
