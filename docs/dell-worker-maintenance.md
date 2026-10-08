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
