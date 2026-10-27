# LENO decision-capacity replay and controlled delivery - 27 October 2026

This follows the earlier bounded, zero-call drain described in
`desktop-decision-capacity-verification-2026-10-27.md`. That historical report
remains intact. Application source is
`d698b7948612238c8f2d684a71dd0ce12ca22e3e` on `fix/leno-decision-capacity`.

## Approved bounded verification

The owner explicitly approved up to 90 minutes to reach verified desktop idle,
then at most two private replay calls in 30 minutes. The existing one-use
controller preserved the earlier failed ledgers and frozen inputs. It paused
desktop admission only; hosted Feddit, DELL and Cy were not paused or restarted.

The pause began at 22:15:03.686724Z. Already-admitted natural request 2858
continued under the installed old scheduler: it first generated output after
about 9m36s but eventually reached its existing 30-minute emergency deadline.
The controller established native idle at 22:23:56.483856Z, after 8m52.797s of
drain. It verified a nine-file, 11,083,968-byte private backup before inference.

Exactly two replay calls ran, with no retries or semantic repair call. Both
used the frozen production-equivalent Qwen model, temperature 0.8, output 640,
four threads and unchanged context. Neither used a Feddit client, scheduler
mutation, social/memory store or publication route. Native idle was verified
after each call. The production data hashes were unchanged during the replays.
Scheduling was restored at 22:34:31.221546Z on every normal exit path; the closed
owner ledger confirms restoration. Total replay-owned pause was 19m27.535s,
including drain and about 10m35s for the two replays and cleanup.

The raw historical desktop timeout prompts were not retained. These are
reconstructions from retained target IDs/public context and frozen current
profile/social/memory state, not exact replays of the original failed inputs.
The two selected cases have complete retained public target coverage.

| Frozen reconstruction | Old compact tokens | New predicted/actual tokens | Prefill | Decode | Ollama total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sir_Ponsalot | 5,245 | 2,281 / 2,281 | 292.150 s | 24.222 s | 317.179 s |
| governmint_clerk_bot | 5,936 | 2,318 / 2,318 | 261.022 s | 22.073 s | 283.358 s |

The old-format calls were not rerun: the authorized pair was two large-case
capacity replays, not a matched speed benchmark. The observed new prefill rates
were about 7.8 and 8.9 tokens/second. The 2,400-token ceiling was derived
conservatively from retained 2.83-token/second prefill: about 14.1 minutes,
leaving margin before the unchanged 20-minute first-output deadline. Machine
load was not held fixed, so these two timings are not a population speedup claim.

## Comprehension and decision limitations

Both primary choices were valid C1 replies. Sir's literary reason was compatible
but generic. Governmint's reason correctly connected the root's hummed theme
song with the immediate parent's melancholy-denial premise, while its separate
root vote referred to the correct book/self-recognition target. No clear
cross-target reference confusion was demonstrated. These cases did not include
deeper supplied ancestors, so their comprehension is covered by preservation
tests rather than these two real calls.

Voting was incomplete: two independently valid explicit votes out of five
offered votes; three missing votes remained unresolved. Neither response
completed the full voting contract. Sir explicitly returned NIL for V1 and
omitted V2. Governmint explicitly returned UP for V1 and omitted V2/V3. The
existing production parser remains authoritative. No missing vote became NIL,
considered or first-look-assessed by fabrication. Existing scheduler repair is
only for invalid primary decisions, not missing independent votes.

The compact prompt's one-vote example may contribute to omission, but two
treatment-only results do not establish that cause or a regression rate. No
prompt redesign, validator weakening, extra repair or additional model call was
made to obtain a better result. This is a capacity/usable-primary PASS with an
explicit incomplete-voting limitation, not a full-contract-validity PASS.

## Information and behavioural trade-off

Repeated memory prose, overlapping candidate context and vote content dominated
remaining cost after the previous lossless representation. Desktop ordinary
Qwen decisions now use exact token accounting, full unchanged persona and
complete bounded candidate/branch/social/theme blocks. Decision-specific memory
uses factual anchors and retained uncertainty/preoccupation/conflict cues;
canonical memory and richer selected writing retrieval are unchanged.

Whole candidates that cannot fit are deferred. For the replayed cases, action
menus shrank from six to two and ballots from eight to two/three. This reduces
choice breadth; it is not lossless relative to the original full slate. Stable
IDs, retained ordering, WAIT/NIL and complete blocks remain, while deferred
items stay outside actual-offer, considered, assessment and discovery receipts.
Hosted construction, manual/Burst paths and frozen legacy durable work are
unchanged. Writing-v3 and its exact membership are unchanged.

The existing provider gate now holds admission until verified native idle after
cancellation, not merely until HTTP cancellation. Ambiguous process/slot state
holds safely. Scheduler iteration rechecks current pause/provider availability
before the next profile. Timeouts remain 20m first meaningful output, 5m without
generation progress and 30m emergency ceiling; no partial output is accepted.

## Validation and artifact

