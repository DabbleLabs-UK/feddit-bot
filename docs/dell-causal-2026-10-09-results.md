# DELL maintenance and frozen hosted-decision comparison, 2026-10-09

## Authority and isolation

The operator authorized exactly one Cy bootstrap restart to load the tested,
default-off maintenance gate, followed by the four-call frozen comparison.
No behavioural/model fix or desktop/public release was authorized or performed.
Experiments used separate loopback Ollama port 11436 and a private model directory.
Production Ollama PID 8312, model manifests, template and execution profile were
not replaced. No experimental decision was submitted to Feddit/Cy effects,
scheduler, considered-state, memory, social state or live Naturalness journals.

Private raw evidence remains outside Git in the DELL maintenance experiment
directory and the ignored local `dell-causal-private` directory. This document
contains metadata and classifications, not private prompts or model reasons.

## Bootstrap and maintenance implementation

- Cy ops branch: `ops/dell-safe-maintenance`,
  `f8746adee4d951fa4448e94c25d04e2c6fe2ac1c`.
- Feddit ops branch: `ops/dell-maintenance-gate`; gate `d40c71a`, verified Windows
  worker bootstrap `a4207aa`, no-retry continuation `7a34f00` / `5a355ce`.
- Gates stop new admission, drain admitted work, then expose fresh PID-bound
  held/active=0 acknowledgements. Both acknowledgements plus an empty arbiter
  were required before unloading resident models or starting isolated inference.
- Cy's supervisor/watchdog launch paths set the maintenance directory. A live
  watchdog clock race was fixed: validate against the time after process lookup,
  not an earlier timestamp that can precede a fresh status write. A negative
  control fixture reproduced the old failure.
- Cy bootstrap was explicitly guarded but was NOT a graceful drain of the old
  process. Existing v2 checkpoint/context/outboxes/control data were backed up;
  read-only server checks found no unsettled commit/delivery/inference work.
  Stop was issued at 13:25:57.864Z for PID 7328; PID 2664 started 13:26:02.541Z.
  Last committed checkpoint was 13:25:08.904Z, SHA-256
  `8de006f2c4e5d8ecdb96e446e41029b28ae7edf432e6de71629eb59440ddd2e9`.
  The checkpoint validated after startup. These observational guards are not an
  atomic crash barrier: up to about 49 seconds of uncheckpointed ordinary tick
  state at stop cannot be guaranteed preserved. No second Cy restart occurred.
- Feddit's old Windows worker was stopped through tested console CTRL_C, not WSL
  systemctl's non-delivering SIGTERM path. The disposable fixture demonstrated
  that already admitted work finishes before SIGINT shutdown. New worker PID
  17348 loaded only worker/gate changes atop its existing production payload.
  Its provider file remained SHA-256
  `d0637155ee1710ec774d0814aa9e573c6aa7bfd28e32098c98910b0832e0e598`.
- An already expired/unacknowledged hosted claim was preserved, then recovered
  and completed through ordinary queue processing after the first hold. It was
  not deleted, manually requeued or interrupted as an active generation.

## Frozen design and provenance

One existing durable case, generation 0 of
`t_2c79a50593f9302295577ec701aa7cb0`, with two action and two vote candidates.
Frozen export SHA-256:
`e495da632ebae37e6b48c120653cda717a466c95873b834ea6d3cffcd5fae69c`.
Same system/user messages, order, temperature 0.8, output budget 640, four CPU
threads, non-streaming request, no seed override, JSON mode, retry or repair.

- Ollama 0.34.1 executable SHA-256:
  `1ff56c8b2c791bff69b6457d25aa63ed11073562cd47b14f42dd16dfa4353e05`.
- Production model:
  `hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M`.
- Manifest SHA-256:
  `c6ec899cdf5f8e3f55350f7fc28735be2f77556c011f71a5bf6402556aba1cc8`.
- GGUF SHA-256:
  `7afb333a43c3cd660e0a9720828ae963336796377dbf189c6a33a403527c6785`.
- Current ChatML template SHA-256:
  `62fbfd9ed093d6e5ac83190c86eec5369317919f4b149598d2dbb38900e9faef`.
- Corrected Llama 3.1 header/eot template SHA-256:
  `349a6b7f07aeed9d860322d6c95338641b527d06fba587a56684d2138e3c0358`.

Template treatment includes its matching stop-token framing, not headers alone.
Non-generating render/tokenize/runner-context inspection measured 3,420 current
and 3,399 corrected input tokens. Both plus the 640-token output allowance fit
the verified 4,096-token full context. The 3,072-context overflow path actually
retained 1,538 tokens (keep=4); this is exact-version truncation logic, not an
inferred parallel-slot bug. Physical free RAM during isolated work was about
3.8 GiB. Same installed binary, weights and inspected production environment.

## Outcomes

| Cell | Framing / context | Duration | Strict contract |
| --- | --- | --- | --- |
| A | Current / 3072 (1538 actual input tokens) | 188.147 s | Invalid |
| B | Current / 4096 (3420 full input tokens) | 300.040 s | Timeout; censored |
| C | Corrected / 3072 (1538 actual input tokens) | 222.798 s | Invalid |
| D | Corrected / 4096 (3399 preflight input tokens) | About 1.1 s before cancellation | Safety-guard cancellation during load; censored |

