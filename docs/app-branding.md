# Feddit Bots logo

The supplied `assets/logo.png` is the unchanged original. Run
`pwsh -File desktop/generate-branding.ps1` to regenerate committed derivatives
from a temporary copy, preserving the full image/aspect ratio. The generator
does not edit files in assets. It produces a 256px dashboard logo, 32px browser
icon, 180px touch icon and identical multi-resolution Windows/browser ICOs.
The ICO includes 16/24/32/48/64/128/256px images.

Both dashboard pages use the logo alongside their existing heading and include
browser/touch icon links. Static image MIME types are explicit. Launcher 0.15.4
embeds the icon as both its Windows executable icon and a bundled tray resource;
the tray owns/disposes its icon, with no dependence on the working directory.
The installer and uninstaller use it too, shortcuts explicitly select executable
icon zero and Apps & Features uses the executable's DisplayIcon.
Third-party Node/Ollama executables are not rebranded or modified.

## Local update and recovery pins

The app-only 0.27.16 package includes the web branding. It does not replace the
root launcher. Existing external self-recovery pins must not be bypassed.
The installer now accepts an explicit reviewed `-LauncherVersion 0.15.4`, while
its default remains 0.15.3 for existing installations. Hash/identity/task
validation is unchanged. Version upgrades must remove the exact old owned tasks
using the old version, at a verified idle/stopped boundary, before replacing the
root executable and installing the same-byte new versioned recovery helper.
Install with the new exact hash/version and unchanged four runtime flags.
Intent, saved pause and all private app data must remain unchanged. Never copy
old backups over later state. An old helper task is deliberately refused rather
than silently rewritten for the new version.

No scheduling, inference, model, provider, canary, profile, persistence format,
data collection or network destination changes are part of this branding pass.
No public release is authorized. Rollback must coordinate launcher/helper pins
and preserve the compatible app state readers introduced before this change.

## Verification, 3 November 2026

Prepared controlled-local app package 0.27.16 and launcher 0.15.4. The supplied
original SHA-256 remains
`629c4573576f107803016da68d425025d2af8cc11f8fb5c77e71801947bb12b1`.
The exact 32px icon extracted from the published executable matches the generated
ICO pixel-for-pixel. Offline branding and desktop UI parity tests pass. Launcher
tests pass 116 checks; recovery installer fixtures pass 19; signed-package tests
pass 32, packaged runtime 90 plus Naturalness checks, update staging nine and
pause-resource fixtures 60. Initial sandbox ACL/execution failures were rerun in
owned fixtures outside the sandbox; no production app, bot or model was used.
NSIS compiles the actual installer script with a launcher-only disposable stage;
that output is explicitly a fixture, not a complete redistributable installer.
The icon path and registry quoting were corrected before the successful compile.

Signed app-update SHA-256:
`b0be1d8ee26949e858fd1e3673737831ce6f67ff4ee76587d22684fcde5f027a`.
Launcher SHA-256:
`19306f53c887d33d8c96c075ca8c8eefb8708242084c5dc81204d9f823753504`.

The existing local application was found running, with recovery enabled and
desired-running intent true. It was not stopped or replaced for cosmetic work.
Installed 0.27.15, its launcher/recovery pins, saved pause, profiles and all other
private data remain untouched. No actual desktop/browser visual check was made;
no hosted/public deployment, release or social/model traffic was triggered.
Application and launcher builds are ready for a coordinated safe local handover.

The owner subsequently approved and completed the local handover. See
`app-branding-delivery-2026-11-03.md` for installed hashes, explicit Desktop and
Start Menu shortcut icons, recovery repinning and preserved paused state.
