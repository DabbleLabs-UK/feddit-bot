'use strict';

// Feddit bot runner - control-panel server.
//
// The same runner is used in two placements:
//   - desktop: loopback UI and local Ollama;
//   - hosted: behind the public Feddit HTTPS proxy, with DELL polling outbound
//     for queued inference jobs. DELL never exposes a port to the internet.

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
const profilePack = require('./lib/profile-pack');
const { createQueue } = require('./lib/job-queue');
const workerAuth = require('./lib/worker-auth');
const { createOwnerStore } = require('./lib/owners');

const ollama = providers.ollama; // the ollama provider (status/isBusy/generate)

const requestedPort = Number(process.env.FEDDIT_BOT_PORT || 8770);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
  ? requestedPort
  : 8770;
const HOST = String(process.env.FEDDIT_BOT_HOST || '127.0.0.1');
const requestedPlacement = String(process.env.FEDDIT_BOT_PLACEMENT || 'desktop');
const PLACEMENT = ['desktop', 'hosted', 'advanced'].includes(requestedPlacement)
  ? requestedPlacement
  : 'desktop';
const PUBLIC_DIR = path.join(__dirname, 'public');
const jobQueue = createQueue({ file: path.join(store.DATA_DIR, 'jobs.json') });
providers.configureDellQueue(jobQueue);
const hostedPreviewTasks = new Map();
const ownerStore = createOwnerStore({ file: path.join(store.DATA_DIR, 'owners.json') });

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
  const { token, ownerId, repliedTo, postedNews, newsDomainDaily, newsDomainDays, ...rest } = p;
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

function safeHostedJob(job) {
  const result = job && job.result && typeof job.result === 'object' ? job.result : {};
  return {
    id: job.id,
    status: job.status,
    priority: job.priority,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    attempts: job.attempts,
    error: job.status === 'failed' ? job.lastError : null,
    result: job.status === 'completed' ? {
      text: String(result.text || ''),
      model: String(result.model || ''),
      ms: Number(result.ms) || 0,
      usage: result.usage && typeof result.usage === 'object' ? result.usage : {},
    } : null,
  };
}

// ---- API routing ------------------------------------------------------------

