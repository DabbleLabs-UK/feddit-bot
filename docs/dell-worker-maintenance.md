# DELL worker maintenance admission

This is opt-in operational tooling. It does not alter scheduling, provider
selection, durable decisions, publication, or the shared arbiter profile.

Set `FEDDIT_MAINTENANCE_DIR` in the worker process environment to an existing
private Windows directory. The Windows Node process must receive the Windows
path, including through WSLENV where the existing service uses WSL supervision.
No environment variable means no maintenance file I/O or admission restriction.

Cy must independently support the same request directory and acknowledge its
own work boundary. Do not replace Cy's operator pause with an arbiter hold:
neither drains the old Cy implementation safely.

## Protocol

- Atomically create `request.json` with `{"version":1,"id":"unique-window-id"}`.
- The worker stops admitting new claims, including claims that would start
  provider timers. An already admitted claim, generation, lease renewal and
  complete/fail acknowledgement run normally.
- `feddit-status.json` is an atomic content-free snapshot: version, PID,
  requestId, state, active count, and timestamp. States are running, draining,
  held, and error. Only fresh held/active=0 is an acknowledgement.
- Require repeated fresh acknowledgements from BOTH actual live client PIDs,
  matching the same request, plus an empty shared arbiter and no unresolved
  running hosted job. Do not treat a slow drain or failed acknowledgement as
  permission to kill work.
- Missing/inaccessible directories, malformed requests and unwritable status
  deny new claims. An admitted job is not cancelled by a gate I/O error.
- There is no automatic expiry/resume. Remove only the exact request file to
  resume after the isolated process is stopped and resource headroom restored.
- A worker restart preserves the request. Held workers do not claim jobs or
  send a misleading availability heartbeat; the hosted capacity view may show
  the worker offline during planned maintenance.

Never reuse a request identifier to accept a stale acknowledgement. Never edit
profiles, scheduler deadlines, queue records or memory to establish maintenance.
Never leave an experimental inference running when admission is restored.

## Installation boundary

The existing Feddit worker has a graceful stop flag, but its Windows process
under WSL supervision must actually receive graceful termination, not a forced
kill. Cy currently lacks the equivalent pre-installed drain boundary. New code
on disk does not prove the existing process loaded it. Verify the running file
provenance and live acknowledgement before authorizing an experiment. If that
cannot be done without interrupting work, abort the experiment.

The private four-call experiment procedure is documented separately in
`causal-maintenance-experiment.md`. No desktop version or public release is part
of this operational patch.

## Verified maintenance bootstrap

This is a maintenance-only operation, not a hosted scheduler or model-policy
change. The old Windows Node worker has a graceful `SIGINT` handler but does not
yet read the maintenance request. Install the file gate only after a proven
natural worker exit. Do not infer idleness from an empty queue snapshot.

## Signal evidence

On 2026-10-09, a disposable WSL user unit reproduced the deployed topology:
`bash -lc` followed by `exec` of Windows Node. `systemctl stop` returned immediately
and killed the fixture without invoking its JavaScript `SIGTERM` handler. Its
eight-second work did not finish. The configured 35-minute stop timeout does not
make that path graceful.

A second disposable WSL fixture had an exclusive Windows console. After checking
that its only members were the fixture and the signal helper, Windows CTRL_C
reached JavaScript `SIGINT`. The fixture logged SIGINT at 13:07:40.534 UTC,
finished its existing work at 13:07:40.837, and exited drained at 13:07:40.838.
An independently cmd-launched fixture did not receive SIGINT despite a successful
signal API return. Do not extrapolate this procedure to Cy or other topologies.

## Prepare without stopping anything

1. Record the old worker release/symlink, unit text, existing drop-ins, MainPID,
   Windows Node PID, exact command line and process creation time. Keep secrets
   private; never print the worker environment file.
