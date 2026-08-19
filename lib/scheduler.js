'use strict';

// Posting/replying loop for the Feddit bot runner. Dropped into the SCHEDULER
// SEAM in server.js via start({ store, providers, feddit, getDeepseekKey }).
//
// SHAPE: a single timer fires runTick() every TICK_MS. Each tick walks the
// ENABLED profiles and, for each one that is DUE, performs exactly one action:
// submit a new post, or reply to something. Everything the loop needs comes from
// the three injected modules; nothing else in the server has to change.
//
// HARD RULES baked in here:
//  - The ollama single-flight gate is PER-PROVIDER, not global. AT MOST ONE
//    ollama generation is ever in flight (always keep_alive: -1) so Cy's
//    resident model on DELL is never queued behind us or evicted. If ollama is
//    already busy we skip ONLY the ollama profiles this tick - a DeepSeek
//    profile is a remote call and is neither blocked by, nor blocks, that gate.
//    Several DeepSeek profiles may generate concurrently (capped in
//    lib/providers). So the tick runs the ollama profiles sequentially and the
//    DeepSeek profiles concurrently, all in the same tick.
//  - SPEND GUARDRAIL: a runner-wide monthly USD cap. Once month-to-date spend
//    reaches it, ALL DeepSeek profiles are skipped (ollama profiles keep going)
//    so a misconfigured cadence can't silently burn money overnight.
//  - Server ceilings are the hard ceiling: 10 posts/hr, 60 comments/hr per bot.
//    We self-limit against a rolling 1h window BEFORE writing, and on a real 429
//    we back off using the reset time parsed from the error (feddit.retryAfterSec)
//    rather than hammering.
//  - Never reply to our OWN posts/comments, and cap any single thread at
//    THREAD_CAP replies from THIS RUNNER so two profiles can't ping-pong forever.
//  - DRY-RUN (default ON): generate and log exactly what we WOULD post, but make
//    no write call. Dedupe/cadence/ceiling bookkeeping still updates so the
//    behaviour you watch in dry-run is the behaviour you get live.
//
// Testability: now() and random() are injectable and runTick() is directly
// callable, so the dry-run harness fakes the clock + a stub feddit client and
// proves targeting/dedupe/cadence/back-off with no live generation or write.

const cost = require('./cost');

const TICK_MS = 20_000;              // how often the loop wakes (production)
const ROLLING_WINDOW_MS = 3_600_000; // 1 hour, matches the server's rate window
const SERVER = { postsPerHour: 10, commentsPerHour: 60 }; // hard per-bot ceiling
const JITTER = 0.4;                  // cadence spread: interval * uniform(0.6 .. 1.4)
const THREAD_CAP = 3;                // max this-runner replies in one post's thread
const MAX_OLLAMA_PER_TICK = 3;       // politeness cap so one tick can't marathon Cy (ollama only)
const MAX_FEDDITS_SCAN = 4;          // read at most this many sub-feddits when targeting
const DEFAULT_BACKOFF_SEC = 900;     // fallback 429 back-off if no reset time given

// Which provider a profile uses, and the model it will actually generate with.
function providerOf(profile) {
  return (profile && profile.provider) === 'deepseek' ? 'deepseek' : 'ollama';
}
function modelOf(profile, defaultOllamaModel) {
  if (providerOf(profile) === 'deepseek') return profile.deepseekModel || 'deepseek-v4-flash';
  return profile.model || defaultOllamaModel;
}
// Build the system prompt from persona + tone notes (shared by all providers).
function buildSystem(persona, toneNotes) {
  return [persona || '', toneNotes ? '\nTone/style: ' + toneNotes : ''].join('').trim();
}

// What a profile is ALLOWED to do, by bot type. A conversational bot obeys its
// mode (post/comment/both); a news bot only ever submits link posts (driven by
// postsPerHour, never comments). Everything downstream - cadence timers,
// ceilings, jitter, back-off, the spend gate - is shared regardless.
function caps(profile) {
  if (profile && profile.botType === 'news') return { canPost: true, canComment: false };
  const mode = profile && profile.mode;
  return { canPost: mode === 'both' || mode === 'post', canComment: mode === 'both' || mode === 'comment' };
}

// ---- news helpers (pure) ----------------------------------------------------

// Known hard-paywall domains. The per-profile paywall toggle drops articles from
// these (and their subdomains). Kept deliberately small and conservative.
const PAYWALL_DOMAINS = new Set([
  'nytimes.com', 'wsj.com', 'ft.com', 'economist.com', 'bloomberg.com',
  'washingtonpost.com', 'thetimes.co.uk', 'telegraph.co.uk', 'newyorker.com',
  'wired.com', 'theatlantic.com', 'businessinsider.com', 'seekingalpha.com',
  'barrons.com', 'foreignpolicy.com', 'hbr.org', 'medium.com',
]);

function isPaywalled(domain) {
  const d = String(domain || '').toLowerCase();
  for (const p of PAYWALL_DOMAINS) {
    if (d === p || d.endsWith('.' + p)) return true;
  }
  return false;
}

