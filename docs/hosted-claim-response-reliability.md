# Hosted claim and response reliability (not deployed)

## Evidence and limits

Read-only inspection on 2026-10-16 found the production runner at
`caa4c6d411a2b775921bfed8a4c598ce2186ffdb`, the functional Windows worker at
`67950b5ff65e5e06b8dda629c35db865523c3937`, and verified Ollama 0.34.1.
The worker repair is based on recovery branch `7a1dd06`, not the held native-schema
experiment. No inference, queue mutation, maintenance hold or deployment was used
for this investigation.

The original 38 completed lease-recovered jobs had 6h30m18.447s of overlapping
first-to-final-claim intervals. Their successful inference took 3250.556s and
shared-arbiter wait took 557.737s. The median claim gap was 608.578s, close to the
ten-minute lease. All 38 first claims followed an aborted worker poll (0.304 to
33.884s earlier). These intervals measure blocked jobs/profiles, NOT exclusive
machine capacity lost: other jobs and Cy could still run.

At 22:15:27 UTC on 16 October, the retained post-worker-repair cohort contained
152 completed jobs, 59 with an expired-lease last error and multiple claims.
Their overlapping claim gaps covered 10h9m37.504s (median 607.935s), versus
5434.797s inference and 766.526s arbiter wait. This bounded terminal history is
not a complete event ledger and cannot establish every intermediate cause.

Caddy's filtered production worker-route error records since the 14 October
deployment contained 316 claim resets, one refused claim connection and one
renewal reset, all HTTP 502. Since the worker repair there were 119 claim resets
and one renewal reset. These 5xx originate in proxy-to-Node transport, not a
model or JSON-validation rejection. The worker journal retained 204 aborted
polls, 118 HTTP-5xx polls and three inference timeouts. It recorded one process
start and no completion-delivery failures in that window. Thus process death
and discarded completion uploads do not explain the observed claim cohort.

Proven code paths compound the problem:

* Worker requests abort after 30 seconds, including response-body consumption.
  A claim is persisted before the response. Previously a lost response could
  strand the claim until lease expiry, with no inference or lease renewal.
* Completion/failure routes synchronously reconciled durable turns before ACK.
  Reconciliation repeatedly replayed unchanged waiting generations and saved
  their unchanged status through the entire synchronous turn-store writer.
  The live turn file was 406,539,674 bytes. The runner's cumulative process I/O
  reported about 4.68 TB written in about 39 hours. The exact fraction due to
  no-op rewrites was not measured; this is not a per-request causal trace.
* Caddy's default upstream idle keepalive exceeds Node's actual five-second
  keepalive timeout. Caddy documents reset/502 risk for non-idempotent requests
  under this mismatch. The mismatch and reset signature are established; the
  proportion caused by idle reuse versus runner stalls is not attributable
  from existing logs alone.
* A separate code hazard treated a failed completion upload as failed inference.
  No such upload incident was present in the retained worker journal. The
  repair covers it deterministically rather than claiming it caused the 38.

## Repair

The worker retains an opaque claim request ID until a valid response arrives.
The queue durably remembers its latest receipt per worker. Repeating that ID
returns the same live claim without another attempt or allocation charge.
Terminal/expired receipts do not allocate replacement work. A new request cannot
claim over the same worker's held job. This closes the abandoned-response gap
without retrying inference or increasing timeout/priority.

New protocol-v2 leases carry a random attempt fence. Renewal and result delivery
must match the live worker, fence and lease. Repeated identical terminal
delivery is acknowledged; conflicting or stale delivery fails closed. Existing
legacy claims retain their prior contract. V2 queued jobs are not offered to
legacy workers, which cannot acknowledge their fence correctly.

