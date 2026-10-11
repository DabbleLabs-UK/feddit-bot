# Hosted budget worker compatibility release

The deployed worker is an operational variant: b7ac516 libraries and the tested
a4207aa maintenance worker/gate. It retains a non-streaming Ollama transport.
It is not the current desktop provider binary. Preserve that existing transport,
five-minute worker request deadline, model, context, threads and maintenance gate.

This release adds only the guard and pinned tokenizer from authoritative
7e7f51267b09296cef2886495a315af4ddba48f8. Both the metadata verification and
independent request-budget check are the validated implementation. No newer
desktop streaming/progress-timeout machinery is substituted into this worker.
The shared main release remains 0.27.1 at that authoritative commit.

The legacy action-candidate helper in this operational tree is not used to
construct production prompts. The hosted runner constructs and freezes them;
the worker uses only measure/verifyRequest and the exact tokenizer. Oversized
legacy queued decisions fail explicitly and non-retryably rather than truncating.

Run test/hosted-budget-compat.js, test/worker.js, and test/worker-maintenance.js
with mocks before deployment. Never introduce live inference merely for tests.
