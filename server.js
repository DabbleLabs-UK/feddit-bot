'use strict';

// Feddit bot runner - control-panel server.
//
// Runs on the DELL machine, which mounts this share at /v/feddit-bot. Start with:
//   cd /v/feddit-bot && node server.js
//
// Binds 0.0.0.0:8770 so the config UI is reachable from anywhere on the LAN.
// Serves the static control panel (public/) plus a small JSON API it talks to.
//
// The scheduler/posting loop is NOT built yet. The seam for it is marked below
// (see "SCHEDULER SEAM"): a future ./lib/scheduler module can require store +
// ollama + feddit and be started here without touching the request handling.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('./lib/store');
const providers = require('./lib/providers');
const secrets = require('./lib/secrets');
const cost = require('./lib/cost');
const feddit = require('./lib/feddit');
const gdelt = require('./lib/gdelt');
const feeds = require('./lib/feeds');
const scheduler = require('./lib/scheduler');

const ollama = providers.ollama; // the ollama provider (status/isBusy/generate)

const PORT = 8770;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- helpers ----------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { // 1MB guard - persona prompts are text, not files
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  // Map "/" -> index.html; prevent path traversal out of public/.
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// Strip the token (and the potentially-large dedupe list) out of a profile
// before sending it to the browser list view, and attach the scheduler's view
// of the next action so the UI can show it. The edit view can still fetch the
// full record incl. token on demand.
function safeProfile(p) {
  // Strip the token and the potentially-large dedupe/tracking arrays; surface a
  // count of the news dedupe set so the UI can show it on the clear button.
  const { token, repliedTo, postedNews, newsDomainDaily, newsDomainDays, ...rest } = p;
  const now = Date.now();
  const spend = store.profileSpend(p, cost.dayKey(now), cost.monthKey(now));
  return {
    ...rest,
    hasToken: Boolean(token),
    referenceName: store.referenceName(p),
    postedNewsCount: Array.isArray(postedNews) ? postedNews.length : 0,
    nextAction: scheduler.nextAction(p),
    effProvider: scheduler.providerOf(p),
    effModel: scheduler.modelOf(p, store.DEFAULT_MODEL),
    spend,
  };
}

// ---- API routing ------------------------------------------------------------

async function handleApi(req, res, urlPath, query) {
  const method = req.method;

  // GET /api/status - health of ollama + deepseek + feddit for the status panel.
  if (method === 'GET' && urlPath === '/api/status') {
    const apiKey = secrets.getDeepseekKey();
    const [oll, ds, fed] = await Promise.all([
      ollama.status(),
      providers.deepseek.reachable(apiKey),
      feddit.reachable(),
    ]);
    const settings = store.getSettings();
    const now = Date.now();
    const runner = store.runnerSpend(cost.monthKey(now), cost.dayKey(now));
    const cap = Number(settings.monthlyCapUsd);
    const capActive = Number.isFinite(cap) && cap >= 0;
    return sendJson(res, 200, {
      ollama: oll,
      deepseek: ds,               // { up, hasKey, keyOk, error }
      feddit: fed,
      defaultModel: store.DEFAULT_MODEL,
      deepseekModels: providers.deepseek.MODELS,
      secret: secrets.publicView(), // { hasKey, redacted }
      spend: {
        monthUsd: runner.monthUsd,
        todayUsd: runner.todayUsd,
        capUsd: capActive ? cap : null,
        overCap: capActive && runner.monthUsd >= cap,
      },
      settings,
    });
  }

  // GET /api/settings - global runner settings (pause / dry-run).
  if (method === 'GET' && urlPath === '/api/settings') {
    return sendJson(res, 200, { settings: store.getSettings() });
  }

  // PUT /api/settings - toggle global pause / dry-run, set the monthly spend
  // cap and per-model pricing. All honoured live by the scheduler.
  if (method === 'PUT' && urlPath === '/api/settings') {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.paused === 'boolean') patch.paused = body.paused;
    if (typeof body.dryRun === 'boolean') patch.dryRun = body.dryRun;
    if (body.monthlyCapUsd != null && Number.isFinite(Number(body.monthlyCapUsd))) {
      patch.monthlyCapUsd = Math.max(0, Number(body.monthlyCapUsd));
    }
    if (body.pricing && typeof body.pricing === 'object') patch.pricing = body.pricing;
    return sendJson(res, 200, { settings: store.updateSettings(patch) });
  }

  // GET /api/secret - deepseek key presence + redacted preview (NEVER the key).
  if (method === 'GET' && urlPath === '/api/secret') {
    return sendJson(res, 200, secrets.publicView());
  }

  // PUT /api/secret - set or clear the ONE shared deepseek key. Never echoed back.
  if (method === 'PUT' && urlPath === '/api/secret') {
    const body = await readBody(req);
    if (typeof body.deepseekApiKey !== 'string') {
      return sendJson(res, 400, { error: 'Provide deepseekApiKey (string; empty string clears it).' });
    }
    secrets.setDeepseekKey(body.deepseekApiKey.trim());
    return sendJson(res, 200, secrets.publicView()); // redacted view only
  }

  // GET /api/feddits - proxy the sub-feddit list so the UI can offer choices.
  if (method === 'GET' && urlPath === '/api/feddits') {
    const r = await feddit.feddits();
    if (!r.ok) return sendJson(res, 502, { error: r.error || 'Feddit unreachable' });
    return sendJson(res, 200, r.data);
  }

  // GET /api/news/feeds - the shipped default RSS/Atom feed list, so the news
  // config UI can render the (optional) feed-picker. Static; no network.
  if (method === 'GET' && urlPath === '/api/news/feeds') {
    return sendJson(res, 200, { feeds: feeds.DEFAULT_FEEDS });
  }

  // GET /api/profiles - list (tokens redacted).
  if (method === 'GET' && urlPath === '/api/profiles') {
    return sendJson(res, 200, { profiles: store.listProfiles().map(safeProfile) });
  }

  // POST /api/profiles - create.
  if (method === 'POST' && urlPath === '/api/profiles') {
    const body = await readBody(req);
    const p = store.createProfile(body);
    return sendJson(res, 201, { profile: safeProfile(p) });
  }

  // Routes under /api/profiles/:id
  const m = urlPath.match(/^\/api\/profiles\/([^/]+)(\/[^/]+)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const sub = m[2]; // e.g. "/register", "/test-generate", or undefined
    const existing = store.getProfile(id);

    // GET /api/profiles/:id - full record for the edit view, but WITHOUT the raw
    // token (the client never reads it - it keys off hasToken) and with the large
    // news dedupe/tracking arrays replaced by a count. Exposes hasToken +
    // referenceName so the token panel and heading render from server truth, not
    // stale client state.
    if (method === 'GET' && !sub) {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const { token, postedNews, newsDomainDaily, newsDomainDays, ...rest } = existing;
      return sendJson(res, 200, {
        profile: {
          ...rest,
          hasToken: Boolean(token),
          referenceName: store.referenceName(existing),
          postedNewsCount: Array.isArray(postedNews) ? postedNews.length : 0,
        },
      });
    }

    // PUT /api/profiles/:id - update fields.
    if (method === 'PUT' && !sub) {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const body = await readBody(req);
      // Never let the client blank an existing token by omission; only overwrite
      // token when a non-empty token is explicitly provided.
      if (body.token === '' || body.token == null) delete body.token;
      const p = store.updateProfile(id, body);
      return sendJson(res, 200, { profile: safeProfile(p) });
    }

    // DELETE /api/profiles/:id
    if (method === 'DELETE' && !sub) {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      store.deleteProfile(id);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/profiles/:id/register - register this identity on Feddit now and
    // capture the returned token straight into the store.
    if (method === 'POST' && sub === '/register') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const username = (existing.fedditUsername || '').trim();
      if (!username) return sendJson(res, 400, { error: 'Set a Feddit username before registering.' });
      if (existing.token) return sendJson(res, 409, { error: 'This profile already has a token. Delete it first to re-register.' });

      const description = (existing.persona || '').slice(0, 500);
      const r = await feddit.register({ username, description });
      if (!r.ok) {
        return sendJson(res, r.status === 429 ? 429 : 502, { error: r.error || 'Registration failed', data: r.data });
      }
      const token = r.data && r.data.token;
      const bot = r.data && r.data.bot;
      if (!token) return sendJson(res, 502, { error: 'Feddit did not return a token', data: r.data });

      store.updateProfile(id, { token });
      store.logActivity(id, { kind: 'register', ok: true, note: 'Registered as ' + username });
      return sendJson(res, 200, { ok: true, bot, profile: safeProfile(store.getProfile(id)) });
    }

    // POST /api/profiles/:id/test-generate - generate a sample reply against a
    // pasted post title+body. Does NOT post anywhere. Routes through the
    // profile's chosen provider. Ollama respects single-flight; deepseek uses
    // the shared key and costs real money (its usage IS recorded).
    if (method === 'POST' && sub === '/test-generate') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const prov = scheduler.providerOf(existing);
      if (prov === 'ollama' && ollama.isBusy()) {
        return sendJson(res, 409, { error: 'Ollama is busy with another generation. Try again in a moment.' });
      }

      const body = await readBody(req);
      const title = (body.title || '').trim();
      const post = (body.body || '').trim();
      const task =
        'You are browsing a forum called Feddit. Write a single reply to this post. ' +
        'Reply in character, plain text, no preamble, no quotes around it.\n\n' +
        'POST TITLE: ' + title + '\n' +
        (post ? 'POST BODY: ' + post + '\n' : '') +
        '\nYour reply:';

      const model = scheduler.modelOf(existing, store.DEFAULT_MODEL);
      try {
        const out = await providers.generate({
          provider: prov,
          model,
          system: scheduler.buildSystem(existing.persona, existing.toneNotes),
          prompt: task,
          temperature: Number(existing.temperature) || 0.8,
          numPredict: Number(existing.numPredict) || 200,
          apiKey: prov === 'deepseek' ? secrets.getDeepseekKey() : undefined,
        });
        // Record spend for deepseek test-gens too (ollama => $0).
        const usd = cost.estimateCost(out.model, out.usage, store.getSettings().pricing);
        store.recordSpend(id, { dayKey: cost.dayKey(Date.now()), usage: out.usage, costUsd: usd });
        return sendJson(res, 200, {
          output: out.text, provider: out.provider, model: out.model, ms: out.ms,
          usage: out.usage, costUsd: usd,
        });
      } catch (err) {
        const code = err.code === 'BUSY' ? 409
          : (err.code === 'BAD_KEY' || err.code === 'NO_KEY') ? 400
          : (err.code === 'INSUFFICIENT_BALANCE') ? 402
          : (err.code === 'RATE_LIMITED') ? 429
          : 500;
        return sendJson(res, code, { error: err.message });
      }
    }

    // POST /api/profiles/:id/preview-news - run the news pick (query GDELT ->
    // filter -> choose -> generate a title) and return the chosen article + title
    // WITHOUT posting or consuming (recording) the article. News profiles only.
    if (method === 'POST' && sub === '/preview-news') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      if (existing.botType !== 'news') return sendJson(res, 400, { error: 'This profile is not a news bot.' });
      const prov = scheduler.providerOf(existing);
      if (prov === 'ollama' && ollama.isBusy()) {
        return sendJson(res, 409, { error: 'Ollama is busy with another generation. Try again in a moment.' });
      }
      const out = await schedulerHandle.previewNews(id);
      if (!out || !out.ok) return sendJson(res, 200, { ok: false, error: (out && out.error) || 'No article chosen' });
      return sendJson(res, 200, out);
    }

    // GET /api/profiles/:id/preview-status - live progress for an in-flight
    // preview (so the button isn't frozen while GDELT is being retried). Returns
    // { message } (message null when nothing is running).
    if (method === 'GET' && sub === '/preview-status') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const prog = schedulerHandle.getPreviewProgress(id);
      return sendJson(res, 200, { message: prog ? prog.message : null });
    }

    // GET /api/profiles/:id/feed-health - this profile's effective feeds joined
    // with each feed's live health (ok / failing + why / last good fetch), so a
    // silently dead feed is visible in the UI. Reads the shared cache; no fetch.
    if (method === 'GET' && sub === '/feed-health') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      return sendJson(res, 200, { feeds: schedulerHandle.feedHealth(id) });
    }

    // POST /api/profiles/:id/clear-posted - wipe this profile's posted-article
    // history (and per-domain counts). Needed because dry-run consumes the dedupe.
    if (method === 'POST' && sub === '/clear-posted') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      store.clearPostedNews(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'Unknown API route' });
}