// Clean routing rules into a predictable shape.
function normalizeRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((r) => ({
      keywords: Array.isArray(r && r.keywords) ? r.keywords.map((k) => String(k || '').trim()).filter(Boolean) : [],
      subFeddit: String((r && r.subFeddit) || '').trim(),
      weight: Number((r && r.weight) || 0),
    }))
    .filter((r) => r.subFeddit); // a rule with no destination is meaningless
}

// Pick the routing rule for an article: among rules whose keywords match (a rule
// with NO keywords is a catch-all), the highest weight wins; ties break to the
// earliest rule in the owner's ordered list. Returns the rule or null (no route
// => the article is not posted at all).
function matchRule(article, rules) {
  const hay = ((article && article.title) || '') + ' ' + ((article && article.domain) || '');
  const h = hay.toLowerCase();
  let best = null, bestW = -Infinity, bestI = Infinity;
  normalizeRules(rules).forEach((r, i) => {
    const matched = r.keywords.length === 0 || r.keywords.some((k) => h.includes(k.toLowerCase()));
    if (!matched) return;
    if (r.weight > bestW || (r.weight === bestW && i < bestI)) { best = r; bestW = r.weight; bestI = i; }
  });
  return best;
}

// Order surviving candidates by rule weight (desc) then freshness (newest first),
// then pick with a little randomisation among the top few so it is not rigidly
// deterministic. `random` is the scheduler's injectable RNG.
function pickArticle(candidates, random) {
  const sorted = candidates.slice().sort((a, b) => {
    const wd = (Number(b.rule.weight) || 0) - (Number(a.rule.weight) || 0);
    if (wd) return wd;
    return (b.seenAt || 0) - (a.seenAt || 0);
  });
  const topK = sorted.slice(0, Math.min(3, sorted.length));
  const idx = Math.floor((random ? random() : 0) * topK.length);
  return topK[idx] || sorted[0] || null;
}

// A short instruction fragment for the chosen title style.
function titleStyleInstruction(profile) {
  switch (profile && profile.newsTitleStyle) {
    case 'deadpan': return 'Style: deadpan and flat, understated, no hype.';
    case 'tabloid': return 'Style: punchy tabloid energy - grabby, but never claim anything false.';
    case 'punny': return 'Style: work in a light pun or bit of wordplay if it fits naturally.';
    case 'custom': return 'Style: ' + (String((profile && profile.newsTitleCustom) || '').trim() || 'as the persona would naturally write.');
    case 'straight':
    default: return 'Style: straight and clear - just describe the story plainly.';
  }
}

// Normalise a generated title: single line, no surrounding quotes, no leading
// "Title:", capped at Feddit's 300-char limit.
function cleanTitle(text) {
  let s = String(text || '').replace(/\r/g, '').replace(/\n+/g, ' ').trim();
  s = s.replace(/^title\s*[:\-]\s*/i, '').trim();
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
  return s.slice(0, 300);
}

// Parse a shortlist reply into a 0-based index, or null if unparseable / out of
// range (the caller then falls back to the code-picked article).
function parseShortlistIndex(text, n) {
  const m = String(text || '').match(/\d+/);
  if (!m) return null;
  const v = parseInt(m[0], 10);
  if (!Number.isInteger(v) || v < 1 || v > n) return null;
  return v - 1;
}

// GDELT timespan (hours) derived from the freshness cap, clamped to a sane band.
function timespanHours(maxAgeHours) {
  const h = Number(maxAgeHours) || 24;
  return Math.max(1, Math.min(168, Math.ceil(h)));
}

// The article fields safe to surface to the UI (preview / activity).
function publicArticle(a) {
  return { url: a.url, domain: a.domain, title: a.title, seendate: a.seendate, socialimage: a.socialimage };
}

// ---- pure helpers (no deps) -------------------------------------------------

// What the UI shows as "next scheduled action" for a profile. Pure: reads the
// stored sched timers + mode, no clock needed.
function nextAction(profile) {
  const s = (profile && profile.sched) || {};
  const c = caps(profile);
  const postKind = profile && profile.botType === 'news' ? 'news' : 'post';
  const opts = [];
  if (c.canPost && s.nextPostAt != null && (Number(profile.postsPerHour) || 0) > 0) {
    opts.push({ kind: postKind, at: s.nextPostAt });
  }
  if (c.canComment && s.nextCommentAt != null && (Number(profile.commentsPerHour) || 0) > 0) {
    opts.push({ kind: 'comment', at: s.nextCommentAt });
  }
  opts.sort((a, b) => a.at - b.at);
  return { next: opts[0] || null, backoffUntil: s.backoffUntil || 0 };
}

