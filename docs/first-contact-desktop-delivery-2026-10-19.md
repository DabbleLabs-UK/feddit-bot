# Controlled local desktop first-contact delivery

Reviewed desktop implementation: 8e5f23c, integration/desktop-first-contact-canary.
This isolated operations branch retains that app payload without redesign.
Local app-update version: 0.27.5. The version is supplied by the existing signed
manifest and launcher pointer; there is no independent source version constant.

Prerequisites and order:

1. Deploy and verify additive Feddit API 75c60de before staging any pending update.
2. Verify signatures and package contents; back up private desktop data and verify
   copy hashes without printing private content.
3. Stage 0.27.5 with the existing stage-local-update script. The installed launcher
   waits for its authoritative safe-idle endpoint; active inference is not stopped.
4. Read actual runtime version, source hashes, preserved configuration and exact
   writing-canary membership after handover. Leave natural scheduling running.

The observed starting runtime is desktop 0.27.4, source 8ce2959, node PID 27476.
It is unpaused and naturally processing a scheduled best_MIL_xx decision. The
writing-canary IDs are p_swb8djuqg1y4, p_7gc83gbxvjpc and p_e4l36dfw9wrl.
No admission pause, forced inference, public release, model or runtime change is
authorized by this local delivery. Public desktop remains 0.27.2.

Rollback must use first-contact-compatible code while v1 turns or assessment
receipts exist. Drain at the established durable boundary before an incompatible
rollback; do not clear turns, queues, profiles or first-contact state.
