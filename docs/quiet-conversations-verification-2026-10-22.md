# Quiet conversation implementation verification - 22 October 2026

## Isolated source lines

- Hosted feature: `feature/quiet-time-conversation-opportunities`, implementation
  `8841caecc958babd67dfbd622dc8809b28c733b2`, based on recovered production/evidence
  `998708e93d97829e86f738ad2fdc7842cc777ac0`.
- Desktop companion: `integration/desktop-quiet-conversations`,
  `d90a4665753142eab8e199a0b9471e65c77d6947`, based on reviewed running desktop
  `f6dafd1fbe842637bdb4a4f8302d1dd8839cdfc6`.
- Authoritative main was and remains `633e808bc94f234f3e4df25663a59c3673749584`.
  No main promotion, API/worker change, deployment, installation or release.
- Read-only preflight found hosted runtime `8fcdcdd` with the recovered segmented
  durable store, worker online and natural work in progress. Desktop remained
  local 0.27.6 with the existing three-bot writing-v3 selection. No pause,
  maintenance gate, scheduler setting or canary membership was changed.

The hosted feature contains both the deployed claim repair and segmented-store
recovery as ancestors. It does not replace either implementation. Desktop is a
scoped companion, not a wholesale merge of the divergent hosted line.

## Public signal verification

One bounded read-only call through the actual Feddit client/controller at
2026-10-22 01:37:58 UTC returned complete expected one-hour public coverage:
three newly created comments, two roots, `status=quiet`. No API mutation, model
call or scheduler admission was performed by this check. No public text or
private runtime evidence is included in this report.

The flag remains default off. This signal check is not a live behavior test or
evidence that conversation density has improved.

## Tests

All model responses, public actions and registrations in tests were fixtures.
The full-suite wrapper isolated HOME/data/TEMP and blocked external requests,
production desktop port 8770 and Ollama ports. Existing optional live scheduler
smoke was excluded; no inference experiment was run.

- Hosted full Node suites: **108/108 passed**, no timeout or blocked request.
- Desktop full Node suites: **110/110 passed**, no timeout or blocked request.
- Quiet public-signal/atomic-ledger checks: **118**, on both source lines.
- Hosted quiet scheduler checks: **138**, with both legacy and segmented stores.
- Desktop quiet scheduler checks: **170**, including selected/control writing,
  frozen restart/removal and existing Naturalness attribution.
- Explicit hosted segmented-mode rerun: **6/6 suites passed**: quiet scheduler
  (138), durable scheduler (601), first-contact scheduler (108), ordinary
  candidate scheduler (79), conversation continuation (37), and voting.
- Additional desktop focused sweep: **16/16 suites passed**, including first-look,
  writing canary, rollout API, writing integration, Burst and durable replay.
- Syntax, manifest JSON and whitespace checks passed.

Two selected-suite invocations initially named nonexistent test files; those
selectors were corrected and rerun. They were not application/test assertion
failures. Final totals above cover the actual repository suites.

Independent review caught and resolved an extra local-work/Burst admission race:
active or draining Burst now suppresses quiet assistance, and the existing
profile busy lock covers the whole local quiet operation with finally cleanup.
Final review found no blocking issue.

## Preservation and limitations

Desktop byte comparisons against f6dafd1 retain the reviewed hosted-budget v1,
legacy turn store, writing implementation/rollout, first-look, turnover,
decision-contract, Ollama provider, worker, store, Burst and Naturalness-evidence
modules unchanged. Only the new scheduler seams select the existing ordinary
writing version. Canary IDs/configuration are never edited by this feature.

WAIT, invalid decisions and successful replies preserve all normal cadence
deadlines; real send counters and backoff remain authoritative. No root-post
backpressure is added. Extra thread exclusions affect only extra opportunities,
not normal direct/renewed continuity. Deferred targets remain unresolved.

Capacity priority is non-preemptive: queued manual/user work wins before an
extra claim, but an already claimed quiet job can wait behind Cy at the existing
arbiter boundary and is not interrupted for later arrivals. Local installations
with a shared arbiter skip extras rather than infer spare capacity from their
own process alone. Busy traffic or unknown evidence may suppress every extra;
four opportunities/hour is a ceiling, not a publication or throughput promise.

Ready for a separately authorized controlled deployment, default off until
explicitly enabled with `FEDDIT_QUIET_CONVERSATIONS=1`. No API or worker rollout
is required. Backups must retain the new bounded admission ledger together with
current profiles/jobs and the complete segmented hosted turn store. Disable new
admission before rollback, then let frozen quiet turns finish on compatible
code; never reinterpret them with an older binary or restore old data over
subsequent activity. See `quiet-conversations.md` for the contract and safeguards.
