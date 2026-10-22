# Hosted durable-turn recovery, 22 October 2026

## Failure and private preservation

First production failure: 21 October 17:59:39 UTC. Monolithic `turns.json` reached
538,471,462 bytes. The previous loader used readFileSync(..., 'utf8') followed by
JSON.parse for the entire store; updates stringify/replace that same aggregate.
Node 22.23.2 rejected the oversized string before scheduler recovery. A 1000-record
terminal cap did not constrain payload bytes. This was not an inference timeout.

The failed service restart loop was stopped with MainPID=0; no working inference
or publication was interrupted. The frozen queue contained 1000 completed jobs,
zero queued/claimed jobs. All seven private JSON stores and the environment were
copied and hash-verified in access-restricted recovery storage:
`/home/dabblela/feddit-bot-recovery/20261022-turn-store-v2` (0700, files 0600).
Eight verified files total 552,774,137 bytes. Original turn-file SHA-256:
`a49aaedbcd4040c291d540af6079abae66099a4d9dfb4d52615a8db3587b93a8`.

Streaming validation found exactly 1001 unique records: 833 completed, 167 failed,
one created/recoverable. They include 524 publication responses and 281 vote-effect
response checkpoints. No publication-uncertain record or attempting publication
exists in this snapshot. Frozen first-contact versions: 867 v0, 60 v1, 74 v2.
The largest compact record is 561,418 bytes, far below an aggregate string limit.

## Repair and migration

Runtime source is `8fcdcddea3bad0edc8fe5c65adb569ad895bc279` on
`fix/hosted-durable-turn-storage`, based exactly on authoritative 633e808.
Source archive SHA-256:
`52aa65234bcbaee8fa31b3dd606efb521712d4a70a1d66ebef05085ba255730a`.
Immutable deployed release:
`/home/dabblela/feddit-bot-runner/releases/8fcdcdd-durable-turn-v2`.

Hosted now uses a fenced 89-byte marker plus atomic per-record live/history files.
Migration preserves every complete record without dropping prompts, outputs,
checkpoints or historical evidence. Completed/failed history remains available
by ID but is not loaded at startup. Publication-uncertain records remain protected
operational evidence, terminal to scheduling and never automatically pruned.

An independent pre-activation review caught that sorting nested JSON keys could
change frozen generation signatures. The unused prepared stage was quarantined
privately, never activated. The final migration preserves insertion order and
verifies both semantic and order-sensitive hashes. Its record-catalogue SHA-256:
`221b01cbdbba4e48fd5f346b9c94e5460b87afcc4229750a596db60846b6b05c`.

All 1001 records were checked through the actual new Node store API, both in a
private rehearsal and as the production service user before service start.
All 1791 stored generation signatures matched. Compact record payloads total
386,585,754 bytes including record newlines, plus small marker/catalogue/directory
metadata. The reduction is whitespace/encoding representation, not evidence loss.
The actual pre-start operational set contains one 192,666-byte record. Its load
took 13.5 ms; no historical payloads were loaded for startup. This is a bounded
verification measurement, not a throughput benchmark.

Before marker activation, every private source hash still matched the verified
backup. The marker and full directory were assigned to fedditbot with private
permissions. API, worker, scheduler, first-look, turnover, budget and provider
source were checked unchanged where applicable. No old snapshot was restored.

## Tests

- Full guarded offline Node suite: 106/106, no timeouts or network-guard blocks.
- Segmented-mode durable scheduler: 601 checks; first-look 108; turnover 79;
  voting suite passes. Legacy behavior also passes its corresponding suites.
- New segmented storage: 50 checks on Windows and Linux, covering >1000 records,
  old history, uncertainty, lazy startup, old-binary fencing, corrupt records,
  atomic commit/archive interruption, cache poisoning and exact frozen state.
- Six Python migration cases pass on Windows and Linux, including interrupted
  activation, source/backup mismatch, corruption/duplicates and Node request order.
- Claim fencing 71, claim/delivery integration 18, worker delivery/outbox 182;
  offline scheduler 532 and legacy turn store 18 checks pass in the full sweep.

Test fixtures used isolated data/home directories, blocked real model/provider
and production endpoints, and excluded the optional live scheduler smoke. No
experimental model call or forced social write occurred.

## Deployment and initial natural recovery

The atomic release switch and service start occurred at 22 October 00:49:25.643
UTC. Actual PID 1394618 runs from the immutable release above. Public HTTPS
`/api/runtime` responds normally. Its inherited hosted app label remains 0.27.2;
the immutable source identity, not that old public desktop label, identifies this
operational patch. Desktop remains local 0.27.6 and was not touched or restarted.

At 00:52:07 UTC the same process remained active, NRestarts unchanged at its
historical 3206 counter. Every original record remained: 1000 terminal records
unchanged, and the original created turn legitimately advanced through recovery.
All 15 hosted profiles, protected persona/provider/model/cadence/enablement fields,
groups and settings match the backup; secrets, owners and population files are
byte-identical. Global scheduling remains unpaused.

Recovered turn `t_96c03ce1101ecde2417035fdbdc10c46` retains first-contact v2 and
its exact original profile/input/creation identity. Normal startup reconciliation
queued its first generation as `j_17f7c25cd4f22bb3cadddf4043d646d9`; worker claimed
it once under lease protocol v2 with a fence. Worker heartbeat is online; one other
natural job is queued. There are zero duplicate job dedupe keys. No active job
existed before migration, so no old claim/inference was recreated.

At 00:54:09.778 UTC the recovered turn's original decision generation completed
and was durably delivered, one attempt, no last error, retaining its v2 fence.
The actual result reports Ollama/the unchanged hosted Llama model, 2210 input
tokens and 41 output tokens. The valid decision resumed the existing normal
`scheduled-generation` writing path, not a second decision or retry. At 00:54:11
the same worker claimed the next natural job, demonstrating that completion
delivery/acknowledgement did not leave it quarantined or stranded. By 00:55:07
the original PID and restart counter remained unchanged; writing was normally
queued behind another admitted turn. No publication was forced for verification.
Original records, queue dedupe keys and first-contact/uncertainty protections
remain intact. The brief live check is not a long-term reliability measurement.

## Compatibility and rollback

No API, worker, Ollama, Cy, desktop, persona, voting, cadence or ecology change was
made. Hosted first-look v2, turnover, construction-v2, decision/continuation replay,
claim recovery/fencing, outbox and publication uncertainty remain authoritative.
Source inspection and regressions establish those boundaries; this short runtime
check is not a claim to have fault-injected production response loss.

Keep compatible segmented-store code. The deliberate non-JSON marker prevents an
old binary interpreting migrated state as empty. Never restore the old backup
over subsequent natural activity. Back up marker AND complete directory with all
other private stores. Prefer a compatible forward fix, not monolithic rollback.
No history was deleted. New completed records are archived without automatic
retention deletion, so history is scalable on disk rather than bounded by count.
