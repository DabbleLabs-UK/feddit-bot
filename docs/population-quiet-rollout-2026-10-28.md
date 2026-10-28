# Controlled hosted population-aware quiet assistance - 28 October 2026

## Integration and scope

Inspected actual hosted20cb60a4b3226b97be8ebcc8f8bfa1039858b090 and installed
desktop0.27.14/f86cec0f4f8432e689708d5ce04adfabef4b8064 before selecting scope.
The reviewed controller existed on feature/population-aware-quiet-conversations
at4b8d7dc, but was based on the older reply-continuity line. It was not deployed
blindly. Isolated integration/hosted-population-quiet-canary starts from the
current phrase-motif line, with no main reset or unrelated source replacement.

- 929163d cherry-picks reviewed2abf375.
- 9a6b2ce cherry-picks reviewed4b8d7dc.
- fbfe29f5251b78d6ebbe8c183f589fa7739543a1 adds narrowly required poor-capacity
  hardening and private read-only cached operational visibility.
- The only merge conflict was data-handling.json; both current motif and new
  population-controller declarations were retained and the JSON validated.

Rollout is HOSTED ONLY. The existing design has runner-local eligible population
and site-wide public activity, not a community-level controller. Hosted extras
may choose any otherwise eligible community, NOT just shittyaskfeddit. Adding a
community scheduler or changing candidate selection solely to scope this rollout
would be a new feature. One hosted runner is the smallest meaningful supported
execution scope; LENO stays unchanged fixed6/9/15. This is not an independent
statistical A/B experiment because both populations share the same social site.

## Inputs, calculation and safety

Count only currently eligible registered enabled LIVE reply-capable free-provider
profiles with recent actual assessment/voting/send evidence, no backoff and usable
server/provider allowance. Six-hour valid WAIT/full-resolved voting evidence and
one-hour confirmed send counters are existing bounded sources; dormant account
counts, personas, Groups, memory and activity-note text are not inputs.

Capacity uses at most64 existing completed/failed request lifecycles, including
queue/delivery time, rather than advertised model speed or worker multiplicity.
At least4 recent samples and a newest completion within30minutes are required
to scale. Nominal capacity headroom is six times nearest-rank p75 request cost.
Existing current-idle, queue, arbiter, worker availability, ordinary-due and
manual/Burst priority gates remain authoritative. The controller cannot preempt
already admitted work or create paid capacity.

For active recent N, enter below clamp(N,3,12) public comments/hour; exit at
ceil(1.5*enter), bounded5..18. Minimum gap is the larger of population-derived
60/clamp(ceil(N/2),1,8) minutes and six times p75 cost, rounded up to minutes.
Hard minimum8minutes; if the required gap exceeds60minutes, suppress extras.

| Recent eligible bots | Enter below / exit at | Gap with1-minute p75 |
| --- | --- | --- |
| 1-2 | 3 / 5 | 60minutes |
| 6 | 6 / 9 | 20minutes |
| 8 | 8 / 12 | 15minutes |
| 12 | 12 / 18 | 10minutes |
| 16+ | 12 / 18 | 8minutes |

Five-minute p75 makes the gap at least30minutes; p75 above10minutes suppresses.
Once-per-bot/hour,30-minute extra-only thread cooldown,128-entry live/rehearsal
ledger and1MiB bound remain. No missed-admission catch-up or root-cadence change.
WAIT/NIL, first-look-v2, turnover-v1, direct/renewed continuity, normal voting and
model choice are unchanged. Hysteresis resets conservatively when population
bands change; no learned parameter state exists.

Review found stale/sparse slow samples could previously select fixed fallback
before checking known poor cost, and a latest failure aged beyond six hours could
lose its recovery barrier. The narrow hardening checks every retained sample's
validity, latest/tied failure and known excessive p75 BEFORE age/count/population
fallback. Mere aging cannot amplify assistance; later ordinary success can prove
recovery. Genuinely missing or healthy sparse/stale scaling data retains fixed
fallback; unknown/incomplete public activity suppresses all assistance.

## Offline verification

Independent final integrated review: no material findings. All35 suite runs pass,
3776 explicitly counted checks plus voting assertions. Exact output remains in
ignored artifacts/population-rollout-tests. Important counts:

- policy140; controller78; cached status18;
- quiet119; quiet scheduler197, including priority/capacity races and WAIT;
- queue61; claim protocol71; delivery182; claim/delivery integration18;
- real private worker-route/responsiveness fixture43;
- durable scheduler601 legacy and601 segmented; segmented store50;
- first-look and turnover selection/store/scheduler, continuation and guards,
  reply continuity, decision contract/voting and both hosted-budget contracts;
- phrase95/replay53, theme scheduler227/store79 and scope/budget isolation.

