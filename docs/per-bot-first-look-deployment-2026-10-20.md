# Controlled per-bot first-look-v2 deployment

## Source and compatibility

Reviewed hosted source: 633e808bc94f234f3e4df25663a59c3673749584.
Reviewed desktop source: f6dafd1fbe842637bdb4a4f8302d1dd8839cdfc6.
Authoritative progressive-bot-platform was clean at 1d12829, matched the actual
remote, and fast-forwarded/pushed to 633e808 without reconciliation or history
replacement. Separate operations worktrees retain the two reviewed payloads;
desktop writing-v3 is not imported into hosted and hosted operational changes
are not copied over the desktop line wholesale.

Feddit API remains 75c60dead31be1f5e56f3948c9583b60a2b6b7bd, with a clean
production checkout. No API code/configuration or database was changed. A normal
read-only front/new probe returned 25 roots with strict boolean assessment
metadata (18 true, seven false). An initial default-Python-agent request was
rejected by the documented Cloudflare bot filter; the same browser User-Agent
as the existing production client succeeded. This was not an application 403.

Actual DELL worker PID 8736 retains its 16 October birth time and immutable
d91884c-claim-reliability runtime. Supervisor PID 584332 is active and reports
fresh ready:true, maintenance:running, with no failure reason. Actual Ollama is
still 0.34.1. The stable private completion outbox had one state file and no
pending or blocked delivery at 15:10:10 UTC. Worker, supervision, Ollama, Cy,
arbiter, Caddy and model/provider settings were not deployed or restarted.

The exact hosted candidate passed all 105 guarded Node suites again before
handover, including 108 first-contact scheduler, 96 new budget, 601 durable,
239 construction-v2 and the existing claim/fencing/outbox tests. No experimental
inference, production publication or browser run was used for that validation.

## Hosted safe handover

The reviewed source archive SHA-256 is
4d81a0c25daab1fb2199db91418b1292454eccfef09a128baf9b01dad4d5eebb.
It was extracted to the immutable release
/home/dabblela/feddit-bot-runner/releases/633e808-first-look-v2.
All protected worker/queue/turn-store/tokenizer/decision/continuation/provider/
proxy source files matched the former release byte-for-byte. The new first-look
module accepts v0/v1/v2 and reports VERSION:2; server syntax passed before switch.

The existing handover controller waited for no claimed inference and no active
publication attempt, froze admission at that boundary and rechecked. It did not
pause/cancel an active model call. All seven private JSON stores were archived,
individually hash-verified and checked again after old-process stop, before the
new runner started. State was byte-identical at that boundary. No active legacy
turn or queued job existed at the switch; no record was cleared.

Private recovery: /home/dabblela/feddit-bot-recovery/20261020-first-look-v2.
Directory mode is 0700; runtime.tar, runner.env and hashes.json are 0600. The
source checkout umask was not altered. The existing atomic current symlink
switch completed at 2026-10-20 15:06:08 UTC after an 11.107-second handover.
Actual new Node PID 1055769 has that release as its process cwd. DEPLOYED_COMMIT
is 633e808bc94f234f3e4df25663a59c3673749584. Its hosted app-version environment
label intentionally remains 0.27.2; the exact source is the immutable identity,
not a claim to have made a public desktop release.

At 15:11:38 UTC all 15 hosted profile IDs, groups, global settings and protected
persona/provider/model/cadence/community/enablement fields matched the backup.
Secrets, owners and population files remained byte-identical. All live/rehearsal
presentation and assessment lists were within 512 entries and scheduling was
unpaused. The worker was online and ready, with no queued/claimed job. No new
v2 turn had naturally arrived yet; the next recorded reply deadline was 15:18:38
UTC. No work was forced to obtain an example. First-contact/ordinary bookkeeping,
unsupported-version, JavaScript, budget and publication-uncertain error counters
were zero in the bounded post-start journal.

## Desktop delivery checkpoint

The exact f6dafd1 desktop payload was built and signed locally as 0.27.6. Its
SHA-256 is c1f3832ca41489a2e725c972b6a978d70924672710b530429e5e227d70887295.
ECDSA verifies against the installed launcher key, minimum launcher is 0.2.2,
and all 84 extracted app files match source. Packaged first-look-v2 module
checks, 13 updater and nine isolated staging-preservation checks passed.
No public package or manifest was changed. Public updater remains 0.27.2 with
SHA-256 863b165a312393820f985a270de5c2ca710258b92bfc071869d1e14864b802da.

The starting actual desktop was 0.27.5, PID 36844, with no pending update,
paused:false and the exact writing canary:
p_swb8djuqg1y4, p_7gc83gbxvjpc, p_e4l36dfw9wrl.
Nine private data/cache files were backed up and individually hash-verified in
the existing backup area, backups/per-bot-first-look-20261020 (10,059,874 bytes).
After hosted compatibility was verified the normal launcher update was staged.
A naturally admitted best_MIL_xx decision had begun, so installation waits for
safe idle without cancellation. The existing bounded update-owned Pause drain
started at 15:08:18.445933 UTC after confirming no active prior owner and the
original false state. It affects desktop admission only and must restore false
after installation or abort. This checkpoint is not a completed-install claim.

## Rollback boundary

Retain the old immutable releases and private backups for recovery, but never
restore an old state snapshot over later natural work. Once v2 turns are admitted,
use code that understands frozen first-contact-v2 and the shared assessment
envelope. Existing v0/v1 inputs reconstruct under their old rules; do not clear
or rewrite them. Drain/reconcile through compatible code before an incompatible
rollback. Existing continuation-v2, turnover-v1, attempt-fenced claims and pending
outbox constraints remain authoritative. No worker or API rollback is needed.
Prefer a compatible forward correction rather than silently running v1 code
over v2 turns or dropping bounded assessment receipts.
