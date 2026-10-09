# Hosted prompt-budget live validation, 2026-10-09

## Scope and execution boundary

Validated production application code from
`7c9a7768deb57b5d5ce38ee780e2a1412328a6a6` on DELL. No application/provider/
scheduler/parser code changed during validation. Commits `b1ac210` and `5d14e99`
add only an explicitly invoked validation harness, its tests, and data-handling
documentation. No deployment, desktop installation or public release occurred.

The real createQueue -> DELL provider -> worker claim/renew/complete -> Ollama
adapter path ran against a separate authenticated loopback test queue, not the
public production queue. Generation was real, not mocked. The normal shared
arbiter serialized requests at synthetic/background priority alongside natural
Cy/Feddit work. No maintenance hold, restart, isolated model daemon, template
override or model reconfiguration was used. This validates worker execution and
construction, not public-runner TLS/authorization routing.

The exact production Llama model/manifest, current ChatML template, Ollama
0.34.1, 3072-token context, four threads, 640-token output allowance and five-
minute hosted timeout were retained. The guard independently checked metadata
and the actual granted profile. Every admitted request reserves 64 safety tokens.

The initial source archive SHA-256 was
`0a8875a8a9545dce2b39d0f50a4316a2acfeac97c032af8f38f51f369fae9255`.
It contained the application from 7c9a776 plus the first validation harness.
The later continuation changed only that harness; application files stayed
identical. Private frozen data and raw results remain outside Git on DELL under
`C:/dev/inference-maintenance/budget-validation-20261009/`.
An unnecessary local raw-evidence export was blocked by safety review and was
not retried; this report retains only content-free metadata.

## Cases and actual input fit

Exactly three real model calls were made, plus one construction-only refusal.
No model call was repeated. The repair case was a planned frozen repair prompt,
not an automatic repair triggered by a preceding model result.

| Case | Original input | Sent / native input | Input + output + safety | Whole blocks deferred | Outcome |
| --- | ---: | ---: | ---: | --- | --- |
| Already fitting | 1890 | 1890 / 1890 | 2594 | None | Existing 300s timeout; partial output rejected |
| Prior causal overflow | 3420 | 2257 / 2257 | 2961 | C2 and V2 | Completed in 291.137s; invalid decision |
| Largest historical repair | 11326 | 2093 / 2093 | 2797 | C2-C8 and V2-V8 | Completed in 212.156s; valid C1 / V1 downvote |
| Minimum cannot fit | 9312 initial / 9355 repair | No inference | Minimum repair: 2382 + 640 + 64 = 3086 | Entire decision unoffered | Explicit construction failure |

The refused case's minimum initial input was 2339 tokens, but its mandatory
repair request exceeded 3072 by 14 tokens. Both must fit before admission; its
eight vote targets remained unresolved/unoffered, not considered.

The two completed native responses reported precisely the predicted input
counts, plus 53 and 62 output tokens respectively. The timed-out first case had
no final usage response, so its input was established from native runner logs:
task 2086 received exactly 1890 tokens. Tasks 2489 and 2548 received 2257 and
2093. All three native task releases reported `truncated = 0`; there was no
input-truncation warning attributable to these requests. Unrelated production
truncation warnings outside these task intervals were not treated as test data.

The already-fitting case waited about 226.5s for normal admission, then first
output arrived 205.877s after its HTTP request. It was still making progress at
the existing absolute 300s timeout: 261 output-bearing stream records / 1274
characters, not a complete accepted answer. No inferred token total is assigned
to those fragments. The request was cancelled and the lease released normally.

After inspecting that confirmed timeout and its native no-truncation evidence,
one explicit continuation ran only the two remaining cases. The harness checks
the prior terminal status, one attempt, exact timeout classification, frozen
profile label and request hash, and refuses changed/ambiguous/repeated work.
The failed first call was never retried. The causal case waited 108.597s for its
lease; the repair case had zero recorded queue wait.

## Decision semantics and limits of the result

- The causal response was non-JSON (152 characters, no ChatML marker). Contract
  v2 rejected the primary decision and kept V1 invalid/unresolved. Its isolated
  considered-state projection stayed empty; deferred V2 was absent altogether.
- The repair response had a valid C1 choice and a reason-bearing explicit V1
  downvote. Only that offered valid vote entered a disposable pure considered-
  state projection. Neither the action nor the vote was executed. V2-V8 never
  entered the parser or that projection.
- The timed-out result was not salvaged or parsed as abstention. The construction
  failure sent no queue job or inference. No live considered-state was opened.
- Mocked probes additionally verify explicit nil abstention, missing/invalid/
  conflicting votes, non-offered choices and deferred targets. Explicit valid
  nil remains eligible for considered-state; technical failures do not.

This establishes fit and safe failure/deferral in this bounded sample, not an
overall decision-validity improvement. Only one of three attempted inferences
produced a valid complete decision. The template question is unchanged. Full
prompt evaluation can also leave little time for output under the existing
five-minute limit; the near-limit 291s completion and progressing timeout must
not be hidden by the successful token-fit measurements.

## Tests and final health

Full offline Node suites passed 87/87 initially. After continuation tests were
added, the full run passed 86/87: the existing population heterogeneous-band
assertion failed once, then its unchanged suite passed all 132 checks on an
immediate isolated rerun. No population code/test was edited. Record this flake
rather than claiming every full run was green.

Focused checks passed: validation harness 26, budget 32, decision contract 91,
durable scheduler 476, worker 22, plus voting and shared-lease suites. Prior
signed/package verification applies to unchanged application files; no new
release build/signing or live registration was performed.

At 19:24:49 UTC, Cy PID 16292 and Feddit worker PID 17348 were both running with
fresh acknowledgements and no maintenance request. The worker service remained
active with original supervisor PID 1464548. The arbiter showed natural Cy
journal work and a natural synthetic job waiting, with all 1635 Feddit leases
released and zero Feddit expiries. The deployed provider hash remained
`d0637155ee1710ec774d0814aa9e573c6aa7bfd28e32098c98910b0832e0e598`.
The test processes and private HTTP queue listeners exited normally. No live
scheduler/social/memory/deadline store, publication route or bot credential was
used by the validation harness; normal service continued independently.

## Recommendation

The prompt-budget fix passes its narrow live correctness gate. Recommend it for
a controlled release as prompt-integrity and explicit-failure protection, with
the known smaller-menu trade-off and timeout/output-validity limitations stated
clearly. No production correctness fix was needed during this validation. Do
not advertise it as solving hosted structured-output validity, expand context,
change templates, or loosen timeouts on the strength of this three-call sample.
Those remain separate investigations. Deployment/release still needs explicit
authorization and safe coordination of the hosted scheduler and DELL guard.
