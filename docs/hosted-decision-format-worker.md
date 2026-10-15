# Native hosted response format: non-streaming worker companion

Unreleased, not deployed. Base 7a1dd06 preserves actual functional worker
67950b5, its verified Ollama 0.34.1 pin and native process supervision.

Only the independent offered-ID response descriptor, deterministic native
format schema and allowlisted finish metadata are added. Legacy requests stay
unformatted. The adapter remains non-streaming with its existing HTTP/lease/
timeout behavior. Budget construction-v2, tokenizer, model, template, context,
threads, queue transport and supervision are unchanged.

Mocked checks pass: native worker format 62, worker 20, maintenance 62 and
bounded operational logging 107. The shared format-module bytes match the
runner branch fix/hosted-structured-decision-validity exactly.

Six bounded real-model calls have now been exercised without deployment: five
responses were retained, three native-schema responses conform to the zero/two/
three-vote tuple schemas and exact frozen input budgets. One control receipt was
lost to a validation-only callback bug and was never repeated. Full semantic
validity is only 2/3 native responses; the complete paired comparison is tied at
1/2 per arm because one native non-nil reason has two words. The app correctly
keeps it unresolved. Native framing alone therefore does not yet satisfy the
requested improvement criterion. HOLD; do not deploy this candidate.

After any later bounded refinement is verified, install this compatible worker BEFORE the runner can emit
format-v1 jobs. Retain compatible binaries while any format-v1 turn is active;
never silently roll those turns back to a format-unaware worker.

Full taxonomy/design/compatibility report is on the runner branch at
docs/hosted-structured-validity-2026-10-15.md. The private validation used normal
synthetic-priority arbitration, no maintenance hold, no live-store/publication
route, no desktop update and no public release. Recovered supervision and the
actual production worker remain unchanged.

## Approved reason refinement, still held

Worker 212ceec adds response-format v2 while preserving exact v1 schema replay.
Up/down reasons formally require 15 characters and three canonical-space words;
nil can remain empty. The existing semantic validator is never weakened. Native
pattern/minLength conjunction is not assumed reliable.

One of at most two additionally authorized frozen checks ran through this exact
non-streaming worker source. It returned a valid five-word, 29-character V1
reason but omitted offered V2 despite the native tuple schema. Input was exactly
2133 tokens, output 56, finish stop, 54.445s normal synthetic-lease wait and
21.606s inference. Full validity and native-schema exactness both failed. The
check stopped immediately without a second call or retry. Missing V2 stayed
unresolved; nothing was published or written to live stores.

HOLD remains. Do not deploy this refinement. Both native-format v1 and v2 require
a compatible worker before runner admission, and compatible binaries must remain
available for replay. Production worker/supervision, Ollama 0.34.1, Cy, desktop
canary and all live state are unchanged. Mocked suites pass: format 105, worker
20, maintenance 62 and operational logging 107.
