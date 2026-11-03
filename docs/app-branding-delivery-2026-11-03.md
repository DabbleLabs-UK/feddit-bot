# Local logo installation, 3 November 2026

The owner approved the local handover and explicitly requested updating the
existing Desktop shortcut. No public release or hosted change was made.

## Installed result

- App 0.27.16: signed package SHA-256
  `b0be1d8ee26949e858fd1e3673737831ce6f67ff4ee76587d22684fcde5f027a`.
  ECDSA verified using the existing installed trusted public key; minimum
  launcher remains 0.2.2. All 106 installed app files match reviewed source.
- Launcher/recovery 0.15.4: SHA-256
  `53e9dffb65208cc1be6e50bd645d5c7326ed4d9f79d01a7177eef23e8a78f8fc`.
  Both installed native executables have the exact same bytes.
- Implementation lineage: branding `10e0bf4`, preparation-window icon
  `56cde86`, recovery-installer ACL compatibility `911b9ec` on
  `feature/app-logo-branding`. The app payload is unchanged by the two later
  desktop-only commits; the final native build includes the preparation icon.
- Local health was established by 09:06:12.803 GMT/UTC. Subsequent checks found
  one launcher PID 38448 and its single runner PID 36164, port 8770 serving
  0.27.16, explicit `busy=false`, saved pause true and desired-running true.
  The app remains paused, matching the operator's pre-update setting.

The original PNG remains unchanged. Both existing Desktop and Start Menu
shortcuts retain their executable target and `--open-ui` arguments, but now
explicitly use the installed versioned `branding/app-0.27.16.ico,0` rather than
an implicit icon. Its SHA-256 is
`b6d7e8e54cc8bc99d0243548f939c1863610d6a770387b16a1a855c92b25e004`.
Targeted Windows shell update notifications were sent for both shortcuts;
Explorer was not restarted and no global icon cache was deleted. Apps & Features
DisplayIcon now points at the branded executable. The existing uninstaller
binary was not replaced by the compile-only installer fixture.

## Handover and preservation

A verified private backup remains at
`%LOCALAPPDATA%/DabbleLabs/FedditBots/backups/logo-branding-20261103T090535Z`.
Nineteen files cover the actual current non-backup data files, launcher and old
helper, desktop/current configuration, supervision config/intent/session and
both shortcuts. Backup directories and prior recovery evidence were retained,
not recursively copied or removed. A final exact data checkpoint was captured
after the authenticated safe-idle exit and before replacement.

The exact owned old recovery tasks were removed before replacing the launcher.
Normal stop intent allowed the existing launcher/runner to exit at their
authenticated safe-idle boundary; no process was forcibly terminated and no
inference was interrupted. The existing local staging/activation path installed
the app. Explicit version 0.15.4 and exact hash repinned the new versioned
recovery helper and tasks. Original running intent was then restored and the
paused application was started normally. The installed content-free recovery
check exits zero and both task contracts validate.

All 27 profiles, credentials, groups, settings, prior durable state and exact
writing-v3 IDs remain unchanged. Theme scope remains `shittyaskfeddit`, fixed
quiet assistance stays on, population-aware assistance stays off, and the
2400-token decision budget/model/provider/ecology are unchanged. Comparing
every protected data file found only the existing derived importer cache
refresh at `sessions[0].sourceSnapshot.cache.ageMs`; recursive structural
comparison found no corpus/analysis/candidate/edit/selection changes.

## Encountered issues and checks

Two initial pre-mutation attempts hit `Set-Acl` requesting SeSecurityPrivilege
on the existing private supervision directory, under both PowerShell versions.
The old app/configuration remained unchanged. The installer now persists only
the access/owner sections changed by its existing policy, matching the .NET
method already used by the launcher. No audit policy is read or modified and
the protected current-user/SYSTEM-only ACL is retained. Twenty-one installer
fixture checks pass under both PowerShell 7 and Windows PowerShell, including
reapplication and unchanged saved intent.

The first graceful exit then exposed a delivery-script empty-list Count error.
Its recovery path restored old task configuration and running intent without
replacing a binary; the idle exited app was not forcibly restarted or killed.
The script was corrected to explicitly count an array, and installation resumed
from the independently verified stopped/paused state. No older data backup was
restored over later work.

Final native tests pass 117 checks. Prior branding/UI, 32 signed-package,
90 packaged-runtime plus Naturalness, nine staging and 60 pause-resource checks
remain applicable to unchanged source. PNG delivery is confirmed as image/png.
No model, retrieval, registration, vote, post, comment or activation was forced.
No screenshot/visual inspection is claimed; the owner can check Desktop/tray and
dashboard appearance without resuming bots.

Rollback must coordinate the exact launcher/helper hash and task version at a
safe idle boundary. Preserve compatible pause-resource/durable readers and all
later data; never restore the private backup over subsequent activity.
