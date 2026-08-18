# feddit-bot

A dependency-free Node bot runner + control panel for posting to
[Feddit](https://feddit.dabblelabs.uk) using the local Ollama instance.

It manages multiple independent **bot profiles**. Feddit has no user accounts:
a bot identity IS a registration that returns a bearer token, so N profiles
means N registrations, each with its own token, persona, and behaviour.

This repo is the **control panel + API clients only**. The scheduler / posting
loop is a deliberate next step and is not built yet (there is a clean seam for
it in `server.js`).

## Running (on DELL)

DELL mounts this share at `/v/feddit-bot`. The only start command is:

```bash
cd /v/feddit-bot && node server.js
```

Requirements on DELL:

- Node (built and tested against Node 26; anything with global `fetch`, i.e.
  Node 18+, will do).
- The local Ollama instance listening on `http://127.0.0.1:11434`.
- **No `npm install`.** There are zero dependencies by design - only Node
  builtins (`node:http`, `node:fs`, global `fetch`). `node_modules` over a CIFS
  share is a trap, so there is none.

On boot the server prints the local and LAN URLs, e.g.:

```
  Feddit bot control panel is up.
  Local:   http://127.0.0.1:8770/
  LAN:     http://<dell-lan-ip>:8770/
```

Open the LAN URL from any machine on the network to reach the control panel.

## Ports

- **8770** - HTTP control panel + JSON API, bound to `0.0.0.0` (LAN-reachable).
- **11434** - the Ollama instance this talks to (localhost only, not exposed).

## Persistence

All state lives in `data/profiles.json` (gitignored, created on first run).
It holds every profile including its **Feddit bearer token**, so it must never
be committed. Writes are atomic (temp file + rename) to survive a crash mid-write
on the share.

## The Ollama / Cy constraint (READ THIS)

This is a 16GB machine shared with **Cy** (the CY project), which is a **live
site**. Cy keeps the model
`hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M`
permanently resident with `keep_alive: -1` and generates continuously at
~4 tok/s.

To avoid disrupting Cy, this runner:

1. **Defaults every profile to that exact model**, so we reuse the weights Cy
   already has loaded - no extra VRAM, no reload.
2. **Sends `keep_alive: -1` on every Ollama request**, so we never reset the
   model's residency timer and never trigger an eviction.
3. **Enforces single-flight**: at most one generation is ever in flight from
   this process. Ollama serialises requests into one queue; firing a second
   generation while Cy is mid-token would sit in that queue and starve the live
   site. A `test-generate` while one is running returns HTTP 409.
4. **Keeps `num_predict` small (~200 by default)** so each generation is short.

If you set a profile's model to anything other than the default, the UI warns
loudly: generating with a different model swaps the VRAM contents, **evicts Cy's
weights, and stalls the live site** until it reloads. Only do that deliberately.

The status bar shows which model is currently resident; if it is not the shared
default, the model indicator turns amber.

## Feddit constraints

- **Cloudflare Bot Fight Mode is ON** for `feddit.dabblelabs.uk`. A default
  runtime User-Agent gets a 403 at the edge, so every request (reads and writes)
  sends a normal desktop-browser User-Agent.
- **Per-bot rate limits**: 10 posts/hr, 60 comments/hr, 1 new sub-feddit/day.
  429 responses are surfaced clearly in the API and UI, with any `Retry-After`.
- **Tokens are shown once.** Registration returns the token in the response
  body; the runner stores it immediately into `data/profiles.json`.

## Layout

```
server.js          HTTP server (port 8770) + JSON API; scheduler seam
lib/store.js       load/save data/profiles.json, atomic write, profile CRUD
lib/ollama.js      Ollama client: default model, keep_alive -1, single-flight
lib/feddit.js      Feddit /api/v1 client: browser UA, 429 handling, register/read/write
public/index.html  self-contained vanilla-JS control panel (no CDN, no build)
```

## What a profile holds

id, display name, Feddit username, API token, persona system prompt, tone/style
notes, which sub-feddits it reads and posts to, what it does (post / comment /
both), cadence (posts + comments per hour), model, temperature, num_predict, and
an enabled flag. Plus a small recent-activity log.

## Control panel

The single page at `/` lets you:

- list profiles and see enabled / token status at a glance;
- create a profile, then **register its identity on Feddit** (captures the
  returned token straight into the store);
- edit every field including the persona prompt in a large textarea;
- **test-generate** a sample reply against a pasted post title+body and see the
  output **without posting it**;
- enable / disable and delete profiles;
- watch live status: is Ollama up, which model is resident, is Feddit reachable,
  and each profile's recent activity.

## API (used by the panel)

```
GET    /api/status                        ollama + feddit health, default model
GET    /api/feddits                       proxied sub-feddit list
GET    /api/profiles                       list (tokens redacted)
POST   /api/profiles                       create
GET    /api/profiles/:id                   full record (incl. token)
PUT    /api/profiles/:id                   update
DELETE /api/profiles/:id                   delete
POST   /api/profiles/:id/register          register on Feddit, store token
POST   /api/profiles/:id/test-generate     generate sample reply, no posting
```

## Not built yet: the scheduler

The posting loop is the next job. `server.js` marks a `SCHEDULER SEAM`: a future
`lib/scheduler` exporting `start({ store, ollama, feddit })` can be wired in
there without touching request handling. It already has everything it needs -
the profiles/cadence in `store`, the single-flight-protected `ollama.generate`,
and the rate-limit-aware `feddit` writers.
