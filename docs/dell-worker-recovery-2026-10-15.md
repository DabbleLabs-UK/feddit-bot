# DELL verified execution recovery, 15 October 2026

## Findings: proven versus unknown

The Ollama desktop updater ran its silent 0.40.4 installer at 07:36:49 UTC,
including forced application closing recorded in upgrade.log. The listener
reported 0.40.4 while hosted verification required 0.34.1. The renderer guard
correctly refused inference and was not bypassed.

Windows worker PID 15152 was absent while systemd still tracked its WSL interop
proxy PID 768 as active with zero restarts. Contact/heartbeat stopped around
14:49 UTC. The old unit tracked only that proxy, without independent native
liveness or readiness. The exact Windows exit cause remains unknown; bounded
available crash/resource-event queries did not establish one. Do not claim the
morning upgrade and afternoon disappearance are a proven single event.

No DELL maintenance owner or authorized version-changing job was found. The
desktop pause during the audit belonged to Cy's authorized LENO-only experiment,
which restored scheduling at 18:21 UTC. Fresh reads confirm paused=false and
unchanged three-profile canary membership. This repair wrote no desktop settings.

## Deployed runtime

- Hosted runner remains caa4c6d411a2b775921bfed8a4c598ce2186ffdb, PID 1130,
  immutable release caa4c6d-budget-v2. No runner source switch or restart.
- Worker source is 67950b5ff65e5e06b8dda629c35db865523c3937, immutable release
  67950b5-verified-worker. Windows PID 7836 began 19:41:13.883608 UTC. WSL
  supervisor PID 28346 reached Type=notify readiness at 19:41:17 UTC.
- Actual shared listener is C:/dev/inference-runtime/ollama-0.34.1/ollama.exe,
  SHA-256 1ff56c8b2c791bff69b6457d25aa63ed11073562cd47b14f42dd16dfa4353e05.
  Matching CPU libraries were copied from the already-verified local runtime.
  Models/template/configuration were not rewritten. Installed 0.40.4 remains
  intact; its startup shortcut was preserved at
  C:/dev/inference-runtime/recovery-20261015/Ollama.lnk rather than deleted.
- DabbleLabs-Feddit-Worker-Identity is a fixed read-only elevated task. Its
  action verifies source SHA-256
  1450f5d9c8d9fd4d2bb73f2a9005c492c25ab11253349bca0b60104e9208cd5f
  before executing those exact bytes. No arbitrary command interface exists.
- Private native PID/birth/path snapshots, fresh maintenance heartbeats and
  exact provider/model/arbiter verification replace wrapper-only confidence.
  Unknown ownership quarantines instead of killing or duplicating workers.
  Logs retain only bounded event/reason classes and validated job identifiers.
- New 30-worker-supervision.conf reconciles the old maintenance drop-in's
  WSLENV override. Worker environment/credential file bytes match their backup.

Provider, tokenizer assets and hosted budget module are byte-identical to the
previous compatible worker. Budget module SHA-256:
28c54d92de8d1f90968bde22fc455293fb25baaf0e3e1934f0cc50b5892de299.
Context 3072, decision output 640, safety 64, shared four-thread profile,
model/template, timeouts, construction v2 and decision contracts are unchanged.
Worker.js changes only opt-in content-free logger wiring.

## Safe coordination and preservation

Owned maintenance started 19:11:36 UTC. Cy acknowledged held/zero by 19:12:21.
Repeated fresh native-PID acknowledgement and empty-arbiter checks preceded the
listener handover. The hold was released after 616 seconds (10m16s). The same
Cy PID 14988 resumed ordinary inference/shared leases; no Cy restart or kill.

Seven hosted data files were captured consistently and privately under
/home/dabblela/feddit-bot-recovery/20261015-worker-reliability-consistent.
The exact runner was briefly SIGSTOP-frozen only after checking no in-flight
publication and two expired claims, then always SIGCONT-resumed after 11.443s.
Every captured file hash was re-read and verified. Recovery archive SHA-256:
8c4e8cb39e7c0d963b27809437c40968c89845a7afb558c9ae96fe63d7435f59.
An earlier online archive could not prove cross-file stability and is not the
verified recovery point. DELL service/configuration backups are private under
~/.local/share/feddit-recovery/20261015-supervision.

The original two turns/jobs and frozen request signatures are preserved. Normal
lease recovery advanced j_62d988e75e5af02763ca92d8bba7707c to attempt 2, completing
at 19:43:40.356 UTC with a durable Ollama result. Its 1230 actual input tokens
exactly match the frozen budget; output 32, inference 135355ms, arbiter wait 0ms.
That decision subsequently entered ordinary content generation. The other
original job remains preserved in normal recovery, not manual retry/replacement.
No artificial public activity was requested for verification.

Hosted protected configuration, groups and settings hashes match before/after;
all 14 profile IDs remain. No credential, persona, cadence, provider/model,
population/importer setting or social/memory policy was rewritten. Natural work
may advance its own state. Desktop remains local-only 0.27.3, unpaused, with
exactly p_swb8djuqg1y4, p_7gc83gbxvjpc and p_e4l36dfw9wrl. No public release.

## Verification

- All 36 applicable Node suites passed: 1327 explicitly numbered checks plus
  suites without totals, covering worker/providers/budget/shared leases and
  isolated HTTP fixtures. The bounded logger passed 107 checks.
- Final supervisor suite passed 33 tests: native absence with live wrapper,
  stale/reused identities, ambiguous ownership, duplicate prevention, runtime
  mismatch/unreachability, drain/restart safety, actual PowerShell parsing,
  C# compilation, timezone handling and repeated atomic snapshot replacement.
- A real held fixture with fake loopback URL/no credentials proved native
  launch/birth/heartbeat, zero claims, exclusive-console guarded Ctrl+C, natural
  exit and proxy cleanup. No inference or publication was admitted.
- Native testing corrected PowerShell 5 null coercion, process-local script
  policy handling and the need for explicit hidden CREATE_NEW_CONSOLE. No
  global execution policy changed. An earlier disposable held fake-endpoint
  fixture without a console was removed only after proving zero work; no
  production worker was force-stopped.
- The legacy scheduler dry-run's unconditional live smoke reported skips;
  its 475 mocked checks were rerun with only that invocation suppressed in
  memory. No source assertion was weakened. Make that old smoke opt-in before
  future automatic runs.

## Remaining issues and rollback

The verified execution chain has completed a natural inference. Pre-existing
claim HTTP abort/5xx and late-response/lease recovery delays still recur,
observed at 19:44:12 and 19:44:54. They were not hidden by changing transport
timeouts or clearing work. Structured-output validity is unchanged, not fixed.

Keep the compatible v2 worker/runner, pinned listener and recovery files. A
worker rollback first requires verified graceful native exit. Never overwrite
later natural state with an old backup. Unknown survivors or unverified runtime
remain quarantine conditions, not permission to bypass verification.
