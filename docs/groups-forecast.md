# Groups and activity forecast

Groups are organizational only. Schema 26 stores owner-scoped `groups` and one
`groupId` per profile. Deleting a group only detaches its bots. Browser-local
disclosure state does not affect the backend. Hosted administrators may manage
unowned population groups, but ordinary owners cannot see them or each other's
groups. Group moves have a dedicated endpoint so saving a stale editor cannot
undo membership.

`GET /api/activity-forecast` reads authorized profiles without changing timers.
LIVE is the default; filters cover mode, group, type and no-cadence. Upcoming
entries are persisted deadlines. Horizons and charts are steady-state expected
opportunities, not a deterministic simulation or promised publication. They use
shared scheduler rate helpers, current population ecology, bounded exponential
spacing, probation ceilings, Speed expiry and hosted boost expiry. Future ecology
drift, new conversations, queue pressure, WAIT, manual work and Burst cannot be
predicted. Paused work is labelled as potential after resuming.

## Imported zero-rate diagnosis

Desktop staging supplied population ecology but omitted text/article/reply
fields. The scheduler already used ecology, while `nextAction` checked only the
stored fields and could say Idle incorrectly. New importer staging now mirrors
the existing ecology allocation into all four rate fields. Generic external
seeds are unchanged. `nextAction` now uses the same rate helper as the scheduler.
An actual operator rate change on a desktop population bot selects its existing
custom-cadence mode, just as hosted edits do; ordinary saves do not change mode.

Existing profiles are NOT cadence-migrated merely by loading schema 26. The
explicit desktop-only `POST /api/importer-profile-repair` accepts `sessionId` and
returns a preview; `apply: true` backs up private state before applying it. The
plan requires confirmed STAGED profile IDs, matching usernames and matching
compact importer source/reference from the saved workspace. It never registers,
retries, starts or publishes. Only the demonstrated zero text/article/reply
default shape is repaired; custom mode or nonzero text/article/reply settings
are excluded. Nonzero votes and all timers/continuity remain intact. Groups use
a stable owner/source/reference hash and retain operator renames and moves.

The recovery branch `55748fa` is included unchanged on this isolated feature
branch. No importer recovery/UI files were rewritten. The narrow integration is
the population profile patch, group naming callback, and read-only workspace
evidence used by the explicit repair.

## Verification and delivery

Tests are fixture-only; the scheduler harness's historical live smoke now needs
explicit `FEDDIT_TEST_LIVE_SMOKE=1`. The packaged browser test checks the actual
extracted group sidebar and forecast as well as the importer and Burst. Local
desktop 0.25.0 is the intended feature build; public promotion is separate and
not authorized by this job.