A returned 59 tokens with a trailing non-JSON character and a vote candidate ID
in the primary action field. C returned 106 tokens, a valid action ID and two
vote-shaped entries, but omitted the closing JSON object brace. Both stopped
normally, not at the 640-token output limit; neither is valid abstention or a
usable considered-state result. No speculative JSON salvage was attempted.
A prompt evaluation took 161.237 s and C 180.618 s; generation took 17.354 s and
35.448 s respectively. B had no accepted response before the five-minute bound.
Timeouts must not be counted as malformed decisions or explicit abstentions.

## Operational deviations and limitations

The first controller restored normal admission after B's bounded timeout. A
tested continuation tool exclusively reserved only previously unstarted C/D in
the ORIGINAL immutable ledger. It pinned config/frozen/model/template/request
hashes and required teardown proof before replacement isolated processes. A/B
were never retried. Each inference retained the 300-second deadline.

After C, a conservative process guard stopped before invoking D during startup
GPU discovery. The transient rejected process identity was not retained, so
its exact identity is not proven. D's daemon/birth/executable and empty model
inventory were subsequently verified. The existing one-use D receipt and idle
daemon were used through a bounded finalizer, with owned-child/orphan checks.
D was reserved/submitted at 14:04:23.920Z. A further process-ownership check
failed, so the finalizer terminated the request driver; Ollama recorded client
disconnect at 14:04:25.026Z, before model loading completed. The exact rejected
child identity was again not retained. Cleanup independently confirmed all
isolated processes/listeners gone and removed the hold at 14:04:26.969Z. D has
no provider result or normal terminal response file; its original started fence
remains intact. It counts as the fourth attempted call and MUST NOT be retried
under this experiment budget. No new inference cell or retry was added. This
was experiment-controller failure, not model-invalidity evidence or a production
provider defect.

One stochastic case cannot establish population-wide causality. Separate cold
loads and process-monitoring overhead also mean timings are operational evidence,
not a controlled throughput benchmark. Censored full-context cells cannot support
a context-versus-template validity interaction estimate.

## Verification

Cy: 453/453 Node tests across 117 files; watchdog clock fixture 8/8, watchdog
logic 20/20, launcher 11/11. Feddit: 1,308 numbered mocked checks, plus voting and
shared-lease pass-only suites. These include maintenance 62, worker 22, original
causal harness 41, continuation 26, decision contract 91, turn store 18, queue 55,
durable scheduler 427, scheduler dry-run 531, decision-shape 27 and bootstrap 8.
Private controller syntax and eight mocked ownership checks also passed.

## Causal conclusion and recommendation

- Confirmed truncation: 3,420/3,399 complete input tokens become 1,538 under the
  current overflow path. Approximately 55% of the rendered input is discarded.
- Template-only observed effect at truncated context: both A and C invalid.
  The failure shape changed, but there is no demonstrated strict-validity gain.
- Context validity effect cannot be measured: B timed out and D was safety
  cancelled before load completed. Neither is an invalid model decision.
- Interaction and dominant cause remain undetermined. This is an INCONCLUSIVE
  four-attempt run, not the intended four-completed-response causal comparison.
- Do not release a template/context behavioural fix on this evidence. The
  demonstrated prompt-fit issue still warrants a token-budgeted input strategy,
  but simply increasing context has not been validated within the hosted
  five-minute budget. A future explicitly authorized comparison needs corrected
  process supervision that records rejected identities and an approved resource/
  time budget sufficient for uncensored full-context responses. Keep strict v2
  unresolved semantics; do not salvage malformed votes or mark them considered.

## Maintenance duration and restoration

All times UTC. First admission hold: 13:27:02.750Z to 13:44:54.938Z,
17m52.188s including draining/preflight. Both clients were confirmed quiescent
by 13:30:18Z. They resumed naturally between the two windows.

Second admission hold: 13:54:35.156Z to 14:04:26.969Z, 9m51.813s;
both acknowledged quiescence at 13:55:05.324Z. Combined admission hold time:
27m44.001s. Wall-clock first hold to final restoration: 37m24.219s, including
the intervening period of normal work.

At 14:07:52Z, request.json was absent; Cy PID 2664 and Feddit PID 17348 were
running with fresh heartbeats and new natural work admitted. Isolated port
11436 had no listener and final process evidence had no surviving isolated
process. The arbiter had no active/queued lease at that snapshot; its Feddit
grant/release counters had advanced after restoration. Additional durable/server
and deployed-file checks followed: Cy's server checkpoint was valid with zero
failed saves and no unsettled delivery/memory attempts at 14:11:10Z. At
14:11:39Z the same Cy/Feddit PIDs and original production Ollama PID remained,
the watchdog reported a fresh ordinary heartbeat, and no isolated listener
existed. Deployed Cy gate/launcher source matched after line-ending
normalization; the watchdog matched byte-for-byte. Feddit's retained provider
hash matched exactly, and its service was active/running with Restart=always.
Public capacity subsequently reported one online worker, zero queued jobs and
one naturally running job. No experimental publication or state application
occurred. Normal work can and did resume after each hold.
