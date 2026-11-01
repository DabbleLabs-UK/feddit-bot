# Desktop paused model release

Desktop only; hosted/advanced placements and shared-arbiter providers do not
unload anything. This does not change inference settings, candidate selection,
the 2400-token decision budget, saved pause, cadence or bot configuration.

## Boundary

The existing saved global pause stops ordinary admission. Already admitted work
may finish its decision, writing and safe publication checkpoints. Only after
the existing scheduler/provider busy boundaries clear does the resource helper
attempt release. Cancellation's existing native-drain gate remains authoritative.
No request, process or Ollama service is killed.

Successful or attempted actual local inference may retain an exact used model
name/digest plus verified service/native PID, birth, executable and native port.
The private atomic `local-model-use.json` has at most eight such records and a
32 KiB read bound; it contains no prompts, generated text, profile IDs or secrets.
Unknown/corrupt state is preserved and disables release, not scheduling.
Restart can release a surviving matching instance while the saved pause remains
on, but never confers ownership on a replacement process or configured model
that Feddit has not actually used. Existing installations without this metadata
need a genuine inference before their model can be identified for release.

The supported LENO runtime (loopback Ollama 0.32.15) must still match the used
process identity and exact sole resident digest/name. All native slots must be
strictly idle. Established other Ollama connections, unsupported versions,
multiple/unknown runners or changed identities retain the model conservatively.
Ollama's empty-input `keep_alive=0` operation releases just that model; no other
model is addressed. Before sending unload, the same atomic file marks that exact
instance release-pending. The existing single-flight gate covers release and any
ambiguous delivery until that instance is positively gone, including on restart.
An idle inference slot alone cannot clear an unresolved unload. A crash between
the pending commit and transmission deliberately retains this conservative gate;
operator reconciliation can establish the instance's retirement, never infer it
from a timeout. Normal request failures do not change the saved pause.

A pause revision and fresh saved-pause/busy recheck fence each asynchronous
probe. Resume before sending release cancels it; resume never loads a model.
An unload already accepted by Ollama cannot be unsent; future genuine work
waits behind the existing gate and lazily reloads if necessary. Repeated pause
does not repeat release of an already retired instance. Periodic cheap checks
revisit transient sharing/errors, including after sleep/resume. The UI's existing
local-work poll displays finishing work, released model or conservative retention.

## Shared-service limitation

Ollama has no client-scoped model residency lease. We can detect current native
processing, connected clients, model/digest changes and process replacement, but
cannot prove that an idle disconnected application will not use the same model
again, or atomically exclude a new external request between observation and API
acceptance. This feature does not claim exclusive ownership or stop/reconfigure
Open WebUI. A future external request may reload the same model naturally.

## Verification

Focused mocked/fault tests cover pending work/cancellation drain, pause/resume
revision races, idempotence, single-flight, strict foreign/shared identity checks,
unknown slots, failed probes/persistence, saved ownership restart and bounded
storage. No public Feddit activity is required. Actual local validation must
retain the operator's original saved pause and desired-running intent.

Rollback leaves current data in place. Before using older code that ignores the
new operational file, prove every release-pending instance has disappeared and
its receipt has cleared. Otherwise retain a compatible release-pending reader.
Never restore old profiles, durable turns or other state over later activity.

The pinned Ollama v0.32.15 scheduler's `expireRunner` sets the residency expiry
but only enqueues actual expiration when `refCount <= 0`; the supported unload
path does not terminate an admitted active request. See the upstream pinned
[scheduler source](https://github.com/ollama/ollama/blob/v0.32.15/server/sched.go).
