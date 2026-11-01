# Local pause/model release delivery, 1 November 2026

Installed application 0.27.15 from
`c3f9960e26bc4f3ce2679e62d62f4e2fb4ae9892` on
`fix/desktop-pause-model-release`, over the latest local desktop companion
`a8866e2` containing reviewed payload `f86cec0`. No main reset, hosted/API/DELL/Cy
deployment, public release or provider/model/ecology change occurred.

Signed package SHA-256:
`df590464f9f07ce2a36a61cdd84483329b50fc7aeb1d3d0051a99839fb5d152a`.
ECDSA verified with the installed public key, minimum launcher 0.2.2; all 102
installed application files match the reviewed packaged source. Root launcher
0.15.3 and its recovery helper remain unchanged at SHA-256
`e580e95a43cc8e54428c0986777f68d49aad8c11b4935bb139a18d086bfb1cdd`.

## Actual local verification

Initial state was deliberately stopped with saved pause true and
`desiredRunning=false`; neither application nor Ollama listener existed. The
owner explicitly approved temporary local validation and restoration of that
stopped/paused state. The existing Open WebUI Ollama 0.32.15 executable and model
store were temporarily run with unchanged context/cache settings; no DELL/Cy
process, shared service configuration or model selection was altered.

Exactly three tiny private requests used isolated data, no profiles or Feddit
client, no scheduler/publication, no social/memory or canary mutations:

| Check | Evidence (GMT/UTC) |
| --- | --- |
| Model resident after private request | 03:42:14.851; Qwen digest `0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0`; native working set 7,396,425,728 bytes, private bytes 7,694,704,640 |
| Idle Pause | By 03:42:26.084, `/api/ps` empty and native process gone; Ollama service still running, working set 54,181,888 bytes |
| Resume only | 03:42:31.447, still no resident model; no preload request |
| Pause during next permitted private inference | Inference completed normally at 03:43:33.013, 26 output tokens / 48,619 ms; only then release completed by 03:43:51.335 |
| Rapid Pause/Resume during third request | 03:44:57.144, request completed and model still resident after six seconds; no unwanted unload |
| Final private Pause | 03:45:12.774, empty residency, native gone, service still alive at 50,282,496-byte working set |

Thus idle release removed about 7.40 GB of native working set, not merely a
diagnostic badge. Subsequent genuine private requests loaded normally. No second
unrelated model was loaded just to test isolation; foreign digests, replacement
processes, multiple residents and external connections were tested with mocks.
The supported Ollama refcount-respecting unload path is documented in the design.
There is no claim of an exclusive cross-application residency lease.

## Tests and review

The broader 19-suite regression run passed 1,499 counted checks plus three
uncounted passing suites. Three status-only files changed during that run, so it
is not represented as a single immutable-source sweep. Final `c3f9960` reran all
nine affected pause/provider/UI suites, 235 counted checks plus three uncounted
passing suites, with unchanged before/after source hashes. This includes 60
controller/identity/persistence tests and 34 provider pending-release/race tests.
The other suites cover native drain, finite progress timeouts, 2400-token budget,
durable scheduler, writing canary, phrase motifs, quiet assistance, first-look,
turnover and reply continuity. Independent review cleared material safety issues;
its pending-unload status clarification is included in the final commit.

Signed-build 28 and staging nine checks passed. Packaged runtime passed its 90
existing importer/Burst/groups/forecast checks plus Naturalness browser checks.
Initial sandbox fixture attempts hit known TEMP atomic-rename/loopback permission
restrictions; exclusively owned workspace TEMP and narrow fixture-only escalation
passed without production endpoints. All test processes exited.

## Installation and preservation

Private verified backup:
`%LOCALAPPDATA%/DabbleLabs/FedditBots/backups/pause-release-delivery-20261101`:
36 data files / 25,565,038 bytes. No old data was restored over newer activity.
The existing pending-update launcher path selected 0.27.15 and exposed it on
port 8770 while saved pause stayed true. Exactly one launcher/runner was checked.

The first 45-second native-idle verification timed out conservatively and restored
stop intent through normal launcher shutdown. A subsequent paused startup reached
verified idle without inference; it was safely stopped by 03:53:36.012 GMT.
No cause is asserted for that transient native-verification delay. An isolated
probe with the installed executable also cleared its startup gate without a model.

Profiles, credentials, groups, settings, durable records, importer content and all
other protected data match the backup. The only data-file difference is the
existing derived importer `sessions[0].sourceSnapshot.cache.ageMs` refresh; recursive
comparison confirms no corpus/analysis/candidates/edits/selections were changed.
Self-recovery configuration, executable pins and desktop config remain unchanged.
Saved pause true and desired-running false were restored, and the task-owned
temporary Ollama process exited after positively verified idle/empty residency.

All 27 profiles remain, with exact writing-v3 IDs
`p_swb8djuqg1y4`, `p_7gc83gbxvjpc`, `p_e4l36dfw9wrl`. Motif scope remains
`shittyaskfeddit`, identity v3 with stable v2 replay; fixed quiet assistance stays
on, population-aware quiet assistance off, and desktop decision budget stays 2400.
No public inference, registration, vote, post, comment or activation was forced.

## Limits and rollback

Unknown/shared instances are retained; pre-existing instances without a genuine
Feddit-use witness are not guessed from selected model settings. Only the verified
Windows loopback 0.32.15 native path supports automatic release. A disconnected
external application's later desire to reuse the same model is unknowable; that
application may naturally reload it. Already accepted unload cannot be unsent.
Ambiguous unload stays fenced across restart until the original instance is gone;
there is no blind resend or inference on top of unresolved release.

Keep compatible pending-release code until pending instances have retired before
rolling back to code that ignores the operational receipt. Never restore older
profiles/turns over later work. The app is installed but intentionally stopped and
paused, matching the owner's original state; normal manual startup is available.
