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

The first ordinary post-deployment turn was
`t_31d6d075072bda4412846dc4bf6fa12a`, fedditfoolish, admitted at 14:22:25.306 UTC
with construction v2 and unchanged continuation v2. It gathered ten primary
candidates and seven independent votes. Its full menu measured 10886 tokens.
The actual packed menu retained C1 (reply to own comment) and C5 (renewed
thread), deferring eight whole primary candidates and all seven votes. Initial
input was 2291 tokens, repair input 2334, each with the full 640 output plus 64
safety reserve inside 3072. Independent verification of the actual frozen
requests passed. The old v1 constructor would have succeeded with C1 alone
on THIS snapshot: the live example proves broader renewed-thread exposure,
not a live reproduction/recovery of the former failing C1/V1 pair.

The compatible worker completed its initial generation at 14:29:10 UTC. Ollama
reported exactly 2291 input tokens, matching the measured request; output was
37 tokens. No input truncation was observed. Its decision was malformed and
entered the existing repair path, not valid abstention. The repair's first
claim again encountered the existing lost/late claim-response pattern. Normal
lease expiry recovered the SAME job `j_9fa888021c49f761c7afc40cea4f25e7` at
14:40:11.968 UTC, attempt 2, without a manual retry. It completed at approximately
14:41:51 UTC and reported exactly 2334 input tokens, matching the frozen repair
request, with 34 output tokens. Both actual calls therefore match the exact
budget; neither silently truncated its input.

The repair was also malformed. The logical turn completed at 14:42:39.337 UTC
as a technical no-publication outcome, not genuine WAIT/abstention. No primary
publication or secondary vote-effect checkpoint exists. Its persisted discovery
receipt exactly matches independent reconstruction using only actually offered
targets and explicit valid decisions. Unexpected deferred-target receipts: 0.
The deferred votes were not offered and no vote decision/effect was created.

Observation cutoff: 14:43:31 UTC, beginning with deployment at 14:14:19 UTC.
One natural v2 opportunity constructed successfully; zero construction failures
or occurrences of the old failing-pair signature were observed. This denominator
is far too small to claim the production signature has disappeared generally.
No genuinely impossible live request occurred; fail-explicit/zero-inference
behavior is verified by deterministic tests, not by manufactured production work.

The deployed constructor was also rechecked in a separate, read-only process
against the SAME frozen overnight corpus after deployment: 49/49 legacy
reconstructions remained exact; 20 old construction failures became zero;
all 20 recovered a fitting primary; all 49 initial/repair pairs independently
verified. Max initial/repair inputs remain 2324/2367 tokens. This is a
construction counterfactual, not 49 live model calls.

Post-deployment protected-field comparison against the verified private backup
found identical profile IDs, enabled/rehearsal settings, personas, tone,
cadences, provider/model selections, community configuration, groups, global
settings and secret-store bytes. At 14:44:43 UTC the completed natural turn's
voting state remained identical to the predeployment backup: deferred votes
did not become considered. Both services were healthy, one worker was online,
the queue was empty, and Cy's original PID 25164 had a fresh running
acknowledgement. There was no shared maintenance request.

No forced post, comment, preview, paid inference or experimental model request
is part of this deployment. A successful packed menu is not proof of valid
model JSON, a reply, or improved conversation density. The known structured
output validity problem and claim HTTP delays remain separate.

## Separate desktop preservation

The local desktop remained 0.27.3 at `a41b691`; it was not rebuilt, installed,
restarted or updated. Its persisted canary IDs remain exactly
`p_swb8djuqg1y4`, `p_7gc83gbxvjpc`, `p_e4l36dfw9wrl`.
Global pause was found ON again during read-only checks. After explicit user
confirmation, only `paused:false` was PUT at 14:20:37 UTC; every other setting
and the three canary IDs were verified identical before/after. The next natural
desktop attempt reported local Ollama ECONNREFUSED; a read-only availability
check confirmed the local endpoint unavailable. No provider/model or local
Ollama process/configuration was changed to hide this separate issue.
At 14:45:24 UTC the local Ollama metadata endpoint was reachable again without
intervention by this deployment; desktop version, unpaused state and all three
canary IDs were reverified unchanged.

The public desktop manifest remains 0.27.2, minimum launcher 0.2.2, SHA-256
`863b165a312393820f985a270de5c2ca710258b92bfc071869d1e14864b802da`.
No updater/release files, tags or public artifacts were changed.

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