// ---- server -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  let parsed;
  try { parsed = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res, 400, { error: 'Bad URL' }); }
  const urlPath = parsed.pathname;

  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath, parsed.searchParams).catch((err) => {
      sendJson(res, 500, { error: err.message });
    });
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res, urlPath);
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
});

// ---- SCHEDULER SEAM ---------------------------------------------------------
// The posting loop lives in ./lib/scheduler and is started here with the
// modules it needs. It honours the global pause + per-profile enable + dry-run
// flags live (read from the store each tick). The ollama single-flight gate is
// per-provider: ollama profiles are serialised so Cy's resident model is never
// queued behind us or evicted, while deepseek profiles (remote) run concurrently
// and independently, subject to the runner-wide monthly spend cap.
const schedulerHandle = scheduler.start({
  store,
  providers,
  feddit,
  gdelt,
  feeds,
  getDeepseekKey: () => secrets.getDeepseekKey(),
});
// -----------------------------------------------------------------------------

function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  console.log('');
  console.log('  Feddit bot control panel is up.');
  console.log('  Local:   http://127.0.0.1:' + PORT + '/');
  console.log('  LAN:     http://' + lan + ':' + PORT + '/');
  console.log('  Data:    ' + store.DATA_FILE);
  console.log('  Ollama:  ' + ollama.OLLAMA_BASE + ' (default model ' + store.DEFAULT_MODEL + ', keep_alive -1)');
  console.log('  DeepSeek:' + providers.deepseek.DEEPSEEK_BASE + ' (key ' + (secrets.getDeepseekKey() ? 'set' : 'NOT set') + ', concurrency cap ' + providers.DEEPSEEK_MAX_CONCURRENT + ')');
  console.log('  Feddit:  ' + feddit.BASE);
  const s = store.getSettings();
  console.log('');
  console.log('  Scheduler is running (tick ' + Math.round(schedulerHandle.tickMs / 1000) + 's). ' +
    'Global: ' + (s.paused ? 'PAUSED' : 'active') + ', dry-run ' + (s.dryRun ? 'ON' : 'OFF') + '.');
  console.log('  Monthly spend cap: $' + s.monthlyCapUsd + ' (deepseek profiles skip over-cap; ollama unaffected).');
  console.log('  It only acts on ENABLED profiles; dry-run logs actions without writing.');
  console.log('');
});
