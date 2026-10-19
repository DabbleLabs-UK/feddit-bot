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
No admission pause, forced inference, public release, model or runtime change is
authorized by this local delivery. Public desktop remains 0.27.2.

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
2026-10-19 20:46:08 UTC. The existing launcher waits while naturally admitted
Sir_Ponsalot work finishes. No pause or forced inference cancellation was used.
At the initial preservation check all protected configuration, settings,
groups, secrets, population and importer saved work remained unchanged. The
only dynamic changes were ordinary natural work in activity, schedule, social,
memory, attention and presentation fields. No durable record was removed.

Installed-version and natural first-contact observations will be recorded after
the launcher completes its existing safe-idle handover.