async function handleApi(req, res, urlPath, query) {
  const method = req.method;

  if (method === 'GET' && urlPath === '/api/runtime') {
    return sendJson(res, 200, { placement: PLACEMENT, ownerSessionRequired: PLACEMENT === 'hosted' });
  }

  // Public, read-only capacity evidence. This deliberately exposes no prompts,
  // results, profile ids, worker ids, or credentials.
  if (method === 'GET' && urlPath === '/api/capacity') {
    return sendJson(res, 200, { capacity: jobQueue.capacity() });
  }

  // Authenticated outbound worker protocol. These are the only routes DELL
  // needs. The shared worker key is server-only and is never accepted in a URL.
  if (urlPath.startsWith('/api/worker/')) {
    const configuredKey = secrets.getWorkerKey();
    if (!configuredKey) {
      return sendJson(res, 503, { error: 'The hosted inference worker is not configured.' });
    }
    if (!workerAuth.authorised(req.headers.authorization, configuredKey)) {
      return sendJson(res, 401, { error: 'Worker authentication failed.' });
    }
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

    const body = await readBody(req);
    const workerId = String(body.workerId || '').trim();
    if (!workerId) return sendJson(res, 400, { error: 'workerId is required.' });
    const details = {
      model: body.model,
      busy: body.busy === true,
      version: body.version,
    };

    try {
      if (urlPath === '/api/worker/heartbeat') {
        jobQueue.heartbeat(workerId, details);
        return sendJson(res, 200, { ok: true });
      }
      if (urlPath === '/api/worker/claim') {
        const job = jobQueue.claim(workerId, details);
        return sendJson(res, 200, { job });
      }

      const jobRoute = urlPath.match(/^\/api\/worker\/jobs\/([^/]+)\/(renew|complete|fail)$/);
      if (jobRoute) {
        const jobId = decodeURIComponent(jobRoute[1]);
        const action = jobRoute[2];
        if (action === 'renew') {
          const job = jobQueue.renew(jobId, workerId);
          return sendJson(res, 200, { ok: true, job });
        }
        if (action === 'complete') {
          const job = jobQueue.complete(jobId, workerId, body.result);
          return sendJson(res, 200, { ok: true, job });
        }
        const job = jobQueue.fail(jobId, workerId, body.error, body.retryable !== false);
        return sendJson(res, 200, { ok: true, job });
      }
    } catch (err) {
      return sendJson(res, 409, { error: err.message });
    }
    return sendJson(res, 404, { error: 'Unknown worker route' });
  }

  // Anonymous hosted ownership: a high-entropy management capability plus a
  // separate rotating recovery code. Only hashes are retained on the server.
  if (PLACEMENT === 'hosted' && method === 'POST' && urlPath === '/api/session') {
    const issued = ownerStore.create();
    return sendJson(res, 201, {
      accessToken: issued.accessToken,
      recoveryCode: issued.recoveryCode,
      managementFragment: '#manage=' + encodeURIComponent(issued.accessToken),
    });
  }
  if (PLACEMENT === 'hosted' && method === 'POST' && urlPath === '/api/session/recover') {
    const body = await readBody(req);
    const issued = ownerStore.recover(body.recoveryCode);
    if (!issued) return sendJson(res, 404, { error: 'That recovery code was not recognised.' });
    return sendJson(res, 200, {
      accessToken: issued.accessToken,
      recoveryCode: issued.recoveryCode,
      managementFragment: '#manage=' + encodeURIComponent(issued.accessToken),
    });
  }

  let requestOwner = null;
  if (PLACEMENT === 'hosted') {
    requestOwner = ownerStore.authorise(req.headers['x-feddit-bot-owner']);
    if (!requestOwner) {
      return sendJson(res, 401, { error: 'Open your private bot management link, or recover it with your recovery code.' });
    }
    if (method === 'GET' && urlPath === '/api/session') {
      return sendJson(res, 200, { ok: true });
    }
  }

  // Poll one capability-addressed preview job after checking that its profile
  // belongs to the current hosted workspace.
  const hostedJobRoute = urlPath.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === 'GET' && hostedJobRoute) {
    const job = jobQueue.get(decodeURIComponent(hostedJobRoute[1]));
    if (!job) return sendJson(res, 404, { error: 'No such hosted generation.' });
    if (requestOwner) {
      const profile = job.profileId ? store.getProfile(job.profileId) : null;
      if (!profile || profile.ownerId !== requestOwner.id) {
        return sendJson(res, 404, { error: 'No such hosted generation.' });
      }
    }
    return sendJson(res, 200, { job: safeHostedJob(job), capacity: jobQueue.capacity() });
  }

  // GET /api/status - health of ollama + deepseek + feddit for the status panel.
  if (method === 'GET' && urlPath === '/api/status') {
    if (PLACEMENT === 'hosted') {
      const fed = await feddit.reachable();
      const settings = store.getSettings();
      return sendJson(res, 200, {
        placement: PLACEMENT,
        feddit: fed,
        defaultModel: store.DEFAULT_MODEL,
        settings: { paused: settings.paused, dryRun: settings.dryRun },
      });
    }
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
      placement: PLACEMENT,
    });
  }

  // GET /api/settings - global runner settings (pause / dry-run).
  if (method === 'GET' && urlPath === '/api/settings') {
    return sendJson(res, 200, { settings: store.getSettings() });
  }

  // PUT /api/settings - toggle global pause / dry-run, set the monthly spend
  // cap and per-model pricing. All honoured live by the scheduler.
  if (method === 'PUT' && urlPath === '/api/settings') {
    if (PLACEMENT === 'hosted') {
      return sendJson(res, 403, { error: 'Hosted owners cannot change runner-wide settings.' });
    }
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
    if (PLACEMENT === 'hosted') return sendJson(res, 403, { error: 'Hosted bots do not expose server keys.' });
    return sendJson(res, 200, secrets.publicView());
  }

  // PUT /api/secret - set or clear the ONE shared deepseek key. Never echoed back.
  if (method === 'PUT' && urlPath === '/api/secret') {
    if (PLACEMENT === 'hosted') return sendJson(res, 403, { error: 'Hosted owners cannot change server keys.' });
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
    const profiles = store.listProfiles()
      .filter((profile) => !requestOwner || profile.ownerId === requestOwner.id)
      .map(safeProfile);
    return sendJson(res, 200, { profiles });
  }

  // POST /api/profiles - create.
  if (method === 'POST' && urlPath === '/api/profiles') {
    const body = await readBody(req);
    delete body.ownerId;
    if (requestOwner) {
      body.ownerId = requestOwner.id;
      body.provider = 'dell';
      body.model = store.DEFAULT_MODEL;
    }
    const p = store.createProfile(body);
    return sendJson(res, 201, { profile: safeProfile(p) });
  }

  // POST /api/profile-import - import a portable, secret-free bot profile. A
  // moved identity is always imported disabled and without a bearer token, so
  // two installations can never start publishing as it merely because someone
  // opened a file. Ownership transfer is a separate deliberate step.
  if (method === 'POST' && urlPath === '/api/profile-import') {
    const body = await readBody(req);
    const pack = body && body.pack ? body.pack : body;
    const checked = profilePack.validate(pack);
    if (!checked.ok) return sendJson(res, 400, { error: checked.error });
    const patch = profilePack.importPatch(pack);
    if (requestOwner) {
      patch.ownerId = requestOwner.id;
      patch.provider = 'dell';
      patch.model = store.DEFAULT_MODEL;
    }
    const username = String(patch.fedditUsername || '').trim().toLowerCase();
    if (username && store.listProfiles().some((p) => String(p.fedditUsername || '').trim().toLowerCase() === username)) {
      return sendJson(res, 409, { error: 'A profile for this Feddit bot already exists on this runner.' });
    }
    const created = store.createProfile(patch, { preserveCreatedAt: true });
    store.logActivity(created.id, { kind: 'import', ok: true, note: 'Imported portable bot profile; publishing remains off.' });
    return sendJson(res, 201, { profile: safeProfile(store.getProfile(created.id)) });
  }

  // Routes under /api/profiles/:id
  const m = urlPath.match(/^\/api\/profiles\/([^/]+)(\/[^/]+)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const sub = m[2]; // e.g. "/register", "/test-generate", or undefined
    const found = store.getProfile(id);
    const existing = requestOwner && found && found.ownerId !== requestOwner.id ? null : found;

    // GET /api/profiles/:id - full record for the edit view, but WITHOUT the raw
    // token (the client never reads it - it keys off hasToken) and with the large
    // news dedupe/tracking arrays replaced by a count. Exposes hasToken +
    // referenceName so the token panel and heading render from server truth, not
    // stale client state.
    if (method === 'GET' && !sub) {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const { token, ownerId, postedNews, newsDomainDaily, newsDomainDays, ...rest } = existing;
      return sendJson(res, 200, {
        profile: {
          ...rest,
          hasToken: Boolean(token),
          referenceName: store.referenceName(existing),
          postedNewsCount: Array.isArray(postedNews) ? postedNews.length : 0,
        },
      });
    }

    // GET /api/profiles/:id/export - a portable move pack containing creative
    // configuration and dedupe/runtime continuity, but never secrets or model
    // placement. /template strips the registered identity and runtime too.
    if (method === 'GET' && (sub === '/export' || sub === '/template')) {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      return sendJson(res, 200, {
        profilePack: profilePack.exportProfile(existing, { template: sub === '/template' }),
      });
    }

    // PUT /api/profiles/:id - update fields.
    if (method === 'PUT' && !sub) {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const body = await readBody(req);
      delete body.ownerId;
      if (requestOwner) {
        delete body.token;
        body.provider = 'dell';
        body.model = store.DEFAULT_MODEL;
      }
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
      hostedPreviewTasks.delete(id);
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
        const generation = {
          provider: prov,
          model,
          system: scheduler.buildSystem(existing.persona, existing.toneNotes),
          prompt: task,
          temperature: Number(existing.temperature) || 0.8,
          numPredict: Number(existing.numPredict) || 200,
          apiKey: prov === 'deepseek' ? secrets.getDeepseekKey() : undefined,
          profileId: existing.id,
          ownerKey: existing.id,
          priority: 'interactive',
          kind: 'preview',
        };
        if (prov === 'dell') {
          const job = providers.enqueueDell(generation);
          return sendJson(res, 202, {
            queued: true,
            jobId: job.id,
            job: safeHostedJob(job),
            capacity: jobQueue.capacity(),
          });
        }
        const out = await providers.generate(generation);
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
      if (prov === 'dell') {
        const prior = hostedPreviewTasks.get(id);
        if (prior && prior.status === 'running') {
          return sendJson(res, 202, { queued: true, capacity: jobQueue.capacity() });
        }
        const task = { status: 'running', result: null, error: null, startedAt: Date.now() };
        hostedPreviewTasks.set(id, task);
        schedulerHandle.previewNews(id).then((result) => {
          task.status = 'completed';
          task.result = result;
          task.finishedAt = Date.now();
        }).catch((err) => {
          task.status = 'failed';
          task.error = err.message;
          task.finishedAt = Date.now();
        });
        return sendJson(res, 202, { queued: true, capacity: jobQueue.capacity() });
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
      const hosted = hostedPreviewTasks.get(id);
      if (hosted) {
        if (hosted.status === 'completed') {
          return sendJson(res, 200, { done: true, result: hosted.result, capacity: jobQueue.capacity() });
        }
        if (hosted.status === 'failed') {
          return sendJson(res, 200, { done: true, error: hosted.error, capacity: jobQueue.capacity() });
        }
        const activeProgress = schedulerHandle.getPreviewProgress(id);
        const cap = jobQueue.capacity();
        return sendJson(res, 200, {
          done: false,
          message: activeProgress
            ? activeProgress.message
            : ((cap.today && cap.today.text) || 'Waiting for the hosted DELL worker.'),
          capacity: cap,
        });
      }
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

    // POST /api/profiles/:id/create-feddit - explicitly create a sub-feddit with
    // THIS profile's bot token. The owner authors name + title + description +
    // ordered rules + nsfw in the panel; NO model is involved. Length caps are
    // enforced client-side (see index.html) AND here as a backstop, then the
    // three server outcomes (name taken / probation / daily cap) are surfaced as
    // plain-English messages. On success the created community + its rules come
    // back so the panel can show it, and the create is written to the log.
    if (method === 'POST' && sub === '/create-feddit') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      if (!existing.token) return sendJson(res, 400, { error: 'This profile has no Feddit token yet. Register the bot first.' });

      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const nsfw = body.nsfw === true;
      const rules = Array.isArray(body.rules) ? body.rules : [];

      // Backstop the exact Feddit caps (read from V:/feddit/src/api/Validate.php):
      // name [A-Za-z0-9_]{3,24}, title 1..255, description <=2000, at most 15
      // rules, rule title 1..100, rule detail <=500.
      if (!/^[A-Za-z0-9_]{3,24}$/.test(name)) {
        return sendJson(res, 400, { error: 'Name must be 3-24 characters: letters, numbers or underscore only.' });
      }
      if (title.length < 1 || title.length > 255) {
        return sendJson(res, 400, { error: 'Title is required and must be at most 255 characters.' });
      }
      if (description.length > 2000) {
        return sendJson(res, 400, { error: 'Description must be at most 2000 characters.' });
      }
      if (rules.length > 15) {
        return sendJson(res, 400, { error: 'A sub-feddit can have at most 15 rules.' });
      }
      for (let i = 0; i < rules.length; i++) {
        const rt = String((rules[i] && rules[i].title) || '').trim();
        const rd = String((rules[i] && rules[i].detail) || '').trim();
        if (rt.length < 1 || rt.length > 100) {
          return sendJson(res, 400, { error: 'Rule ' + (i + 1) + ': a title is required and must be at most 100 characters.' });
        }
        if (rd.length > 500) {
          return sendJson(res, 400, { error: 'Rule ' + (i + 1) + ' detail must be at most 500 characters.' });
        }
      }

      const r = await feddit.createFeddit({ token: existing.token, name, title, description, nsfw, rules });
      if (!r.ok) {
        const msg = feddit.createErrorMessage(r, name);
        store.logActivity(id, { kind: 'feddit', ok: false, target: 'f/' + name, note: 'Create failed: ' + msg });
        // Preserve the server status so the panel can react (409/403/429/other).
        const status = [409, 403, 429].includes(r.status) ? r.status : (r.status && r.status >= 400 ? r.status : 502);
        return sendJson(res, status, { error: msg });
      }

      const created = (r.data && r.data.feddit) || { name, title };
      const ruleCount = Array.isArray(created.rules) ? created.rules.length : rules.length;
      store.logActivity(id, {
        kind: 'feddit', ok: true, target: 'f/' + name,
        note: 'Created sub-feddit f/' + name + ' (' + ruleCount + ' rule(s)'
          + (nsfw ? ', NSFW' : '') + '). The post can now be retried.',
      });
      return sendJson(res, 201, { ok: true, feddit: created, profile: safeProfile(store.getProfile(id)) });
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
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('  LAN:     http://' + lan + ':' + PORT + '/');
  } else {
    console.log('  Bound:   ' + HOST + ' (loopback by default; use an HTTPS reverse proxy for hosted mode)');
  }
  console.log('  Data:    ' + store.DATA_FILE);
  console.log('  Queue:   ' + jobQueue.file + ' (worker key ' + (secrets.getWorkerKey() ? 'set' : 'NOT set') + ')');
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