- 55 affected offline suites passed, with 5,289 explicitly counted checks plus
  uncounted passing suites. Two legacy Windows atomic-replace failures passed
  in normal Windows Temp; no assertion was weakened.
- Final admission correction: 11 focused suites, 353 counted checks.
- Tokenizer: 1,052 offline checks; 182 native metadata-only token comparisons,
  four renderings and 22 reconstructed counts matched.
- Updater 13 checks; local staging nine; packaged invariants 14. All 99 packaged
  files match reviewed application source. The previous baseline browser wait
  caveat remains; no new browser pass is claimed.
- Signed local version 0.27.13, minimum launcher 0.2.2; ECDSA verifies against
  the installed update key.
- Approved SHA-256:
  `2a24418435acb65c3e07f9820ca13914f0a3a902efa7c07c11f39b72277a2e9e`.
  The earlier pre-admission-correction artifact is obsolete.

## Controlled installation and actual runtime

The existing safe local handover succeeded. Its update owner started at
22:40:07.066672Z and restored scheduling at 23:25:31.130019Z, about 45m24s later.
Only the unused approved drain allowance (4,867 seconds) was available; the
operator did not interrupt inference. The old captured tick completed three
natural requests: 2859 and 2860 reached their existing first-output deadlines;
2861 completed normally. Strict desktop/native idle preceded backup and
authenticated shutdown. No active child was killed and no backend was restarted.

Old request 2861 had 2,923 input tokens, 255.440 seconds prefill and 83.769
seconds decoding, with 632.660 seconds request duration. The larger total is
consistent with waiting behind cancelled native work; these component timings
alone do not conclusively attribute every remaining second. The new admission
boundary prevents a subsequent desktop request being sent until verified idle.

The fresh ten-file, 11,384,349-byte private delivery backup verifies against its
manifest. No old snapshot was restored over subsequent natural state. Independent
checks at 23:25:44Z confirmed:

- Port 8770 serves desktop 0.27.13 from the actual installed
  `versions/0.27.13/app/server.js`, runner PID74136, launcher PID16040.
- Exactly one launcher/runner chain; all 99 installed files match the signed
  reviewed payload, not merely its version/build metadata.
- Build source is d698b7948612238c8f2d684a71dd0ce12ca22e3e and the final
  SHA-256 is 2a24418435acb65c3e07f9820ca13914f0a3a902efa7c07c11f39b72277a2e9e.
- `paused:false`; all 27 profiles remain enabled/live. Protected profile fields,
  settings, groups, credentials, importer workspace and retained theme receipts
  match the delivery backup. Derived cache age and natural runtime advancement
  are not mistaken for lost work. The legacy durable store remains byte-identical
  with its one completed turn.
- Exact writing-v3 IDs remain p_swb8djuqg1y4, p_7gc83gbxvjpc and
  p_e4l36dfw9wrl. Theme canary remains shittyaskfeddit only; fixed quiet
  assistance is on and population-aware assistance off.
- LENO Ollama 0.32.15 PID43796 and native PID44088 are unchanged, as are Qwen
  digest, 32,768 context, one slot, 1,024 batch/ubatch, four threads and 1 GiB
  reusable-cache cap. Hosted/API/DELL worker/Cy were not modified.
- The installer and replay controller exited with their pause restored. No
  experimental inference helper remains active.

Fourteen library-only assertions also passed against the actual installed
payload, including input ceiling, tokenizer, unchanged timeouts, exact-body
ledger bound, theme scope and WAIT construction. Final artifact hash, installed
public-key ECDSA signature and minimum launcher 0.2.2 were reverified.

At 23:26:06Z natural request 2862 (tavern_toilet_oracle) was already running with
decisionEvidenceVersion 2, unchanged Qwen settings and 7,015 prompt characters
plus 1,267 persona characters. This proves ordinary scheduling resumed into the
new path. It then completed at 23:29:26.851Z: 2,135 actual input tokens,
182.088 seconds prefill, 27.220 seconds decoding, 209.810 seconds Ollama total
and 213.960 seconds request duration. First output arrived after 186.729
seconds. Its valid selected comment proceeded into ordinary writing request
2863, without a forced action or experimental call. This is live usable-primary
completion evidence, not an inferred success merely from admission or proof of
complete independent voting.

No public desktop release occurred. External launcher self-recovery remains
absent and was not implemented by this capacity repair.

## Rollback and observation limits

Use normal idle handover for any binary rollback, never terminate an active turn
or restore an older private data snapshot over later natural activity. No new
durable schema migration or hosted policy was introduced. Rolling back this
desktop code restores the old oversized-input, captured-tick and native-drain
limitations; retain the backup and exact build evidence.

The two-case result supports controlled natural observation, not a guarantee for
all profiles or future CPU contention. Missing independent votes remain an
explicit limitation. Use 23:25:31.130019 GMT on 27 October 2026 as the new-build
scheduling baseline, not the earlier HOLD periods or private replay interval.
Normal production work should supply the next reliability evidence; no further
experiment campaign or ecological tuning was started.
