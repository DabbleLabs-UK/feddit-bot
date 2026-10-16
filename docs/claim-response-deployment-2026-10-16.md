# Claim/response reliability deployment, 16 October 2026

## Exact releases and order

1. Worker `d91884cb46dd5cc052623223d5a3a3fba170b562`, immutable release
   `/home/user/.local/lib/feddit-bot/releases/d91884c-claim-reliability`.
   Existing supervisor requested graceful native exit; old PID 7836 exited.
   New Windows PID 8736 started at 22:39:42.850326 UTC, supervised by WSL
   PID 584332. Actual PID/birth/path, fresh maintenance heartbeat and unchanged
   provider/model/renderer metadata passed readiness before runner deployment.
2. Runner `1c873b75470b8123e1b9a910800a5243e697a4c0`, immutable release
   `/home/dabblela/feddit-bot-runner/releases/1c873b7-claim-reliability`.
   New PID 328476 started at the safe handover, completed by 22:41:38 UTC.
3. The reviewed Caddy upstream idle keepalive was loaded as 4,000,000,000 ns.
   Active admin configuration was read back. Request/inference timeouts and
   POST retry policy were not extended. An initial environment-less adaptation
   failed without reload and restored the original file; adaptation with the
   existing service environment then passed before graceful reload. No secret
   values were printed.

The runtime app-version field remains hosted 0.27.2; this is an operational
source deployment, not a public desktop version change. Desktop remains local
0.27.3. No native-schema candidate or writing implementation was deployed.

## Safe boundary, recovery and preservation

The old worker stopped through existing identity-guarded supervision, not native
termination. No Cy or Ollama process restart, shared maintenance gate or model
call was requested for deployment. DELL Cy PID 14988 remained running.

The runner handover found zero active inference jobs and zero active durable
turns. It explicitly rejected any publication-attempting state. A bounded
16.592-second backup/handover boundary froze the old runner only after safety
checks, rechecked while frozen, and unconditionally resumed it on exit paths.
All seven private JSON files were archived, their hashes re-read and archive
members verified. Every data file was byte-identical immediately before restart.
No queue was cleared and no job/turn was recreated.

Private recovery locations:

* VPS3: `/home/dabblela/feddit-bot-recovery/20261016-claim-response` (0700).
* DELL WSL: `/home/user/.local/share/feddit-recovery/20261016-claim-response`
  (0700), retaining worker credentials/config, unit, drop-ins and prior health.
* Stable outbox: `C:/dev/feddit-worker-state`, with inheritance removed and only
  the worker account, SYSTEM and Administrators granted access. WSLENV forwards
  this path; it is outside immutable worker releases.

After restart, all 15 hosted profile IDs and protected persona, enablement,
LIVE/rehearsal, cadence, provider/model, group and community configuration matched
the backup. Scheduler deadlines and social/memory/discovery/considered state
matched before natural work resumed. Settings, secrets, population and owners
were unchanged, as were both service credential/config files. Natural work can
subsequently advance its own state.

The worker provider, hosted tokenizer/budget module, supervisor, identity probe
and Ollama unit were byte-identical to the recovered production files. Ollama
0.34.1 verification remains mandatory; construction-v2 and decision semantics
are unchanged. No public updater files or desktop packages were modified.

## Desktop pause ownership

A live LENO Cy
neutral-gate rehearsal started at 22:18 UTC. Its private isolation record says
`phase=ISOLATED`, `paused_by_isolation=true`, `restored=false`, with a bounded
deadline at 2026-10-17 01:53:31 UTC. Controller PID 21936, model-test PID 28996,
watchdog PID 32700 and sampler PID 29168 were positively alive by elevated CIM
inspection. Its existing controller/watchdog owned restoration. This was not a stale ownerless
pause, even though older completed rehearsal records show prior restoration.

Desktop settings and the exact canary IDs were read only:
`p_swb8djuqg1y4`, `p_7gc83gbxvjpc`, `p_e4l36dfw9wrl`.
No desktop setting, inference process or rehearsal evidence was changed.

