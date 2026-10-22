# Quiet-time assistance controlled deployment - 22 October 2026

## Reviewed source and unchanged dependencies

Hosted payload: `1c713d61ec71c23000ad2049d06b33c2a62dd21d`, including reviewed
implementation `8841cae` and the deployed segmented-store recovery as ancestors.
Desktop payload: `d90a4665753142eab8e199a0b9471e65c77d6947`, preserving the
separate ordinary writing-v3 canary implementation and desktop legacy budgets.
Authoritative main remains `633e808`; this is an isolated controlled deployment,
not a promotion or public desktop release.

API remains `75c60de`. DELL worker/supervision retain `d91884c`, actual Windows
worker PID 8616 and WSL supervisor PID 6234. Ollama is still 0.34.1, and the
existing arbiter is active. Cy reports running, PID 14160. This deployment did
not restart or change API, worker, Ollama, Cy, arbiter or Caddy.

## Verification before delivery

- Exact hosted source: 108/108 guarded offline Node suites passed.
- Exact desktop source: 110/110 guarded offline Node suites passed.
- Hosted segmented replay: 5/5 focused suites passed, including 138 quiet,
  601 durable, 108 first-look and 79 turnover checks plus voting.
- Quiet controller: 118 checks; desktop quiet/canary scheduler: 170 checks.
- Updater: 13 checks; isolated local staging preservation: nine checks.
- Signed build: 28 checks, including packaged-browser fixtures with 90 existing
  checks and Naturalness rendering/gating coverage; no real provider calls.

An exploratory Linux-on-Windows-mount test used incompatible file-mode semantics;
the native Windows verification passed. Final suites had no assertion failures,
timeouts or blocked production/model requests. Test file-selector typos were
corrected before final verification. No experimental inference was run.

## Hosted safe handover

Starting runtime was `8fcdcddea3bad0edc8fe5c65adb569ad895bc279`, PID 1394618,
serving from `releases/8fcdcdd-durable-turn-v2`. The queue had active natural
inference, so the controller waited for a natural no-claim/no-publication boundary.

The controller positively confirms the stopped process, PID/start identity and
immutable source; rechecks after backup; and prevents returning to admission
while an asynchronous termination is unresolved. The first attempt safely
aborted when systemd itself resumed/terminated the stopped process before the
pending-signal observer polled. Its fallback restarted the old compatible build,
PID 1553563, at 19:00:24 UTC. No active inference was cut off or data restored.
That verified private backup was retained, not overwritten. The controller was
corrected to accept already-completed default termination and recheck the full
frozen hashes before switching. Independent script review found no remaining
blocking safety issue.

Successful handover completed at **19:02:09.716 UTC**, with a 13.641-second frozen
boundary. Source archive SHA-256:
`51fdb0b260459467333bcb4257a6d57fd7fbfe59933d7a4fc8fd152def831ed1`.
Immutable release: `/home/dabblela/feddit-bot-runner/releases/1c713d6-quiet-conversations`.
Actual new PID: **1554145**. Its environment contains
`FEDDIT_QUIET_CONVERSATIONS=1`; only that environment setting was added.
The inherited hosted app label remains 0.27.2; the immutable source identity is
the deployed operational revision, not a public desktop version claim.

Private recovery directory:
`/home/dabblela/feddit-bot-recovery/20261022-quiet-conversations-attempt2`.
The earlier aborted attempt remains separately retained. The successful backup
contains 1,099 individually verified files / 456,197,250 bytes, including marker
and the complete segmented tree, all private stores and separately retained
restricted environment. Exact original turn states: 924 completed, 167 failed;
zero active or publication-uncertain turns and zero queued jobs at the boundary.
No record or queue was cleared. State was byte-identical after old-process stop
and before new-process start.

Post-start verification confirms all 1,091 old terminal records byte-identical,
all 15 profile IDs and protected fields, groups and settings preserved, and
secrets/owners/population/turn marker byte-identical. The marker remains 89 bytes;
new history is appended per record, not loaded as an aggregate blob. Queue
dedupe keys remain unique. Existing first-look-v2, turnover-v1, continuation-v2,
claim/fencing/outbox and publication paths were not replaced.

## First natural hosted evidence

At 19:02:30.697 UTC `kiddingme` naturally received the first quiet admission:
`t_18550becd28d421d58d713f148de72ab`, profile `p_ytfmpw5he385`.
Fresh complete public evidence reported three comments and two roots in the
preceding hour. The turn froze quiet-v1, first-look-v2, turnover-v1 and
continuation-v2 and completed at 19:02:35.174.

This was a valid empty-menu WAIT: no eligible unread post/comment existed in
that bot's current feed. It used **zero inference calls and no publication**.
It proves natural admission and safe decline, not a model-chosen response or
improved conversation density. Its persisted live ledger has one admission,
rehearsal has zero, and no thread was selected. The next global quiet slot cannot
open before 19:17:30 UTC; this bot cannot receive another before 20:02:30 UTC.
Normal user work subsequently used the worker while assistance remained idle.
No bookkeeping/version/runtime errors, duplicate job keys or uncertainty were
observed in the bounded post-start check.

## Desktop delivery

Starting actual desktop: 0.27.6, Node PID 36304, launcher PID 23428, paused:false.
Exact canary: `p_swb8djuqg1y4`, `p_7gc83gbxvjpc`, `p_e4l36dfw9wrl`.
No pending update or previous pause owner was present.

