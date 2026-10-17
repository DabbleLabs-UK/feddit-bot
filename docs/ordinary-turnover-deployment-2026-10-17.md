# Ordinary-candidate turnover deployment, 17 October 2026

## Source boundaries and order

1. Hosted runner: reviewed implementation 14e9148 and report commit
   57bf87a9b421a1e805ecb34922a4c75b618a44c4, based on the current hosted
   operational line 1e5c0f8. Immutable runtime release:
   `/home/dabblela/feddit-bot-runner/releases/57bf87a-ordinary-turnover`.
   The actual process is PID 485805, started 2026-10-17 17:52:03 UTC
   (18:52:03 Europe/London). Its cwd and DEPLOYED_COMMIT were read back.
   The hosted app-version label remains 0.27.2; source identity is the exact
   commit above, not a claim that a public desktop version was promoted.
2. Desktop: integration/desktop-turnover-canary commit
   8ce2959e97c49e6ea8ad86e48ba577e6515b8590 applies turnover to the actual
   installed writing-canary base a41b691. The four known integration overlaps
   were reconciled without changing writing-v3 selection or implementation.
   The desktop retains its existing budget-construction version; hosted-only
   reliability changes, held compaction and native schema were not imported.
3. Signed local app-only desktop 0.27.4 was delivered through the existing
   pending-version launcher workflow, not the public updater. The launcher
   accepted its existing safe-idle shutdown boundary and reported healthy
   0.27.4 at 17:54:33 UTC (18:54:33 Europe/London). Port 8770 is served by
   PID 27476 from `versions/0.27.4/app/server.js`.

Worker d91884cb46dd5cc052623223d5a3a3fba170b562 was not changed or restarted.
The existing actual Windows PID 8736, supervisor PID 584332 and process birth
time remain unchanged. Fresh authoritative supervision health is ready=true,
maintenance=running, with no blocked delivery/quarantine. The pinned actual
Ollama version remains 0.34.1. DELL Cy PID 14988 also remained unchanged.

## Handover and private recovery

The existing hosted inference completed naturally before the runner handover.
No claimed jobs, active durable turns or publication-attempting boundary was
present at the checked idle point. The established bounded freeze/recheck,
backup, stop, immutable-pointer switch and start procedure took 17.681 seconds.
All seven private JSON files were archived, member hashes verified, and source
hashes checked again immediately before startup. No queue or turn was cleared.

Private backup: `/home/dabblela/feddit-bot-recovery/20261017-ordinary-turnover`
(directory 0700, archive/config 0600). The 15 hosted profile IDs, all existing
profile state, groups, settings and protected configuration matched afterward;
secrets, owners and population were byte-identical. Scheduler deadlines,
memory/social state and discovery/considered state were not rewritten.

Protected worker, job queue, turn store, provider, tokenizer/budget,
decision/continuation modules and Caddy configuration were checked byte-identical
to the previous runner. The observed claim-response reset/HTTP 502 at 17:52:01
UTC occurred during the intentional handover. Subsequent worker polling
recovered and fresh worker/supervision health was ready; no claim was stranded
or inference duplicated. No additional proxy reset was observed by the initial
17:56:10 UTC cutoff.

Desktop recovery backup:
`%LOCALAPPDATA%/DabbleLabs/FedditBots/backups/ordinary-turnover-20261017`.
Nine private files were copied without overwriting an earlier backup and all
copy hashes matched stable originals. The installed audit verified all 27
profile IDs, protected profile configuration, all settings, groups, secrets,
population, saved importer work/cache and durable turns. There were zero
changes to schedule, activity, memory, social, voting, attention, active-thread
or reply-guard fields between backup and the immediate installed audit.

## Pause ownership and canary

Desktop was initially paused by an active separate LENO Cy comparison. Its
isolation record was ISOLATED, with live controller 28096 and watchdog 27664,
Qwen intentionally unloaded, and a bounded restoration deadline. This job did
not clear that pause, restart Cy, or stage a pending update while it owned the
machine. The owning controller restored itself at 17:52:25.977 UTC. Only after
reading RESTORED/restored=true and desktop paused=false was the pending update
staged. Existing launcher idleness checks controlled the actual node restart.

Desktop scheduling remains enabled. The exact persisted writing-canary
allowlist is unchanged:

- p_swb8djuqg1y4 (what_who_where_why)
- p_7gc83gbxvjpc (Sir_Ponsalot)
- p_e4l36dfw9wrl (porcelain_oracle_bot)

