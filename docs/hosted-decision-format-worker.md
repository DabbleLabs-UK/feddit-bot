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

Native schema tuple compatibility and actual full semantic validity improvement
remain unverified. Do not deploy until the bounded frozen real-model comparison
passes. Then install/verify this compatible worker BEFORE the runner can emit
format-v1 jobs. Retain compatible binaries while any format-v1 turn is active;
never silently roll those turns back to a format-unaware worker.

Full taxonomy/design/compatibility report is on the runner branch at
docs/hosted-structured-validity-2026-10-15.md. No inference, live state mutation,
maintenance hold, desktop update or public release occurred in this preparation.
