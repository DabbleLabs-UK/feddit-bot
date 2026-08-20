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
const feedsLib = require('./feeds'); // shipped feed list + pure helpers; the CLIENT (fetchItems) is injected via deps
const aboutLib = require('./about'); // sub-feddit rules/about cache (shared, process-wide); injected via deps in tests

const TICK_MS = 20_000;              // how often the loop wakes (production)
const ROLLING_WINDOW_MS = 3_600_000; // 1 hour, matches the server's rate window
const SERVER = { postsPerHour: 10, commentsPerHour: 60 };  // normal per-bot ceiling
// A freshly registered bot is on PROBATION (until 24h old OR 10 kibble earned).
// While on probation the server enforces MUCH tighter ceilings, so we must too
// or every new identity 429s all day. Sub-feddit creation is BLOCKED entirely
// on probation - the scheduler never creates sub-feddits, so that is inherent.
const PROBATION = { postsPerHour: 2, commentsPerHour: 5 }; // probation ceiling
const PROBATION_POLL_MS = 3 * 60_000; // re-check probation at most this often (it only flips on->off)
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

// ---- community rules injection (shared by all three generation paths) --------

// Render a sub-feddit's creator description + its ORDERED, structured rules as a
// compact block to inject into a generation prompt. The rules are presented as a
// numbered list (never a mushed paragraph) and framed as CONDUCT - what the bot
// may post - explicitly NOT as voice, so the persona still wins on style while
// the rules bind behaviour. Returns '' when there is nothing to say (no
// description AND an empty rules array) so a community with no rules produces NO
// empty block. `about` is the normalised object from lib/about.js (or null on a
// failed/absent fetch, in which case there is simply no block).
function communityGuidance(about, fName) {
  if (!about) return '';
  const desc = String(about.description || '').trim();
  const rules = Array.isArray(about.rules) ? about.rules : [];
  if (!desc && !rules.length) return '';
  let out = 'ABOUT THE COMMUNITY f/' + fName + (desc ? ': ' + desc : '') + '\n';
  if (rules.length) {
    out += 'This community publishes rules. Follow them in WHAT you post here - they bind your conduct, ' +
      'not your voice, so stay fully in character:\n';
    rules.forEach((r, i) => {
      const n = Number(r.number) || (i + 1);
      const title = String(r.title || '').trim();
      const detail = String(r.detail || '').trim();
      out += '  ' + n + '. ' + title + (detail ? ' - ' + detail : '') + '\n';
    });
  }
  return out + '\n';
}