The rehearsal subsequently restored its own state: `phase=RESTORED`,
`restored=true`, `restored_by=controller finally`, updated at 22:47:02.325309 UTC.
A fresh desktop API read at 22:49:36 UTC confirmed `paused=false`, version 0.27.3
and the same three IDs. This deployment performed zero desktop settings writes.

## Verification and observation limits

All 97 offline Node suites passed again on the deployed source, and 34/34
supervision tests passed. Focused fixtures include lost claim and completion
ACKs across restart with exactly one inference/claim attempt; stale attempt
fences; exact terminal redelivery; storage/auth/protocol quarantine; and no false
maintenance quiescence. These faults were NOT injected into live publication.
One first repeat of the offline sweep reused a prior mock's unacknowledged
outbox and correctly failed closed. Fresh per-suite fixture directories fixed
the ignored local test orchestrator; the budget suite and entire 97-suite sweep
then passed. Deployed application code was not changed.

One claim HTTP 502/reset occurred at 22:41:34 UTC during the planned runner
handover. It was recorded as a content-free body-phase HTTP-5xx diagnostic
(7,919 ms), not converted into failed inference. Subsequent polls reconnected.

Natural protocol-v2 job `j_c9c5d2c1e1275aad5f2a03bb9063506b` was created at
22:47:10.759 UTC and claimed at 22:47:26.918 UTC, attempt 1. Its persisted
receipt matched the attempt fence, and its lease renewed normally. No activity
was forced. It completed at 22:51:23.365 UTC, still attempt 1, with 235,976 ms
inference and zero arbiter wait. The Windows completed/ACK event was recorded at
22:51:23.509 UTC; cross-host timestamps are not a precise network latency
measurement. The persisted outbox was empty afterward, with no quarantine or
delivery retry. Durable reconciliation used one unique generation checkpoint.

The next natural phase, `scheduled-generation` job
`j_fd67ff2c35b3f933b0c33e9007329999`, was created at 22:52:33.189 UTC and claimed
at 22:52:50.759 UTC (17.570 seconds, attempt 1, lease protocol v2). It is a
different writing phase, not duplicate inference of the first decision. It was
still naturally running at the 22:53:52 UTC observation cutoff. No publication
was forced or blindly repeated. Publication uncertainty/dedupe behavior remains
unchanged and is covered by the durable suite; this window is not a proof about
all future publications.

One post-completion claim poll timed out awaiting response headers at
22:51:54.533 UTC (30,004 ms). The worker retained its durable request identity;
subsequent polling recovered, and the later generation job was claimed normally
without waiting for an expired lease. The request with no job receipt did not
start inference. The next request's private hash was observed both in the local
outbox and server receipt. Lost ACKs on a committed job and stale-fence rejection
were fault-injected only in isolated tests, not against live publication.

From runner handover through 22:53:52 UTC there were zero additional worker-route
HTTP 5xx/resets, zero expired-lease recoveries on new jobs, zero duplicate job
attempts, zero blocked deliveries and no worker/supervisor restart. The worker
remained ready, with fresh actual Windows heartbeat, and Cy remained healthy.
The first decision's valid result resumed ordinary writing; this does not claim
that overall structured-output validity has been fixed.

Residual runner reconciliation/construction latency is still visible in that
single 30-second claim timeout. The deployed repair prevents abandonment and
wrong inference retries but does not eliminate every event-loop stall. This
requires a separate bounded performance investigation, not a longer timeout or
an unreviewed behavior change in this deployment. The observation is short and
contains only two new natural jobs; it cannot establish a population-wide rate.

## Rollback boundary

The old immutable releases and verified private backups remain available. Do
not restore old data over later natural work. V2 jobs/outstanding receipts require
compatible runner and worker code: do not switch to the pre-v2 runner or old
worker while they exist. Preserve/quiesce deliveries through compatible code
before rollback, retaining publication uncertainty. Prefer a compatible forward
fix to an unsafe old-worker replacement. The pinned Ollama and identity guard
remain independent and must not be rolled back implicitly.
