# Verified DELL worker supervision

This operational deployment preserves the worker's provider, model, template,
3072-token context, 640-token decision output reserve, budget construction v2,
shared arbitration and all durable-turn/publication behavior.

## Runtime pin

The desktop Ollama updater replaced the formerly verified 0.34.1 installation
with 0.40.4. The worker correctly rejected the unverified renderer. The dedicated
runtime at `C:/dev/inference-runtime/ollama-0.34.1` uses the existing verified CPU
binary (SHA-256 `1ff56c8b2c791bff69b6457d25aa63ed11073562cd47b14f42dd16dfa4353e05`)
and its matching libraries. It shares the unchanged model store and loopback
listener with Cy. The installed desktop app is not overwritten or uninstalled.
Its auto-start shortcut is preserved in the private recovery directory rather
than allowed to race the pinned service. No runtime version exemption is added.

`feddit-ollama-supervisor.sh` checks the executable hash before execution and
refuses an existing listener reporting a different version. It never kills or
replaces an unknown listener. Exit 78 requires operator attention.

## Authoritative worker readiness

The WSL service uses `Type=notify`. It becomes ready only after independently
verifying the actual Windows worker PID/birth/path, its fresh existing maintenance
heartbeat, and the exact provider/model/tokenizer/arbiter metadata. Metadata
probes perform no inference or lease acquisition.

WSL interop runs at medium integrity and cannot inspect elevated Cy/arbiter
command lines. The fixed `identity-probe.ps1`, installed as the same user's
highest-privilege interactive scheduled task, supplies a fresh read-only native
inventory. It cannot execute requested commands, start or stop processes, or
read application credentials. Unrelated Node arguments are replaced with a fixed
marker; unreadable or ambiguous worker identities remain unverified. Its private
snapshot is `C:/dev/feddit-worker-ops/identity.json`. Every inventory requires a
scan begun after the request; stale/replayed evidence fails closed.

Install the task using a fixed action pointing to the immutable release's
`deploy/dell/identity-probe.ps1`, Interactive logon, highest run level, hidden
window and restart-on-failure. Pin its SHA-256 in the fixed task action: read
the bytes once, verify them, then execute only those verified in-memory bytes.
Do not substitute an unrestricted command broker or reopen a mutable source
file for execution after verification.
The unit sets `FEDDIT_IDENTITY_SNAPSHOT` to the snapshot location.

Native absence permits only the owned WSL launch proxy to be cleaned up and the
service restarted. Uncertain ownership, unreadable identity, stale heartbeat or
unconfirmed graceful stop quarantines the service with exit 78 and prohibits
automatic replacement. Health is in `~/.local/state/feddit-worker/health.json`;
check freshness and `ready`, not just a wrapper PID or historical file.

The optional worker logger is enabled by `FEDDIT_WORKER_LOG_FILE`. It retains
only whitelisted event/reason classes, validated job IDs and timestamps in a
current and previous file, each at most 256 KiB. It never retains raw error
messages, prompts, response bodies, URLs or credentials. Ensure no old systemd
drop-in overrides the updated `WSLENV` list and silently drops this setting.

An ordinary stop or detected runtime drift uses the previously tested, hash-pinned
exclusive-console Ctrl+C helper. It stops new admission and lets the admitted job
finish its result delivery. No Windows process is force-killed by the supervisor.
The 35-minute systemd stop allowance is retained; systemd cannot escalate to
killing native work. Startup inventories and a native mutex prevent duplicates.

## Recovery and rollback

Keep the compatible construction-v2 worker and runner while v2 turns exist.
Never clear or replace durable queues, publication uncertainty checkpoints,
profiles or runtime data to recover a service. A runtime pin switch requires an
owned maintenance request, repeated fresh zero-work Cy acknowledgement, actual
live process verification and an empty shared arbiter. Never use owner pause or
process termination as a drain substitute. Remove only the matching maintenance
request after verifying the production listener, and verify Cy resumes normally.

Rollback of supervisor source requires proving the current native worker has
finished or exited. Retain the verified runtime pin and process-identity probe
unless their removal has separately been reviewed. Do not restore a data backup
over later natural work. An unverified version or ambiguous survivor is an
operational blocker, not permission to bypass the guard.
