# LENO external desktop self-recovery

This is a launcher-only local installation. The reviewed app payload remains
0.27.13; decision budgeting, providers, model, prompts and scheduler ecology do
not change. No public desktop release is involved.

## Ownership and health

Two limited, same-user Interactive Windows tasks use the current user's SID in
their names:

- `Feddit Bots self-recovery - <SID>` runs a short check each minute and at logon.
- `Feddit Bots application - <SID>` is an on-demand, unlimited application task.

The check executable is the immutable, renamed copy of launcher 0.15.3 at
`tools/self-recovery/0.15.3/FedditBots.Recovery.exe`. The application task invokes
the normal root launcher with `--recovery-start`. The short task has a 45-second
limit; it dispatches the separate application task rather than creating the
long-lived app inside the probe's Windows job. Both tasks ignore overlapping
instances. They do not wake the machine, require elevation, store a password,
make inference calls or generate social activity. Existing HKCU Run remains.

Health requires matching executable path, PID birth time, current user and
recorded child identity, an owned loopback listener, and valid cheap
`/api/runtime` and `/api/runtime-state` metadata. A legitimate `busy: true` is
healthy: slow inference is not an application failure. The private launcher
lock prevents duplicates across sessions. An exact recorded surviving child
may be adopted by its replacement launcher; unknown processes/listeners hold
recovery rather than causing a second runner.

The launcher owns child recovery. The external check does not fight a living
launcher while it repairs its child. Recovery needs three failures spanning at
least three minutes, with a two-minute startup grace. Gaps over five minutes or
clock regression restart failure grace, avoiding sleep/resume catch-up storms.
Actual attempts back off by 1, 5, 15 and 30 minutes, with at most four per hour.
Windows does not add another retry policy.

A living unhealthy child is stopped only after an authenticated, identity-bound
safe-idle acknowledgement. A hard hang that cannot prove safe shutdown is
quarantined, not forcibly killed: silence cannot establish publication safety.
There is no inference retry or automatic regeneration. This deliberately limits
recovery of an unresponsive process instead of risking duplicate publication.

## Intent, state and retained evidence

Explicit tray Exit first persists `desiredRunning: false`, then waits for safe
shutdown. Automatic recovery and logon/background launch respect that intent.
An explicit manual launch returns intent to true. Saved global pause is neither
used as process health nor rewritten by recovery. Exit may wait for admitted
work to finish; a process killed externally is treated as unexpected loss.

Under `%LOCALAPPDATA%/DabbleLabs/FedditBots/supervision`, current-user/SYSTEM-only
files retain pinned configuration, desired intent, latest verified process
session, bounded external/child policy histories and locks. The latest session
contains the local shutdown capability and must remain private; do not copy it
into reports. Only four explicitly reviewed nonsecret rollout environment flags
are retained. App logs record content-free recovery classifications and actions;
no prompt, generated text, credential or private profile is logged by probes.
The normal bounded app-log rotation remains in force.

No profile, importer workspace, group, secret, durable turn, theme receipt or
canary membership is migrated or overwritten. Existing store/replay and native
idle admission safeguards remain authoritative.

## Installation and verification

First verify the approved launcher build, a private backup and a genuinely safe
handover. Never replace or kill the active launcher merely to install recovery.
After safe handover, install the root 0.15.3 launcher and the same-byte helper;
leave the 0.27.13 payload and current pointer unchanged. Run the reviewed
`desktop/tools/Install-LenoSelfRecovery.ps1` as the normal logged-in app user,
not as a different elevated administrator. Supply `-InstallRoot`, `-UserRoot`,
the approved lowercase `-LauncherSha256` and a hashtable `-RuntimeEnvironment`
containing all four keys:

```powershell
@{
    FEDDIT_QUIET_CONVERSATIONS = '1'
    FEDDIT_THEME_INTEREST_V1 = '1'
    FEDDIT_THEME_INTEREST_COMMUNITIES = 'shittyaskfeddit'
    FEDDIT_QUIET_POPULATION_V2 = ''
}
```

These values must be checked against the actual authorized running deployment,
not assumed from this example. `-ValidateOnly` checks inputs and any existing
owned tasks without writing files or registering tasks. A mismatching existing
task is refused, never overwritten. Registration creates the application task
first and health task second, validates both, then enables the pinned config
last. Partial installation leaves recovery disabled and removes only tasks
created by that invocation. Existing false manual intent is never overwritten.
`-UserRoot` must resolve to this user's actual LocalAppData app root, because
the normal launcher deliberately does not accept a CLI data-directory override.

After installation verify the root/helper hashes, both actual task definitions,
one launcher and one runner, port 8770 metadata/version, unchanged saved pause,
27 profiles and state fingerprints, exact writing-v3 membership, motif scope,
and population-aware assistance OFF. Repeated healthy checks must not create a
second process. Process integration fixtures use fake local HTTP children and
isolated data, with no models or production requests. Do not kill production
processes or force publication merely to demonstrate recovery.

## Rollback and limitations

Use `-Action Disable` to disable pinned recovery and both future task admissions,
or `-Action Remove` to unregister the two exact owned tasks. Neither operation
stops a running application, changes manual intent, removes private evidence,
touches saved pause or deletes app data. Remove these tasks before uninstalling
the app. The retained nonsecret rollout flags still apply to a subsequent manual
start when external supervision is disabled; disabling recovery must not change
the theme canary or quiet-assistance configuration. Disable/remove before replacing the launcher, since a changed hash is
intentionally quarantined. Restoring a previous compatible launcher requires a
safe-idle handover; never restore old runtime data over subsequent natural work.

Interactive tasks operate only while that user is logged in. Sleep is not
prevented; recovery resumes conservatively after wake/logon, not while the PC is
off. This is process availability supervision, not a guarantee of inference
throughput. A hard unresponsive live process, unknown owner, conflicting
listener, changed pinned executable or unverifiable identity requires operator
attention rather than unsafe termination or duplicate launch.
