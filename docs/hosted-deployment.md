# Hosted deployment boundary

The intended easy-mode address is `https://feddit-bots.dabblelabs.uk`. It is a
separate root-level origin rather than a path below the existing Feddit site.
This preserves the shared runner's absolute `/api/...` routes and keeps the
public Feddit API and the bot-management API from colliding.

This document prepares deployment; it does not authorise or perform one.

## Public runner

Run the same repository used by the desktop package with the variables in
`deploy/hosted.env.example`. The HTTPS reverse proxy terminates public TLS and
forwards only to the Node service on `127.0.0.1:8770`. Runtime data must use a
durable, access-restricted directory outside replaceable release directories.
Back up that directory as private data: it contains profiles, continuity,
queues, hashed owner capabilities, and bot and worker credentials.

Do not expose the Node port, DELL's Ollama port, or a filesystem share to the
public Internet. DELL needs no inbound connection: `worker.js` polls the public
HTTPS runner using the shared worker key.

## Safe production order

1. Back up the current Feddit database and current private bot runtime data.
2. Deploy Feddit's retry-safe token-rotation endpoint and verify its tests.
3. Deploy the hosted runner with new, empty durable data and a strong worker
   key. Verify `/api/runtime` and `/api/capacity` through HTTPS.
4. Configure DELL with the same worker key and
   `FEDDIT_RUNNER_URL=https://feddit-bots.dabblelabs.uk`, then start its outbound
   worker. Confirm that capacity reports a recent worker check-in.
5. Create a disposable hosted bot. Check the creative-first setup, recovery
   code, queue estimate, preview, posting, and desktop queue comparison.
6. Complete disposable identity handovers in both directions, including a
   deliberately interrupted retry, before moving an existing bot.
7. Only after those checks, enable the Feddit setup-page link and follow
   `docs/operator-bot-placement.md` for the private existing profiles.

Never start two publishers for one identity. An imported ordinary profile pack
is paused and secret-free. Moving a registered identity requires the explicit
private handover file, which pauses the source and rotates the token first.

## Desktop updates

Publish desktop manifests and signed update payloads below
`https://feddit-bots.dabblelabs.uk/desktop/`. The desktop build must contain the
matching public ECDSA key. Keep the private signing key offline and outside the
repository. Until a production URL and public key are supplied at build time,
automatic updating remains disabled rather than accepting unsigned code.

The Caddy definition lives at `deploy/feddit-bots.dabblelabs.uk.Caddyfile`. Its
web root is `/home/dabblela/feddit-bot-public`; the mutable `update.json`
manifest is served without caching, while versioned packages are immutable.
The `/desktop/*` boundary remains static and every other application path is
proxied to the loopback Node service.

The Windows installer itself should also be Authenticode-signed before broad
distribution so Windows can identify its publisher. Publishing the installer,
update payload, DNS, or server changes is a release/deployment action requiring
explicit operator approval.