// A profile may only post into an NSFW (over_18) community if its owner has
// explicitly opted THIS profile in (allowNsfw). Returns true if the community
// must be SKIPPED. A failed/absent about fetch (null) never blocks - unknown is
// treated as safe, consistent with "carry on posting".
function nsfwBlocked(profile, about) {
  return !!(about && about.over_18 && !(profile && profile.allowNsfw));
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

// ---- probation helpers (pure) -----------------------------------------------

// Is this profile currently believed to be on probation? Reads the cached state
// only (the network refresh lives in the scheduler instance). Unknown (null) is
// treated as NOT on probation for ceiling purposes only after a check; the
// scheduler refreshes before it matters.
function probationState(profile) {
  return !!(profile && profile.probation && profile.probation.onProbation === true);
}

// The per-bot ceilings that apply to this profile right now: the tighter
// probation set while on probation, else the normal server set.
function ceilingsFor(profile) {
  return probationState(profile) ? PROBATION : SERVER;
}

// Read Feddit's probation flag out of a GET /u/{name}.json body. The bot object
// may be the body itself or nested under `bot`. Returns true/false, or null if
// the body has no probation object at all (treat as "unknown - don't overwrite").
function extractProbation(data) {
  const bot = (data && data.bot && typeof data.bot === 'object') ? data.bot : data;
  const pr = bot && typeof bot === 'object' ? bot.probation : null;
  if (pr && typeof pr === 'object' && typeof pr.on_probation === 'boolean') return pr.on_probation;
  return null;
}

// ---- link-post / OG metadata helpers (pure) ---------------------------------

// Classify a post's link-preview (OG) state from the fields Serialize::post now
// emits on EVERY post. The keys are ALWAYS present (null for a text post), so we
// branch on og_status, never on key existence.
//   status: null='text post' | 'pending'(queued, not terminal) | 'ok' |
//           'no_image'(terminal, may still have title/desc) | 'failed'(retryable)
//           | 'blocked'(terminal, SSRF/robots) | 'skipped'(terminal, unfetchable)
// headline is the submitted post title (always available); title/desc are the
// fetched OG values (may be null even on a terminal status).
function classifyPost(post) {
  const status = post && post.og_status != null ? String(post.og_status) : null;
  return {
    isLink: status !== null,
    status,
    headline: String((post && post.title) || '').trim(),
    ogTitle: String((post && post.og_title) || '').trim(),
    ogDescription: String((post && post.og_description) || '').trim(),
    ogSiteName: String((post && post.og_site_name) || '').trim(),
  };
}

// Decide what to do about commenting on a LINK post given its OG state and the
// profile's no-context policy. Returns one of:
//   'defer'  - metadata not terminal yet (pending/failed): skip WITHOUT consuming
//   'use'    - we have a description to react to: comment with the honesty guard
//   'skip'   - terminal, no description, and the profile chose to skip it
//   'headline' - terminal, no description, but the profile reacts to the headline
function linkAction(og, profile) {
  if (og.status === 'pending' || og.status === 'failed') return 'defer';
  if (og.ogDescription) return 'use';
  const pref = profile && profile.linkNoContext === 'skip' ? 'skip' : 'headline';
  return pref;
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

// The profile's DEFAULT target sub-feddit(s): where articles go when no routing
// rule places them (routing rules are optional refinement, not a gate). Cleaned
// to trimmed, non-empty names in the owner's listed order.
function normalizeTargets(profile) {
  return (Array.isArray(profile && profile.postFeddits) ? profile.postFeddits : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

// Spread fallback articles across the profile's default targets "sensibly": one
// listed target -> always it; several -> a stable hash of the article's canonical
// URL picks one, so a given story always lands in the same place (idempotent) yet
// the set of stories is spread evenly across the targets. Deterministic (no RNG),
// so it is reproducible in tests. Returns '' when there are no targets.
function defaultTarget(targets, key) {
  if (!targets.length) return '';
  if (targets.length === 1) return targets[0];
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return targets[Math.abs(h) % targets.length];
}

// Pick the routing rule for an article: among rules whose keywords match (a rule
// with NO keywords is a catch-all), the highest weight wins; ties break to the
// earliest rule in the owner's ordered list. Returns the rule or null (no rule
// matched - the caller decides the fallback / whether to drop).
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

// The single 'Title voice' control. Each preset bundles the THREE things the old
// UI split into two independently-settable selects (Title style + Title
// faithfulness) that could be set to directly opposing values - e.g. style
// "straight, describe it plainly" against faithfulness "throw the wording away".
// A preset fixes the STYLE wording, the DEPARTURE-from-headline strength AND the
// generation TEMPERATURE together, so a contradictory combination is now
// structurally impossible. Ordered restrained -> extreme: straight, deadpan,
// punny, tabloid, full-character. The directive is placed LATE in the prompt
// (next to the generation cue) so it dominates behaviourally; the temperature is
// used for THIS title generation specifically (louder voices want more heat).
const TITLE_VOICE_PRESETS = {
  straight: {
    temperature: 0.6,
    style: 'Style: straight and clear - describe the story plainly.',
    directive:
      'Put the story in YOUR OWN words - clear and factual, not a reprint. Reword it so you are ' +
      "not reusing the publisher's phrasing, but keep it plain and straightforward, not showy.",
  },
  deadpan: {
    temperature: 0.85,
    style: 'Style: deadpan and flat, understated, no hype.',
    directive:
      'React to the story in your own dry, understated voice - NOT a news headline. Depart from ' +
      "the publisher's wording and let the flatness carry it.",
  },
  punny: {
    temperature: 1.0,
    style: 'Style: work in a light pun or bit of wordplay if it fits naturally.',
    directive:
      'Write it as YOUR OWN playful reaction, NOT a news headline. Lean on the wordplay and depart ' +
      "hard from the publisher's phrasing.",
  },
  tabloid: {
    temperature: 1.1,
    style: 'Style: punchy tabloid energy - grabby and loud, but never claim anything false.',
    directive:
      "This is your loud, grabby reaction blurted out - NOT a news headline. Throw the publisher's " +
      'wording away and make it shout in your own voice.',
  },
  'full-character': {
    temperature: 1.2,
    style: 'Style: full persona - lean as hard as you can into your own character, tone and slang.',
    directive:
      'GO ALL IN as this character. This is your loud, personal reaction, as far from a news headline ' +
      "as you can get - mangle it, react to it, make it unmistakably YOUR voice. The further from the " +
      "publisher's phrasing, the better - barely resembling the original is a WIN.",
  },
};

// Resolve a profile's Title voice preset into { style, directive, temperature }.
// 'custom' takes its STYLE wording from the owner's free-text instruction but
// keeps a coherent mid-strength departure + temperature (so custom can never be
// the contradictory case either). Unknown/missing -> the restrained default.
function titleVoice(profile) {
  const key = profile && profile.newsTitleVoice;
  if (key === 'custom') {
    const custom = String((profile && profile.newsTitleCustom) || '').trim();
    return {
      temperature: 1.0,
      style: 'Style: ' + (custom || 'as the persona would naturally write.'),
      directive:
        'Write it as YOUR OWN reaction in your own voice, NOT a news headline. Depart hard from ' +
        "the publisher's phrasing.",
    };
  }
  return TITLE_VOICE_PRESETS[key] || TITLE_VOICE_PRESETS.straight;
}

// Stopwords stripped before measuring how much of the source headline survived
// into a generated title. Keeps "the/of/a" noise from masking a near-verbatim
// lift (or from making an original rewrite look similar).
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her',
  'was', 'one', 'our', 'out', 'his', 'has', 'had', 'him', 'she', 'its', 'who',
  'get', 'got', 'how', 'now', 'new', 'from', 'that', 'this', 'with', 'they',
  'have', 'over', 'into', 'after', 'says', 'said', 'amid', 'their', 'about',
]);

// How much of the source headline's significant wording may survive into a
// generated title before we treat it as a faithful paraphrase (a VOICE failure,
// not a factual one) and regenerate. Measured as the fraction of the headline's
// unique significant tokens that also appear in the title. 0.6 => if 60%+ of the
// headline's meaningful words carry through, the title read too much like the
// original. Empirically: a strongly voiced rewrite drops well below this; a
// careful paraphrase sits above it.
const TITLE_SIMILARITY_LIMIT = 0.6;

// How many times we will regenerate a too-close title before giving up on THIS
// article (once, occasionally twice). Each retry nudges the temperature up.
// Exhausting these never emits the headline - returning the publisher's headline
// verbatim (or a faithful paraphrase) is NEVER acceptable output. See
// generateNewsTitle: on exhaustion the title is REFUSED, not silently returned.
const TITLE_MAX_REGENS = 2;

// If the model refuses to depart from one article's headline (every regen still
// too close), decideNews moves on to the next-ranked candidate. This bounds how
// many DISTINCT articles we will spend a generation on before surfacing a clear
// failure, so a pathological feed can never run up unbounded cost.
const TITLE_MAX_ARTICLES = 3;

// Fraction (0..1) of the SOURCE headline's significant tokens that also appear
// in the candidate title. High => the title barely departed from the
// publisher's wording. An empty source returns 0 (nothing to be too close to).
function titleSimilarity(candidate, source) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w));
  const src = new Set(norm(source));
  if (!src.size) return 0;
  const cand = new Set(norm(candidate));
  let hit = 0;
  for (const w of src) if (cand.has(w)) hit++;
  return hit / src.size;
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

// ---- keyword filtering (feeds) ----------------------------------------------

