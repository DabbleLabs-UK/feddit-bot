# LENO external self-recovery delivery, 28 October 2026

## Reviewed source and installation

- Branch: `fix/leno-external-self-recovery`.
- Core checkpoint: `ee76176e4f26405a7a0d62e84aaa1425edd0551b`.
- Final reviewed launcher/operator source: `6b233cdce488d98321aac2bdd14435892cdb2dee`.
- Installed launcher: `0.15.3+6b233cdce488d98321aac2bdd14435892cdb2dee`.
- Root launcher and immutable recovery helper SHA-256:
  `e580e95a43cc8e54428c0986777f68d49aad8c11b4935bb139a18d086bfb1cdd`.
- Application remains desktop **0.27.13**, source
  `d698b7948612238c8f2d684a71dd0ce12ca22e3e`; all 99 installed application
  files match the previously approved payload. No app package was replaced.

The root launcher is installed in `%LOCALAPPDATA%/Programs/Feddit Bots`.
The same-byte, renamed helper is
`tools/self-recovery/0.15.3/FedditBots.Recovery.exe` beneath that directory.
The two limited Interactive tasks are `Feddit Bots application - <current SID>`
and `Feddit Bots self-recovery - <current SID>`.
Existing HKCU Run was left unchanged. No public release occurred.

## Handover and preservation

The one-use operator verified exact source, old process birth identities,
current pointer, existing rollout flags, canary IDs, no competing pending update,
and unpaused scheduling before claiming its temporary update pause.

- Owned pause: **08:07:43.541 GMT**.
- Existing natural work drained; application and native slot were verified idle.
- Existing authenticated shutdown rechecked safe idleness before stopping the
  old child. Only then was the old launcher retired and its executable replaced.
- New application started through the separate unlimited application task.
- Installed and healthy: **08:08:14.929 GMT**.
- Scheduling restored: **08:08:15.323 GMT**.
- Owned pause duration: **31.782 seconds**. No inference was interrupted.

Verified private backups live under
`%LOCALAPPDATA%/DabbleLabs/FedditBots/backups/external-recovery-delivery-20261028`.
The original launcher, pointer/configuration and before-drain snapshot are
retained, alongside the stable safe-idle snapshot and ownership receipt.
The safe-idle snapshot contains **36 files / 25,019,393 bytes**; every digest
verifies. Backup and supervision directories are current-user/SYSTEM private.
Private control capabilities are not included in committed evidence.

Post-installation comparisons verify:

- 27 profiles, protected persona/provider/cadence/enablement fields unchanged;
- groups and all settings unchanged except the owned pause, subsequently restored;
- credentials and importer workspace unchanged;
- all prior retained live/rehearsal theme receipts preserved;
- prior durable turn unchanged, with no historical data restored over new work;
- exact writing-v3 membership remains `p_swb8djuqg1y4`, `p_7gc83gbxvjpc`,
  `p_e4l36dfw9wrl`;
- fixed quiet assistance remains ON, population-aware quiet remains OFF,
  theme canary remains limited to `shittyaskfeddit`;
- hosted, DELL/Cy, model/provider configuration, backend, prompts and ecology
  were not changed.

## Tests and actual checks

- Full Windows launcher/updater/recovery suite: **114 checks passed**.
  Fake local child processes exercise absence, child-only failure, surviving
  orphan adoption, short failure, safe unhealthy recovery, genuinely silent
  live-process quarantine, foreign listener rejection, backoff, repeated
  invocations, pause/data preservation and manual stop during asynchronous
  preparation. No model is involved.
- Installer: **17 checks passed**, using protected temporary files and real but
  unregistered Task Scheduler definitions. It verifies atomic writes, exact
  identity/action settings, no short application deadline, minute/logon trigger
  bounds and retained manual-stop intent.
- Existing local update preservation: **9 checks passed**.
- Existing signed update build: **28 checks passed**, including the packaged
  browser/runtime fixture's 90 existing checks and Naturalness checks.
- Initial sandbox-only update fixtures hit existing Windows atomic move/replace
  permission failures; the unchanged fixtures passed under the actual Windows
  account. No production workaround or app persistence change was introduced.
- Independent review cleared launcher and installer safety findings.
- `git diff --check` passes; `server.js`, `lib/` and `public/` remain identical
  to the reviewed 0.27.13 application source.

Actual installed metadata checks ran twice concurrently and exited **0 / 0**
in 4.374 seconds total. Task-based checks subsequently completed with result 0
and content-free `healthy` classification, with zero recovery attempts.
Repeated application-task admission was refused while its existing instance
remained running, as intended; its one engine PID remained the real launcher.
The application task's resulting `0x800710e0` is this deliberately rejected
duplicate start, not the health authority. Health comes from owned process and
listener identity plus local runtime metadata, not the task wrapper state.

At 08:11 GMT the single launcher was PID 36900, child PID 71000; port 8770 was
healthy on 0.27.13, saved pause false, desired-running true, enabled recovery,
one application task instance and no duplicate runner. Natural scheduling
resumed; no test inference or social publication was requested.

## Operating contract and rollback

See [the runbook](leno-external-self-recovery.md). Checks need three sustained
failures spanning at least three minutes, have two-minute startup grace, reset
after stale/sleep gaps, and back off 1/5/15/30 minutes with at most four attempts
per hour. Slow active inference is healthy. The short task cannot kill the
separate unlimited application task.

Explicit tray Exit saves stop intent and waits for authenticated safe shutdown;
the app stays stopped until an explicit manual launch. The saved global pause
is not used as process health and is never rewritten by recovery. Disabling or
removing external tasks retains rollout flags for later manual starts.

`-Action Disable` stops future supervision; `-Action Remove` unregisters only
the exact owned tasks. Neither stops admitted work or changes app data. Remove
tasks before uninstalling the app. Replacing the launcher requires safe idle,
updated approved pins or disabled supervision. Never restore an old data backup
over subsequent natural activity.

Limitations remain deliberate: the user must be logged in, sleep is not
prevented, and an unresponsive live process with no trustworthy safe-shutdown
acknowledgement is quarantined rather than killed. Unknown identity/listener
conflicts also require operator attention. Process availability supervision does
not guarantee model throughput. No production crash or sleep was forced merely
to demonstrate recovery; those failure paths were tested with isolated fakes.
