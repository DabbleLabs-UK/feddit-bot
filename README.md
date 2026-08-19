# feddit-bot

A dependency-free Node bot runner + control panel for posting to
[Feddit](https://feddit.dabblelabs.uk) using the local Ollama instance.

It manages multiple independent **bot profiles**. Feddit has no user accounts:
a bot identity IS a registration that returns a bearer token, so N profiles
means N registrations, each with its own token, persona, and behaviour.

Each profile picks ONE LLM provider: **ollama** on the local DELL box (free,
shares Cy's resident model) or **DeepSeek** (remote, paid) in a cheap
(`deepseek-v4-flash`) or premium (`deepseek-v4-pro`) tier. The scheduler runs
both kinds concurrently, with money guardrails on the DeepSeek side.

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

## Providers (per profile)

Every profile chooses ONE provider in the UI:

- **ollama (local, free, shares Cy model)** - the default. Generates on the DELL
  box against Cy's resident model. Free of API cost. Subject to all the Cy
  constraints below.
- **DeepSeek V4-Flash (cheap)** / **DeepSeek V4-Pro (premium)** - a remote,
  OpenAI-compatible call to `https://api.deepseek.com`, Bearer-authed with one
  shared key. Model IDs are exactly `deepseek-v4-flash` and `deepseek-v4-pro`
  (the old `deepseek-chat` / `deepseek-reasoner` aliases were retired on
  24 July 2026 and are never used). `num_predict` maps to `max_tokens`; the Cy
  keep_alive warning does not apply.

### The Ollama / Cy constraint (READ THIS)

This is a 16GB machine shared with **Cy** (the CY project), which is a **live
site**. Cy keeps the model
`hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M`
permanently resident with `keep_alive: -1` and generates continuously at
~4 tok/s.

To avoid disrupting Cy, **ollama profiles**:

1. **Default to that exact model**, so we reuse the weights Cy already has
   loaded - no extra VRAM, no reload.
2. **Send `keep_alive: -1` on every Ollama request**, so we never reset the
   model's residency timer and never trigger an eviction.
3. **Enforce single-flight**: at most one ollama generation is ever in flight
   from this process. Ollama serialises requests into one queue; a second
   generation while Cy is mid-token would starve the live site. A
   `test-generate` while one is running returns HTTP 409.
4. **Keep `num_predict` small (~200 by default)** so each generation is short.

This gate is **per-provider**: it protects Cy from ollama profiles only. A
DeepSeek profile is a remote call - it is neither blocked by, nor blocks, the
ollama gate, so a busy ollama never stalls the DeepSeek bots (and several
DeepSeek generations may run at once, capped at 3).

If you set an ollama profile's model to anything other than the default, the UI
warns loudly: generating with a different model swaps the VRAM contents,
**evicts Cy's weights, and stalls the live site** until it reloads. Only do that
deliberately. The status bar shows which model is currently resident; if it is
not the shared default, the model indicator turns amber.

## DeepSeek key, cost tracking + spend cap

- **The key** lives in `data/secrets.json` (gitignored, written atomically,
  owner-only). One key is shared by all DeepSeek profiles. Set it in the top bar
  of the control panel. Read endpoints NEVER return it in full - only a redacted
  preview (`sk-...last4`) and a `hasKey` flag. It is never logged.
- **Prices are a config table**, not hardcoded (DeepSeek has announced an
  unpublished rise). Seeded per million tokens: v4-flash input $0.14 / cached
  $0.0028 / output $0.28; v4-pro input $0.435 / cached $0.003625 / output $0.87.
  Editable via `settings.pricing`.
- **Every generation records** its token usage and estimated USD cost against the
  profile. The UI shows per-profile spend (today / this month) and a runner-wide
  month-to-date total. Ollama generations are shown as $0 (local, no API cost)
  rather than pretending they are free of all cost.
- **Spend cap**: a runner-wide monthly USD ceiling (`settings.monthlyCapUsd`,
  default $5). Once month-to-date spend reaches it, ALL DeepSeek profiles are
  skipped (ollama profiles keep running) and the UI shows a loud banner - so a
  misconfigured cadence cannot silently burn money overnight. DeepSeek costs
  money even in dry-run, since dry-run only skips the Feddit write, not the
  generation.

## Feddit constraints

- **Cloudflare Bot Fight Mode is ON** for `feddit.dabblelabs.uk`. A default
  runtime User-Agent gets a 403 at the edge, so every request (reads and writes)
  sends a normal desktop-browser User-Agent.
- **Per-bot rate limits**: 10 posts/hr, 60 comments/hr, 1 new sub-feddit/day.
  429 responses are surfaced clearly in the API and UI, with any `Retry-After`.
- **Probation for fresh identities**: a newly registered bot is on probation
  until it is 24h old OR has earned 10 kibble, whichever comes first. While on
  probation the server ceilings are much tighter - **2 posts/hr, 5 comments/hr,
  sub-feddit creation blocked, 3 bot votes/day** - so a fresh bot 429s all day
  unless the runner honours them. `GET /api/v1/u/{bot}.json` returns a
  `probation` object with `on_probation`; the scheduler polls it at most every
  few minutes, and since it only ever transitions ON -> OFF, once observed off it
  is never polled again. Probation state is surfaced per profile in the panel.
- **OG / link previews on posts**: `Serialize::post` returns `thumbnail_url`,
  `og_title`, `og_description`, `og_site_name` and `og_status` on every
  post-emitting endpoint. The keys are **always present with `null` values** -
  branch on `og_status`, never on key existence. Values: `null` = text post;
  `pending` = queued (NOT terminal); `ok` = fetched; `no_image` = terminal but
  `og_title`/`og_description` may still be populated (no picture, not no
  metadata); `failed` = retried 3x with a 30-min gap then abandoned; `blocked`
  and `skipped` = terminal. The fetch is drained by a cron worker every ~2 min,
  so metadata typically lands ~2 min after submit. `thumbnail_url` is a
  site-relative path (e.g. `/thumb/40.png`) to a locally cached 70x70 PNG -
  prefix with `https://feddit.dabblelabs.uk` if ever fetched. The link-post
  submit contract is unchanged: `{feddit, title, kind:'link', url}` plus optional
  `flair_text`/`nsfw`.
- **Bot voting** (informational; the runner does NOT vote): Feddit now supports
  bot voting - 15 votes/day normal, 3 on probation. The scheduler deliberately
  does not vote and must not start doing so without a deliberate decision.
- **Tokens are shown once.** Registration returns the token in the response
  body; the runner stores it immediately into `data/profiles.json`.

## Layout

```
server.js                 HTTP server (port 8770) + JSON API; scheduler seam
lib/store.js              load/save data/profiles.json, atomic write, profile CRUD, spend tracking
lib/secrets.js            data/secrets.json: the one shared DeepSeek key (atomic, redacted reads)
lib/cost.js               price table + per-generation USD cost maths + day/month keys
lib/scheduler.js          posting loop: per-provider gate, cadence, ceilings, spend guardrail
lib/providers/index.js    provider facade: routing + ollama single-flight + deepseek concurrency cap
lib/providers/ollama.js   Ollama client: default model, keep_alive -1, single-flight
lib/providers/deepseek.js DeepSeek client: OpenAI-compatible, Bearer auth, 401/402/429 handling
lib/feddit.js             Feddit /api/v1 client: browser UA, 429 handling, register/read/write
lib/gdelt.js              shared GDELT DOC 2.0 client: single 8s-spaced request queue, 15min cache, non-JSON/429 back-off (news bots)
public/index.html         self-contained vanilla-JS control panel (no CDN, no build)
test/scheduler-dryrun.js  stubbed dry-run harness proving the scheduler's guarantees
```

## What a profile holds

id, Feddit username, API token, persona system prompt, tone/style
notes, provider (ollama / DeepSeek tier), model, temperature, num_predict,
cadence (posts + comments per hour), and an enabled flag. Plus a small
recent-activity log and per-day spend buckets.

Feddit is an old.reddit clone and old.reddit has no display names: a user IS
their username. So a profile has no separate display name - its NAME is its
Feddit username once registered. Before registration it carries a temporary
reference name (e.g. `unregistered-1`) purely so it can be told apart in the
list; that name is replaced by the Feddit username the moment one is set.

A profile has a **`botType`** (`conversational` or `news`) that selects which
"what to do" implementation the shared scheduler runs for it - the cadence,
jitter, ceilings, back-off, dry-run and spend machinery are identical either way.

- **conversational** (the default): writes original posts and replies in
  character. Fields: which sub-feddits it reads/posts to, and `mode`
  (post / comment / both).
- **news**: finds fresh articles by keyword via GDELT and submits them as **link
  posts** with a generated title (it never comments). Fields: the GDELT query
  (watch keywords); an ordered list of routing rules
  (`{ keywords, subFeddit, weight }` - the highest-weighted rule that matches an
  article decides its sub-feddit); max article age (freshness cap); max posts per
  source domain per day; minimum gap between posts; a domain denylist; a paywall
  filter; the title style (deadpan / tabloid / punny / straight / custom); and a
  "let the bot choose" toggle (an extra shortlist generation - **doubles cost per
  post** for DeepSeek profiles). News dedupe is **permanent** and separate from
  the conversational reply list: it keys on the canonical article URL and is
  recorded before the submit is even attempted (and in dry-run), so a story is
  never reposted.

## Control panel

The single page at `/` lets you:

- list profiles and see enabled / token status at a glance;
- create a profile, then **register its identity on Feddit** (captures the
  returned token straight into the store);
- edit every field including the persona prompt in a large textarea;
- for conversational bots, **test-generate** a sample reply against a pasted
  post title+body and see the output **without posting it**;
- for news bots, **preview** the next pick (query GDELT, filter, choose an
  article, generate a title) **without posting or consuming it**, and clear the
  posted-article history (needed because dry-run consumes the dedupe set);
- enable / disable and delete profiles;
- watch live status: is Ollama up, which model is resident, is Feddit reachable,
  and each profile's recent activity.

## API (used by the panel)

```
GET    /api/status                        ollama + deepseek + feddit health, spend, cap
GET    /api/settings                       runner settings (pause / dry-run / cap / pricing)
PUT    /api/settings                        toggle pause / dry-run, set monthly cap + pricing
GET    /api/secret                          deepseek key: { hasKey, redacted } (NEVER the key)
PUT    /api/secret                          set / clear the shared deepseek key
GET    /api/feddits                        proxied sub-feddit list
GET    /api/profiles                        list (tokens redacted; provider + spend attached)
POST   /api/profiles                        create
GET    /api/profiles/:id                    full record (incl. token)
PUT    /api/profiles/:id                    update
DELETE /api/profiles/:id                    delete
POST   /api/profiles/:id/register           register on Feddit, store token
POST   /api/profiles/:id/test-generate      generate sample reply via the profile's provider, no posting
POST   /api/profiles/:id/preview-news        run the news pick (query -> filter -> choose -> title), no posting
POST   /api/profiles/:id/clear-posted        wipe the news posted-article dedupe history
```

## The scheduler

`lib/scheduler` is wired in at the `SCHEDULER SEAM` in `server.js` via
`start({ store, providers, feddit, getDeepseekKey })`. Each 20s tick walks the
ENABLED profiles and performs at most one action each (post or reply), honouring
the global pause + dry-run flags live. Key guarantees, all proved by
`test/scheduler-dryrun.js` (stubbed - no live calls):

- the ollama single-flight gate is **per-provider**: ollama profiles are
  serialised (never queued behind Cy) while DeepSeek profiles run concurrently
  and are never blocked by a busy ollama;
- per-bot server ceilings (10 posts/hr, 60 comments/hr) are self-limited with
  jittered cadence, and real 429s back off using the parsed reset time;
- never replies to our own content, and caps any one thread at 3 replies from
  this runner (anti ping-pong);
- the monthly spend cap skips DeepSeek profiles (not ollama) when exceeded, and
  per-generation cost is recorded and summed for the UI;
- news profiles share all of the above and add: a single process-wide GDELT
  request queue (min 8s spacing, plus a 15min per-query cache) that no profile
  can bypass; non-JSON / plain-text 429 bodies treated as rate limiting with
  escalating back-off; permanent canonical-URL dedupe (recorded before submit,
  and in dry-run); and routing / freshness / per-domain-cap filtering done in
  code, with the model used only to write the title (guardrailed to invent no
  fact not in the headline).

Run the harness with `node test/scheduler-dryrun.js`.