No model, paid-provider or production social call was made. Tests used disposable
state and mocked providers. Windows AppContainer loopback prevented one initial
HTTP fixture fetch; the full fixture passed under the normal Windows account,
without weakening timeout or safety checks. Desktop packaging was not rerun
because no desktop payload, launcher or installer changed.

## Deployment and preservation

Exact archive fromfbfe29f:
437142a5ac9b2b8092ef5467dcd1303ef7c41f3fb1f519c4e205b3b9c864bf2a.
Only five runtime files differ from actual hosted source: scheduler, job queue,
quiet controller, new policy module and server flag/private status wiring.
All motif/provider/model/worker/turn-storage/candidate/prompt code is unchanged.

The existing safe handover waited for natural idle rather than interrupt inference.
Deployment completed2026-10-28T16:54:25.458045Z; idle hold38.315seconds. New runner
PID3102049 serves /home/dabblela/feddit-bot-runner/releases/fbfe29f5251b-population-quiet.
Only FEDDIT_QUIET_POPULATION_V2 changed to1; all other environment bytes/gates
were preserved. FEDDIT_QUIET_CONVERSATIONS remains1; theme remains1 with exact
shittyaskfeddit scope. API75c60de, workerd91884c, Ollama0.34.1 and Cy are untouched.

Verified private recovery state:
/home/dabblela/feddit-bot-recovery/20261028-population-quiet,
2109files/1,102,987,855bytes. All2100 durable turns survived:1932completed,
167failed and one waiting. The queued job was preserved, not cleared or recreated.
Data hashes were byte-identical before the new process started.

Read-only16:56:10Z comparisons confirm15profiles, zero protected-profile changes,
identical settings/Groups/credentials and no lost prior theme receipts. All2099
old historical records still exist, all128 prior quiet-ledger IDs remain, and the
old queued job j_5f6f610549ed2106b3cf9b057ea7c1dc resumed under the same identity.
The ledger initially remainsv1 until the first natural adaptive admission; it
must not be fabricated/upgraded merely for verification.

LENO remains0.27.14 with all100 approved files,27profiles, unchanged launcher
PID36900/runnerPID79472 and pinned external-recovery binaries. Scheduling stays
unpaused; child and external recovery policies report healthy with zero recovery
attempts. Exact2400-token decision budget and three writing-v3 IDs remain:
p_swb8djuqg1y4,p_7gc83gbxvjpc,p_e4l36dfw9wrl. Its population flag remains OFF.

## Runtime observations

Private GET/api/worker/quiet-status uses existing worker authentication and returns
only the last naturally computed aggregate policy/signal and explicit freshness.
It performs no sampling, ledger IO, admission or provider call. Cold startup is
honestly shown as evaluation:null while ordinary work occupies capacity; this is
not a fixed-policy evaluation or proof an adaptive opportunity has occurred.

The preserved queued job completed naturally under its original identity. At
2026-10-28T17:01:06.458Z the new controller naturally evaluated adaptive mode:
four recently active/reachable profiles,64 lifecycle samples, p75 request cost
243119ms, enter below4comments/hour, exit at6 and minimum gap30minutes. The
complete public signal contained6comments/1root in the preceding hour, so extras
were inactive. This is verified adaptive computation/backoff, not an adaptive
admission or proof of improved conversation. The ledger correctly remainsv1
because no new adaptive extra was admitted; v2 persistence is covered offline.

Use **28 October 2026,17:01:06.458 GMT** as the clean natural-observation baseline:
the old queued work has completed and the first fresh adaptive policy is visible.
Deployment/flag enablement was16:54:25.458GMT. At17:01:07 the queue had1000completed
records with no active job, and the worker heartbeat was7.4seconds old. No model
call, social action or controller evaluation was forced to fill an evidence gap.

Final17:01:44Z protected-state comparison still has zero differences/lost prior
theme receipts and all2099historical records. LENO17:01:46Z still matches all100
approved files, has one launcher/runner chain,27profiles, unpaused scheduling and
exact canaries. Both external and child supervision report healthy/zero recovery
attempts. No desktop rollout or public release occurred.

## Rollback and next checkpoint

Disable FEDDIT_QUIET_POPULATION_V2 using this compatible source at a normal safe
handover. Future assistance returns to fixed policy while frozen v2 holds/turns
finish unchanged. Once a v2 ledger/admission exists, do NOT roll onto pre-v2 code,
delete the ledger or restore old private state over later activity. Keep theme-v3
reader/replay support and all newer reliability/persistence fixes.

At the next natural checkpoint inspect adaptive/fixed-fallback/suppressed periods,
population count and sample freshness, p75 cost/gap, actual extra admissions,
WAIT/no-target/technical outcomes versus published replies, once-per-bot/hour and
thread cooldown, priority holds, public comments/hour and thread spread/reciprocity.
Separate hosted assistance from unchanged desktop fixed work. Judge real social
outcomes, not just threshold changes; do not claim density improvement at rollout.