Signed local-only 0.27.7 payload SHA-256:
`7007a4be3ced4adbdf9ea0e8559886e12730bf58ad62596885ccc9d4d851075c`.
ECDSA verifies against the installed launcher key; minimum launcher is 0.2.2;
all 85 packaged app files match reviewed d90a466. No public package or manifest
was uploaded or altered.

The existing update-owned Pause drain began at 19:07:20.719918 UTC. A naturally
admitted `premise_goblin_bot` decision, started at 19:04:38.309 UTC, finished
normally, including its subsequent writing phase, before idle at 19:26:50 UTC.
Its existing 20m/5m/30m policy was unchanged. No inference was cancelled.
The controller had a 35-minute bound and restored normal scheduling on exit.
Its private owner/recovery path is
`C:/Users/jodyf/AppData/Local/DabbleLabs/FedditBots/backups/quiet-conversations-20261022`.
The verified backup contains nine files / 10,509,762 bytes; hashes remained
identical at the safe shutdown boundary. The idle-safe authenticated shutdown
accepted the request before the old launcher was stopped. No child was killed.

The reviewed feature is environment-gated, while the installed launcher inherits
its process environment. Delivery therefore uses the existing authenticated
idle-safe shutdown, not a forced child kill, then restarts the unchanged launcher
with the enabled flag and a persisted user environment setting. The standard
staged-update mechanism activates/health-checks 0.27.7 and retains rollback.
All profiles/cache/credentials remain in their existing data directory.

Installation completed at **19:27:00.719480 UTC**, and scheduling was restored
at **19:27:00.784554 UTC**, a 19m40.064636s update-owned admission pause.
Actual Node PID 42912 serves 0.27.7 from `versions/0.27.7/app/server.js`;
launcher PID 40816 is unchanged launcher code. The actual runtime environment
has the enabled flag and original data directory; the user environment retains
the flag for future launcher starts. `current.json` is 0.27.7, pending update
is consumed, and the private build-source receipt identifies exact d90a466.
All 85 installed app files match the signed verified package and reviewed source.

Post-start checks preserve all 27 profile IDs and protected settings, groups,
provider/model/cadence/enablement, secrets, cache, population policy, existing
durable IDs and exact canary membership. All **1,364 memory episodes** retain
their IDs and identical content, with zero removed or added. The only removed
population opportunity-history entries were 25 already expired beyond 14 days;
policy was unchanged. Importer work is semantically identical (ignoring only
derived cache age): 100 posts, 321 comments, 24 candidates, 22 confirmed staging
receipts and two skipped candidates, including all edits and selections.

Normal natural work resumed at 19:27:21.368 UTC with `Sir_Ponsalot`'s scheduled
decision. Final read-only runtime check confirms 0.27.7, paused:false, and the
same three canary IDs. No desktop extra slot was forced while normal work used
capacity. Public updater remains untouched at 0.27.2, SHA-256
`863b165a312393820f985a270de5c2ca710258b92bfc071869d1e14864b802da`.

## Subsequent natural hosted admission

`botbaffler_999` received the second extra at **19:19:50.544 UTC**:
`t_7f000932d1151ee1abcb4dd766764b76`. The 17m19.847s admission gap exceeds
15 minutes; each bot has only one extra. Fresh evidence still reported three
comments and two roots. The gathered menu retained four attention, three renewed
and three ordinary candidates. First-look-v2/turnover-v1/continuation-v2 remain
frozen. The bot naturally selected ordinary root 730 and published a reply with
HTTP 201 at **19:25:22.550 UTC**, without a forced target or publication.

Decision job `j_6f0670420f9899944da36c6bf9a85ec1` and writing job
`j_8bf079b5d97986b516a497a5c812e7d2` both completed with exactly one attempt,
background priority and synthetic allocation. The actual decision request used
2,186 input tokens + 640 output + 64 safety = 2,890 / 3,072, retaining exact
construction-v2 budgeting. No extra repair/inference retry was introduced.
Selection persisted root 730's extra-only cooldown until 19:53:49.296 UTC.

Final bounded hosted inspection finds two completed quiet turns (one safe
empty-menu WAIT and one reply), live ledger two/rehearsal zero, valid global and
per-bot admission gaps, no active/uncertain operational turns, no duplicate job
dedupe keys, all original 1,091 historical records still byte-identical and the
89-byte segmented-store fence healthy. Worker outbox/readiness checks remain
healthy. Actual natural one-attempt decision and writing delivery demonstrate
the unchanged worker/claim path, not merely a wrapper service status.

## Rollback and evidence limits

Disable future extras first; finish frozen quiet turns on compatible code before
an incompatible source rollback. Keep segmented-store support and never restore
an old snapshot over later natural work. Back up the bounded quiet ledger with
profiles/jobs and the complete turn marker/directory. Local inference retains its
existing publication/restart contract, not a new durable inference guarantee.

Live evidence establishes one natural selected reply, not repeated conversational
continuation or a density improvement. Threshold recession at nine comments/hour,
thread re-exclusion across later menus and restart/replay safety pass fixtures;
they have not all occurred naturally in this short window. No single-thread
runaway is observed, but two admissions cannot establish a long-term distribution.
No traffic or extra restart was manufactured to fill these evidence gaps.
Already claimed work remains non-preemptive. No ecological improvement or
long-term reliability conclusion is claimed here. No remaining deployment blocker
was found; both installations are left enabled with normal work running.
