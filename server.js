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
const { cleanAllocationClass, createQueue } = require('./lib/job-queue');
const { createTurnStore } = require('./lib/turn-store');
const hostedPolicy = require('./lib/hosted-policy');
const workerAuth = require('./lib/worker-auth');
const { createOwnerStore } = require('./lib/owners');
const modelCatalog = require('./lib/model-catalog');
const { createModelInstaller } = require('./lib/model-installer');

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
const jobQueue = createQueue({
  file: path.join(store.DATA_DIR, 'jobs.json'),
  maxActivePerProfile: PLACEMENT === 'hosted' ? hostedPolicy.MAX_ACTIVE_JOBS_PER_BOT : 0,
});
const turnStore = createTurnStore({ file: path.join(store.DATA_DIR, 'turns.json') });
providers.configureDellQueue(jobQueue);
const hostedPreviewTasks = new Map();
const hostedSimulationTasks = new Map();
const ownerStore = createOwnerStore({ file: path.join(store.DATA_DIR, 'owners.json') });
const OWNER_ACTIVITY_COOKIE = 'feddit_owner_activity';
const modelInstaller = createModelInstaller({
  pullModel: ollama.pullModel,
});

function activeDefaultModel() {
  const settings = store.getSettings();
  return String(settings.localDefaultModel || store.DEFAULT_MODEL);
}

function applyHostedProfilePolicy(patch, current = {}, at = Date.now()) {
  const ownerId = patch.ownerId || current.ownerId;
  const context = { ownerLastActiveAt: ownerId ? ownerStore.lastActiveAt(ownerId) : null };
  Object.assign(patch, hostedPolicy.applyHostedPolicy(patch, current, at, context));
  patch.provider = 'dell';
  patch.model = store.DEFAULT_MODEL;
  return patch;
}

async function unavailableLocalModel(profile) {
  const provider = String(profile?.provider || 'ollama');
  if (PLACEMENT === 'hosted' || !profile || profile.enabled !== true || provider !== 'ollama') return '';
  const model = String(profile.model || activeDefaultModel()).trim();
  const status = await ollama.status();
  // A temporarily stopped local service is handled by the existing runner
  // startup/recovery path. Only reject a model that a reachable Ollama instance
  // definitively says is absent.
  if (!status.up || (status.models || []).includes(model)) return '';
  return 'This bot prefers the local model "' + model + '", but it is not installed on this computer. Pause the bot, then download it from the bot model selector or choose an installed model.';
}

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

function cookieValue(req, name) {
  const source = String(req.headers.cookie || '');
  for (const part of source.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
  }
  return '';
}

function setOwnerActivityCookie(req, res, value) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host !== 'feddit-bots.dabblelabs.uk') return;
  res.setHeader('Set-Cookie', OWNER_ACTIVITY_COOKIE + '=' + encodeURIComponent(value) +
    '; Domain=.dabblelabs.uk; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax');
}

function ownerPolicyContext(profile) {
  return {
    ownerLastActiveAt: profile && profile.ownerId
      ? ownerStore.lastActiveAt(profile.ownerId)
      : null,
  };
}

function recordHostedOwnerActivity(req, res, owner, allowIssue) {
  if (!owner) return false;
  const existingToken = cookieValue(req, OWNER_ACTIVITY_COOKIE);
  const activityOwner = ownerStore.authoriseActivity(existingToken);
  let changed = false;
  if (activityOwner && activityOwner.id === owner.id) {
    changed = ownerStore.touchActivity(owner.id);
  } else if (allowIssue) {
    const issued = ownerStore.issueActivity(owner.id);
    if (issued) {
      setOwnerActivityCookie(req, res, issued.activityToken);
      changed = true;
    }
  }
  if (changed) reconcileHostedProfiles();
  return changed;
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
  const {
    token, ownerId, repliedTo, postedNews, newsDomainDaily, newsDomainDays,
    attentionState, socialState, memoryState, simulationState, ...rest
  } = p;
  const now = Date.now();
  const spend = store.profileSpend(p, cost.dayKey(now), cost.monthKey(now));
  const simulation = scheduler.isDryRun(p, store.getSettings());
  return {
    ...rest,
    sched: simulation && simulationState && simulationState.sched ? simulationState.sched : rest.sched,
    hasToken: Boolean(token),
    handoverPending: Boolean(secrets.getFedditHandover(p.id)),
    referenceName: store.referenceName(p),
    fedditHistoryUrl: p.fedditUsername ? feddit.botConversationsUrl(p.fedditUsername) : '',
    postedNewsCount: Array.isArray(postedNews) ? postedNews.length : 0,
    simulationHandledCount: simulationState && Array.isArray(simulationState.repliedTo)
      ? simulationState.repliedTo.length : 0,
    simulationArticleCount: simulationState && Array.isArray(simulationState.postedNews)
      ? simulationState.postedNews.length : 0,
    relationshipCount: socialState && socialState.relationships
      ? Object.keys(socialState.relationships).length : 0,
    simulationRelationshipCount: simulationState && simulationState.socialState && simulationState.socialState.relationships
      ? Object.keys(simulationState.socialState.relationships).length : 0,
    memoryEpisodeCount: memoryState && Array.isArray(memoryState.episodes) ? memoryState.episodes.length : 0,
    simulationMemoryEpisodeCount: simulationState && simulationState.memoryState && Array.isArray(simulationState.memoryState.episodes)
      ? simulationState.memoryState.episodes.length : 0,
    nextAction: scheduler.nextAction(p, simulation),
    effProvider: scheduler.providerOf(p),
    effModel: scheduler.modelOf(p, store.DEFAULT_MODEL),
    hostedWork: PLACEMENT === 'hosted' ? hostedWorkForProfile(p) : null,
    hostedAllocation: PLACEMENT === 'hosted' ? hostedPolicy.allocationFor(p, now, ownerPolicyContext(p)) : null,
    spend,
  };
}