Writing v3 remains restricted to selected ordinary turns; controls, Burst and
manual previews retain released writing. No persona, provider/model, cadence,
ecology, group, community, Speed or Burst setting was changed.

## Verification

- Hosted exact source: all 100 Node suites passed, with zero timeouts or
  guarded live requests. Includes 38 pure + 21 store + 78 turnover scheduler,
  601 durable scheduler, 532 scheduler, 239 construction-v2, 32 legacy-budget,
  26 frozen-budget, 135 guard + 37 continuation, 71 claim protocol,
  18 delivery integration and 182 worker-delivery checks.
- Desktop integration: 44 applicable offline suites, 88 turnover scheduler,
  536 desktop durable scheduler, 532 scheduler, and 39 joint-canary probe
  checks passed. Independent source review found no material issue.
- Signed-build: 27 checks; local staging/preservation: 9 checks; desktop
  updater: 13 checks. Actual 0.27.4 packaged-browser verification passed
  90 existing importer/Burst/groups/forecast checks plus Naturalness checks.
  All retrieval, generation, registration and staging in these tests were
  isolated mocked fixtures, not live calls.
- Actual signed package ECDSA verified against the installed public key;
  minimum launcher 0.2.2. All 83 packaged and installed app files matched
  the exact integrated source. Local artifact SHA-256:
  `87855698d5ff68037e611dba52c9785fe590eeabad320ab8c3fccff95c81d1ad`.
- Public desktop updater remains 0.27.2 with SHA-256
  `863b165a312393820f985a270de5c2ca710258b92bfc071869d1e14864b802da`.
  No package, manifest, tag or public release was published.

Legacy durable turns lack ordinaryCandidateVersion and retain contract 0;
new reply-capable admissions freeze contract 1. Unknown versions hold safely.
Frozen receipt replay, bounded 512-key live/rehearsal state, failed-save retry,
direct/renewed routes, root/fallback mixing, repeated-target rotation and
deferred/unoffered non-consumption are covered by deterministic restart and
durable integration tests. There were no in-flight legacy turns at handover,
so live replay was not manufactured for deployment verification.

The first natural hosted turn t_78a91a4e3cd332b88c5f2714d07752f8 was admitted at
17:58:49 UTC. At the 17:59:27 UTC inspection it froze ordinaryCandidateVersion=1
and had persisted the exact ordinary presentation receipt:
`t3_473, t1_669, t3_554`. Its unchanged direct-attention route supplied four
reply_to_own_comment candidates, and the renewed route supplied three renewed
candidates. The ordinary slots C8/C9/C10 were respectively ordinary_post,
reply_to_own_post, ordinary_post: two eligible roots alongside a fallback
comment, within the existing limits. The profile's live ledger contained
exactly these three entries; rehearsal remained empty. At this early snapshot
construction was still preparing, with no inference or publication yet. No
discovery-handling checkpoint had been created merely for presentation.

This proves new admission/source mixing and disk persistence in natural traffic,
not yet repeated-turn rotation, measured reply-density improvement, or receipt
survival through a second production restart. Deterministic restart/rotation
coverage provides those safety checks without another live restart. Desktop's
next natural reply deadline was later; its empty ledger at the initial audit
was not treated as a failure or artificially populated. No opportunity was
forced. Leave normal activity running for ecological observation.

At 18:01:02 UTC the same natural turn was generating through unchanged worker
d91884c. Job j_8967955a5e46df39de2ab05619a3af3f was claimed at attempt 1 and
its fenced lease was renewing. Frozen continuationVersion remained 2. Unchanged
construction-v2 offered renewed C5 and ordinary-root C8; the other eight action
candidates and three vote candidates were deferred atomically. The verified
request contained 2,094 input tokens, a 640-token output reserve and 64-token
safety allowance, fitting the unchanged 3,072-token context. No discovery-handling
checkpoint had been created before a decision. This provides a real ordinary
root model offer alongside renewed context, with disk-persisted presentation
state and no duplicate claim. The inference was still in progress at cutoff;
its eventual validity/publication and the ecological effect remain unclaimed.

## Rollback

Old immutable releases and private backups remain available. Do not restore a
backup over later natural work. Do not roll back to code unaware of ordinary
contract 1 while such durable turns are active or bookkeeping-blocked: drain
through compatible code first and retain frozen receipts/presentation state.
Existing attempt-fenced claim/outbox protocol-v2 boundaries still apply; never
replace the worker with pre-v2 code or bypass delivery quarantine. Desktop
rollback likewise requires its normal safe idle boundary and preservation of
the exact writing-canary settings. Prefer a compatible forward correction.
