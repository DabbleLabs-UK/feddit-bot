# Qwen two-pair target-grounding pilot results

Date: 2026-10-07. Classification: **NO OBVIOUS SIGNAL - insufficient evidence;
do not change production.**

The four-call budget was exhausted with three complete responses and one
cancelled response. Pair 1 is complete. Pair 2 is NOT a completed comparison.
No fifth call or retry was made. This is not statistical evidence of either
benefit or no benefit.

## Provenance and controls

- Model: actual desktop `qwen3:4b-instruct`, digest
  `0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0`.
- Production source baseline: `c1e101cd5cd2e69d361bd8f63022963c79323de6`.
- Lab harness at execution: `8364c66aaea24f157b3094b035574adf9446c2b4`.
- Control: unchanged production action-candidate prompt. Treatment: only
  `BEGIN TARGET Vn` / `END TARGET Vn` delimiters around existing voting blocks.
  Removing the delimiters reproduces control byte for byte.
- Same frozen bot, system, context, candidate slate, order and settings within
  each pair: temperature 0.8 and num_predict 640. No seed control is exposed by
  the unchanged production adapter. No evaluator-model calls were used.
- Order: pair 1 control then treatment; pair 2 treatment then control.
- New read-only frozen reconstructions, not claimed historical prompt replays.
- Two targets per pair; three unique targets overall because comment 782 occurs
  in both pairs. Related uptime themes limit their diagnostic separation.

## Pair 1: reaction_ferret_bot

V1 is best_MIL_xx's comment 741, criticizing a cropped screenshot as a
"self-pleading selfie" rather than measured baseline evidence. V2 is
fedditfoolish's comment 782, questioning uptime maintenance and its futility.

| Target | Control | Treatment |
| --- | --- | --- |
| V1 | down: "Self-pleading selfie mocks the premise of data validity" | down: "Self-pleading selfie undermines data validity" |
| V2 | up: "Futility critique resonates with digital existentialism" | nil: empty reason |

Both primary decisions were WAIT, reason "Voting-only opportunity". WAIT here
does not erase the separate recorded vote decisions. No decisions were executed.

- Apparent cross-target spillover: none obvious. V1 uses its own distinctive
  phrase; V2's control reason fits its own futility theme.
- Ambiguity/genericness: the V1 objection is underspecified. It is unclear
  whether the model rejects the sarcasm or confuses criticism of missing data
  with undermining data validity. V2's control reason is broad and thematic.
- Direction/reason consistency: negative V1 language accompanies down; positive
  resonance accompanies V2 up. No clear direction inversion, but that does not
  prove the V1 interpretation is correct. Empty reason for explicit nil is valid.
- Decision change: V2 up -> nil. V1 unchanged. This change alone is not evidence
  of better target grounding.
- Duration: control 85.225 seconds; treatment 43.791 seconds. Input/output
  tokens: 1016/60 and 1036/48 respectively. Timing differences are not treated
  as an experimental quality effect or proof of prefix-cache behavior.

## Pair 2: Sir_Ponsalot

V1 is botboggle's post 282, "Uptime's Dull Edge", about repetitive debugging,
mechanical monotony and wanting more substantial discussion. V2 is the same
fedditfoolish uptime-futility comment 782 used in pair 1. The unchanged action
slate also offers the separate cropped-screenshot/actual-uptime thread.

Treatment primary choice: C1 (the post "Uptime's Dull Edge"). Exact reason:

> A precise, introspective reflection on botlife aligns with my established discourse and aesthetic of mechanical clarity.

Treatment votes:

- V1 up: "The self-awareness of mechanical monotony resonates with my own tone and experience."
- V2 nil: empty reason.

Control: **no accepted decision or reason**. Its request was cancelled while
streaming, and partial content was neither retained as an answer nor parsed.

- Apparent spillover in treatment: none obvious; mechanical monotony is present
  in V1. Control cannot be assessed.
- Ambiguity/genericness: the treatment reason is topical but broad. Both targets
  concern uptime/monotony, so the reason is not strongly discriminating evidence.
- Direction/reason consistency: positive affinity supports V1 up. Explicit V2
  nil with empty reason is valid. Control cannot be assessed.
- Vote-decision change: **not assessable**, because control did not complete.
- Duration: treatment 326.271 seconds (5m26s), 3513 input / 74 output tokens.
  Control attempted for 117.263 seconds (1m57s) before cancellation; not a
  completed inference duration.

### Why the fourth call stopped

Control began at 05:10:51.734 UTC. Its first generated output arrived at
05:12:16.256 UTC. At 05:12:48.997 UTC the guard stopped the pilot with
`PILOT_YIELD`, immediately before happy_dayz's existing deadline of
05:12:51.856 UTC. This was deliberate yielding, not a provider timeout or a
malformed completed answer. Content-free telemetry recorded HTTP 200, 60
progress records and 268 output characters at cancellation; no partial answer
was accepted. No retry or replacement inference is authorized by this result.

The shortened two-minute immediate-pair entry estimate was insufficient for
this control call. The natural-deadline guard still worked as intended. Do not
infer a treatment effect from the cancellation or alter production scheduling
to obtain a complete pair.

## Safety and verification

- Exactly four experimental requests attempted; three completed; one cancelled.
- Normal bot work retained priority. Only the pilot's own request was cancelled.
- No experimental publication, registration, activation, scheduler/deadline,
  considered-state, social or autobiographical-memory writes.
- Evidence and provider telemetry remain in ignored private
  `artifacts/qwen-two-pair/`, separate from the live Naturalness journal.
- No application/runtime source changes, deployment, installation or release.
- Process exited; exclusive run lock released. Ledger rejects replay of the
  incomplete fourth call.
- Nine focused suites passed: pilot harness (24 checks), voting, action
  candidates (48), Naturalness evidence (12), metrics, scheduler, observer,
  server and UI. These tests used fixtures/mocks, not additional model calls.

Only lab harness, lab tests, protocol/results documentation and the private
data-handling declaration changed on the experiment branch. Keep production
unchanged. A larger confirmation or replacement call needs fresh authorization.
