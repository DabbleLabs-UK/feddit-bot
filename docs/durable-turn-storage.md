# Hosted durable-turn storage v2

This is a persistence-only change. First-look, construction, continuation,
decision, claim/fence/outbox and publication semantics are not changed.
Hosted placement selects segmented storage; desktop/advanced remain legacy.

## Authority and commit order

`turns.json` is a small marker prefixed `FEDDIT_TURN_STORE_V2`. It is deliberately
not valid legacy JSON: old binaries must fail rather than load an empty store.
`turns.json.d/live/<id>.json` is authoritative for every operational turn and
publication-uncertain record. Completed/failed turns reside under
`history/<sha256(id)[0:2]>/<id>.json`. Every full frozen record remains available
by ID without loading other history. Publication-uncertain remains terminal to
the scheduler but its evidence is retained indefinitely, not automatically retried.

Synchronous mutations first clone state, write an exclusive private temporary
record, fsync it, atomically rename over live and fsync the directory. Only after
that commit may completed/failed records atomically move into history; both
directories are synced. A crash between these steps leaves the committed live
record authoritative over any stale historical copy. No separately committed
active index can lose an admitted turn. Persistence errors block further store
operations until restart/reconciliation; once-markers cannot advance only in cache.

Startup scans only live records, ignoring recognized uncommitted temporary files.
Historical payloads are read lazily by stable ID. This avoids aggregate strings,
whole-history memory use and whole-history write amplification. Historical disk
usage grows linearly in sharded individual files. No archive payload is pruned or
compressed; future deliberate retention/erasure must preserve required evidence.
Single-writer service ownership remains required, as for the previous store.
Windows directory fsync is unavailable; hosted Linux requires successful fsync.

## Offline migration

Stop the writer at a safe boundary; for an already failed startup, stop its restart
loop and establish no running publisher. Back up and hash-verify all private stores
and the runner environment first. Retain the exact original store privately.

`python3 bin/migrate-durable-turns.py inspect --source /private/data/turns.json`
streams one complete legacy record at a time. It rejects duplicate JSON keys/IDs,
invalid IDs/envelopes and changed source hashes. It reports only content-free
counts/hashes. Individual migration records are bounded to 64 MiB.

`prepare --source ... --staged /private/data/turns-v2-prepared` creates a new,
non-authoritative directory, preserving every record and unknown envelope metadata
in a private migration catalogue. All canonical record hashes/counts are verified.
Nested property order is preserved too: existing frozen request signatures depend
on JSON.stringify ordering. Independent order-sensitive record hashes and actual
stored generation signatures are verified, not merely deep object equality.
`verify --source ... --staged ...` repeats the staged content checks.

`activate --source ... --staged ... --backup /private/backup/turns.json` requires
the source and backup to match the frozen hash. It renames the complete prepared
directory to `turns.json.d`, then atomically replaces the legacy file with the
fenced marker. Until that final replacement, the old file remains authoritative.
After an interruption between directory and marker commits, explicitly inspect and
verify the final directory, then use it as `--staged`; never import an old backup
over changed/migrated source. Preserve any interrupted marker temp as evidence.
Set the marker/directory ownership to the service user, with private permissions.

Migration does not activate the scheduler, infer, register or publish. Verify every
original record through the actual new store API before starting the runner.
Backups must now include BOTH marker and entire directory, plus jobs, profiles,
owners, secrets, population, evidence and other existing private state.

## Replay and rollback

Every existing turn, job association, prompt, version, result, publication attempt,
response, vote checkpoint and once-marker is preserved exactly as JSON data.
No inference/publication is repeated merely by migration. Normal scheduler replay
remains authoritative, including existing uncertainty handling.

Do not point old code at migrated data. Before any rollback, stop/drain compatible
code and retain its latest marker/directory. Prefer a compatible forward fix.
Never restore the pre-migration backup over later natural activity. A rollback
to monolithic JSON is not safe at this size and is not an automatic recovery path.
