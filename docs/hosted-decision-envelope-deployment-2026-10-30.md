# Final hosted decision-envelope deployment, 30 October 2026

## Reviewed source and validation

Deployed source `b7740026f53494abaaacf19e617859ef44eac7ed` on isolated branch
`fix/hosted-decision-contract-final`, based on `bf83f00` over active source
`65006491cbc4c79e82f0a79ca3a6c20b4204c086`. Current remote and actual production
heads were inspected first; no main reset or unrelated experimental merge occurred.

Archive SHA-256:
`48a38ae4a66475a621793a5378b052c8d8530948acec2e66290d1cb30392d3d3`.
Only existing runtime file `lib/scheduler.js` changes, plus new pure
`lib/hosted-decision-envelope.js`. Provider/worker, prompts, decision validator,
packing/tokenizer, social/memory/theme, first-look, turnover, quiet controllers,
claim/outbox/fencing, duplicate guard and segmented-storage sources remain exact.
No desktop package or public release was made.

All 39 affected suite variants passed, 4,322 counted checks plus voting assertions,
with zero test failures/retries. Windows Node 22.14.0 used workspace-owned TEMP/TMP.
This includes envelope 122, scheduler/output integration 177, public boundary 98,
strict contract 91, durable scheduler 601 in each storage mode, segmented store,
budget v1/v2, voting, first-look, turnover, continuation, quiet/population, theme
scope/canary and claim/worker delivery. Source hashes stayed at the reviewed commit
through every suite. Independent source review found no outstanding material issue.

Exact frozen replay recovers all four primary failures, preserves the 11 valid
primary/vote controls and one empty-menu WAIT, and retains seven explicit original
vote decisions plus five unresolved items in the recovered cases. The normal
initial/repair path avoids one previously needed repair call; no call is added.
No real model, vote, post or comment was invoked for validation.

See [the envelope contract](hosted-decision-envelope.md) for the two uniquely
validated one-character repairs, strict exclusions and retained corpus digest.
Ambiguous bare public pipes are unchanged: their raw provider writing already
contains the character, without evidence sufficient to safely delete it as a
protocol delimiter. There is no generalized prose/code stripping or regeneration.

## Private backup and safe handover

The operator matched all base source hashes and the reviewed archive before the
safe natural-idle boundary. It rejected active claims/publication attempts, froze
only the verified idle runner, rechecked safety and read-back verified a private
2,341-file / 1,277,871,100-byte backup. All 2,332 terminal turns survived intact:
2,165 completed and 167 failed; no active turn or queued job existed at the boundary.
No queue was cleared and no job/turn was recreated.

Private recovery directory:
`/home/dabblela/feddit-bot-recovery/20261030-decision-envelope` (0700, private
0600 archive/environment/hash receipts). All runtime data and the entire
environment file were byte-identical immediately before restart. Environment,
policy flags and service configuration were not edited.

Handover completed **2026-10-30T14:25:44.981706Z**; the owned safe-idle
freeze/backup/restart lasted 46.903 seconds. PID 3522376 serves immutable release
`/home/dabblela/feddit-bot-runner/releases/b7740026f534-decision-envelope`.
No active inference, worker, Ollama or Cy process was interrupted or restarted.

## Preservation and runtime checks

At 14:26:16 protected comparison has zero profile-policy differences; all 15
hosted profiles, settings, groups, credentials, prior theme receipts and 128 quiet
ledger IDs remain. The ledger is still v2 with live/rehearsal separation. All
2,332 old historical records are present. Hosted adaptive assistance remains ON;
motif scope remains `shittyaskfeddit` only. Initial cached quiet evaluation is
honestly null/stale while new ordinary work occupies capacity, not a policy change.
The worker heartbeat is fresh and a natural queued request is present.
At 14:26:35 all 329 deployed source files match the approved archive and all
2,332 historical turn records are additionally byte-identical to the backup.
Natural ordinary turn `t_a6b8af4504425599d69b939d2cc7bf9c` freezes both existing
hostedOutputVersion 1 and new hostedDecisionEnvelopeVersion 1; its original
one-attempt request is claimed by the unchanged worker. Completion is pending.

LENO read-only verification at 14:25:24 confirms unchanged desktop 0.27.14 /
`f86cec0f4f8432e689708d5ce04adfabef4b8064`, all 100 approved app files, one launcher
and runner, port 8770, 27 profiles, unpaused scheduling, fixed assistance and the
exact 2,400-token budget. Motif scope and exact writing-v3 IDs remain unchanged;
external/child health is healthy. No LENO file, process, pause, canary or setting
was modified by this job.

Existing legacy turns retain their frozen interpretation. New compatible turns
freeze envelope v1; unsupported versions block. Offline restart tests prove raw
responses/checkpoint interpretation and publication fences remain intact, without
duplicate inference, unsafe retry or publication. Natural post-deployment results
must not be inferred from the four-case replay. Scheduling is left running without
forced activity or a new experiment/telemetry campaign.

## Rollback constraints and remaining limitation

Keep the compatible envelope-v1 reader until admitted v1 turns drain at a normal
safe boundary. Retain output-boundary v1, decision v2, construction v2, adaptive
ledger v2, motif v3 and existing claim/segmented-store readers. Never overwrite later
natural state with this backup. The baseline release is retained, but an immediate
old-binary switch onto unfinished v1 turns is not a compatible rollback.

Malformed values, missing data, nested damage, multiple punctuation errors,
ambiguous keys and exhausted/unknown output metadata remain explicit failures.
The model is not guaranteed to emit a fully valid contract. No broader model,
native-schema, parser, reliability or ecology iteration is initiated by this job.