function normalizeFedditBio(value) {
  if (typeof value !== 'string') {
    const error = new Error('The public Feddit biography must be text.');
    error.code = 'INVALID_BIO';
    throw error;
  }
  const bio = value.replace(/\r\n?/g, '\n').trim();
  if ([...bio].length > 500) {
    const error = new Error('The public Feddit biography must be at most 500 characters.');
    error.code = 'INVALID_BIO';
    throw error;
  }
  return bio;
}

function workspaceProfiles(requestOwner) {
  return store.listProfiles().filter((profile) => !requestOwner || profile.ownerId === requestOwner.id);
}

function communityManagerProfiles(requestOwner) {
  const probationRank = (profile) => {
    if (profile.probation && profile.probation.onProbation === false) return 0;
    if (!profile.probation || profile.probation.onProbation == null) return 1;
    return 2;
  };
  return workspaceProfiles(requestOwner)
    .filter((profile) => Boolean(profile.token) && !secrets.getFedditHandover(profile.id))
    .sort((a, b) => {
      const byProbation = probationRank(a) - probationRank(b);
      if (byProbation) return byProbation;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id));
    });
}

function communityManagerMap(requestOwner) {
  const managers = new Map();
  for (const profile of communityManagerProfiles(requestOwner)) {
    const username = String(profile.fedditUsername || '').trim().toLowerCase();
    if (username && !managers.has(username)) managers.set(username, profile);
  }
  return managers;
}

function communityListFromResponse(response) {
  return response && response.data && Array.isArray(response.data.feddits)
    ? response.data.feddits
    : [];
}

function communityForClient(community) {
  const value = { ...(community || {}) };
  const suppliedUrl = String(value.url || '');
  value.url = /^https?:\/\//i.test(suppliedUrl)
    ? suppliedUrl
    : suppliedUrl
      ? feddit.SITE_BASE + (suppliedUrl.startsWith('/') ? suppliedUrl : '/' + suppliedUrl)
      : feddit.SITE_BASE + '/f/' + encodeURIComponent(value.name || '');
  value.can_manage = true;
  return value;
}

function normalizeCommunityRequest(body, creating = false) {
  const input = body && typeof body === 'object' ? body : {};
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  const sidebarText = String(input.sidebarText ?? input.sidebar_text ?? '').trim();
  const postFormat = String(input.postFormat ?? input.post_format ?? 'any').toLowerCase();
  const nsfw = input.nsfw === true || input.over_18 === true;
  const rules = Array.isArray(input.rules) ? input.rules : [];

  if (creating && !/^[A-Za-z0-9_]{3,24}$/.test(name)) {
    throw new Error('Name must be 3-24 characters: letters, numbers or underscore only.');
  }
  if ([...description].length > 2000) throw new Error('Description must be at most 2000 characters.');
  if ([...sidebarText].length > 10000) throw new Error('Sidebar notes must be at most 10000 characters.');
  if (!['any', 'text', 'link'].includes(postFormat)) throw new Error('Post format must be text, link or either.');
  if (rules.length > 15) throw new Error('A community can have at most 15 rules.');
  for (let i = 0; i < rules.length; i++) {
    const title = String((rules[i] && rules[i].title) || '').trim();
    const detail = String((rules[i] && rules[i].detail) || '').trim();
    if (!title || [...title].length > 100) {
      throw new Error('Rule ' + (i + 1) + ' needs a title of at most 100 characters.');
    }
    if ([...detail].length > 500) throw new Error('Rule ' + (i + 1) + ' detail must be at most 500 characters.');
  }
  return { name, description, sidebarText, postFormat, nsfw, rules };
}

async function currentFedditBiography(profile) {
  const stored = typeof profile.fedditBio === 'string' ? profile.fedditBio : '';
  if (!profile.token || !String(profile.fedditUsername || '').trim()) {
    return { bio: stored, status: 'draft', error: null };
  }
  const info = await feddit.botInfo(profile.fedditUsername, { timeoutMs: 5000 });
  const bot = info && info.data && info.data.bot;
  if (info && info.ok && bot && (Object.prototype.hasOwnProperty.call(bot, 'bio') ||
      Object.prototype.hasOwnProperty.call(bot, 'description'))) {
    const remote = normalizeFedditBio(String(bot.bio ?? bot.description ?? ''));
    if (profile.fedditBio !== remote) store.updateProfile(profile.id, { fedditBio: remote });
    return { bio: remote, status: 'loaded', error: null };
  }
  return {
    bio: stored,
    status: 'unavailable',
    error: (info && info.error) || 'Feddit did not return this bot\'s biography.',
  };
}

function safeHostedJob(job) {
  const result = job && job.result && typeof job.result === 'object' ? job.result : {};
  const allocationClass = cleanAllocationClass(job.allocationClass, job.priority);
  return {
    id: job.id,
    status: job.status,
    priority: job.priority,
    serviceClass: allocationClass === 'interactive'
      ? 'interactive'
      : (allocationClass === 'synthetic'
        ? 'system spare capacity'
        : (job.onboarding ? 'new bot onboarding' : 'user-created bot')),
    kind: job.kind,
    activityAction: job.activityAction,
    activityTrigger: job.activityTrigger,
    activityTarget: job.activityTarget,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    waitingPosition: job.waitingPosition,
    waitingTotal: job.waitingTotal,
    runningTotal: job.runningTotal,
    waitingMs: job.waitingMs,
    runningMs: job.runningMs,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    retrying: job.status === 'queued' && Number(job.attempts || 0) > 0,
    error: job.status === 'failed' || Number(job.attempts || 0) > 0 ? job.lastError : null,
    result: job.status === 'completed' ? {
      text: String(result.text || ''),
      model: String(result.model || ''),
      ms: Number(result.ms) || 0,
      usage: result.usage && typeof result.usage === 'object' ? result.usage : {},
    } : null,
  };
}

