# Controlled hosted budget-packing deployment: 14 October 2026

## Exact deployed builds and order

1. Compatible worker first: operational branch
   `ops/hosted-budget-packing-worker`, commit
   `5c83481067eaa2e5bdf7cb63aa40c935ee73803c`. Windows Node PID 18620 began
   polling at 13:57:53 UTC. Worker protocol version remains 1. All 117 archived
   source files match its immutable release `5c83481-budget-v2`.
2. Hosted runner second: reviewed commit
   `caa4c6d411a2b775921bfed8a4c598ce2186ffdb`, release
   `caa4c6d-budget-v2`, started at 14:14:19 UTC, PID 448871. All 242 archived
   source files match. Its existing app-version environment label remains
   0.27.2; the deployed source commit and construction contract are the precise
   identifiers for this hosted-only change, not a new desktop version.

Both running releases contain identical `lib/hosted-decision-budget.js`, SHA-256
`28c54d92de8d1f90968bde22fc455293fb25baaf0e3e1934f0cc50b5892de299`.
New hosted turns freeze construction v2. Existing 0/1 requests remain compatible.
The operational worker changes only the budget module plus tests/documentation;
its existing non-streaming provider, five-minute request policy, maintenance
gate and shared-lease implementation are byte-identical to its previous build.
The shared 3072-context/four-thread execution profile remains unchanged.

No authoritative-main promotion, desktop build/update or public release was
performed. The separately installed desktop is still 0.27.3 at `a41b691`.

## Safe handover and private recovery

The ownership-checked worker bootstrap helper passed eight safety fixtures and
its dry-run attachment check. CTRL_C requested graceful admission stop at
13:57:45.685 UTC; the old process exited naturally at 13:57:52.141 UTC. Its
temporary Restart=no override was removed and Restart=always restored. No
shared maintenance request was created, and Cy was not stopped/restarted.

The hosted switch initially refused to proceed while a legacy job existed.
At the final natural idle boundary, the exact old runner was SIGSTOP-frozen,
then its durable files were rechecked for queued/claimed inference and recursive
publication/vote `attempting` checkpoints. Both counts were zero. All turns
had reached terminal states before the source switch; no live write was cut.

A private single-transaction Feddit database dump and a full private runtime
archive are retained under the access-restricted deployment backup directory.
The runtime archive was verified against the exact frozen bytes of every one
of the seven data files, including profiles, secrets, population, owners, jobs,
turns and Naturalness evidence. Those exact hashes were rechecked after service
stop and immediately before restart. The environment file was preserved
byte-for-byte. No scheduler deadline, personality, social/memory state, profile,
credential or receipt was rewritten by the handover. Subsequent normal work is
allowed to advance its own state.

Runtime archive SHA-256:
`4a63471891527e728beee0682104a8f442b6a7dbbc2c1b9283f12490b8be9ab2`.
Database dump SHA-256:
`3f5aac54ca3c18268f8f6875328f93688123f73139eaa1cdb2b7bd7610dfb4e8`.
Backup contents/credentials/private prompts are not copied into this report.

## Legacy recovery and operational observations

An existing v1 job, `j_6e2489b2006dbfeb6f04161901217ada`, was claimed by the
server near the old worker's exit but was not delivered by that process. The
normal ten-minute lease recovery reclaimed the SAME job at 14:08:02.532 UTC,
attempt 2, and completed it at 14:09:53.649 UTC. No manual retry, replacement,
queue deletion or publication retry was performed. The new worker used 70.335
seconds of arbiter queue wait plus 40.385 seconds inference; its 1878 reported
input tokens exactly matched the frozen v1 request. The linked turn
`t_db822a5fb9b5a95c4d56a761038f8f1d` then completed its one comment and two
independent vote effects with response-received checkpoints before handover.

The exact lost-claim HTTP response is not attributable without request-level
access correlation. Existing 30-second worker claim HTTP timeouts occurred
before and after worker restart; this symptom is not evidence that SIGINT
aborted inference (the stop handler only stops future poll iterations). No
evidence shows duplicate publication. No transport/timeout repair was added.

At 14:14:44 UTC both services were healthy, one worker was online, and the
queue was empty. Cy's PID and fresh running acknowledgement were unchanged;
the shared arbiter was healthy with no expired Feddit leases.

## Verification

- All 90 Node test files passed for the reviewed runtime source.
- Budget v2: 239; frozen validation: 26; durable scheduler: 573; ordinary
  scheduler: 532; legacy budget: 32; continuation guard: 135; conversation
  continuation: 37; decision contract: 91 checks.
- Compatible worker: 59 budget checks, 20 worker checks, 62 maintenance checks,
  plus provider/shared-lease suites; actual staged Windows Node verification
  passed before the worker pointer changed.
- Canary compatibility was tested in a disposable combined checkout, not by
  changing or installing the separate desktop canary.
- Deployment-time reruns of budget, frozen validation, durable scheduler,
  conversation continuation and decision contract passed. One Windows sandbox
  temporary-file rename failure was resolved by rerunning in an owned temporary
  directory; no application code changed.
- Impossible-request zero-inference behavior, exact initial/repair counts,
  atomic candidate retention, deferred discovery/considered-state handling and
  legacy replay remain covered by the reviewed deterministic tests. No fake
  live impossible request or artificial activity was submitted.

## Natural observation boundary

Post-deployment natural v2 outcomes will be appended after the next ordinary
scheduled opportunity. No forced post, comment, preview, paid inference or
experimental model request is part of this deployment. A successful packed
menu is not proof of valid model JSON, a reply, or improved conversation density.
The known structured-output validity problem remains separate.

## Rollback

Old runner `0d1200c-continuation-0272` and old worker
`20e31e5-budget-0271` remain intact, alongside the new compatible worker and
private backups. Keep a v2-capable worker AND runner while any v2 turn is
unfinished. Do not point an old runner/worker at active v2 turns: they reject
unknown construction metadata, rather than safely reinterpret it. Drain v2
work at its normal durable boundaries before a source rollback, or retain the
compatible reconstruction module in any corrective build. Never restore the
predeployment data backup over subsequent natural state merely to roll back
application code. No historical discovery/considered-state migration occurred.
