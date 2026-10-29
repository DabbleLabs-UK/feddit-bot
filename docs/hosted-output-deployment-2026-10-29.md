# Hosted reply/output repair deployment, 29 October 2026

## Source and scope

Deployed source: `65006491cbc4c79e82f0a79ca3a6c20b4204c086`, branch
`fix/hosted-reply-output-correctness`, based on current production documentation
HEAD `691c8b8` over running application `fbfe29f5251b78d6ebbe8c183f589fa7739543a1`.
No reset, unrelated feature merge, worker update, desktop package or public release.

The only changed existing runtime file is `lib/scheduler.js`; the new pure module
is `lib/hosted-output-boundary.js`. Protected provider, decision validator, token
budget, voting, first-look, turnover, continuation, quiet controller, theme,
claim/outbox and segmented storage sources match the prior release exactly.
The 325 archived source files match deployed bytes. Archive SHA-256:
`9981c53490fd616e60729bfefa8eaab8c63f81dd4c8907e4b5c92a8f0e15a3be`.

See [the repair design](hosted-reply-output-correctness.md) for the 77-case
failure taxonomy, strict framing boundary and explicit remaining limitations.

## Tests and replay

All 38 affected suite variants passed, totaling 4,122 counted checks plus voting
assertions. This includes boundary 98, new scheduler integration 99, strict
decision contracts 91, durable scheduler 601 in each legacy/segmented mode,
segmented store 50, budgeting v1/v2, first-look, turnover, continuation, reply
continuity, quiet/population controllers, theme canary and claim/outbox delivery.

Initial sandbox AC/Temp fixtures hit Windows atomic-rename EPERM and downstream
persistence failures. Unchanged suites passed with workspace-owned TEMP/TMP. One
quiet-conversations bounded-ledger run then failed with bookkeeping pending;
an immediate unchanged isolated run passed 119 checks. The underlying I/O cause
of that intermittent failure is not established. Original failures and reruns
remain in ignored private logs. Independent read-only review cleared quotation,
code-span, tag/EOS ordering and durable/publication boundary fixes.

The owner-approved credential-excluded private 77-case replay made zero model or
publication calls. Thirteen of 33 failed primary decisions recover, twenty remain
explicitly invalid; existing 39 valid replies and five empty-menu WAITs are
preserved. Writing replay cleans 15 exact suffixes, rejects four identified
scaffolding bodies and leaves twenty unchanged. This is counterfactual parsing,
not a measured production improvement rate or invented replacement writing.

## Safe handover and preservation

Prior source and complete base hashes were verified before mutation. The existing
safe-idle operator checked no claimed inference, publication attempt or active
durable turn, then positively froze the owned runner and rechecked safety.
It backed up and read-back verified 2,206 files / 1,175,168,062 bytes, including all
2,197 durable terminal turns (2,030 completed, 167 failed). No queue was cleared,
job recreated or old data restored.

Private backup: `/home/dabblela/feddit-bot-recovery/20261029-output-correctness`,
0700 directory with 0600 archive/environment/hash receipts. The original data and
environment were byte-identical immediately before restart. All 2,197 historical
turn files were additionally verified byte-identical after startup.

Handover completed at **2026-10-29T11:02:55.353471Z**, in 40.926 seconds of owned
safe-idle freeze/backup/restart. Hosted PID 3270071 runs immutable release
`/home/dabblela/feddit-bot-runner/releases/65006491cbc4-output-correctness`.
No active inference was interrupted. Configuration was not edited.

Post-start comparison: 15 hosted profiles, protected persona/provider/cadence/LIVE
settings, groups, credentials, old theme receipts and all 128 quiet-ledger IDs
preserved. Quiet ledger remains v2. Hosted adaptive assistance remains ON with
unchanged policy; motif scope remains only `shittyaskfeddit`. Fresh cached policy
at 11:03:35 used three active profiles, 61 samples, p75 268178ms, 3/5 hysteresis
and 30-minute gap; no tuning occurred.

LENO read-only verification at 11:05:53: desktop 0.27.14 / `f86cec0`, all 100
approved app files exact, one unchanged launcher/runner chain, 27 profiles,
scheduling unpaused, fixed quiet assistance, theme canary scope and exact writing-v3
IDs retained. External and child supervision are healthy with zero recoveries.
No LENO file, pause, model, budget, canary or controller setting was changed.

## Natural/runtime evidence and limits

At 11:08:55 the runner is healthy, and one naturally admitted reply turn
`t_38505bbcead402c425f8ada8b6148ca0` freezes hostedOutputVersion 1. Its first
decision is still in progress, so no outcome or post-repair failure rate is
claimed. No work was forced to obtain this record.

At 11:12:29 the same natural turn has completed a valid initial primary decision
without provider error or repair inference. Its one-attempt writing job is now
claimed normally; final publication/output-boundary outcome is pending. The
runner remains active with zero restarts. A separate cheap native metadata GET
confirms Ollama 0.34.1. This is evidence of normal execution, not a measured
population-wide validity improvement or proof this individual decision needed
terminal-marker decoding.

Worker deployment remains `d91884cb46dd5cc052623223d5a3a3fba170b562`; actual Windows
worker PID 14512 remains alive and handles claims. The WSL health receipt inspected
under `/home/user/.local/state/feddit-worker/health.json` is stale since 24 October
and says quarantined / PROCESS_IDENTITY_UNREADABLE despite the native worker and
hosted heartbeat. That is not proof of current supervised readiness. No worker,
supervisor, Ollama or Cy operation was attempted; this discrepancy is separate
from the 33 model-output failures and should not be silently called healthy.

Existing publication-uncertainty, claim fencing and duplicate safeguards are
unchanged; offline restart tests prove no duplicate HTTP or inference from these
new checkpoints. There were no in-flight turns/publication uncertainties at the
handover and no forced publication or synthetic activity. Natural scheduling is
running for follow-up. Twenty frozen primary failures and novel semantic/prose
leakage formats remain limitations, not fabricated abstentions or repaired votes.

## Rollback

Keep v1 boundary readers until all admitted v1 turns finish. Do not switch an old
binary onto unfinished v1 turns: it predates this field. At a safe handover use
compatible code to stop new admissions and drain first. Keep adaptive quiet v2,
first-look v2, motif v3, segmented storage and all claim/outbox readers. Never
restore this private backup over later natural work.