function hostedWorkForProfile(profile) {
  if (!profile || PLACEMENT !== 'hosted') return null;
  const activeTurn = schedulerHandle.activeTurnForProfile(profile.id);
  const activeJob = jobQueue.activeForProfile(profile.id);
  if (activeJob) {
    return {
      ...safeHostedJob(activeJob),
      botName: store.referenceName(profile),
      turnId: activeTurn && activeTurn.id,
      turnStatus: activeTurn && activeTurn.status,
      turnStage: activeTurn && activeTurn.stage,
    };
  }

  if (activeTurn) {
    return {
      id: activeTurn.id,
      turnId: activeTurn.id,
      status: activeTurn.status,
      turnStatus: activeTurn.status,
      turnStage: activeTurn.stage,
      botName: store.referenceName(profile),
      activityAction: activeTurn.stage === 'publishing'
        ? 'publishing its completed output to Feddit'
        : 'finishing its durable hosted turn',
      activityTrigger: activeTurn.trigger || 'scheduled activity',
      createdAt: activeTurn.createdAt,
      startedAt: activeTurn.updatedAt,
    };
  }

  const simulationTask = hostedSimulationTasks.get(profile.id);
  if (simulationTask && simulationTask.status === 'running') {
    return {
      status: 'preparing',
      botName: store.referenceName(profile),
      activityAction: simulationTask.action === 'comment'
        ? 'reading Feddit and choosing a reply target'
        : 'choosing what kind of post to make',
      activityTrigger: 'pressed-now simulation',
      createdAt: simulationTask.startedAt,
    };
  }

  const previewTask = hostedPreviewTasks.get(profile.id);
  if (previewTask && previewTask.status === 'running') {
    return {
      status: 'preparing',
      botName: store.referenceName(profile),
      activityAction: 'finding an article before asking hosted compute to write its title',
      activityTrigger: 'manual article preview',
      createdAt: previewTask.startedAt,
    };
  }

  if (schedulerHandle.isProfileBusy(profile.id)) {
    return {
      status: 'preparing',
      botName: store.referenceName(profile),
      activityAction: 'reading sources and preparing its next turn',
      activityTrigger: 'scheduled activity',
      createdAt: Date.now(),
    };
  }
  return null;
}

function hostedWorkMessage(work) {
  if (!work) return 'No hosted work is waiting or running for this bot.';
  if (work.status === 'claimed') return 'Hosted compute is now ' + (work.activityAction || 'generating this bot\'s output') + '.';
  if (work.status === 'queued') {
    const place = Number(work.waitingPosition) || 1;
    const total = Number(work.waitingTotal) || 1;
    const retry = work.retrying ? ' A previous attempt failed and the job is waiting for a safe retry.' : '';
    return 'Waiting for hosted compute: this bot is ' + place + ' of ' + total + ' in the waiting queue.' + retry;
  }
  if (work.status === 'generating') return 'Hosted compute is generating this bot\'s output.';
  if (work.status === 'result-received') return 'Hosted generation finished; the runner is applying the result to this bot\'s turn.';
  if (work.status === 'finalising') return 'The generated output is ready and the runner is finalising the Feddit action.';
  return 'Preparing the turn before it enters the hosted generation queue.';
}

function safeLocalGenerationActivity() {
  const snapshot = ollama.generationActivity();
  const enrich = (item) => {
    if (!item) return null;
    const profile = item.profileId ? store.getProfile(item.profileId) : null;
    return {
      ...item,
      botName: item.botName || (profile ? store.referenceName(profile) : '') || 'unknown bot',
    };
  };
  return {
    active: enrich(snapshot.active),
    recent: (snapshot.recent || []).map(enrich),
  };
}

// ---- API routing ------------------------------------------------------------

