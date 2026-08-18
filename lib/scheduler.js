'use strict';

// Posting/replying loop for the Feddit bot runner. Dropped into the SCHEDULER
// SEAM in server.js via start({ store, ollama, feddit }).
//
// SHAPE: a single timer fires runTick() every TICK_MS. Each tick walks the
// ENABLED profiles and, for each one that is DUE, performs exactly one action:
// submit a new post, or reply to something. Everything the loop needs comes from
// the three injected modules; nothing else in the server has to change.
//
// HARD RULES baked in here:
//  - ONE generation in flight, ever. Generations are awaited sequentially and we
//    bail the whole tick if ollama is already busy (e.g. Cy or the UI's
//    test-generate). Combined with lib/ollama's own single-flight gate and
//    keep_alive: -1, Cy's resident model is never queued behind us or evicted.
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

const TICK_MS = 20_000;              // how often the loop wakes (production)
const ROLLING_WINDOW_MS = 3_600_000; // 1 hour, matches the server's rate window
const SERVER = { postsPerHour: 10, commentsPerHour: 60 }; // hard per-bot ceiling
const JITTER = 0.4;                  // cadence spread: interval * uniform(0.6 .. 1.4)
const THREAD_CAP = 3;                // max this-runner replies in one post's thread
const MAX_ACTIONS_PER_TICK = 3;      // politeness cap so one tick can't marathon Cy
const MAX_FEDDITS_SCAN = 4;          // read at most this many sub-feddits when targeting
const DEFAULT_BACKOFF_SEC = 900;     // fallback 429 back-off if no reset time given

// ---- pure helpers (no deps) -------------------------------------------------

// What the UI shows as "next scheduled action" for a profile. Pure: reads the
// stored sched timers + mode, no clock needed.
function nextAction(profile) {
  const s = (profile && profile.sched) || {};
  const canPost = profile.mode === 'both' || profile.mode === 'post';
  const canComment = profile.mode === 'both' || profile.mode === 'comment';
  const opts = [];
  if (canPost && s.nextPostAt != null && (Number(profile.postsPerHour) || 0) > 0) {
    opts.push({ kind: 'post', at: s.nextPostAt });
  }
  if (canComment && s.nextCommentAt != null && (Number(profile.commentsPerHour) || 0) > 0) {
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
  const { store, ollama, feddit } = deps;
  const now = deps.now || Date.now;
  const random = deps.random || Math.random;
  const log = deps.log || (() => {});

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
    const canPost = profile.mode === 'both' || profile.mode === 'post';
    const canComment = profile.mode === 'both' || profile.mode === 'comment';
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

  function generate(profile, task) {
    return ollama.generate({
      model: profile.model || store.DEFAULT_MODEL,
      persona: profile.persona,
      toneNotes: profile.toneNotes,
      task,
      temperature: Number(profile.temperature) || 0.8,
      numPredict: Number(profile.numPredict) || 200,
    });
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

    const { title, body } = splitPost(gen.content);
    store.updateSched(profile.id, { nextPostAt: scheduleNext('post', profile) });

    if (settings.dryRun) {
      recordSend(profile, 'post');
      store.logActivity(profile.id, { kind: 'post', dryRun: true, ok: true, target: 'f/' + fName, note: 'DRY-RUN would post: ' + snippet(title) });
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
    store.logActivity(profile.id, { kind: 'post', ok: true, target: 'f/' + fName, note: 'Posted: ' + snippet(title), postId });
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

    const text = String(gen.content || '').trim().slice(0, 10_000);
    store.updateSched(profile.id, { nextCommentAt: scheduleNext('comment', profile) });

    if (settings.dryRun) {
      // Record dedupe + thread + send so dry-run behaves exactly like live.
      store.recordReplied(profile.id, target.key);
      store.bumpThreadReply(target.postId);
      recordSend(profile, 'comment');
      store.logActivity(profile.id, { kind: 'comment', dryRun: true, ok: true, target: target.label, note: 'DRY-RUN would reply: ' + snippet(text) });
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
    store.logActivity(profile.id, { kind: 'comment', ok: true, target: target.label, note: 'Replied to ' + target.key + ': ' + snippet(text) });
    return { acted: true, action: 'comment', ok: true, target: target.key };
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

    const canPost = (p.mode === 'both' || p.mode === 'post') && effRate(p.postsPerHour, 'post') > 0;
    const canComment = (p.mode === 'both' || p.mode === 'comment') && effRate(p.commentsPerHour, 'comment') > 0;
    const postDue = canPost && sc.nextPostAt != null && t >= sc.nextPostAt;
    const commentDue = canComment && sc.nextCommentAt != null && t >= sc.nextCommentAt;
    if (!postDue && !commentDue) return null;

    let action;
    if (postDue && commentDue) {
      action = (t - sc.nextPostAt) >= (t - sc.nextCommentAt) ? 'post' : 'comment'; // whichever is more overdue
    } else {
      action = postDue ? 'post' : 'comment';
    }
    return action === 'post' ? doPost(p, settings) : doComment(p, settings);
  }

  async function tickBody() {
    const settings = store.getSettings();
    if (settings.paused) return { skipped: 'paused' };          // global pause, honoured live
    if (ollama.isBusy && ollama.isBusy()) return { skipped: 'ollama-busy' }; // never queue behind Cy/UI

    const results = [];
    let actions = 0;
    for (const listed of store.listProfiles()) {
      if (!listed.enabled) continue;
      if (actions >= MAX_ACTIONS_PER_TICK) break;
      const r = await maybeAct(listed.id, settings);
      if (r && r.acted) { actions++; results.push(r); }
    }
    return { acted: actions, results };
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

  const api = { start, stop, runTick, nextAction, tickMs: TICK_MS };
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
  THREAD_CAP,
  SERVER,
};
