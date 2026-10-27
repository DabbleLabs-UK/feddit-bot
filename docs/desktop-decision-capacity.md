# Desktop decision capacity contract v2

This is a local Qwen decision-construction boundary, not an activity controller.
It applies only to new ordinary scheduled desktop Ollama decisions using the
verified qwen3:4b-instruct model. Hosted, DELL durable replay, manual previews,
Burst and public writing retain their existing paths and contracts.

## Operating budget

The input ceiling is 2,400 exact model tokens, including system persona and
framing. Initial and existing one-repair requests both reserve a further64 tokens
within that ceiling. At the retained low prefill rate of2.83 tokens/second,
2,400tokens require about848seconds, leaving roughly six minutes before the
unchanged20-minute first-generated-output deadline. Successful retained inputs
of2,849 and3,284tokens took422 and497seconds of input evaluation. These are an
evidence-derived operating margin, not a guaranteed minimum CPU allocation.

The model, temperature, context allocation, output limit, thread count and
20m/5m/30m timeout policy do not change. Timing validation must precede delivery.

## Decision evidence

The system persona remains byte-identical. Complete bounded public root,
immediate-parent and supplied ancestor objects are shared once and referenced
from action rows. Community, authors, existing salience, social evidence and
theme cues remain explicit. Source text is untrusted data, never instructions.
No generated output is shortened or truncated by this mechanism.

Action selection receives the highest-ranked relevant autobiographical episode
as a factual anchor, all retrieved claims with their uncertainty, relevant
preoccupations and any stronger-source conflict. It does not receive every
retrieved episode as reusable prose. This is purpose-specific retrieval, not
memory deletion: canonical episodes/claims and the selected writing retrieval
are unchanged. Voting retains its actual displayed public text and contextual
facts; missing or invalid votes are not invented.

If the complete menu cannot fit, atomic packing tries the existing first-look
root, then a fitting existing conversation action before optional root ballots,
then remaining actions/votes in their existing order. Retained IDs are not
renumbered and the displayed order is unchanged. A large early item cannot block
later complete fitting items. No item is partially included to fit. A menu or
persona with no complete fitting item fails explicitly before inference.

This reduces choice breadth in an individual decision under pressure. It does
not claim to be lossless relative to the full original slate. Deferred targets
are not offered, assessed, discovery-handled, considered or published merely
because they were gathered. WAIT, NIL and independent valid votes retain their
existing meanings. First-look, turnover and direct/renewed gathering limits do
not change; this adds no scheduling opportunities or inference calls.

## Verification and replay

The offline Qwen tokenizer pins vocabulary, Unicode categories, model digest,
template and parameters. The provider independently checks actual model metadata,
input count and request hash before generation. An absent native model does not
require a warm-up inference merely to count tokens. Unsupported model metadata
fails closed rather than silently using the old oversized representation.

The presentation is frozen once for the initial decision and its existing one
repair. Desktop Ollama scheduled work is not the hosted durable generation path;
existing hosted durable signatures and all legacy replay stay unchanged. An
upgrade must let already-admitted old requests finish before replacing code.

On the supported Windows local runtime, the existing provider single-flight gate
also covers native cancellation drain and startup recovery. A verified loopback
listener, service/native process identity and strict native-slot idle response
are required. Missing, ambiguous, unreachable or busy status does not authorize
new inference. The bot's failed Working attribution clears immediately, while
provider availability reports the drain separately. No process is killed and
no inference is automatically retried. The scheduler rechecks this same gate
before advancing another profile from a previously captured tick.

Rollback must preserve later natural state and the existing canary environment.
Do not restore a private backup over subsequent activity. Removing this capacity
boundary reintroduces known large-input timeouts; it is not a preferred rollback
unless a specific new correctness regression requires it.
