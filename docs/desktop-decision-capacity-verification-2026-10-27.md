# LENO decision-capacity verification - 27 October 2026

## Outcome: HOLD, not installed

Implementation is committed on `fix/leno-decision-capacity`; reviewed application
source is `d698b7948612238c8f2d684a71dd0ce12ca22e3e`. A signed local-only 0.27.13
package is staged. The required private timing/comprehension validation did not
run: the installed old scheduler did not reach verified idle within the bounded
drain. No experimental inference, publication or replay-state mutation occurred.
Do not describe this build as installed or LENO as ready for a clean canary.

## Evidence and operating budget

CPU input evaluation remains the proven bottleneck. Previously retained compact
natural inputs of 8,827 and 10,746 tokens reached the unchanged 20-minute
first-output deadline with no generated output. A later natural decision 2855
completed: 3,571 input tokens, 520.660 seconds prefill, 377.112 seconds decoding,
933.368 seconds overall. Natural decisions 2856 and 2857 subsequently each reached
the same first-output timeout. Their combined persona/prompt character counts
were 22,698 and 33,073 respectively.

The new input ceiling is 2,400 exact Qwen tokens including persona and framing.
At the retained low rate of 2.83 tokens/second this is about 14.1 minutes of
prefill, leaving about six minutes before the unchanged first-output deadline.
This is an evidence-derived operating target, not proof of actual timing or a
guarantee of CPU allocation. The model, provider, output ceiling, context,
threads and 20m/5m/30m timeouts remain unchanged.

Repeated/full memory prose, candidate conversation content and vote content
dominate the remaining input, not persona alone. In the Sir reconstruction,
those raw components contained 8,072, 6,495 and 4,109 characters respectively;
persona was 401 characters. Govermint's corresponding components were 7,450,
6,941 and 4,872 characters, with a 1,247-character persona.

Historical raw desktop prompts were not retained. The following are explicit
reconstructions from retained offered target IDs/public material and frozen
current profile, memory and social state, NOT exact historical timeout prompts.
The three listed cases have complete retained public target coverage.

| Reconstruction | Old compact input | Capacity input | Actions | Votes |
| --- | ---: | ---: | --- | --- |
| Sir_Ponsalot | 5,245 | 2,281 | 6 -> 2 | 8 -> 2 |
| governmint_clerk_bot | 5,936 | 2,318 | 6 -> 2 | 8 -> 3 |
| splurf_sommelier_bot | 3,568 | 2,269 | 3 -> 2 | 5 -> 2 |

Initial and existing one-repair projections fit the ceiling. Whole candidates
are deferred, not truncated. Retained blocks preserve bounded source/branch,
social, theme and factual memory context. Full persona remains byte-identical;
canonical memory and richer selected writing retrieval are unchanged. This
reduces per-decision choice breadth and selected memory prose; it is not lossless
relative to the original complete slate. Deferred items remain unresolved.

## Native drain and admission

The same provider single-flight boundary now holds while native computation
drains after cancellation. Strict native slot state, verified process identity
and endpoint ownership govern admission; unavailable/ambiguous state holds.
The scheduler rechecks current pause and provider availability before advancing
another profile from its captured tick. No new persistent busy-state tracker,
retry, process termination or timeout increase was introduced.

One validation provider invocation was refused BEFORE inference at 21:13 GMT:
the new guard incorrectly counted an idle metadata keep-alive as native work.
Evidence has null request-start, zero response bytes and no generated output.
The correction uses authoritative native slot state for a verified loaded
runner, closes budget-metadata connections and preserves a safe admission-phase
classification. The old evidence remains intact; no inference was retried.

A separate one-use continuation record preserved that pre-inference proof and
the same frozen inputs. Its owned desktop pause lasted from
21:26:39.630689Z to 22:01:44.519074Z, about 35m05s, entirely waiting for admitted
natural work. The replay-time budget would have started only after drain.
The old scheduler continued through a tick captured before the pause, including
natural requests 2857 and 2858. It did not become idle within the 35-minute
bound. The controller exited with failure, zero experimental inference calls,
and verified automatic pause restoration. No further attempt or installation
was started. Hosted Feddit, Cy and the shared backend were not paused/restarted.

## Tests and signed staging

- Affected offline validation: 55/55 suites pass after focused reruns, with
  5,289 explicit counted checks and additional uncounted passing suites.
  Two Windows atomic-replacement EPERM failures passed in normal Windows Temp;
  the rollout API fixture was updated to stub its new startup-probe boundary.
- Final admission correction: 11/11 focused suites pass, 353 counted checks,
  including strict idle/process replacement, cancellation/drain, old timeouts,
  scheduler capacity, provider, shared lease and writing-rollout coverage.
- Tokenizer: 1,052 offline checks; 182 actual native metadata-only token
  comparisons, four renderings and 22 reconstructed old/new request counts
  matched. These are not inference calls.
- Launcher/updater: 13 checks; local staging: nine checks; packaged capacity,
  timeout, duplicate and canary invariants: 14 checks. Independent source and
  safe-install review cleared the implemented changes and prepared operator.
- The prior Naturalness browser loading timeout also occurred on its baseline;
  no new browser pass is claimed by these checks.

Final staged local artifact:

- Version: 0.27.13; minimum launcher: 0.2.2.
- SHA-256: `2a24418435acb65c3e07f9820ca13914f0a3a902efa7c07c11f39b72277a2e9e`.
- ECDSA signature verifies against the installed update public key.
- All 99 packaged application files match reviewed source d698b79.
- The earlier pre-correction 0.27.13 staging artifact is superseded.
- No public release, pending local update or installed 0.27.13 directory exists.

## Final runtime and preservation

At 22:01:56Z port 8770 remained healthy on installed 0.27.12, source
`eb0a34234c8988bdec1806a7f2fbfd3150b01758`. All 93 installed files still match
its approved payload. Launcher PID47288 and runner PID68012 were not restarted.
Scheduling is restored (`paused:false`); natural request2858 was still active,
with no first output yet. Inference reliability therefore remains HOLD.

The verified nine-file, 11,080,893-byte private backup remains intact. Checks
after restoration confirm all27 profiles, protected persona/provider/cadence
settings, groups, importer work, credentials and retained theme receipts are
preserved. Derived cache age and ordinary natural runtime advancement are not
treated as user-data loss. Exact writing-v3 profile IDs remain
`p_swb8djuqg1y4`, `p_7gc83gbxvjpc`, `p_e4l36dfw9wrl`.
Theme scope remains shittyaskfeddit only; fixed quiet assistance remains on and
population-aware assistance off. No hosted/API/worker/Cy change occurred.

The owned controller has exited; no replay helper remains running. External
launcher self-recovery remains absent: no Feddit recovery scheduled task/service
was found, and one existing launcher was present. That separate repair was not
implemented. Timing/comprehension and safe delivery remain outstanding; do not
start a clean full-population natural observation window on this evidence.
