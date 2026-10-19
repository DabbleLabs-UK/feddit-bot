# Controlled local desktop first-contact delivery

Reviewed desktop implementation: 8e5f23c, integration/desktop-first-contact-canary.
This isolated operations branch retains that app payload without redesign.
Local app-update version: 0.27.5. The version is supplied by the existing signed
manifest and launcher pointer; there is no independent source version constant.

Prerequisites and order:

1. Deploy and verify additive Feddit API 75c60de before staging any pending update.
2. Verify signatures and package contents; back up private desktop data and verify
   copy hashes without printing private content.
3. Stage 0.27.5 with the existing stage-local-update script. The installed launcher
   waits for its authoritative safe-idle endpoint; active inference is not stopped.
4. Read actual runtime version, source hashes, preserved configuration and exact
   writing-canary membership after handover. Leave natural scheduling running.

The observed starting runtime is desktop 0.27.4, source 8ce2959, node PID 27476.
It is unpaused and naturally processing a scheduled best_MIL_xx decision. The
writing-canary IDs are p_swb8djuqg1y4, p_7gc83gbxvjpc and p_e4l36dfw9wrl.
The initial delivery waited hands-off for a natural idle point. Forced inference,
public release, model or runtime changes are not authorized. After the pending
update remained blocked by captured scheduler work, a conventional temporary
update-owned use of the existing Pause control was authorized for safe drain,
with original false state recorded and mandatory restoration. No new admission
gate or experiment mechanism was introduced. Public desktop remains 0.27.2.

Rollback must use first-contact-compatible code while v1 turns or assessment
receipts exist. Drain at the established durable boundary before an incompatible
rollback; do not clear turns, queues, profiles or first-contact state.

## Verified package and staged handover

The signed app-only package was built from operations source 89a0bab, whose
server.js/lib/public payload is byte-identical to reviewed 8e5f23c. Package
SHA-256: 6d9f7967667a97c5b10e589b2f344af85f737930c20d39ee685d55e2c776d7b7.
ECDSA verifies against the installed launcher public key; minimum launcher is
0.2.2. All 84 archive app files match exact source hashes.

Offline verification passed 21 desktop suites, including 150 first-contact,
88 ordinary-turnover scheduler, 536 durable-scheduler and 39 writing-canary
checks. Signed-build 27, local staging/preservation 9, updater 13, and actual
0.27.5 packaged-browser 90 existing checks plus Naturalness checks passed.
All model, retrieval, registration and publication operations in those tests
were isolated mocks. Windows sandbox atomic-rename restrictions caused initial
EPERM failures; unchanged suites passed under narrow normal-process execution.

Before staging, nine private data/cache files were copied to the existing
desktop backup area at backups/first-contact-20261019. Each copy hash matched
the source both before and after copying. Profiles, secrets, importer saved
work/cache, population, Naturalness evidence and durable turns are preserved.
The snapshot contains 27 profiles and one organizational group.

After API compatibility was confirmed, a read-only request through the exact
desktop API client received 100 feed roots, all with boolean assessment metadata
(89 unassessed). The normal pending-version workflow staged 0.27.5 at
2026-10-19 20:46:08 UTC. The existing launcher initially waited hands-off while
naturally admitted Sir_Ponsalot work finished, without inference cancellation.
At the initial preservation check all protected configuration, settings,
groups, secrets, population and importer saved work remained unchanged. The
only dynamic changes were ordinary natural work in activity, schedule, social,
memory, attention and presentation fields. No durable record was removed.

The completed safe-idle handover and preservation results are recorded below.

## Conventional update-owned drain

Source review confirms Pause is read at tick entry, not as an active inference
cancellation. A captured tick retains its settings while processing up to
MAX_OLLAMA_PER_TICK=3 acted profiles. The launcher requires scheduler idleness,
not just the brief gap between model calls. Sir_Ponsalot writing finished at
21:04:47.242 UTC; another already-captured natural decision began at
21:04:49.303 UTC. This is not evidence that an active model was interrupted or
that the pending package failed validation.

At 21:09:27.316 UTC, pause was verified false with no recent competing pause
owner in the known maintenance records. The existing PUT /api/settings control
was temporarily set to paused:true under this update's explicit ownership.
The private owner record is in the verified recovery folder. Current admitted
work continues untouched; future ticks are held. The operational controller
restores false immediately after healthy 0.27.5 or any aborted bounded handover.
No profile enablement, cadence, deadline, canary or provider was manually changed.

## Completed local delivery and preservation

The existing launcher positively reported safe idle and stopped the old runner
at 21:19:38.262 UTC, activated 0.27.5 at 21:19:38.276 UTC, and reported healthy
0.27.5 at 21:19:41.213 UTC. The operational controller verified that version and
restored paused:false at 21:19:41.483 UTC. The update-owned admission drain lasted
10 minutes 14.166 seconds; all already-admitted natural work completed normally.
The controller exited successfully, with its private ownership record marked
restored:true. No owned verification or handover process remains running.

Port 8770 is served by node PID 36844 from
`%LOCALAPPDATA%/Programs/Feddit Bots/versions/0.27.5/app/server.js`.
All 84 installed app file hashes match the reviewed desktop payload exactly.
The launcher and shared Node/Ollama runtimes were not replaced. A new ordinary
happy_dayz decision was naturally admitted at 21:20:02.693 UTC, proving normal
scheduling resumed. Its Naturalness voting offers include direct/own-thread
and renewed routes. No post-update model completion was forced or awaited.
The hosted natural first-contact root/action/vote proof is recorded separately
by the coordinated hosted deployment report; no desktop-specific first-contact
outcome or ecological improvement is claimed from this brief startup window.

All 27 profile IDs, one group, every protected profile setting and all global
settings including the exact three writing-canary IDs are unchanged. Secrets,
population storage and the private FetchLayer corpus cache are byte-identical.
All existing durable turn IDs remain present. Live/rehearsal presentation and
assessment ledgers remain within their 512-entry bounds.

The saved importer has the same one workspace ID, 100 source posts, 321 comments,
24 stable candidate IDs, 24 edited drafts, 24 selections, 22 confirmed candidates
and two skipped candidates. Analysis, importResult, review/edits, task, source
reference and complete staging evidence have identical component hashes. The
only workspace file difference is derived sourceSnapshot.cache.ageMs recomputed
by the unchanged importer session normalizer. Removing only that elapsed-age
field yields the same canonical workspace SHA-256 on both sides:
42304a0376a956bdfb8185b43b401c6e148376a9af6c87a4f3e3af87437e54bb.
No retrieval, generation, registration or staging was used for this audit.

Dynamic state was not incorrectly asserted byte-identical while natural work
continued: unchanged startup normalization removed expired 14-day opportunity
history from populationActivity on ten profiles; every rate, band and target
remains identical. The natural tavern turn advanced its driftUpdatedAt timestamp
before handover, without changing its rate. Shared memory episode IDs retain
identical content; natural completed turns added bounded episodes, and existing
startup normalization aged preoccupation weights. The memory, population-activity
and importer-normalization source modules are byte-identical to desktop 8ce2959.
No memory policy, persona or runtime-model setting was changed by this delivery.

Public updater remains version 0.27.2 with SHA-256
863b165a312393820f985a270de5c2ca710258b92bfc071869d1e14864b802da.
No public package, manifest, tag or desktop release was published.