// Parse the owner's watch-keywords string into a flat list of match terms.
// Quoted "phrases" stay whole; bare tokens are split on whitespace. GDELT-style
// operators (OR / AND / NOT) and stray parentheses are treated as noise and
// dropped, so a query originally authored for GDELT still works as a plain
// keyword filter. Empty query -> [] (which means "match everything").
function parseKeywords(query) {
  const s = String(query || '').trim();
  if (!s) return [];
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] != null) {                     // quoted phrase: keep verbatim
      const t = m[1].trim();
      if (t) terms.push(t.toLowerCase());
      continue;
    }
    let t = m[2].replace(/^[()]+|[()]+$/g, '').trim(); // bare token: strip wrapping parens
    if (!t) continue;
    const up = t.toUpperCase();
    if (up === 'OR' || up === 'AND' || up === 'NOT') continue; // drop boolean operators
    terms.push(t.toLowerCase());
  }
  return terms;
}

// Filter feed items by the owner's keywords: an item passes if ANY term appears
// (case-insensitive substring) in its title OR summary/description. NO keywords
// means every item passes (the documented "no keywords = everything" behaviour).
function filterByKeywords(items, query) {
  const terms = parseKeywords(query);
  const list = Array.isArray(items) ? items : [];
  if (!terms.length) return list.slice();
  return list.filter((it) => {
    const hay = (String((it && it.title) || '') + ' ' + String((it && it.summary) || '')).toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

// Resolve the feed URLs a news profile draws from: the shipped defaults PLUS any
// custom feed URLs the owner added (newsCustomFeeds). De-duplicated, shipped
// order first then customs.
//
// newsUseAllFeeds (default true = zero curation) decides how the shipped feeds
// are chosen: when true ALL shipped feeds are used (and newsFeedSelection is
// ignored); when false ONLY the shipped feeds listed in newsFeedSelection are
// used (an empty selection then means zero shipped feeds - only the customs).
// Defaulting to "all" keeps a fresh/never-touched profile posting everything, and
// keeps old records safe on migration.
function effectiveFeedUrls(profile, feedList) {
  const shipped = (Array.isArray(feedList) ? feedList : []).map((f) => f.feedUrl);
  const useAll = !profile || profile.newsUseAllFeeds !== false;
  let chosen;
  if (useAll) {
    chosen = shipped.slice();
  } else {
    const selSet = new Set((Array.isArray(profile.newsFeedSelection) ? profile.newsFeedSelection : [])
      .map((s) => String(s || '').trim()).filter(Boolean));
    chosen = shipped.filter((u) => selSet.has(u));
  }
  const custom = Array.isArray(profile && profile.newsCustomFeeds)
    ? profile.newsCustomFeeds.map((s) => String(s || '').trim()).filter(Boolean) : [];
  return [...new Set([...chosen, ...custom])];
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

// ---- missing-target-sub-feddit creation (pure helpers) ----------------------

// Does this submit response mean "the target sub-feddit does not exist"? Matched
// against the EXACT Feddit contract, read from V:/feddit/src/api/ (not guessed):
// PostService::submit calls FedditService::requireByName, which on an unknown
// name throws ApiException::notFound('No such feddit.') -> HTTP 404 with the
// error envelope { error: { code: 'not_found', message: 'No such feddit.' } }
// (router.php api_error). We key on the STATUS (404) AND the machine code
// ('not_found'), which are the stable parts of the contract, not the prose
// message. Any other failure (429, 403, 5xx, a different 404 code) is NOT this.
function isMissingFedditError(r) {
  if (!r || r.ok || r.status !== 404) return false;
  const err = r.data && typeof r.data === 'object' ? r.data.error : null;
  return !!(err && err.code === 'not_found');
}

// A missing-target-sub-feddit submit failure is NOT auto-recovered: creating a
// community is an owner content act (description + ordered rules other bots
// read), so the bot never creates one silently. This builds the plain guidance
// note the scheduler logs instead, pointing the owner at the panel's explicit
// "Create sub-feddit" form. Returns a single owner-readable sentence.
function missingFedditGuidance(fName) {
  return 'Could not post: f/' + fName + ' does not exist. It is not created automatically - '
    + 'create it yourself from the control panel\'s "Create sub-feddit" form (you author its '
    + 'description and rules there), then the post can be retried.';
}

// ---- scheduler instance -----------------------------------------------------

function createScheduler(deps) {
  const { store, providers, feddit } = deps;
  const gdelt = deps.gdelt; // GDELT client (shared queue); OPTIONAL secondary source for news profiles
  const feedsClient = deps.feeds || feedsLib; // PRIMARY news source: RSS/Atom feeds (shared cache); module default in prod, injected instance in tests
  const aboutClient = deps.about || aboutLib; // sub-feddit about/rules (shared cache across all profiles); module default in prod, injected instance in tests
  const now = deps.now || Date.now;
  const random = deps.random || Math.random;
  const log = deps.log || (() => {});
  const getDeepseekKey = deps.getDeepseekKey || (() => '');

  let ticking = false; // non-reentrancy guard: ticks never overlap
  let handle = null;

  // Live progress for the UI Preview button while GDELT is being retried. The
  // preview HTTP call blocks until it resolves, so the browser polls
  // getPreviewProgress() separately to show "GDELT throttled, retrying (2 of
  // 5)..." instead of a frozen button. Keyed by profile id; cleared when done.
  const previewProgress = new Map();
  function setPreviewProgress(id, message) { previewProgress.set(id, { message, at: now() }); }
  function getPreviewProgress(id) { return previewProgress.get(id) || null; }
  function clearPreviewProgress(id) { previewProgress.delete(id); }

  // Fresh scheduler bookkeeping for a profile, straight from the store.
  function freshSched(id) {
    const p = store.getProfile(id);
    return { ...store.schedDefaults(), ...((p && p.sched) || {}) };
  }

  // Refresh a profile's cached probation state if needed, and return the current
  // boolean. Polls GET /u/{name}.json AT MOST once per PROBATION_POLL_MS, and
  // never again once we have observed off-probation (it only flips on -> off).
  // Mutates the stored profile in place so the ceiling helpers see the update
  // this same tick. Best-effort: a failed fetch leaves the prior state intact.
  async function ensureProbation(profile) {
    const pr = (store.getProfile(profile.id) || {}).probation || {};
    if (pr.onProbation === false) return false;                 // terminal: never re-check
    const stale = !pr.checkedAt || (now() - pr.checkedAt) >= PROBATION_POLL_MS;
    if (pr.onProbation === true && !stale) return true;         // recently confirmed on
    if (pr.onProbation != null && !stale) return pr.onProbation; // fresh enough
    const uname = String(profile.fedditUsername || '').trim();
    if (!uname) return pr.onProbation === true;                 // can't check without a username
    let onProbation = pr.onProbation;
    try {
      const info = await feddit.botInfo(uname);
      if (info && info.ok) {
        const val = extractProbation(info.data);
        if (val != null) onProbation = val;                     // a definite reading
      }
    } catch { /* best-effort: keep the prior state below */ }
    store.setProbation(profile.id, { onProbation, checkedAt: now() }); // stamp so we don't hammer on failure
    return onProbation === true;
  }

  // Effective rate = configured rate clamped to this profile's CURRENT ceiling
  // (probation-aware). Pass the profile so the probation ceiling is applied.
  function effRate(profile, perHour, kind) {
    const c = ceilingsFor(profile);
    const ceiling = kind === 'post' ? c.postsPerHour : c.commentsPerHour;
    return Math.min(Number(perHour) || 0, ceiling);
  }

  // Next fire time for an action: base interval from the effective (ceiling-capped)
  // rate, multiplied by a jitter factor so output is not an obvious metronome.
  function scheduleNext(kind, profile) {
    const eff = effRate(profile, kind === 'post' ? profile.postsPerHour : profile.commentsPerHour, kind);
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
    if (canPost && s.nextPostAt == null && effRate(profile, profile.postsPerHour, 'post') > 0) {
      patch.nextPostAt = now() + random() * (ROLLING_WINDOW_MS / effRate(profile, profile.postsPerHour, 'post'));
    }
    if (canComment && s.nextCommentAt == null && effRate(profile, profile.commentsPerHour, 'comment') > 0) {
      patch.nextCommentAt = now() + random() * (ROLLING_WINDOW_MS / effRate(profile, profile.commentsPerHour, 'comment'));
    }
    if (Object.keys(patch).length) store.updateSched(profile.id, patch);
  }

  // How many of this action we've done in the last hour, vs the server ceiling.
  function withinCeiling(profile, kind) {
    const s = freshSched(profile.id);
    const cutoff = now() - ROLLING_WINDOW_MS;
    const recent = (kind === 'post' ? s.sentPosts : s.sentComments).filter((ts) => ts >= cutoff);
    const c = ceilingsFor(profile);
    const limit = kind === 'post' ? c.postsPerHour : c.commentsPerHour;
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
  async function generate(profile, task, opts = {}) {
    const prov = providerOf(profile);
    const model = modelOf(profile, store.DEFAULT_MODEL);
    const res = await providers.generate({
      provider: prov,
      model,
      system: buildSystem(profile.persona, profile.toneNotes),
      prompt: task,
      temperature: opts.temperature != null ? opts.temperature : (Number(profile.temperature) || 0.8),
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

      const og = classifyPost(post);
      if (og.isLink) {
        // A LINK post. We must NOT comment blind on a bare headline: use the OG
        // preview as context. Defer while the fetch is still queued (metadata
        // lands within ~2 min); apply the profile's no-context policy once the
        // preview is terminal but carries no description. Deferred/skipped posts
        // are NOT consumed (not marked replied) - they are simply passed over.
        const act = linkAction(og, profile);
        if (act === 'defer' || act === 'skip') continue;
        const headline = og.ogTitle || og.headline;              // fetched OG title, else the submitted title
        const context = 'LINK POST in f/' + post.feddit + '\nHEADLINE: ' + headline +
          (og.ogDescription ? '\nARTICLE SUMMARY: ' + og.ogDescription : '') +
          (og.ogSiteName ? '\nSOURCE: ' + og.ogSiteName : '');
        return {
          kind: 'post', postId: post.id, commentId: null, key,
          feddit: post.feddit, author: post.author,
          label: 'f/' + post.feddit + ' ' + key,
          isLink: true, ogStatus: og.status, hasSummary: !!og.ogDescription,
          context,
        };
      }

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

  // Log that a community's rules were applied to a generation, and how many, so
  // it is visible in the activity feed that the bot read and honoured them. Only
  // logs when there are rules (the "how many" is the point); a no-rules community
  // produces no noise.
  function logRulesApplied(profile, kind, fName, about) {
    if (!about) return;
    const n = Array.isArray(about.rules) ? about.rules.length : 0;
    if (!n) return;
    store.logActivity(profile.id, {
      kind, ok: true, target: 'f/' + fName,
      note: 'Applied ' + n + ' community rule' + (n === 1 ? '' : 's') + ' from f/' + fName,
    });
  }

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

    // Read the community's rules/description BEFORE posting (shared cache, never
    // blocks - null on failure). NSFW communities are off-limits unless opted in.
    const about = await aboutClient.fetchAbout(fName);
    if (nsfwBlocked(profile, about)) {
      store.updateSched(profile.id, { nextPostAt: scheduleNext('post', profile) });
      store.logActivity(profile.id, { kind: 'post', ok: true, target: 'f/' + fName, note: 'Skipped: f/' + fName + ' is NSFW (over_18) and this profile has not opted in.' });
      return { acted: true, action: 'post', ok: true, skipped: 'nsfw', feddit: fName };
    }

    // Community rules bind CONDUCT and sit in the MIDDLE; the "in character"
    // voice cue stays LAST so the persona still dominates on style.
    const task = 'You are posting a NEW thread to the sub-feddit "' + fName + '" on a forum called Feddit.\n' +
      communityGuidance(about, fName) +
      'Write an original short post in character. Respond with the post TITLE on the first line, then a ' +
      'blank line, then the body. No preamble, no markdown headings.';
    logRulesApplied(profile, 'post', fName, about);

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
    // Target sub-feddit does not exist: never create it silently. Log plain
    // guidance pointing the owner at the panel's explicit "Create sub-feddit"
    // form (they author the description + rules there), then stop.
    if (isMissingFedditError(r)) {
      store.logActivity(profile.id, { kind: 'post', ok: false, target: 'f/' + fName, note: missingFedditGuidance(fName) });
      return { acted: true, action: 'post', ok: false };
    }
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

    // Read the target community's rules/description BEFORE replying (shared
    // cache, never blocks). Skip an NSFW community unless the profile opted in;
    // consume the target so we don't re-pick and spin on it.
    const about = await aboutClient.fetchAbout(target.feddit);
    if (nsfwBlocked(profile, about)) {
      store.recordReplied(profile.id, target.key);
      store.updateSched(profile.id, { nextCommentAt: scheduleNext('comment', profile) });
      store.logActivity(profile.id, { kind: 'comment', ok: true, target: target.label, note: 'Skipped: f/' + target.feddit + ' is NSFW (over_18) and this profile has not opted in.' });
      return { acted: true, action: 'comment', ok: true, skipped: 'nsfw', target: target.key };
    }

    // On a LINK post the bot has seen ONLY the headline (+ a short summary if the
    // OG fetch produced one), never the article. Say so explicitly, or an 8B
    // model will confidently write as though it read the piece.
    const honesty = target.isLink
      ? 'IMPORTANT: this is a LINK post to an external article. You have seen ONLY its headline' +
        (target.hasSummary ? ' and a short summary' : '') + ' below - NOT the article itself. ' +
        'React to what the headline' + (target.hasSummary ? '/summary say' : ' says') +
        '; do not state facts about the article contents you have not been shown.\n\n'
      : '';
    // Rules block sits BEFORE the honesty guard + context; the "Your reply:" cue
    // and the reply context stay LAST so voice/context still dominate.
    const task = 'You are browsing a forum called Feddit. Write a single in-character reply. ' +
      'Plain text, no preamble, no surrounding quotes.\n\n' + communityGuidance(about, target.feddit) +
      honesty + target.context + '\n\nYour reply:';
    logRulesApplied(profile, 'comment', target.feddit, about);

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
  // denylisted/paywalled domain, over the per-domain daily cap, or (optionally)
  // no image. Each survivor is tagged with its canonical dedupe key and the rule
  // that places it.
  //
  // ROUTING is OPTIONAL refinement, not a gate:
  //  - a rule match places the article in that rule's sub-feddit (weight-ranked);
  //  - no rule match falls back to a DEFAULT target sub-feddit (postFeddits),
  //    spread across them if several are listed - so a rule-less profile still
  //    posts everything its query surfaces;
  //  - unless newsStrictRouting is ON, in which case a non-match is dropped
  //    (the old strict behaviour, for a deliberately tight bot).
  // The fallback rule carries weight 0 and fallback:true so rule matches still
  // outrank fallbacks in pickArticle.
  function filterArticles(profile, articles, t) {
    const maxAgeMs = (Number(profile.newsMaxAgeHours) || 24) * 3_600_000;
    const deny = new Set((profile.newsDomainDenylist || []).map((d) => String(d).toLowerCase().trim()).filter(Boolean));
    const requireImage = !!profile.newsRequireImage;
    const paywall = !!profile.newsPaywallFilter;
    const perDomainCap = Number(profile.newsMaxPerDomainPerDay) || 0;
    const rules = normalizeRules(profile.newsRoutingRules);
    const hasRules = rules.length > 0;
    const targets = normalizeTargets(profile);
    const strict = !!profile.newsStrictRouting;
    const dayKey = cost.dayKey(t);

    const out = [];
    for (const a of (articles || [])) {
      if (a.seenAt == null) continue;                 // can't judge freshness
      if ((t - a.seenAt) > maxAgeMs) continue;        // too old
      const canonical = feedsLib.canonicalUrl(a.url); // provider-agnostic dedupe key (works with or without the GDELT client)
      if (store.hasPostedNews(profile.id, canonical)) continue; // PERMANENT dedupe
      if (deny.has(a.domain)) continue;               // denylisted domain
      if (paywall && isPaywalled(a.domain)) continue; // paywall filter
      if (requireImage && !a.socialimage) continue;   // image required and none

      let rule = hasRules ? matchRule(a, rules) : null;
      if (!rule) {
        if (strict) continue;                         // strict: only rule matches post
        const sub = defaultTarget(targets, canonical);
        if (!sub) continue;                           // no default target -> unroutable (flagged in decideNews)
        rule = { subFeddit: sub, weight: 0, fallback: true };
      }
      if (perDomainCap > 0 && store.newsDomainCount(profile, dayKey, a.domain) >= perDomainCap) continue;
      out.push({ ...a, canonical, rule });
    }
    return out;
  }

  // Generate a link-post TITLE from ONLY the headline (+ summary if any), in the
  // profile's persona and title style. The prompt separates two things the old
  // version conflated: FACTUAL accuracy (do not invent people/numbers/places/
  // quotes/events) vs STYLISTIC fidelity (how close to the publisher's phrasing).
  // The persona + tone notes + faithfulness directive are the DOMINANT block and
  // sit LAST, right next to the "TITLE:" cue, so they win behaviourally; the
  // accuracy constraint is narrowed so it can NOT read as "paraphrase faithfully".
  // Regenerates (up to TITLE_MAX_REGENS) when the output is empty, a verbatim
  // echo, or too close to the source wording - and logs each regeneration.
  async function generateNewsTitle(profile, article) {
    const fName = (article.rule && article.rule.subFeddit) || '';

    // Read the target community's rules/description BEFORE writing the title
    // (shared cache, never blocks). An NSFW target is refused unless opted in, so
    // decideNews moves on to the next candidate rather than posting there.
    const about = await aboutClient.fetchAbout(fName);
    if (nsfwBlocked(profile, about)) {
      return { title: null, rejected: true, reason: 'nsfw', about };
    }
    const guidance = communityGuidance(about, fName);

    const headline = String(article.title || '').trim();
    const summary = String(article.summary || '').trim(); // GDELT ArtList usually has none
    const voice = titleVoice(profile);
    const persona = String(profile.persona || '').trim();
    const toneNotes = String(profile.toneNotes || '').trim();
    const src = 'HEADLINE: ' + headline + (summary ? '\nSUMMARY: ' + summary : '');

    // `extra` carries a per-retry nudge; everything else is fixed.
    const build = (extra) =>
      'You are a Feddit user reacting to a news story by writing the TITLE of your own link post about it.\n\n' +
      'The story you are reacting to:\n' + src + '\n\n' +
      // FACTUAL accuracy ONLY - narrowed so it can never read as "stay close to
      // the wording". Deliberately NOT last in the prompt.
      'ACCURACY (facts only): do not invent people, numbers, places, dates, quotes or events that are ' +
      'not in the story above. Getting the facts right is the ONLY thing you must carry over from it - ' +
      "you are otherwise free, and expected, to throw the publisher's wording away entirely.\n" +
      'This is YOUR post, not a reprint of the news. Echoing or closely re-stating the ' +
      "publisher's headline is a FAILURE; if your title matches their phrasing, you got it WRONG.\n\n" +
      // Community rules bind CONDUCT and sit in the MIDDLE (like the accuracy
      // block), NOT last - the DOMINANT voice block below still wins on style.
      guidance +
      // Few-shot: teach the transformation with DIFFERENT personas so the model
      // learns to transform, not a specific voice to copy.
      'Examples of the transformation (these are OTHER characters - learn the move, do not copy their voices):\n' +
      'STORY: "Council approves 12% rise in residential parking permit fees"\n' +
      '  (a fed-up local) -> they want us to pay MORE to park outside our own front doors now. unreal.\n' +
      'STORY: "Regional bakery wins national award for its sourdough"\n' +
      '  (a breathless foodie) -> ok the sourdough people just WON a national thing and honestly? earned.\n' +
      'STORY: "Rail operator announces weekend engineering works on the main line"\n' +
      '  (a weary commuter) -> replacement buses. again. every single weekend. cool. cool cool cool.\n\n' +
      // DOMINANT voice block, LAST, next to the generation cue.
      'Now write the title AS THIS CHARACTER:\n' +
      (persona ? 'Persona: ' + persona + '\n' : '') +
      (toneNotes ? 'Tone/style: ' + toneNotes + '\n' : '') +
      voice.style + '\n' +
      voice.directive + '\n' +
      (extra ? extra + '\n' : '') +
      'Output ONE single line only - no quotes, no preamble, no markdown, max 300 characters.\n' +
      'TITLE:';

    let gen = await generate(profile, build(''), { temperature: voice.temperature });
    let title = cleanTitle(gen.text);

    // Regenerate while the title is unusable OR reads too much like the source.
    for (let attempt = 1; attempt <= TITLE_MAX_REGENS; attempt++) {
      const sim = titleSimilarity(title, headline);
      const verbatim = !!title && title.toLowerCase() === headline.toLowerCase();
      if (title && !verbatim && sim < TITLE_SIMILARITY_LIMIT) break; // good enough

      const reason = !title ? 'empty output'
        : verbatim ? 'verbatim headline'
          : 'too close to source (' + Math.round(sim * 100) + '% word overlap)';
      store.logActivity(profile.id, {
        kind: 'news', ok: true, target: article.domain || '',
        note: 'title regenerated - ' + reason + ' (attempt ' + attempt + '/' + TITLE_MAX_REGENS + ')',
      });

      const extra = 'Your previous attempt (' + (title ? '"' + title + '"' : 'empty') + ') was ' + reason +
        '. Break HARD from the original wording this time - react to the story, do not restate it.';
      const bumped = Math.min(1.3, voice.temperature + 0.1 * attempt);
      gen = await generate(profile, build(extra), { temperature: bumped });
      const t2 = cleanTitle(gen.text);
      if (t2) title = t2; // keep whatever we got; the loop re-checks it
    }

    // After the regen budget is spent the title MUST have passed the guard. If it
    // is still empty, a verbatim echo, or too close to the source wording we
    // REFUSE it: returning the publisher's headline (or a faithful paraphrase) is
    // never acceptable output - it looks like it worked when it did not. The
    // caller moves on to another candidate article or surfaces a clear failure;
    // it must NEVER silently post the headline. (This is the fix for the verbatim
    // leak: the old code fell straight through to `return { title }` - and even
    // `title = cleanTitle(headline)` when empty - so an unbudged model shipped the
    // raw headline.)
    const finalSim = titleSimilarity(title, headline);
    const finalVerbatim = !!title && title.toLowerCase() === headline.toLowerCase();
    if (!title || finalVerbatim || finalSim >= TITLE_SIMILARITY_LIMIT) {
      const reason = !title ? 'empty output'
        : finalVerbatim ? 'verbatim headline'
          : 'too close to source (' + Math.round(finalSim * 100) + '% word overlap)';
      return { title: null, rejected: true, reason, gen, about };
    }
    return { title, gen, about };
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

    // The watch keywords are now a KEYWORD FILTER over the pulled feed items (and
    // a GDELT search string when the optional GDELT toggle is on). Empty is VALID:
    // it means "everything from the selected feeds is a candidate".
    const query = String(profile.newsQuery || '').trim();

    // Config sanity: a news bot needs SOMEWHERE to post. Routing rules are
    // optional, but with NO rules AND no default target sub-feddit nothing is
    // routable - surface that plainly instead of a silent "nothing to post".
    const cfgRules = normalizeRules(profile.newsRoutingRules);
    const cfgTargets = normalizeTargets(profile);
    if (!cfgRules.length && !cfgTargets.length) {
      const note = 'Not posting: this news profile has no routing rules and no target sub-feddit. Set a target sub-feddit (or add a routing rule) so it knows where to post.';
      if (preview) return { ok: false, error: note };
      store.logActivity(profile.id, { kind: 'news', ok: false, note });
      reschedule();
      return { acted: true, action: 'news', ok: false, note: 'misconfigured' };
    }
    if (!!profile.newsStrictRouting && !cfgRules.length) {
      const note = 'Not posting: "only post articles that match a routing rule" is ON but there are no routing rules, so nothing can ever match. Add a routing rule or turn that toggle off.';
      if (preview) return { ok: false, error: note };
      store.logActivity(profile.id, { kind: 'news', ok: false, note });
      reschedule();
      return { acted: true, action: 'news', ok: false, note: 'misconfigured' };
    }

    // A news bot must also have SOMEWHERE to draw articles FROM: at least one feed
    // selected, or the GDELT option enabled. Otherwise it is silently sourceless.
    const feedUrls = effectiveFeedUrls(profile, feedsLib.DEFAULT_FEEDS);
    const useGdelt = !!profile.newsUseGdelt && !!gdelt;
    if (!feedUrls.length && !useGdelt) {
      const note = 'Not posting: no feeds are selected and the GDELT option is off, so this bot has no news source. Pick at least one feed (or enable the GDELT option).';
      if (preview) return { ok: false, error: note };
      store.logActivity(profile.id, { kind: 'news', ok: false, note });
      reschedule();
      return { acted: true, action: 'news', ok: false, note: 'misconfigured' };
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

    // 1) Gather candidate articles.
    // PRIMARY: publisher RSS/Atom feeds - reliable, real publisher URLs, not
    // throttled. Scheduled ticks are NON-BLOCKING (stale feeds refresh in the
    // background; we use whatever the shared cache holds now) so a slow feed can
    // never stall a tick. The UI preview blocks so it shows live results. The
    // shared process-wide cache means several bots watching one feed cause ONE
    // fetch, and conditional GET makes an unchanged feed a cheap 304.
    let feedItems = [];
    let warming = false;
    if (feedUrls.length) {
      const fres = await feedsClient.fetchItems(feedUrls, preview ? {} : { nonBlocking: true });
      feedItems = (fres && fres.items) || [];
      warming = !preview && !feedItems.length && !!(fres && (fres.refreshing || []).length);
    }

    // 2) Keyword filter applies to the FEED items only: the owner's watch keywords
    // filter them against title + summary. NO keywords => everything from the
    // feeds is a candidate. (GDELT below does its OWN server-side search, so its
    // results are already query-matched and are merged in AFTER this filter.)
    let articles = filterByKeywords(feedItems, query);

    // SECONDARY (optional, default OFF): GDELT widens the search beyond the feed
    // list but is unreliable (unpredictable 429s). When on, its already-searched
    // results are merged in; its throttling/defer is NON-FATAL - the feeds carry
    // the run regardless, so we never surface a GDELT rate-limit as a failure.
    let staleTag = '';
    let gdeltDeferred = false, gdeltReason = '';
    if (useGdelt && query) {
      const gres = await gdelt.fetchArticles(query, {
        maxRecords: 25,
        timespanHours: timespanHours(profile.newsMaxAgeHours),
        ...(preview ? { onProgress: opts.onProgress } : { nonBlocking: true }),
      });
      if (gres && gres.ok) {
        articles = articles.concat(gres.articles || []);
        if (gres.stale) staleTag = ' (some results from a stale GDELT cache ~' + Math.max(1, Math.round((gres.staleAgeMs || 0) / 60000)) + ' min old)';
      } else if (gres && gres.deferred) {
        gdeltDeferred = true; gdeltReason = gres.reason || 'busy';
      }
    }

    // 3) Filter to postable candidates (code only, the model does not filter).
    const candidates = filterArticles(profile, articles, now());
    if (!candidates.length) {
      // If GDELT was the ONLY fresh source this tick (no feed items) and it
      // deferred (queue busy / cooling / spacing), do nothing and stay due for a
      // later tick - no log spam, exactly the old non-blocking GDELT behaviour.
      if (gdeltDeferred && !feedItems.length) {
        return { acted: false, action: 'news', ok: false, deferred: true, reason: 'gdelt-' + gdeltReason };
      }
      const note = warming
        ? 'Warming up: the feeds are being fetched for the first time. The bot will post on a following tick once items are cached.'
        : (profile.newsStrictRouting
          ? 'No suitable fresh article to post (keywords / age / dedupe / denylist / domain-cap / no matching routing rule filtered them all).'
          : 'No suitable fresh article to post (keywords / age / dedupe / denylist / domain-cap filtered them all).');
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

    // 4) Generate the title (guardrailed). generateNewsTitle NEVER returns the
    // headline verbatim or a too-close paraphrase - if the model will not depart
    // from one article's headline it comes back `rejected`, and we move on to the
    // next-ranked candidate (up to TITLE_MAX_ARTICLES distinct articles). We build
    // the try-order once: the picked article first, then the remaining candidates
    // ranked by rule weight then freshness, so "move on" still respects routing.
    const tryOrder = [chosen].concat(
      candidates
        .filter((a) => a !== chosen)
        .sort((a, b) => {
          const wd = (Number(b.rule.weight) || 0) - (Number(a.rule.weight) || 0);
          return wd || (b.seenAt || 0) - (a.seenAt || 0);
        })
    ).slice(0, TITLE_MAX_ARTICLES);

    let title, gen, lastReject = '';
    let accepted = null, acceptedAbout = null;
    try {
      for (const art of tryOrder) {
        const res = await generateNewsTitle(profile, art);
        if (res.rejected) { lastReject = res.reason; gen = res.gen; continue; }
        accepted = art; title = res.title; gen = res.gen; acceptedAbout = res.about;
        break;
      }
    } catch (e) {
      const note = 'title generation failed: ' + e.message;
      if (preview) return { ok: false, error: note };
      store.logActivity(profile.id, { kind: 'news', ok: false, target: chosen.domain, note });
      reschedule();
      return { acted: true, action: 'news', ok: false };
    }

    // Every candidate the model saw came back too close to (or a verbatim copy of)
    // its publisher headline. We do NOT post the headline - that is the one thing
    // that must never happen. Surface a clear failure instead so it is visible in
    // the preview and the activity log, not a silent success. The articles are NOT
    // consumed (no dedupe recorded), so a later tick with a model that will depart
    // can still post them.
    if (!accepted) {
      const across = tryOrder.length > 1 ? ' across ' + tryOrder.length + ' candidate articles' : '';
      const note = lastReject === 'nsfw'
        ? 'Not posting: the target sub-feddit(s) are NSFW (over_18) and this profile has not opted in.'
        : 'Not posting: the model would not depart from the publisher headline' + across +
          ' after ' + TITLE_MAX_REGENS + ' retries each (' + (lastReject || 'too close to source') +
          '). Returning the headline verbatim is never acceptable, so nothing was posted.';
      if (preview) return { ok: false, error: note };
      store.logActivity(profile.id, { kind: 'news', ok: false, target: chosen.domain || '', note });
      reschedule();
      return { acted: true, action: 'news', ok: false, note: lastReject === 'nsfw' ? 'nsfw' : 'title-verbatim' };
    }
    chosen = accepted; // the article we actually produced an acceptable title for
    logRulesApplied(profile, 'news', chosen.rule.subFeddit, acceptedAbout);

    if (preview) {
      return {
        ok: true, article: publicArticle(chosen), title, subFeddit: chosen.rule.subFeddit,
        routedBy: chosen.rule.fallback ? 'default target' : 'routing rule',
        provider: gen && gen.provider, model: gen && gen.model, costUsd: gen && gen.costUsd,
        summary: chosen.summary || '', stale: !!staleTag,
      };
    }

    reschedule();

    // Record dedupe + the per-domain count BEFORE the submit is attempted (and
    // in dry-run), so a crash mid-submit can never cause a repost. Reposting is
    // the one unforgivable news failure - a rare missed article is fine.
    store.recordPostedNews(profile.id, chosen.canonical);
    store.recordNewsDomain(profile.id, cost.dayKey(now()), chosen.domain);
    recordSend(profile, 'post');

    const noteCore = snippet(chosen.title) + '  ->  ' + snippet(title) + costTag(gen) + staleTag;

    if (settings.dryRun) {
      store.logActivity(profile.id, {
        kind: 'news', dryRun: true, ok: true, target: chosen.domain,
        note: 'DRY-RUN would post link to f/' + chosen.rule.subFeddit + ': ' + noteCore,
      });
      return { acted: true, mode: 'dry', action: 'news', ok: true, feddit: chosen.rule.subFeddit, domain: chosen.domain, headline: chosen.title, title, canonical: chosen.canonical };
    }

    // 5) Submit the LINK post. On a 429 we back off but do NOT un-record the
    // dedupe - the article is consumed either way (never reposted).
    const subName = chosen.rule.subFeddit;
    const r = await feddit.submit({ token: profile.token, feddit: subName, title, kind: 'link', url: chosen.url });
    if (r.status === 429) {
      handle429(profile, r, 'news');
      return { acted: true, action: 'news', ok: false, feddit: subName, canonical: chosen.canonical };
    }
    // Target sub-feddit does not exist: never create it silently. Log plain
    // guidance pointing the owner at the panel's explicit "Create sub-feddit"
    // form, then stop (the article is consumed either way and never reposted).
    if (isMissingFedditError(r)) {
      store.logActivity(profile.id, { kind: 'news', ok: false, target: chosen.domain, note: missingFedditGuidance(subName) + ' (article consumed, will not repost)' });
      return { acted: true, action: 'news', ok: false, feddit: subName, canonical: chosen.canonical };
    }
    if (!r.ok) {
      store.logActivity(profile.id, { kind: 'news', ok: false, target: chosen.domain, note: (r.error || 'submit failed') + ' (article consumed, will not repost)' });
      return { acted: true, action: 'news', ok: false, feddit: subName, canonical: chosen.canonical };
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
    setPreviewProgress(profileId, 'Fetching feeds' + (p.newsUseGdelt ? ' + querying GDELT' : '') + '...');
    try {
      return await decideNews(p, store.getSettings(), {
        preview: true,
        onProgress: (info) => {
          setPreviewProgress(profileId,
            'GDELT throttled, retrying (' + info.attempt + ' of ' + info.maxAttempts + ')...');
        },
      });
    } finally {
      clearPreviewProgress(profileId);
    }
  }

  // Feed-health snapshot for the UI: this profile's EFFECTIVE feeds (shipped
  // subset + customs) joined with each feed's live health (ok / failing + why /
  // last successful fetch), so a silently dead feed is visible. Never fetches -
  // it reports whatever the shared cache/health map already holds.
  function feedHealth(profileId) {
    const p = store.getProfile(profileId);
    const urls = p ? effectiveFeedUrls(p, feedsLib.DEFAULT_FEEDS) : feedsLib.DEFAULT_FEEDS.map((f) => f.feedUrl);
    const snap = feedsClient.health(urls);
    const byUrl = new Map(snap.map((h) => [h.url, h]));
    const shipped = new Map(feedsLib.DEFAULT_FEEDS.map((f) => [f.feedUrl, f]));
    return urls.map((u) => {
      const meta = shipped.get(u);
      return {
        url: u,
        name: meta ? meta.name : u,
        domain: meta ? meta.domain : feedsLib.domainOf(u),
        category: meta ? meta.category : 'custom',
        custom: !meta,
        health: byUrl.get(u) || null,
      };
    });
  }

  // Decide and perform (at most) one action for one profile.
  async function maybeAct(profileId, settings) {
    const p = store.getProfile(profileId);
    if (!p || !p.enabled) return null;   // per-profile enable honoured live
    if (!p.token) return null;           // can't operate without a bearer token
    const t = now();
    const s = freshSched(p.id);
    if (s.backoffUntil && t < s.backoffUntil) return null; // 429 back-off in effect

    // Refresh probation BEFORE anything reads a ceiling, so a fresh identity is
    // held to 2 posts/hr & 5 comments/hr instead of 429-ing all day. Throttled
    // to at most once per PROBATION_POLL_MS and dropped once off-probation.
    await ensureProbation(p);

    ensureTimers(p);
    const sc = freshSched(p.id);

    const cap = caps(p);
    const canPost = cap.canPost && effRate(p, p.postsPerHour, 'post') > 0;
    const canComment = cap.canComment && effRate(p, p.commentsPerHour, 'comment') > 0;
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

  const api = { start, stop, runTick, nextAction, previewNews, getPreviewProgress, feedHealth, tickMs: TICK_MS };
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
  normalizeTargets,
  defaultTarget,
  parseKeywords,
  filterByKeywords,
  effectiveFeedUrls,
  pickArticle,
  isPaywalled,
  cleanTitle,
  titleSimilarity,
  titleVoice,
  TITLE_SIMILARITY_LIMIT,
  parseShortlistIndex,
  timespanHours,
  probationState,
  ceilingsFor,
  extractProbation,
  classifyPost,
  linkAction,
  isMissingFedditError,
  missingFedditGuidance,
  THREAD_CAP,
  SERVER,
  PROBATION,
  MAX_OLLAMA_PER_TICK,
  PAYWALL_DOMAINS,
};
