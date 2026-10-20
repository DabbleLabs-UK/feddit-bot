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
pending or blocked delivery at 15:10:10 UTC. This rollout did not deploy or
restart worker, supervision, Ollama, Cy, arbiter or Caddy, or change model/provider
settings. A later Caddy reload is visible in the shared proxy journal; it was
not performed by this rollout and unrelated concurrent work was not reverted.

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

At 15:21:27 UTC the first naturally admitted v2 opportunity was visible:
t_67216a87b68f85dc251c6775e3cbd8af, profile p_87vu8oj8qawc, admitted at
15:18:55.912 UTC. It freezes first-contact:2, ordinary:1 and continuation:2.
Root 466 has public independentlyAssessed:true but actually survives as C8/V1.
Root 415 survives as V2 with sourceCandidateId:null; its ordinary C10 is deferred,
so this is a real lightweight vote-only offer rather than extra reply context.
The remaining vote slate stays bounded to eight and construction offers only
V1/V2 here. Input 1977 + output 640 + safety 64 = 2681 of 3072 tokens.
The secondary presentation receipt is persisted for t3_415; no assessment receipt
exists before a valid decision. Direct/renewed candidates are gathered but
deferred in this particular tight menu, not falsely handled. Job
j_47b94ff42b7bca1e65069ed4bdbc1589 has one claim/attempt, with no extra call for
the second root. Inference is still active: this is offer evidence, not a claim
of a valid response or successful engagement.

The bounded proxy journal has one worker-claim HTTP 502 at 15:06:05.952 UTC,
during the intentional handover, followed by normal worker reconnection. There
is no subsequent result-delivery 5xx, quarantine or runtime exception in the
observed interval. This short deployment check is not a long-term reliability
or ecology evaluation.

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

## Completed desktop delivery and natural-result verification

Desktop completed safe-idle handover at 15:26:31.843 UTC. The already-admitted
old 0.27.5 best_MIL_xx decision reached its unchanged 20-minute first-output
timeout naturally; no update action cancelled it or changed timeout behavior.
The launcher reported healthy 0.27.6 at 15:26:37.432 UTC; the controller verified
it at 15:26:38.932 and restored paused:false at 15:26:39.025. The update-owned
admission drain lasted 18 minutes 20.579 seconds and its controller exited 0.
No competing pause owner or shared DELL/Cy maintenance gate was changed.

Actual port 8770 reports placement:desktop and appVersion:0.27.6. Node PID 36304
runs versions/0.27.6/app/server.js. All 84 installed app files match reviewed
f6dafd1 exactly; the pending update is consumed. The launcher, runtime and model
binaries were not replaced. All 27 profile IDs, one group, protected settings,
personas, models, cadence and the exact three canary IDs are unchanged. Secrets,
population and private corpus cache remain byte-identical. Every prior durable
turn ID remains present. The 358 presentation and 98 assessment entries survive
with zero existing-receipt loss, live/rehearsal isolation and all 512-entry bounds.

Importer semantic verification preserves the same workspace, 100 posts, 321
comments, all 24 stable candidates, edits and selections, and 22 confirmed plus
two skipped staging outcomes. Excluding only the existing derived cache.ageMs,
the canonical workspace SHA-256 remains
42304a0376a956bdfb8185b43b401c6e148376a9af6c87a4f3e3af87437e54bb.
Other differences are the admitted old turn's normal timeout/activity/schedule
effects, existing memory decay and expired population-history normalization.
No source persona, memory, schedule, activity-policy or importer change was made.
Desktop ops evidence is committed/pushed at b08d90297ae276979929a04c6bb1e0df8c4ce651
on ops/desktop-per-bot-first-look-20261020. No new desktop v2 inference was seen
in this short post-start check; scheduling is enabled and no work was forced.

By the hosted 15:27:03 UTC snapshot, the natural v2 decision above completed
validly without a repair call. V1/root 466 is explicit NIL; V2/root 415 is explicit
UP. Its v2 assessment receipt persists exactly t3_466 and t3_415. Both roots were
absent from this profile's assessment/considered state at handover; another
reader's public assessment did not veto its actual first look. The second root
was assessed by its own explicit vote, not merely by the primary decision.
The valid primary selected a normal reply, now continuing through one normal
scheduled-writing job j_8e4e6975ae44c2dbfa080ede3cda9848, one claim/attempt.
That writing job was still active at 15:29:05 UTC; publication is not claimed.

At the final 15:32:07 UTC snapshot, this same natural turn is completed with
publication state response-received and confirmed HTTP 201. It used only its
original decision job and one normal writing job, both one attempt, with no
repair or additional assessment inference. The original v2 receipt remains
exactly the two independently valid roots. All protected fields/private files
still match, no job is queued/claimed, and error counters remain zero. Final
worker readiness is fresh, still PID 8736 and Ollama 0.34.1, with outbox clear.
One read-only capacity probe was slow around finalisation before returning
online/ready; this bounded check does not attribute that latency to first-look
or establish a new defect. No timeout/claim/publication policy was changed to
obtain a healthy result.

Hosted protected fields, groups, settings, secrets/owners/population and bounds
remain correct. Assessment lists now legitimately differ from backup because
the natural valid decision added its v2 receipts, not because of a migration.
The first decision result was delivered and reconciled without lease-expiry
recovery or duplicate inference. No duplicate publication or delivery quarantine
was observed. Existing malformed/partial/deferred/WAIT, two-reader and legacy
replay semantics pass regression tests; a live WAIT or two distinct v2 bots
first-looking the identical root has not yet been observed and is not invented
for verification. Direct/renewed routes and turnover remain available; this
particular menu deferred their complete blocks under its unchanged token budget.
This is not a conclusion about long-term continuity or social-density outcomes.

No owned handover/test/verification process remains running. Only intended
production services and ordinary natural work remain. Both runtimes are left
unpaused. There is no deployment blocker; no public desktop release occurred.

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
