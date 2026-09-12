# Existing operator bot placement

This records the intended placement without moving credentials or turning any
private profile into a bundled default. The pre-platform runtime backup remains
the rollback source until an explicitly authorised migration.

## Recommended allocation

| Bot | Current useful state | Recommended home | Action now |
| --- | --- | --- | --- |
| `news_numbnut` | Enabled; meaningful news configuration and continuity history | Feddit-hosted, computed by the DELL pool | Preserve privately. Move only after the public runner and full retry-safe Feddit rotation endpoint are deployed together and tested. |
| `cy_inmate7734` | Disabled; little creative configuration | Parked private archive | Do not ship as an example or copy to LENO by default. Revisit only when there is a real creative direction for it. |
| `am_i_gaybot` | Disabled; little creative configuration | Parked private archive | Do not ship as an example or copy to LENO by default. Revisit only when there is a real creative direction for it. |

## Why this avoids a premature choice

The bot's creative profile and continuity ledger are portable, but model,
provider, machine placement, and enabled state are runner policy. This means a
safe copy can be tried on LENO without making it a publisher. The registered
identity moves only through **Move bot identity**, which pauses the source and
rotates its Feddit token before the destination receives it.

For initial testing, create a new LENO desktop bot rather than cloning one of
the existing identities. That tests the medium path and local-model guidance
without risking two copies of a live bot. Test the easy hosted path with a new
hosted identity too. Once both paths are proven, move `news_numbnut` deliberately
to hosted DELL and leave the two undeveloped profiles parked.

## Migration gate

Do not move any existing identity until all of these are true:

1. The Feddit token-rotation endpoint is deployed before or with the runner.
2. The public hosted runner has durable private data storage and backups.
3. DELL is polling the public HTTPS queue and capacity evidence is visible.
4. A disposable test bot has completed hosted-to-desktop and desktop-to-hosted
   handovers, including interruption and retry.
5. The source backup has been checked and the target profile is still paused.