2. Stage an isolated worker release based on the actual deployed worker source,
   adding only `worker.js` admission wiring and `lib/worker-maintenance.js`.
   Preserve the deployed Ollama/provider code and its hashes. Do not replace the
   worker with an unrelated current desktop/server tree.
3. Prepare the local private maintenance directory and `request.json` with
   `{"version":1,"id":"<unique-safe-window-id>"}`. This existing request must be
   in place before the replacement worker can start. Keep its old contents if
   another operation already owns it; do not overwrite another request.
4. Create a dedicated temporary user-unit drop-in containing only:

   ```ini
   [Service]
   Restart=no
   ```

   Use a new owned filename such as `90-maintenance-bootstrap.conf`; refuse to
   overwrite an existing file. Run `systemctl --user daemon-reload`, then verify
   `systemctl --user show feddit-worker.service -p Restart -p MainPID`. Restart
   must be `no` and the old MainPID must be unchanged. Do not restart/stop the
   unit. This barrier prevents automatic re-admission after graceful exit.

## Drain the old worker

Run `tools/worker-maintenance-bootstrap.ps1` on DELL in a separate PowerShell
process. Supply the just-observed Windows PID, exact command line, and UTC
creation time. Without `-Send` it validates identity and exclusive console
ownership only. With `-Send` it repeats those checks, delivers console CTRL_C,
and waits for the original process to exit naturally. The old worker's SIGINT
handler sets its admission loop's stopped flag; already admitted claim,
generation, renewal and complete/fail delivery retain their existing path.

```powershell
powershell.exe -NoProfile -File tools/worker-maintenance-bootstrap.ps1 `
  -TargetPid <verified-pid> -ExpectedCommandLine '<exact-command-line>' `
  -ExpectedCreatedAtUtc '<verified-UTC-time>'
# Repeat with -Send only after Restart=no was read back and no competing
# supervisor/restart task can start the worker.
```

The helper must see exactly two console members: the target worker and itself.
Any extra process, identity mismatch, attachment failure, delivery error or exit
timeout aborts the operation. Never replace this failure with `systemctl stop`,
`Stop-Process`, a task kill, or an empty-queue assumption. A successful signal
API return is not completion: require the actual original PID to disappear,
the user unit to become inactive, no replacement PID, and no claimed durable
job or incomplete result acknowledgement. Inspect existing safe job/log evidence;
do not manufacture work.

## Start the gated worker once

While the old unit is inactive, point its current release at the staged minimal
worker release using the existing release/symlink procedure. Configure
`FEDDIT_MAINTENANCE_DIR` as the Windows directory path used by the worker and
append `FEDDIT_MAINTENANCE_DIR` to the existing `WSLENV` value without removing
any existing entries. Read back the resulting unit configuration without
exposing secret environment values. Run daemon-reload, then start the unit once.

Require a fresh `feddit-status.json` with the exact request ID, exact new Windows
PID, `state: "held"`, and `active: 0`. Confirm no new claim/model request occurs.
The Cy gate and shared arbiter must independently agree before any experiment.
Only then restore the prior restart policy by removing the single owned
temporary drop-in and daemon-reloading. A crash/restart still honors the persisted
maintenance request before its first claim. Keep the replacement gate configured.

## Resume or abort

After stopping/unloading the isolated experiment process, release only this
operation's matching request file. Confirm status becomes running, worker health
returns, and natural claims may resume. Do not trigger artificial publication.

If replacement startup fails, keep the request and restart-disabled barrier;
inspect safely. Do not automatically roll back to a non-gated worker while Cy or
the isolated experiment is still held/running. An explicit rollback requires the
experiment stopped and a deliberate decision to resume the old normal service.
Restore every pre-existing unit setting; never delete unrelated drop-ins. Record
the actual interruption and final worker/queue state.

The helper changes no unit, release, scheduler, profile, model, or gate state.
`-SelfTest` executes eight ownership fixtures without attaching or signalling.
