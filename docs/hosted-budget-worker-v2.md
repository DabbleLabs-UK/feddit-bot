# Hosted construction-v2 worker compatibility overlay

This worker branch starts from the deployed maintenance-capable worker line.
Only `lib/hosted-decision-budget.js` is replaced, byte-for-byte, with the reviewed
module from runner commit `caa4c6d411a2b775921bfed8a4c598ce2186ffdb`.

The worker uses `measure` and `verifyRequest`; it does not invoke candidate
construction. Its existing action-candidate helper remains valid for module
loading. The construction exports are included unchanged to avoid a divergent
worker-only implementation of the reviewed contract.

The overlay accepts frozen v1 and v2 request metadata and independently recounts
the exact prompt, system and output reservation. The context remains 3072 tokens,
with the existing 640-token decision output reserve and 64-token safety margin.
Unknown versions, mismatched requests and impossible requests fail closed before
inference. The worker, provider, model settings, shared lease and maintenance
gate are unchanged.

Deploy this compatible worker before activating construction v2 on the runner.
Allow admitted work to finish its normal completion/failure delivery before
restarting the worker. Existing v1 jobs remain accepted after this overlay.
Do not roll the worker back to a v1-only verifier while v2 jobs may still run.

`test/hosted-budget-worker-v2.js` uses injected network and generation fakes only.
It checks exact metadata verification, unchanged worker routing and priority,
zero inference after deterministic refusal, and exactly-once delivery of an
already-admitted v1 job when new admission is stopped. Existing worker,
shared-lease, maintenance and provider compatibility fixtures remain required.