Worker completion/failure delivery is separate from inference. Before upload,
an atomic, flushed, bounded private outbox retains the result or safe failure
receipt. Transport failures retry delivery only; they do not generate again,
report successful inference as failed, or claim more work. Auth, protocol and
ownership conflicts quarantine the receipt for operator reconciliation. Corrupt
or unwritable delivery state blocks new claims. Result content is private and
must never be printed in operational logs.

Blocked delivery and persistence failure publish a fixed delivery-blocked error
through the existing maintenance heartbeat, without claiming quiescence. The
recovered worker supervisor rejects that heartbeat and reports quarantine, not
execution-ready. Renewal stops while the blocked receipt remains preserved.
Startup recovery records an outstanding delivery before its first heartbeat,
so a maintenance hold cannot observe a false idle/held transition.

Runner ACKs follow durable queue transitions but precede coalesced asynchronous
reconciliation. Periodic/restart reconciliation remains authoritative if the
process exits between ACK and replay. Unchanged queued/claimed generations no
longer trigger replay/writes; changed, missing, terminal and blocked states do.
Worker ACKs omit payloads and expensive fairness/queue-position simulation.
Caddy upstream idle pooling is reduced to four seconds; this is not a request
timeout increase and enables no automatic POST retry.

Diagnostics retain only operation, headers/body phase, elapsed time, HTTP status
and fixed transport classification. They exclude prompts, responses, headers,
URLs and credentials. Existing publication attempting/uncertain checkpoints,
job dedupe, admission priorities, model verification, prompt construction-v2,
decision contracts and desktop canary behavior are unchanged.

## Later controlled deployment and rollback

This job prepares code only. Before a later authorized deployment, take private
backups and use the existing safe drain/handover. Deploy the compatible worker
first, retaining the verified provider and supervision. Configure
`FEDDIT_WORKER_STATE_DIR` to a stable owner-protected Windows data directory
OUTSIDE immutable release directories, and preserve it across updates/restarts.
Restrict its ACL to the worker account and administrators; it can contain private
model output. Never delete/quarantine-clear it merely to resume claims.

Then deploy the compatible runner and validated Caddy configuration. Existing
legacy claims can finish normally; new claims use v2. Observe natural work and
the new content-free request classifications. Do not force publication.

The runner branch carries the common worker modules and tests for source
consistency. The companion worker branch is the deployable worker artifact:
it retains the already-recovered Type=notify supervision, pinned provider and
non-streaming transport. Do not install the runner branch's older worker service
in place of that recovered companion service.

Do not roll a runner back to pre-v2 while fenced jobs or delivery receipts are
outstanding. Do not replace the worker with an old worker while it has pending
delivery. Resolve/quiesce those records through compatible code first, preserving
publication uncertainty. No historical turns or queue records are rewritten by
a migration and no desktop release is required.

Still separate: model inference timeouts, overall structured-output validity,
and any residual proxy/process pressure after this repair. No model/template,
context, inference-timeout, persona, cadence or canary changes are included.
## Verification for the prepared repair

The runner repair passed all 96 suites in the initial offline Node sweep plus
18 end-to-end queue/worker checks (97 test files total). The sweep disabled only
scheduler-dryrun's explicitly live smoke invocation in memory; its 532 fixture
checks still ran. A network guard blocked all non-loopback destinations and live
desktop/Ollama/arbiter ports. Loopback fixture tests required narrow Windows
sandbox escalation; the same ChatGPT-plan fixture then passed in 4.846s.

Focused results: queue protocol 71, legacy queue 55, durable scheduler 601,
HTTP ACK/responsiveness 38, proxy lifecycle 6, worker delivery 182, worker 20,
maintenance 62 and operational diagnostics 119. The companion worker additionally
passed hosted-budget-worker 59, real-provider mocked HTTP compatibility 21 and
supervision 34/34. Tests cover response loss before/after durable commit,
restart, stale fences, exact terminal redelivery, no duplicate inference,
quarantine/storage faults, no false maintenance quiescence, and safe legacy
contracts. No live inference or publication was performed.