// Split a generated post into a title (first line) and body (the rest).
function splitPost(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { title: '', body: '' };
  const nl = trimmed.indexOf('\n');
  let title = nl === -1 ? trimmed : trimmed.slice(0, nl).trim();
  let body = nl === -1 ? '' : trimmed.slice(nl + 1).trim();
  title = title.replace(/^title\s*[:\-]\s*/i, '').replace(/^["']|["']$/g, '').trim().slice(0, 300);
  if (!title) title = (body || trimmed).slice(0, 120);
  return { title, body: body.slice(0, 40_000) };
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

// Flatten a threaded comments Listing ({ data: { children: [{ data, replies }] }})
// into a flat array of comment data objects, descending into nested replies.
function flattenComments(listing) {
  const out = [];
  const walk = (l) => {
    if (!l || !l.data || !Array.isArray(l.data.children)) return;
    for (const ch of l.data.children) {
      if (!ch || !ch.data) continue;
      out.push(ch.data);
      if (ch.data.replies && typeof ch.data.replies === 'object') walk(ch.data.replies);
    }
  };
  walk(listing);
  return out;
}

// ---- scheduler instance -----------------------------------------------------

function createScheduler(deps) {
  const { store, providers, feddit } = deps;
  const gdelt = deps.gdelt; // GDELT client (shared queue); only used by news profiles
  const now = deps.now || Date.now;
  const random = deps.random || Math.random;
  const log = deps.log || (() => {});
  const getDeepseekKey = deps.getDeepseekKey || (() => '');

  let ticking = false; // non-reentrancy guard: ticks never overlap
  let handle = null;

  // Fresh scheduler bookkeeping for a profile, straight from the store.
  function freshSched(id) {
    const p = store.getProfile(id);
    return { ...store.schedDefaults(), ...((p && p.sched) || {}) };
  }

  function effRate(perHour, kind) {
    const ceiling = kind === 'post' ? SERVER.postsPerHour : SERVER.commentsPerHour;
    return Math.min(Number(perHour) || 0, ceiling);
  }

  // Next fire time for an action: base interval from the effective (ceiling-capped)
  // rate, multiplied by a jitter factor so output is not an obvious metronome.
  function scheduleNext(kind, profile) {
    const eff = effRate(kind === 'post' ? profile.postsPerHour : profile.commentsPerHour, kind);
    if (eff <= 0) return null;
    const interval = ROLLING_WINDOW_MS / eff;
    const jitter = (1 - JITTER) + random() * 2 * JITTER;
    return now() + interval * jitter;
  }

  // Lazily seed the first fire times, spread randomly within one interval so
  // profiles don't all fire together at start-up.
  function ensureTimers(profile) {
    const s = freshSched(profile.id);
    const patch = {};
    const { canPost, canComment } = caps(profile);
    if (canPost && s.nextPostAt == null && effRate(profile.postsPerHour, 'post') > 0) {
      patch.nextPostAt = now() + random() * (ROLLING_WINDOW_MS / effRate(profile.postsPerHour, 'post'));
    }
    if (canComment && s.nextCommentAt == null && effRate(profile.commentsPerHour, 'comment') > 0) {
      patch.nextCommentAt = now() + random() * (ROLLING_WINDOW_MS / effRate(profile.commentsPerHour, 'comment'));
    }
    if (Object.keys(patch).length) store.updateSched(profile.id, patch);
  }

  // How many of this action we've done in the last hour, vs the server ceiling.
  function withinCeiling(profile, kind) {
    const s = freshSched(profile.id);
    const cutoff = now() - ROLLING_WINDOW_MS;
    const recent = (kind === 'post' ? s.sentPosts : s.sentComments).filter((ts) => ts >= cutoff);
    const limit = kind === 'post' ? SERVER.postsPerHour : SERVER.commentsPerHour;
    return { ok: recent.length < limit, recent };
  }

  // Record one send (real or dry-run) into the rolling window.
  function recordSend(profile, kind) {
    const s = freshSched(profile.id);
    const cutoff = now() - ROLLING_WINDOW_MS;
    const arr = (kind === 'post' ? s.sentPosts : s.sentComments).filter((ts) => ts >= cutoff);
    arr.push(now());
    store.updateSched(profile.id, kind === 'post' ? { sentPosts: arr } : { sentComments: arr });
  }

  // Generate via the profile's chosen provider, then record token usage + USD
  // cost against the profile (ollama => $0, tracked as free-of-API-cost). Every
  // successful generation flows through here so spend can never be under-counted.
  async function generate(profile, task) {
    const prov = providerOf(profile);
    const model = modelOf(profile, store.DEFAULT_MODEL);
    const res = await providers.generate({
      provider: prov,
      model,
      system: buildSystem(profile.persona, profile.toneNotes),
      prompt: task,
      temperature: Number(profile.temperature) || 0.8,
      numPredict: Number(profile.numPredict) || 200,
      apiKey: prov === 'deepseek' ? getDeepseekKey() : undefined,
    });
    const settings = store.getSettings();
    const usd = cost.estimateCost(res.model, res.usage, settings.pricing);
    res.costUsd = usd;
    store.recordSpend(profile.id, { dayKey: cost.dayKey(now()), usage: res.usage, costUsd: usd });
    return res;
  }

  // A short "[provider model $cost]" tag for activity notes. Ollama shows as
  // free of API cost rather than pretending it is free of all cost.
  function costTag(res) {
    if (!res) return '';
    if (res.provider === 'ollama') return ' [ollama local, no API $]';
    return ' [' + res.model + ' $' + (res.costUsd || 0).toFixed(4) + ']';
  }

  function handle429(profile, r, kind) {
    const secs = r.retryAfterSec != null ? r.retryAfterSec : DEFAULT_BACKOFF_SEC;
    store.updateSched(profile.id, { backoffUntil: now() + secs * 1000 });
    store.logActivity(profile.id, {
      kind, ok: false,
      note: 'Rate limited (429); backing off ' + secs + 's. ' + (r.error || ''),
    });
    return { acted: true, action: kind, ok: false, backoffSec: secs };
  }

  // ---- targeting ------------------------------------------------------------

  // Pick one thing to reply to: prefer a fresh POST we've not answered; else a
  // COMMENT (continuing a thread). Skips our own content, already-replied targets,
  // and any thread already at the ping-pong cap. Returns a target or null.
  async function pickReplyTarget(profile) {
    const self = (profile.fedditUsername || '').toLowerCase();
    const names = (profile.readFeddits && profile.readFeddits.length)
      ? profile.readFeddits
      : (profile.postFeddits || []);

    const posts = [];
    for (const name of names.slice(0, MAX_FEDDITS_SCAN)) {
      const r = await feddit.feddit(name, 'new');
      if (!r.ok || !r.data || !r.data.data || !Array.isArray(r.data.data.children)) continue;
      for (const child of r.data.data.children) {
        if (child && child.data) posts.push(child.data);
      }
    }
    posts.sort((a, b) => (b.id || 0) - (a.id || 0)); // newest first

    // 1) reply directly to a post
    for (const post of posts) {
      const key = 't3_' + post.id;
      if ((post.author || '').toLowerCase() === self) continue;      // never our own
      if (store.hasReplied(profile.id, key)) continue;               // dedupe
      if (store.getThreadReplyCount(post.id) >= THREAD_CAP) continue; // ping-pong cap
      return {
        kind: 'post', postId: post.id, commentId: null, key,
        feddit: post.feddit, author: post.author,
        label: 'f/' + post.feddit + ' ' + key,
        context: 'POST in f/' + post.feddit + '\nTITLE: ' + (post.title || '') +
          (post.selftext ? '\nBODY: ' + post.selftext : ''),
      };
    }

    // 2) else continue a thread by replying to a comment
    for (const post of posts) {
      if (store.getThreadReplyCount(post.id) >= THREAD_CAP) continue;
      const cr = await feddit.comments(post.id);
      if (!cr.ok || !cr.data) continue;
      for (const c of flattenComments(cr.data.comments)) {
        const key = 't1_' + c.id;
        if ((c.author || '').toLowerCase() === self) continue;
        if (store.hasReplied(profile.id, key)) continue;
        return {
          kind: 'comment', postId: c.post_id != null ? c.post_id : post.id, commentId: c.id, key,
          feddit: post.feddit, author: c.author,
          label: 'f/' + post.feddit + ' ' + key,
          context: 'POST TITLE: ' + (post.title || '') +
            '\nA COMMENT (by ' + (c.author || 'someone') + ') you are replying to: ' + (c.body || ''),
        };
      }
    }
    return null;
  }

  // ---- actions --------------------------------------------------------------

  async function doPost(profile, settings) {
    const feddits = (profile.postFeddits && profile.postFeddits.length) ? profile.postFeddits : [];
    if (!feddits.length) { store.updateSched(profile.id, { nextPostAt: scheduleNext('post', profile) }); return null; }

    const ceil = withinCeiling(profile, 'post');
    if (!ceil.ok) {
      // At the ceiling: wait until the oldest counted post falls out of the window.
      store.updateSched(profile.id, { nextPostAt: (ceil.recent[0] || now()) + ROLLING_WINDOW_MS });
      return null;
    }

    const fName = feddits[Math.floor(random() * feddits.length)] || feddits[0];
    const task = 'You are posting a NEW thread to the sub-feddit "' + fName + '" on a forum called Feddit. ' +
      'Write an original short post in character. Respond with the post TITLE on the first line, then a ' +
      'blank line, then the body. No preamble, no markdown headings.';

    let gen;
    try { gen = await generate(profile, task); }
    catch (e) {
      store.logActivity(profile.id, { kind: 'post', ok: false, target: 'f/' + fName, note: 'generate failed: ' + e.message });
      store.updateSched(profile.id, { nextPostAt: scheduleNext('post', profile) });
      return { acted: true, action: 'post', ok: false };
    }

    const { title, body } = splitPost(gen.text);
    store.updateSched(profile.id, { nextPostAt: scheduleNext('post', profile) });

    if (settings.dryRun) {
      recordSend(profile, 'post');
      store.logActivity(profile.id, { kind: 'post', dryRun: true, ok: true, target: 'f/' + fName, note: 'DRY-RUN would post: ' + snippet(title) + costTag(gen) });
      return { acted: true, mode: 'dry', action: 'post', feddit: fName, title };
    }

    const r = await feddit.submit({ token: profile.token, feddit: fName, title, kind: 'text', text: body });
    if (r.status === 429) return handle429(profile, r, 'post');
    if (!r.ok) {
      store.logActivity(profile.id, { kind: 'post', ok: false, target: 'f/' + fName, note: r.error || 'submit failed' });
      return { acted: true, action: 'post', ok: false };
    }
    recordSend(profile, 'post');
    const postId = r.data && r.data.post && r.data.post.data && r.data.post.data.id;
    store.logActivity(profile.id, { kind: 'post', ok: true, target: 'f/' + fName, note: 'Posted: ' + snippet(title) + costTag(gen), postId });
    return { acted: true, action: 'post', ok: true, postId };
  }

  async function doComment(profile, settings) {
    const target = await pickReplyTarget(profile);
    if (!target) { store.updateSched(profile.id, { nextCommentAt: scheduleNext('comment', profile) }); return null; }

    const ceil = withinCeiling(profile, 'comment');
    if (!ceil.ok) {
      store.updateSched(profile.id, { nextCommentAt: (ceil.recent[0] || now()) + ROLLING_WINDOW_MS });
      return null;
    }

    const task = 'You are browsing a forum called Feddit. Write a single in-character reply. ' +
      'Plain text, no preamble, no surrounding quotes.\n\n' + target.context + '\n\nYour reply:';

    let gen;
    try { gen = await generate(profile, task); }
    catch (e) {
      store.logActivity(profile.id, { kind: 'comment', ok: false, target: target.label, note: 'generate failed: ' + e.message });
      store.updateSched(profile.id, { nextCommentAt: scheduleNext('comment', profile) });
      return { acted: true, action: 'comment', ok: false };
    }

    const text = String(gen.text || '').trim().slice(0, 10_000);
    store.updateSched(profile.id, { nextCommentAt: scheduleNext('comment', profile) });

    if (settings.dryRun) {
      // Record dedupe + thread + send so dry-run behaves exactly like live.
      store.recordReplied(profile.id, target.key);
      store.bumpThreadReply(target.postId);
      recordSend(profile, 'comment');
      store.logActivity(profile.id, { kind: 'comment', dryRun: true, ok: true, target: target.label, note: 'DRY-RUN would reply: ' + snippet(text) + costTag(gen) });
      return { acted: true, mode: 'dry', action: 'comment', target: target.key };
    }

    const r = await feddit.comment({ token: profile.token, postId: target.postId, text, parentCommentId: target.commentId });
    if (r.status === 429) return handle429(profile, r, 'comment'); // don't burn the target; retry after back-off
    // Any other outcome (success or hard failure) consumes the target so we
    // don't spin on it: record dedupe + thread either way.
    store.recordReplied(profile.id, target.key);
    store.bumpThreadReply(target.postId);
    if (!r.ok) {
      store.logActivity(profile.id, { kind: 'comment', ok: false, target: target.label, note: r.error || 'comment failed' });
      return { acted: true, action: 'comment', ok: false };
    }
    recordSend(profile, 'comment');
    store.logActivity(profile.id, { kind: 'comment', ok: true, target: target.label, note: 'Replied to ' + target.key + ': ' + snippet(text) + costTag(gen) });
    return { acted: true, action: 'comment', ok: true, target: target.key };
  }

  // ---- news actions ---------------------------------------------------------

  // Filter GDELT articles down to the ones this profile MAY post right now. Code
  // does all the filtering (the model never searches): too old, already posted,
  // denylisted/paywalled domain, over the per-domain daily cap, no matching
  // routing rule, or (optionally) no image. Each survivor is tagged with its
  // canonical dedupe key and the routing rule that will place it.
  function filterArticles(profile, articles, t) {
    const maxAgeMs = (Number(profile.newsMaxAgeHours) || 24) * 3_600_000;
    const deny = new Set((profile.newsDomainDenylist || []).map((d) => String(d).toLowerCase().trim()).filter(Boolean));
    const requireImage = !!profile.newsRequireImage;
    const paywall = !!profile.newsPaywallFilter;
    const perDomainCap = Number(profile.newsMaxPerDomainPerDay) || 0;
    const rules = profile.newsRoutingRules;
    const dayKey = cost.dayKey(t);

    const out = [];
    for (const a of (articles || [])) {
      if (a.seenAt == null) continue;                 // can't judge freshness
      if ((t - a.seenAt) > maxAgeMs) continue;        // too old
      const canonical = gdelt.canonicalUrl(a.url);
      if (store.hasPostedNews(profile.id, canonical)) continue; // PERMANENT dedupe
      if (deny.has(a.domain)) continue;               // denylisted domain
      if (paywall && isPaywalled(a.domain)) continue; // paywall filter
      if (requireImage && !a.socialimage) continue;   // image required and none
      const rule = matchRule(a, rules);
      if (!rule) continue;                            // no routing rule -> not posted
      if (perDomainCap > 0 && store.newsDomainCount(profile, dayKey, a.domain) >= perDomainCap) continue;
      out.push({ ...a, canonical, rule });
    }
    return out;
  }

  // Generate a link-post TITLE from ONLY the headline (+ summary if any), in the
  // profile's persona and title style. Hard guardrail: the model may not state
  // any fact not present in the inputs (an 8B model will otherwise invent a
  // number/place/quote). Enforces the 300-char cap, strips newlines/quotes, and
  // regenerates ONCE if the output is empty or is just the headline verbatim.
  async function generateNewsTitle(profile, article) {
    const headline = String(article.title || '').trim();
    const summary = String(article.summary || '').trim(); // GDELT ArtList usually has none
    const style = titleStyleInstruction(profile);
    const base =
      'You are writing the TITLE for a link post to a news article on a forum called Feddit, in character.\n' +
      'You are given ONLY the article headline' + (summary ? ' and a short summary' : '') + ' below. ' +
      'HARD RULE: do NOT state any fact, number, place, name, date or quote that is not present in ' +
      'the headline' + (summary ? ' or summary' : '') + '. Invent nothing. If unsure, stay vague.\n' +
      'Output ONE single-line title only - no quotes, no preamble, no markdown, max 300 characters.\n' +
      style + '\n\nHEADLINE: ' + headline + (summary ? '\nSUMMARY: ' + summary : '') + '\n\nTITLE:';

    let gen = await generate(profile, base);
    let title = cleanTitle(gen.text);
    if (!title || title.toLowerCase() === headline.toLowerCase()) {
      const retry = base + '\n\n(Your previous attempt was empty or just repeated the headline. ' +
        'Rephrase it in your own voice, still inventing nothing.)';
      gen = await generate(profile, retry);
      const t2 = cleanTitle(gen.text);
      if (t2 && t2.toLowerCase() !== headline.toLowerCase()) title = t2;
      else title = cleanTitle(headline); // fall back to the plain headline so we still post
    }
    return { title, gen };
  }

  // OPTIONAL extra "let the bot choose" step: hand the model a numbered shortlist
  // of ~5 headlines and take back just the index of the most interesting one for
  // its persona. Strict parse; any unparseable/out-of-range reply -> null so the
  // caller keeps the code-picked article. This DOUBLES cost per post.
  async function shortlistPick(profile, candidates) {
    const list = candidates.map((a, i) => (i + 1) + '. ' + a.title).join('\n');
    const task =
      'Below is a numbered shortlist of news headlines. Pick the SINGLE most interesting one ' +
      'for your persona to share. Reply with ONLY the number of your choice and nothing else.\n\n' +
      list + '\n\nNumber:';
    try {
      const gen = await generate(profile, task);
      const idx = parseShortlistIndex(gen.text, candidates.length);
      return idx == null ? null : candidates[idx];
    } catch {
      return null; // generation failed - fall back to the code pick
    }
  }

  // The news equivalent of doPost. Code does the searching + filtering + picking;
  // the model only writes the title. With opts.preview the whole thing runs
  // steps 1-4 and returns the chosen article + title WITHOUT recording dedupe or
  // submitting (so a preview never consumes an article). Reuses the same ceiling,
  // cadence, jitter, back-off, dedupe and spend machinery as everything else.
  async function decideNews(profile, settings, opts = {}) {
    const preview = !!opts.preview;
    const reschedule = () => { if (!preview) store.updateSched(profile.id, { nextPostAt: scheduleNext('post', profile) }); };

    if (!gdelt) {
      if (preview) return { ok: false, error: 'GDELT client not available.' };
      store.logActivity(profile.id, { kind: 'news', ok: false, note: 'GDELT client not wired in.' });
      reschedule();
      return { acted: true, action: 'news', ok: false };
    }

    const query = String(profile.newsQuery || '').trim();
    if (!query) {
      if (preview) return { ok: false, error: 'No watch keywords / GDELT query configured.' };
      reschedule();
      return null;
    }

    // Self-limit against the server ceiling + the owner's minimum gap (live path).
    if (!preview) {
      const ceil = withinCeiling(profile, 'post');
      if (!ceil.ok) {
        store.updateSched(profile.id, { nextPostAt: (ceil.recent[0] || now()) + ROLLING_WINDOW_MS });
        return null;
      }
      const s = freshSched(profile.id);
      const last = (s.sentPosts || []).reduce((m, x) => Math.max(m, x), 0);
      const gapMs = (Number(profile.newsMinGapMinutes) || 0) * 60_000;
      if (gapMs && last && (now() - last) < gapMs) {
        store.updateSched(profile.id, { nextPostAt: last + gapMs });
        return null;
      }
    }

    // 1) Query GDELT through the shared queue (may be served from cache).
    const res = await gdelt.fetchArticles(query, { maxRecords: 25, timespanHours: timespanHours(profile.newsMaxAgeHours) });
    if (!res.ok) {
      const note = res.backoff ? 'GDELT rate-limit back-off active (waiting ' + (res.retryInSec || '?') + 's)'
        : res.rateLimited ? 'GDELT rate limited; backing off ' + (res.retryInSec || '?') + 's'
          : 'GDELT fetch failed: ' + (res.error || 'unknown');
      if (preview) return { ok: false, error: note };
      store.logActivity(profile.id, { kind: 'news', ok: false, note });
      reschedule();
      return { acted: true, action: 'news', ok: false };
    }

    // 2) Filter to postable candidates (code only, the model does not filter).
    const candidates = filterArticles(profile, res.articles, now());
    if (!candidates.length) {
      const note = 'No suitable fresh article to post (age / dedupe / routing / denylist / domain-cap filtered them all).';
      if (preview) return { ok: false, error: note };
      store.logActivity(profile.id, { kind: 'news', ok: true, note });
      reschedule();
      return { acted: true, action: 'news', ok: true, note: 'none' };
    }

    // 3) Pick the target: highest-weight rule, newest first, lightly randomised.
    let chosen = pickArticle(candidates, random);
    if (profile.newsLetBotChoose) {
      const picked = await shortlistPick(profile, candidates.slice(0, 5));
      if (picked) chosen = picked; // else fall back cleanly to the code pick
    }

    // 4) ONE generation for the title (guardrailed), or two with the shortlist.
    let title, gen;
    try {
      ({ title, gen } = await generateNewsTitle(profile, chosen));
    } catch (e) {
      const note = 'title generation failed: ' + e.message;
      if (preview) return { ok: false, error: note };
      store.logActivity(profile.id, { kind: 'news', ok: false, target: chosen.domain, note });
      reschedule();
      return { acted: true, action: 'news', ok: false };
    }

    if (preview) {
      return {
        ok: true, article: publicArticle(chosen), title, subFeddit: chosen.rule.subFeddit,
        provider: gen && gen.provider, model: gen && gen.model, costUsd: gen && gen.costUsd,
      };
    }

    reschedule();

    // Record dedupe + the per-domain count BEFORE the submit is attempted (and
    // in dry-run), so a crash mid-submit can never cause a repost. Reposting is
    // the one unforgivable news failure - a rare missed article is fine.
    store.recordPostedNews(profile.id, chosen.canonical);
    store.recordNewsDomain(profile.id, cost.dayKey(now()), chosen.domain);
    recordSend(profile, 'post');

    const noteCore = snippet(chosen.title) + '  ->  ' + snippet(title) + costTag(gen);

    if (settings.dryRun) {
      store.logActivity(profile.id, {
        kind: 'news', dryRun: true, ok: true, target: chosen.domain,
        note: 'DRY-RUN would post link to f/' + chosen.rule.subFeddit + ': ' + noteCore,
      });
      return { acted: true, mode: 'dry', action: 'news', ok: true, feddit: chosen.rule.subFeddit, domain: chosen.domain, headline: chosen.title, title, canonical: chosen.canonical };
    }

    // 5) Submit the LINK post. On a 429 we back off but do NOT un-record the
    // dedupe - the article is consumed either way (never reposted).
    const r = await feddit.submit({ token: profile.token, feddit: chosen.rule.subFeddit, title, kind: 'link', url: chosen.url });
    if (r.status === 429) {
      handle429(profile, r, 'news');
      return { acted: true, action: 'news', ok: false, feddit: chosen.rule.subFeddit, canonical: chosen.canonical };
    }
    if (!r.ok) {
      store.logActivity(profile.id, { kind: 'news', ok: false, target: chosen.domain, note: (r.error || 'submit failed') + ' (article consumed, will not repost)' });
      return { acted: true, action: 'news', ok: false, feddit: chosen.rule.subFeddit, canonical: chosen.canonical };
    }
    const postId = r.data && r.data.post && r.data.post.data && r.data.post.data.id;
    store.logActivity(profile.id, { kind: 'news', ok: true, target: chosen.domain, note: 'Posted link to f/' + chosen.rule.subFeddit + ': ' + noteCore, postId });
    return { acted: true, action: 'news', ok: true, feddit: chosen.rule.subFeddit, domain: chosen.domain, headline: chosen.title, title, canonical: chosen.canonical, postId };
  }

  // Run the news pick (steps 1-4) for the UI preview button without posting.
  async function previewNews(profileId) {
    const p = store.getProfile(profileId);
    if (!p) return { ok: false, error: 'No such profile' };
    if (p.botType !== 'news') return { ok: false, error: 'Not a news profile' };
    return decideNews(p, store.getSettings(), { preview: true });
  }

  // Decide and perform (at most) one action for one profile.
  async function maybeAct(profileId, settings) {
    const p = store.getProfile(profileId);
    if (!p || !p.enabled) return null;   // per-profile enable honoured live
    if (!p.token) return null;           // can't operate without a bearer token
    const t = now();
    const s = freshSched(p.id);
    if (s.backoffUntil && t < s.backoffUntil) return null; // 429 back-off in effect

    ensureTimers(p);
    const sc = freshSched(p.id);

    const cap = caps(p);
    const canPost = cap.canPost && effRate(p.postsPerHour, 'post') > 0;
    const canComment = cap.canComment && effRate(p.commentsPerHour, 'comment') > 0;
    const postDue = canPost && sc.nextPostAt != null && t >= sc.nextPostAt;
    const commentDue = canComment && sc.nextCommentAt != null && t >= sc.nextCommentAt;
    if (!postDue && !commentDue) return null;

    let action;
    if (postDue && commentDue) {
      action = (t - sc.nextPostAt) >= (t - sc.nextCommentAt) ? 'post' : 'comment'; // whichever is more overdue
    } else {
      action = postDue ? 'post' : 'comment';
    }
    if (action === 'post') {
      return p.botType === 'news' ? decideNews(p, settings, {}) : doPost(p, settings);
    }
    return doComment(p, settings);
  }

  // Runner-wide monthly spend vs the cap. Returns { monthUsd, cap, overCap }.
  function spendState(settings) {
    const t = now();
    const monthUsd = store.runnerSpend(cost.monthKey(t), cost.dayKey(t)).monthUsd;
    const cap = Number(settings.monthlyCapUsd);
    const capActive = Number.isFinite(cap) && cap >= 0;
    return { monthUsd, cap: capActive ? cap : null, overCap: capActive && monthUsd >= cap };
  }

  async function tickBody() {
    const settings = store.getSettings();
    if (settings.paused) return { skipped: 'paused' };          // global pause, honoured live

    const spend = spendState(settings);
    // The ollama gate is LOCAL to ollama: is our single ollama slot busy right
    // now (e.g. a UI test-generate)? This only affects ollama profiles.
    const ollamaBusy = providers.ollamaBusy && providers.ollamaBusy();

    // Split the enabled profiles by provider so the two provider policies run in
    // parallel: ollama serialised through its single-flight gate, deepseek
    // concurrent (and skipped entirely while over the monthly cap).
    const ollamaDue = [];
    const deepseekDue = [];
    for (const listed of store.listProfiles()) {
      if (!listed.enabled) continue;
      if (providerOf(listed) === 'deepseek') deepseekDue.push(listed);
      else ollamaDue.push(listed);
    }

    // Ollama: sequential, at most ONE generation in flight, ever. If the slot is
    // busy we skip ONLY these profiles this tick - deepseek is unaffected.
    const ollamaRun = (async () => {
      const out = [];
      if (ollamaBusy) return ollamaDue.map((p) => ({ skipped: 'ollama-busy', id: p.id }));
      let count = 0;
      for (const listed of ollamaDue) {
        if (count >= MAX_OLLAMA_PER_TICK) break;
        const r = await maybeAct(listed.id, settings);
        if (r && r.acted) { count++; out.push(r); }
      }
      return out;
    })();

    // Deepseek: all due profiles concurrently (the providers facade caps real
    // concurrency). Skipped wholesale while month-to-date spend is over the cap.
    const deepseekRuns = deepseekDue.map((listed) => {
      if (spend.overCap) return Promise.resolve({ skipped: 'spend-cap', id: listed.id });
      return maybeAct(listed.id, settings);
    });

    const [ollamaResults, deepseekResults] = await Promise.all([
      ollamaRun,
      Promise.all(deepseekRuns),
    ]);

    const results = [...ollamaResults, ...deepseekResults].filter(Boolean);
    const acted = results.filter((r) => r && r.acted).length;
    return { acted, results, spend };
  }

  async function runTick() {
    if (ticking) return { skipped: 'reentrant' };
    ticking = true;
    try {
      return await tickBody();
    } catch (e) {
      log('scheduler tick error: ' + e.message);
      return { error: e.message };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (handle) return api;
    log('scheduler started (dry-run ' + (store.getSettings().dryRun ? 'ON' : 'off') + '; honours pause/enable live)');
    handle = setInterval(() => { runTick(); }, TICK_MS);
    if (handle && handle.unref) handle.unref(); // don't keep the process alive on our own
    return api;
  }

  function stop() { if (handle) { clearInterval(handle); handle = null; } }

  const api = { start, stop, runTick, nextAction, previewNews, tickMs: TICK_MS };
  return api;
}

// Convenience for the SCHEDULER SEAM: create + start with the default clock.
function start(deps) {
  const s = createScheduler(deps);
  s.start();
  return s;
}

module.exports = {
  start,
  createScheduler,
  nextAction,
  // exported for the harness / tests
  splitPost,
  flattenComments,
  providerOf,
  modelOf,
  buildSystem,
  caps,
  matchRule,
  normalizeRules,
  pickArticle,
  isPaywalled,
  cleanTitle,
  parseShortlistIndex,
  timespanHours,
  THREAD_CAP,
  SERVER,
  MAX_OLLAMA_PER_TICK,
  PAYWALL_DOMAINS,
};
