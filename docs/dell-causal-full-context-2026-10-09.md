# Full-context hosted-decision follow-up, 2026-10-09

## Scope and provenance

This completes the missing B/D conditions from `dell-causal-2026-10-09-results.md`.
Original A/C were retained, not rerun. Original censored B/D records remain
immutable. Private raw responses, prompts and process journals are outside Git.
No experimental decision entered publication, scheduler, considered-state,
social/memory state or live Naturalness evidence.

Exact original weights, Ollama 0.34.1 binary, templates and stop framing, frozen
case, role messages, candidate order, temperature 0.8, 640 output-token budget,
four threads and non-streaming request were retained. No seed, JSON mode, repair
or salvage was added. Full context was 4096; actual runner and response evidence
confirmed 3420 input tokens for B and 3399 for D. D reused the same verified
isolated daemon/runner; only its common initial token was cached. Timings are
operational measurements, not a cold-load throughput benchmark.

## Harness diagnosis and fixes

- The previous D finalizer compared slash-normalized child paths against an
  unnormalized Windows directory prefix. Its earlier controller also relied on
  brittle direct-child executable names. These could reject legitimate probes.
- New ownership checks use PID, birth time, canonical executable and proven
  descendant ancestry, with durable content-free rejection evidence.
- A new B attempt exposed an additional real Windows PID-reuse case: exited
  Ollama probe PID 25540 was reused by unrelated WSL `msrdc.exe`, with a different
  birth, executable and parent. The guard aborted rather than claiming it.
- This interrupted B at 282.442 seconds while processing its prompt, before any
  generated response. It is censored, not a malformed decision. The model log
  reported 2560 processed tokens and no truncation when cancelled.
- Exact-identity cleanup proved the isolated processes gone and restored normal
  admission. The unrelated process was never terminated. Its failed ledger was
  pinned in the subsequent separately reserved continuation.
- The corrected helper treats demonstrably foreign reuse as a departed prior
  identity; later legitimate owned generations require current proven ancestry
  and explicit journal transitions. Root reuse, unknown model-path references
  and missing-parent ambiguity remain fail-closed. Cleanup never kills a PID
  based solely on an earlier observation.
- Native HTTP avoids an independent fetch header deadline. The experiment-only
  limit is 15 minutes per call, with an eight-minute drain and 40-minute window
  bound. Production provider and timeout code did not change.
- Response acceptance rechecks ownership/quiescence and exact full input count.
  Signal cancellation follows cleanup; diagnostic failure cannot bypass it.
  A clock captured before heartbeat reads was also corrected in experiment code.

The diagnosed harness interruption was followed by one controlled B/D execution;
there was no automatic model retry. This job attempted three requests: one
pre-generation censored B, followed by completed B and D. A/C were not repeated.

## Combined four completed conditions

| Cell | Template / input | Elapsed | Strict JSON | Accepted primary | Valid explicit votes | Complete contract |
| --- | --- | --- | --- | --- | --- | --- |
| A, retained | Current / truncated, 1538 tokens | 188.147 s | No | No | 0/2 | No |
| B, new | Current / full, 3420 tokens | 413.735 s | No | No | 0/2 | No |
| C, retained | Corrected / truncated, 1538 tokens | 222.798 s | No | No | 0/2 | No |
| D, new | Corrected / full, 3399 tokens | 402.280 s | Yes | C2 | 0/2 | No |

B stopped normally after 65 tokens, not at the output limit. It named C1 and
one V1 upvote, but omitted the outer closing brace, leaked a ChatML end marker
and omitted V2. Its malformed envelope prevents acceptance of either vote.
Prompt evaluation took 383.953 seconds; generation took 21.878 seconds.

D stopped normally after 46 tokens, also not at the output limit. It returned
valid JSON and a valid C2 primary decision. V1 was missing; V2 proposed an upvote
with an empty required reason. Thus V1 is missing and V2 invalid under contract
v2: neither is explicit abstention or eligible for considered-state. Prompt
evaluation took 385.206 seconds; generation took 15.221 seconds. No marker leak.

## Causal interpretation and recommendation

- Severe truncation is directly established: the original overflow path retains
  1538 of 3420/3399 tokens, discarding about 55 percent of the rendered input.
- Full context alone did not produce valid JSON or a complete decision (A vs B).
- Corrected framing alone did not produce valid JSON or a complete decision at
  truncated context (A vs C).
- Only the combined treatment produced valid JSON and an accepted primary
  decision (D). This is an observed interaction signal for envelope/primary
  validity, not proof of a population-wide causal effect from one stochastic case.
- Complete voting-contract validity was zero in every cell. Neither truncation,
  template nor their interaction is established as the dominant or sufficient
  cause of the whole hosted validity problem. Missing votes/reasons remain.
- Full input evaluation alone exceeded the existing five-minute hosted bound.
  Blindly increasing context without accounting for that budget is not a safe
  production remedy; this job changed no production timeout.
- Smallest justified direction: prevent silent prompt overflow with token-budget
  validation and bounded input construction that preserves contract and slate.
  Correct Llama framing plus matching stops is a candidate for further frozen
  validation alongside prompt fit, not an overall validity fix ready to deploy.
  Retain strict unresolved v2 semantics; never default malformed/missing votes
  to nil, accept empty reasons or salvage an invented decision.

No model/template/context behavioural fix or release was deployed.

## Maintenance, concurrent work and restoration

No Cy bootstrap restart was performed in this job. A separate concurrent Cy
deployment requested a restart at 16:39:02 UTC for generic-memory-tag-floor /
empty-tag-wipe-guard work (`86b61e6`). Replacement PID 16292 began at 16:39:17,
before our first hold. Its tested maintenance gate matched the prior source
after line-ending normalization. That newer Cy work was preserved.

Admission windows, UTC:

- 16:40:55.105 to 16:54:09.655: 13m14.550s, including drain and aborted B.
- 17:02:41.351 to 17:17:29.349: 14m47.998s, including drain and completed B/D.
- Total admission hold: 28m02.548s. Normal service ran between the windows.

The final run recorded 95 accepted process snapshots. Three transient incomplete
CIM rows during startup/teardown were rejected and safely resampled; they did
not authorize work or release. Two teardown proofs confirmed no owned processes
or isolated listener remained before the hold was removed.

At 17:18:40 UTC, both gates were running without a request. Cy PID 16292 had
resumed natural expressive inference; Feddit PID 17348 remained unchanged.
Production Ollama PID 8312 retained its September 24 birth time. Its production
manifest hash was unchanged. Cy's persisted checkpoint was valid with zero failed
saves and no unsettled postcard/memory delivery attempts. Feddit's service was
active, public capacity showed one online worker and zero queued/running jobs.
The retained production provider SHA-256 remained
`d0637155ee1710ec774d0814aa9e573c6aa7bfd28e32098c98910b0832e0e598`.

## Tests and commits

Experiment harness: 43 base, 26 continuation, 79 full-context and 41 coordinator
ordering checks. Ownership: 17 final mocked cases; real model-free Windows
process observation/cleanup also passed (native run before the final additional
conservative orphan check, covered separately by mocks). Worker maintenance 62,
worker 22, decision contract 91, decision-shape 27 and durable scheduler 427
checks passed; voting and shared-lease suites passed. No test used live publishing.

Harness commits on `ops/dell-maintenance-gate`: `62e60c2`, then `4fe9ed6` for the
observed PID-reuse correction. Cy ops remains `f8746ad`; no Cy source change was
made here. Only experiment tools/tests and documentation changed in this job.