async function handleApi(req, res, urlPath, query) {
  const method = req.method;

  if (method === 'GET' && urlPath === '/api/runtime') {
    return sendJson(res, 200, {
      placement: PLACEMENT,
      appVersion: String(process.env.FEDDIT_APP_VERSION || 'development'),
      ownerSessionRequired: PLACEMENT === 'hosted',
      hostedPolicy: PLACEMENT === 'hosted' ? hostedPolicy.runtimePolicy() : null,
    });
  }

  // Lightweight, prompt-free operational visibility for the desktop UI. This
  // is deliberately separate from /api/status so it can be polled frequently
  // without repeatedly probing Ollama, DeepSeek and Feddit.
  if (method === 'GET' && urlPath === '/api/local-model-activity') {
    if (PLACEMENT === 'hosted') return sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 200, safeLocalGenerationActivity());
  }

  if (method === 'GET' && urlPath === '/api/runtime-state') {
    return sendJson(res, 200, {
      busy: schedulerHandle.isBusy() || providers.ollamaBusy() || providers.deepseekInFlight() > 0,
    });
  }

  if (method === 'POST' && urlPath === '/api/desktop/shutdown') {
    const controlKey = String(process.env.FEDDIT_DESKTOP_CONTROL_KEY || '');
    if (PLACEMENT !== 'desktop' || !controlKey || !workerAuth.authorised(req.headers.authorization, controlKey)) {
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (schedulerHandle.isBusy() || providers.ollamaBusy() || providers.deepseekInFlight() > 0) {
      return sendJson(res, 409, { error: 'The runner is currently generating or completing a bot action.' });
    }
    schedulerHandle.stop();
    sendJson(res, 202, { ok: true });
    setImmediate(() => server.close());
    return;
  }

  // Public, read-only capacity evidence. This deliberately exposes no prompts,
  // results, profile ids, worker ids, or credentials.
  if (method === 'GET' && urlPath === '/api/capacity') {
    return sendJson(res, 200, { capacity: jobQueue.capacity() });
  }

  // Local model setup is intentionally a guided choice, not an Ollama
  // administration screen. Hosted owners never see or control worker models.
  if (urlPath.startsWith('/api/models')) {
    if (PLACEMENT === 'hosted') return sendJson(res, 404, { error: 'Not found' });
    if (method === 'GET' && urlPath === '/api/models') {
      const status = await ollama.status();
      const hardware = modelCatalog.adviseHardware({
        totalMemoryBytes: os.totalmem(),
        cpuCount: os.cpus().length,
        platform: os.platform(),
        arch: os.arch(),
      });
      return sendJson(res, 200, {
        hardware,
        installed: status.models || [],
        installedDetails: status.modelDetails || [],
        ollama: { up: status.up, error: status.error },
        selectedModel: activeDefaultModel(),
        downloads: modelInstaller.list(),
      });
    }
    if (method === 'POST' && urlPath === '/api/models/pull') {
      const body = await readBody(req);
      try {
        const download = modelInstaller.start(body.model);
        return sendJson(res, 202, { download });
      } catch (error) {
        return sendJson(res, 409, { error: error.message });
      }
    }
    if (method === 'PUT' && urlPath === '/api/models/default') {
      const body = await readBody(req);
      const model = String(body.model || '').trim();
      const status = await ollama.status();
      if (!(status.models || []).includes(model)) {
        return sendJson(res, 409, { error: 'Download this model before selecting it.' });
      }
      const settings = store.updateSettings({ localDefaultModel: model });
      return sendJson(res, 200, { selectedModel: settings.localDefaultModel });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
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
          schedulerHandle.reconcileDurableTurns();
          return sendJson(res, 200, { ok: true, job });
        }
        const job = jobQueue.fail(jobId, workerId, body.error, body.retryable !== false);
        schedulerHandle.reconcileDurableTurns();
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

  // A deliberately capability-limited, cross-subdomain activity marker lets
  // Feddit page visits extend the owner's higher exploratory cadence. It can do
  // nothing except refresh a timestamp and reveals no page or bot information.
  if (PLACEMENT === 'hosted' && method === 'GET' && urlPath === '/api/activity.gif') {
    const activityOwner = ownerStore.authoriseActivity(cookieValue(req, OWNER_ACTIVITY_COOKIE));
    if (activityOwner) recordHostedOwnerActivity(req, res, activityOwner, false);
    res.writeHead(204, { 'Cache-Control': 'no-store, max-age=0' });
    return res.end();
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
    if (method === 'POST' && urlPath === '/api/activity') {
      recordHostedOwnerActivity(req, res, requestOwner, true);
      return sendJson(res, 200, {
        ok: true,
        lastActiveAt: ownerStore.lastActiveAt(requestOwner.id),
        dormantAfterHours: hostedPolicy.OWNER_ACTIVITY_BOOST_MS / (60 * 60 * 1000),
      });
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
        defaultModel: modelCatalog.DELL_SHARED_MODEL,
        settings: { paused: settings.paused },
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
      defaultModel: activeDefaultModel(),
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

  // GET /api/settings - global runner settings (pause / spend controls).
  if (method === 'GET' && urlPath === '/api/settings') {
    return sendJson(res, 200, { settings: store.getSettings() });
  }

  // PUT /api/settings - toggle global pause, set the monthly spend cap and
  // per-model pricing. A legacy dryRun field is still accepted for old clients,
  // but current profiles own their rehearsal/live mode.
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

  // Community administration lives once per private workspace, rather than in
  // every bot editor. Feddit currently represents authority through the bearer
  // token of the identity that originally created a community. The runner hides
  // that compatibility detail: it finds the matching credential among this
  // workspace's registered profiles, while Feddit still performs the decisive
  // creator check on every update.
  if (urlPath === '/api/communities' && method === 'GET') {
    const r = await feddit.feddits();
    if (!r.ok) return sendJson(res, 502, { error: r.error || 'Feddit unreachable' });
    const managers = communityManagerMap(requestOwner);
    const communities = communityListFromResponse(r)
      .filter((community) => managers.has(String(community.created_by || '').trim().toLowerCase()))
      .map(communityForClient);
    return sendJson(res, 200, {
      communities,
      canCreate: communityManagerProfiles(requestOwner).length > 0,
    });
  }

  if (urlPath === '/api/communities' && method === 'POST') {
    const managers = communityManagerProfiles(requestOwner);
    if (!managers.length) {
      return sendJson(res, 409, {
        error: 'Register at least one bot identity in this workspace before creating a community. Feddit uses that credential to enforce ownership behind the scenes.',
      });
    }
    let input;
    try {
      input = normalizeCommunityRequest(await readBody(req), true);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    const manager = managers[0];
    const r = await feddit.createFeddit({ token: manager.token, ...input });
    if (!r.ok) {
      let message = feddit.createErrorMessage(r, input.name);
      message = message.replace(/^This bot is still on probation,/, 'Feddit is still applying new-identity probation in this workspace,');
      const status = [400, 403, 409, 429].includes(r.status) ? r.status : 502;
      return sendJson(res, status, { error: message });
    }
    const created = (r.data && r.data.feddit) || { name: input.name, title: input.name };
    store.logActivity(manager.id, {
      kind: 'feddit', ok: true, target: 'f/' + input.name,
      note: 'Created community f/' + input.name + ' from the workspace community manager.',
    });
    return sendJson(res, 201, { ok: true, community: communityForClient(created) });
  }

  const communityRoute = urlPath.match(/^\/api\/communities\/([^/]+)$/);
  if (communityRoute && (method === 'GET' || method === 'PUT')) {
    const name = decodeURIComponent(communityRoute[1]);
    const list = await feddit.feddits();
    if (!list.ok) return sendJson(res, 502, { error: list.error || 'Feddit unreachable' });
    const listed = communityListFromResponse(list).find((community) =>
      String(community.name || '').toLowerCase() === name.toLowerCase());
    if (!listed) return sendJson(res, 404, { error: 'No such community.' });
    const manager = communityManagerMap(requestOwner).get(String(listed.created_by || '').trim().toLowerCase());
    if (!manager) {
      return sendJson(res, 403, { error: 'This community is not managed by this private workspace.' });
    }

    if (method === 'GET') {
      const detail = await feddit.about(listed.name);
      if (!detail.ok) return sendJson(res, 502, { error: detail.error || 'Feddit could not load this community.' });
      const community = detail.data && detail.data.feddit;
      if (!community || String(community.created_by || '').trim().toLowerCase() !== String(manager.fedditUsername || '').trim().toLowerCase()) {
        return sendJson(res, 403, { error: 'This community is not managed by this private workspace.' });
      }
      return sendJson(res, 200, { community: communityForClient(community) });
    }

    let input;
    try {
      input = normalizeCommunityRequest(await readBody(req), false);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    const updated = await feddit.updateFeddit({ ...input, token: manager.token, name: listed.name });
    if (!updated.ok) {
      const status = [400, 401, 403, 404, 409, 429].includes(updated.status) ? updated.status : 502;
      return sendJson(res, status, { error: updated.error || 'Feddit could not update this community.' });
    }
    const community = updated.data && updated.data.feddit;
    return sendJson(res, 200, { ok: true, community: communityForClient(community || listed) });
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
    if (Object.prototype.hasOwnProperty.call(body, 'fedditBio')) {
      try {
        body.fedditBio = normalizeFedditBio(body.fedditBio);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }
    delete body.ownerId;
    delete body.botOrigin;
    delete body.hostedOnboardingTurnsCompleted;
    delete body.hostedActivatedAt;
    if (requestOwner) {
      body.ownerId = requestOwner.id;
      applyHostedProfilePolicy(body);
    } else if (!body.model) {
      body.model = activeDefaultModel();
    }
    const modelError = await unavailableLocalModel(body);
    if (modelError) return sendJson(res, 409, { error: modelError, code: 'LOCAL_MODEL_MISSING' });
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
      applyHostedProfilePolicy(patch);
    } else if (!patch.model) {
      patch.model = activeDefaultModel();
    }
    const username = String(patch.fedditUsername || '').trim().toLowerCase();
    if (username && store.listProfiles().some((p) => String(p.fedditUsername || '').trim().toLowerCase() === username)) {
      return sendJson(res, 409, { error: 'A profile for this Feddit bot already exists on this runner.' });
    }
    const created = store.createProfile(patch, { preserveCreatedAt: true });
    store.logActivity(created.id, { kind: 'import', ok: true, note: 'Imported portable bot profile; publishing remains off.' });
    return sendJson(res, 201, { profile: safeProfile(store.getProfile(created.id)) });
  }

  // POST /api/handover-import - import the private, one-time form of a bot pack.
  // Unlike an ordinary profile copy this carries the rotated bearer token. The
  // destination is still paused: importing a file is never permission to post.
  if (method === 'POST' && urlPath === '/api/handover-import') {
    const body = await readBody(req);
    const pack = body && body.pack ? body.pack : body;
    const checked = profilePack.validateHandover(pack);
    if (!checked.ok) return sendJson(res, 400, { error: checked.error });
    const patch = profilePack.importHandoverPatch(pack);
    if (requestOwner) {
      patch.ownerId = requestOwner.id;
      applyHostedProfilePolicy(patch);
    } else if (!patch.model) {
      patch.model = activeDefaultModel();
    }
    const username = String(patch.fedditUsername || '').trim().toLowerCase();
    if (store.listProfiles().some((p) => String(p.fedditUsername || '').trim().toLowerCase() === username)) {
      return sendJson(res, 409, { error: 'A profile for this Feddit bot already exists on this runner.' });
    }
    const created = store.createProfile(patch, { preserveCreatedAt: true });
    store.logActivity(created.id, { kind: 'handover-in', ok: true, note: 'Imported bot identity; publishing remains off until deliberately started.' });
    return sendJson(res, 201, {
      profile: safeProfile(store.getProfile(created.id)),
      warning: 'Delete the private handover file now, then finish the handover on the source runner.',
    });
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
      const biography = await currentFedditBiography(existing);
      const {
        token, ownerId, postedNews, newsDomainDaily, newsDomainDays,
        socialState, memoryState, simulationState, ...rest
      } = existing;
      const simulation = scheduler.isDryRun(existing, store.getSettings());
      return sendJson(res, 200, {
        profile: {
          ...rest,
          fedditBio: biography.bio,
          fedditBioStatus: biography.status,
          fedditBioError: biography.error,
          sched: simulation && simulationState && simulationState.sched ? simulationState.sched : rest.sched,
          hasToken: Boolean(token),
          handoverPending: Boolean(secrets.getFedditHandover(existing.id)),
          referenceName: store.referenceName(existing),
          fedditHistoryUrl: existing.fedditUsername ? feddit.botConversationsUrl(existing.fedditUsername) : '',
          postedNewsCount: Array.isArray(postedNews) ? postedNews.length : 0,
          simulationHandledCount: simulationState && Array.isArray(simulationState.repliedTo)
            ? simulationState.repliedTo.length : 0,
          simulationArticleCount: simulationState && Array.isArray(simulationState.postedNews)
            ? simulationState.postedNews.length : 0,
          relationshipCount: socialState && socialState.relationships
            ? Object.keys(socialState.relationships).length : 0,
          simulationRelationshipCount: simulationState && simulationState.socialState && simulationState.socialState.relationships
            ? Object.keys(simulationState.socialState.relationships).length : 0,
          memoryEpisodeCount: memoryState && Array.isArray(memoryState.episodes) ? memoryState.episodes.length : 0,
          simulationMemoryEpisodeCount: simulationState && simulationState.memoryState && Array.isArray(simulationState.memoryState.episodes)
            ? simulationState.memoryState.episodes.length : 0,
          hostedAllocation: PLACEMENT === 'hosted'
            ? hostedPolicy.allocationFor(existing, Date.now(), ownerPolicyContext(existing))
            : null,
        },
      });
    }

    // PUT /api/profiles/:id/biography - edit the public Feddit biography without
    // conflating it with the private persona or any behavioural setting. Drafts
    // keep it locally for registration; registered identities update Feddit
    // first so a failed remote write cannot leave the runner claiming success.
    if (method === 'PUT' && sub === '/biography') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const body = await readBody(req);
      let bio;
      try {
        bio = normalizeFedditBio(body.bio);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      if (existing.token) {
        const updated = await feddit.updateMe(existing.token, { bio });
        if (!updated.ok) {
          const status = updated.status === 400 || updated.status === 401 || updated.status === 403 || updated.status === 429
            ? updated.status : 502;
          return sendJson(res, status, {
            error: updated.error || 'Feddit could not update this biography. The previous biography was kept.',
          });
        }
        const remoteBot = updated.data && updated.data.bot;
        if (remoteBot && (Object.prototype.hasOwnProperty.call(remoteBot, 'bio') ||
            Object.prototype.hasOwnProperty.call(remoteBot, 'description'))) {
          bio = normalizeFedditBio(String(remoteBot.bio ?? remoteBot.description ?? ''));
        }
      }
      const profile = store.updateProfile(id, { fedditBio: bio });
      return sendJson(res, 200, {
        ok: true,
        profile: { ...safeProfile(profile), fedditBio: bio, fedditBioStatus: existing.token ? 'saved' : 'draft', fedditBioError: null },
      });
    }

    // GET /api/profiles/:id/work-status - current hosted work for this bot.
    // This deliberately reports operational facts (preparing, queue place,
    // claimed by DELL and elapsed time) separately from long-term reliability.
    if (method === 'GET' && sub === '/work-status') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const capacity = jobQueue.capacity();
      const work = hostedWorkForProfile(existing);
      return sendJson(res, 200, {
        work,
        message: hostedWorkMessage(work),
        capacity,
      });
    }

    // GET /api/profiles/:id/export - a portable move pack containing creative
    // configuration, a non-secret local-model preference and dedupe/runtime
    // continuity, but never secrets or execution placement. /template strips
    // the registered identity and runtime too.
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
      // Public biography writes deliberately use /biography so an ordinary
      // behaviour/settings save can never overwrite the live Feddit profile.
      delete body.fedditBio;
      delete body.fedditBioStatus;
      delete body.fedditBioError;
      delete body.ownerId;
      delete body.botOrigin;
      delete body.hostedOnboardingTurnsCompleted;
      delete body.hostedActivatedAt;
      delete body.memoryState;
      if (existing.token && Object.prototype.hasOwnProperty.call(body, 'fedditUsername')) {
        const currentUsername = String(existing.fedditUsername || '').trim().toLowerCase();
        const requestedUsername = String(body.fedditUsername || '').trim().toLowerCase();
        if (requestedUsername !== currentUsername) {
          return sendJson(res, 409, {
            error: 'A registered Feddit username is permanent. Create a different bot identity instead.',
          });
        }
        body.fedditUsername = existing.fedditUsername;
      }
      if (requestOwner) {
        delete body.token;
        applyHostedProfilePolicy(body, existing);
      }
      const pendingHandover = secrets.getFedditHandover(id);
      if (pendingHandover && (body.enabled === true || Object.prototype.hasOwnProperty.call(body, 'token'))) {
        return sendJson(res, 409, { error: 'Finish or resume this bot handover before changing the source credential or starting this copy.' });
      }
      // Never let the client blank an existing token by omission; only overwrite
      // token when a non-empty token is explicitly provided.
      if (body.token === '' || body.token == null) delete body.token;
      const modelError = await unavailableLocalModel({ ...existing, ...body });
      if (modelError) return sendJson(res, 409, { error: modelError, code: 'LOCAL_MODEL_MISSING' });
      const p = store.updateProfile(id, body);
      return sendJson(res, 200, { profile: safeProfile(p) });
    }

    // DELETE /api/profiles/:id
    if (method === 'DELETE' && !sub) {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      store.deleteProfile(id);
      hostedPreviewTasks.delete(id);
      hostedSimulationTasks.delete(id);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/profiles/:id/register - register this identity on Feddit now and
    // capture the returned token straight into the store.
    if (method === 'POST' && sub === '/register') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const username = (existing.fedditUsername || '').trim();
      if (!username) return sendJson(res, 400, { error: 'Set a Feddit username before registering.' });
      if (secrets.getFedditHandover(id)) return sendJson(res, 409, { error: 'This bot has a handover in progress.' });
      if (existing.token) return sendJson(res, 409, { error: 'This profile already has a token. Delete it first to re-register.' });

      const description = normalizeFedditBio(typeof existing.fedditBio === 'string' ? existing.fedditBio : '');
      const r = await feddit.register({ username, description });
      if (!r.ok) {
        return sendJson(res, r.status === 429 ? 429 : 502, { error: r.error || 'Registration failed', data: r.data });
      }
      const token = r.data && r.data.token;
      const bot = r.data && r.data.bot;
      if (!token) return sendJson(res, 502, { error: 'Feddit did not return a token', data: r.data });

      const registeredBio = bot && (Object.prototype.hasOwnProperty.call(bot, 'description') ||
          Object.prototype.hasOwnProperty.call(bot, 'bio'))
        ? normalizeFedditBio(String(bot.bio ?? bot.description ?? ''))
        : description;
      store.updateProfile(id, { token, fedditBio: registeredBio });
      store.logActivity(id, { kind: 'register', ok: true, note: 'Registered as ' + username });
      return sendJson(res, 200, { ok: true, bot, profile: safeProfile(store.getProfile(id)) });
    }

    // POST /api/profiles/:id/handover - pause this source, pre-stage a
    // replacement credential, rotate Feddit to it, then return a resumable
    // private handover file. If a response is lost, retrying proves whether the
    // staged token took effect, so the identity is never stranded between hosts.
    if (method === 'POST' && sub === '/handover') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const username = String(existing.fedditUsername || '').trim();
      if (!username) return sendJson(res, 409, { error: 'Register this bot on Feddit before moving its identity.' });

      let source = existing;
      if (source.enabled) source = store.updateProfile(id, { enabled: false });
      if (schedulerHandle.isBusy() || providers.ollamaBusy() || providers.deepseekInFlight() > 0) {
        return sendJson(res, 409, {
          error: 'This source is paused, but the runner is still finishing work already in flight. Try Move bot identity again in a moment.',
          retrySafe: true,
        });
      }
      let pending = secrets.getFedditHandover(id);
      if (!pending) {
        if (!source.token) return sendJson(res, 409, { error: 'This profile has no Feddit token to hand over.' });
        pending = secrets.stageFedditHandover(id, feddit.createReplacementToken());
      }

      if (pending.status !== 'ready') {
        let rotated = null;
        if (source.token) rotated = await feddit.rotateToken(source.token, pending.token);
        const returnedToken = rotated && rotated.ok && rotated.data
          ? String(rotated.data.token || '')
          : '';
        let confirmedToken = /^feddit_[a-f0-9]{64}$/.test(returnedToken) ? returnedToken : '';
        let replacementWorks = Boolean(confirmedToken);

        // The rotation may have succeeded even if its HTTP response was lost.
        // Probing the pre-staged replacement turns that ambiguity into a safe,
        // repeatable result without publishing or changing profile content.
        if (!replacementWorks) {
          const probe = await feddit.verifyToken(pending.token);
          replacementWorks = probe.ok;
          if (replacementWorks) confirmedToken = pending.token;
        }
        if (!replacementWorks) {
          const detail = rotated && rotated.error
            ? rotated.error
            : 'Feddit could not confirm the replacement credential.';
          return sendJson(res, 502, {
            error: detail + ' The bot is paused and the handover is safely staged; use Resume handover to retry.',
            retrySafe: true,
          });
        }
        pending = secrets.markFedditHandoverReady(id, confirmedToken);
        source = store.getProfile(id);
        store.logActivity(id, { kind: 'handover-out', ok: true, note: 'Paused here and prepared a private handover file.' });
      }

      return sendJson(res, 200, {
        handover: profilePack.createHandover(source, pending.token),
        profile: safeProfile(source),
      });
    }

    // POST /api/profiles/:id/handover-complete - after the destination import,
    // erase the source runner's last protected copy of the replacement token.
    // The source profile remains as a disabled, secret-free record.
    if (method === 'POST' && sub === '/handover-complete') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const pending = secrets.getFedditHandover(id);
      if (!pending) return sendJson(res, 200, { ok: true, profile: safeProfile(existing) });
      if (pending.status !== 'ready') {
        return sendJson(res, 409, { error: 'Resume the handover first so Feddit can confirm the replacement credential.' });
      }
      secrets.completeFedditHandover(id);
      store.logActivity(id, { kind: 'handover-complete', ok: true, note: 'Removed this runner\'s transfer credential copy.' });
      return sendJson(res, 200, { ok: true, profile: safeProfile(store.getProfile(id)) });
    }

    // POST /api/profiles/:id/simulate-now - immediately run either the real
    // post or comment selection path, but force the final write boundary to a
    // dry-run. It ignores the timetable and enabled switch, while retaining the
    // same live targeting, model, cadence and dedupe effects as scheduled
    // simulation. Hosted DELL work returns immediately and is polled below.
    if (method === 'POST' && sub === '/simulate-now') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const body = await readBody(req);
      const action = body.action === 'comment' ? 'comment' : (body.action === 'post' ? 'post' : '');
      if (!action) return sendJson(res, 400, { error: 'Choose either post or comment.' });

      if (scheduler.providerOf(existing) === 'dell') {
        const prior = hostedSimulationTasks.get(id);
        if (prior && prior.status === 'running') {
          return sendJson(res, 202, { queued: true, action: prior.action, capacity: jobQueue.capacity() });
        }
        const task = { status: 'running', action, result: null, error: null, startedAt: Date.now() };
        hostedSimulationTasks.set(id, task);
        schedulerHandle.simulateNow(id, action).then((result) => {
          task.status = 'completed';
          task.result = result;
          task.finishedAt = Date.now();
        }).catch((err) => {
          task.status = 'failed';
          task.error = err.message;
          task.finishedAt = Date.now();
        });
        return sendJson(res, 202, { queued: true, action, capacity: jobQueue.capacity() });
      }

      const result = await schedulerHandle.simulateNow(id, action);
      return sendJson(res, 200, result);
    }

    // GET /api/profiles/:id/simulate-now-status - status for an immediate
    // hosted simulation. No result is exposed across owners because the normal
    // profile ownership check above has already succeeded.
    if (method === 'GET' && sub === '/simulate-now-status') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const task = hostedSimulationTasks.get(id);
      if (!task) return sendJson(res, 200, { done: true, error: 'No immediate simulation is running.' });
      if (task.status === 'completed') {
        return sendJson(res, 200, { done: true, result: task.result, work: null, capacity: jobQueue.capacity() });
      }
      if (task.status === 'failed') {
        return sendJson(res, 200, { done: true, error: task.error, work: null, capacity: jobQueue.capacity() });
      }
      const capacity = jobQueue.capacity();
      const work = hostedWorkForProfile(existing);
      return sendJson(res, 200, {
        done: false,
        action: task.action,
        work,
        message: hostedWorkMessage(work),
        capacity,
      });
    }

    // POST /api/profiles/:id/reset-simulation - clear rehearsal-only cards,
    // timers and handled-target/article continuity. Live publishing continuity
    // is deliberately untouched, so this cannot cause real duplicate replies.
    if (method === 'POST' && sub === '/reset-simulation') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      const task = hostedSimulationTasks.get(id);
      if ((task && task.status === 'running') || schedulerHandle.isProfileBusy(id)) {
        return sendJson(res, 409, { error: 'This bot is still finishing a simulation. Reset it when that work has finished.' });
      }
      store.resetSimulation(id);
      return sendJson(res, 200, { ok: true, profile: safeProfile(store.getProfile(id)) });
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
          botName: store.referenceName(existing),
          ownerKey: existing.ownerId || existing.id,
          priority: 'interactive',
          kind: 'preview',
          activityAction: 'writing a manual reply preview',
          activityTrigger: 'manual preview button',
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
          : (err.code === 'QUEUE_OWNER_LIMIT' || err.code === 'QUEUE_PROFILE_LIMIT') ? 429
          : 500;
        return sendJson(res, code, { error: err.message });
      }
    }

    // POST /api/profiles/:id/preview-news - run the news pick (query GDELT ->
    // filter -> choose -> generate a title) and return the chosen article + title
    // WITHOUT posting or consuming (recording) the article. Available only to
    // profiles whose independent abilities include sharing article links.
    if (method === 'POST' && sub === '/preview-news') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      if (!scheduler.caps(existing).canShareLinks) return sendJson(res, 400, { error: 'This bot is not configured to share article links.' });
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
          return sendJson(res, 200, { done: true, result: hosted.result, work: null, capacity: jobQueue.capacity() });
        }
        if (hosted.status === 'failed') {
          return sendJson(res, 200, { done: true, error: hosted.error, work: null, capacity: jobQueue.capacity() });
        }
        const activeProgress = schedulerHandle.getPreviewProgress(id);
        const cap = jobQueue.capacity();
        const work = hostedWorkForProfile(existing);
        return sendJson(res, 200, {
          done: false,
          work,
          message: activeProgress
            ? activeProgress.message
            : hostedWorkMessage(work),
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

    // POST /api/profiles/:id/clear-posted - wipe this profile's LIVE
    // posted-article history (and per-domain counts). Simulation is separate.
    if (method === 'POST' && sub === '/clear-posted') {
      if (!existing) return sendJson(res, 404, { error: 'No such profile' });
      store.clearPostedNews(id);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/profiles/:id/create-feddit - explicitly create a sub-feddit with
    // THIS profile's bot token. The owner authors name + description + format +
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
      const description = String(body.description || '').trim();
      const nsfw = body.nsfw === true;
      const postFormat = String(body.postFormat || 'any').toLowerCase();
      const rules = Array.isArray(body.rules) ? body.rules : [];

      // Backstop the exact Feddit caps (read from V:/feddit/src/api/Validate.php):
      // name [A-Za-z0-9_]{3,24}, description <=2000, at most 15
      // rules, rule title 1..100, rule detail <=500.
      if (!/^[A-Za-z0-9_]{3,24}$/.test(name)) {
        return sendJson(res, 400, { error: 'Name must be 3-24 characters: letters, numbers or underscore only.' });
      }
      if (description.length > 2000) {
        return sendJson(res, 400, { error: 'Description must be at most 2000 characters.' });
      }
      if (!['any', 'text', 'link'].includes(postFormat)) {
        return sendJson(res, 400, { error: 'Post format must be text, link or either.' });
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

      const r = await feddit.createFeddit({ token: existing.token, name, description, nsfw, rules, postFormat });
      if (!r.ok) {
        const msg = feddit.createErrorMessage(r, name);
        store.logActivity(id, { kind: 'feddit', ok: false, target: 'f/' + name, note: 'Create failed: ' + msg });
        // Preserve the server status so the panel can react (409/403/429/other).
        const status = [409, 403, 429].includes(r.status) ? r.status : (r.status && r.status >= 400 ? r.status : 502);
        return sendJson(res, status, { error: msg });
      }

      const created = (r.data && r.data.feddit) || { name, title: name, post_format: postFormat };
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
function reconcileHostedProfiles(at = Date.now()) {
  if (PLACEMENT !== 'hosted') return;
  for (const profile of store.listProfiles()) {
    if (!profile.ownerId && profile.botOrigin !== 'system') continue;
    const managed = applyHostedProfilePolicy({}, profile, at);
    const changed = Object.keys(managed).some((key) =>
      JSON.stringify(profile[key]) !== JSON.stringify(managed[key]));
    if (changed) store.updateProfile(profile.id, managed);
  }
}

function activeSyntheticTurnCount() {
  if (PLACEMENT !== 'hosted') return 0;
  return turnStore.listActive().filter((turn) => {
    const profile = store.getProfile(turn.profileId);
    return profile && profile.botOrigin === 'system';
  }).length;
}
reconcileHostedProfiles();
const schedulerHandle = scheduler.start({
  store,
  providers,
  jobQueue,
  turnStore,
  feddit,
  gdelt,
  feeds,
  queueAllocationFor: PLACEMENT === 'hosted'
    ? (profile, at) => hostedPolicy.processingFor(profile, at)
    : undefined,
  admitHostedTurn: PLACEMENT === 'hosted'
    ? (profile) => hostedPolicy.admissionFor(profile, jobQueue.capacity(), {
      activeSyntheticTurns: activeSyntheticTurnCount(),
    })
    : undefined,
  getDeepseekKey: () => secrets.getDeepseekKey(),
  log: (message) => console.log('[scheduler] ' + message),
});
if (PLACEMENT === 'hosted') {
  const hostedPolicyTimer = setInterval(reconcileHostedProfiles, hostedPolicy.RECONCILE_INTERVAL_MS);
  hostedPolicyTimer.unref();
}
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
  const profiles = store.listProfiles();
  const rehearsalCount = profiles.filter((profile) => scheduler.isDryRun(profile, s)).length;
  const liveCount = profiles.length - rehearsalCount;
  console.log('');
  console.log('  Scheduler is running (tick ' + Math.round(schedulerHandle.tickMs / 1000) + 's). ' +
    'Global: ' + (s.paused ? 'PAUSED' : 'active') + '. Bots: ' + rehearsalCount + ' rehearsal, ' + liveCount + ' live.');
  console.log('  Monthly spend cap: $' + s.monthlyCapUsd + ' (deepseek profiles skip over-cap; ollama unaffected).');
  console.log('  It only acts on ENABLED profiles; each bot can rehearse without writing or publish live.');
  console.log('');
});
