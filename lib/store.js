'use strict';

// Persistence layer: data/profiles.json holds all bot profiles including
// their Feddit bearer tokens. This file is gitignored and created on first
// run. Writes are atomic (write tmp, rename over the real file) so a crash
// mid-write can never leave a truncated/corrupt JSON on the CIFS share.

const fs = require('node:fs');
const path = require('node:path');
const cost = require('./cost');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'profiles.json');

// ---- shape / defaults -------------------------------------------------------

const DEFAULT_MODEL = 'hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M';

// A single profile IS one registered Feddit bot identity. Feddit has no user
// accounts; registration returns a bearer token that authorises writes, so N
// profiles means N independent registrations, each with its own token.
function profileDefaults() {
  return {
    id: null,                 // assigned on create
    // Feddit is an old.reddit clone and old.reddit has NO display names: a user
    // IS their username. So a profile has no separate display name. Its NAME is
    // its fedditUsername once registered; before that it carries a temporary
    // refName purely so it can be told apart in the list (see referenceName()).
    fedditUsername: '',       // the username registered on Feddit (this IS the name once set)
    refName: '',              // TEMPORARY reference label, used ONLY until a username exists
    token: '',                // bearer token (shown ONCE at register time)
    persona: '',              // system prompt describing who this bot is
    toneNotes: '',            // extra tone/style guidance appended to the system prompt
    readFeddits: [],          // sub-feddit names this bot reads
    postFeddits: [],          // sub-feddit names this bot posts/comments to (conversational); for a NEWS bot these are the DEFAULT target sub-feddit(s) articles route to when no routing rule matches
    // NOTE: there is deliberately NO auto-create-missing-sub-feddit flag. Creating
    // a community is a CONTENT act (it carries an owner-authored description + an
    // ordered rules list that other bots READ before posting), so it is done
    // explicitly by the owner from the control panel's "Create sub-feddit" form,
    // never silently by a bot on a submit 404. The old `createMissingSubFeddit`
    // field is purged on load (see migrateProfiles).
    // OFF by default. A community can be marked NSFW (over_18) by its creator;
    // the bot reads that from the sub-feddit's about data before posting. When
    // OFF the scheduler refuses to post or comment into an NSFW community (it
    // skips and logs). Turn ON only to let THIS profile post into over_18
    // communities. Fetch failures never block posting - unknown is treated as
    // safe. Applies to posts, comments and news link posts alike.
    allowNsfw: false,
    // botType decides which "what to do" implementation the (shared) scheduler
    // runs for this profile. NOTE: this is deliberately NOT called "mode" - that
    // key is already taken (post/comment/both) and means something else.
    botType: 'conversational', // 'conversational' (persona poster/commenter) | 'news' (GDELT link poster)
    mode: 'both',             // 'post' | 'comment' | 'both' (conversational only; news is post-only)
    postsPerHour: 0,          // cadence: submissions per hour (also drives news posting)
    commentsPerHour: 0,       // cadence: comments per hour (conversational only)
    // ---- news bot config (owner-configured; only used when botType === 'news') --
    // PRIMARY source is publisher RSS/Atom feeds (lib/feeds.js). The owner curates
    // nothing: they just pick keywords. They MAY narrow to a subset of the shipped
    // feeds and/or add their own feed URLs, but neither is required.
    newsUseAllFeeds: true,    // true (default, zero-curation) = use ALL shipped feeds; false = use ONLY newsFeedSelection
    newsFeedSelection: [],    // when newsUseAllFeeds is false, the shipped feed URLs to use (empty then = only the customs)
    newsCustomFeeds: [],      // owner-added RSS/Atom feed URLs, merged with the shipped selection
    newsUseGdelt: false,      // OPTIONAL secondary: also search GDELT (wider than the feed list, but unreliable). DEFAULT OFF
    newsQuery: '',            // watch KEYWORDS: filter feed items by title+summary (empty = everything); also the GDELT search string when newsUseGdelt is on
    newsRoutingRules: [],     // OPTIONAL, ORDERED [{ keywords:[], subFeddit:'', weight:Number }] - highest-weight match refines placement; no rules => everything routes to postFeddits
    newsStrictRouting: false, // OFF (default): an article matching NO rule falls back to postFeddits. ON: only post articles that match a routing rule (old drop-on-no-match)
    newsMaxAgeHours: 24,      // freshness cap: drop articles older than this
    newsMaxPerDomainPerDay: 3,// per-source-domain daily post cap (0 = unlimited)
    newsMinGapMinutes: 30,    // minimum gap between two news posts from this profile
    newsDomainDenylist: [],   // domains this profile will never post from
    newsPaywallFilter: true,  // drop known hard-paywall domains
    newsRequireImage: false,  // only post articles that already have a GDELT image (default OFF)
    // Single 'Title voice' preset. Each preset bundles the title STYLE wording,
    // the DEPARTURE-from-headline strength AND the generation temperature together
    // so the controls can no longer be set to contradictory values (the old split
    // newsTitleStyle + newsTitleFaithfulness could). Restrained -> extreme:
    // 'straight' | 'deadpan' | 'punny' | 'tabloid' | 'full-character' | 'custom'.
    newsTitleVoice: 'straight',
    newsTitleCustom: '',      // extra style instruction when newsTitleVoice === 'custom'
    newsLetBotChoose: false,  // ON = one extra generation to pick from a shortlist (DOUBLES cost per post)
    // How this profile comments on a LINK post whose OG preview is terminal but
    // carries NO description (e.g. og_status 'blocked'/'no_image' with nothing to
    // summarise): 'headline' = react to the bare headline (with the honesty
    // guard), 'skip' = never comment on it. A 'pending' preview is always
    // deferred regardless (never consumed). Conversational bots only.
    linkNoContext: 'headline', // 'headline' | 'skip'
    provider: 'ollama',       // 'ollama' (local, free, shares Cy) | 'deepseek' (remote, paid)
    model: DEFAULT_MODEL,     // ollama model; default reuses Cy's resident weights
    deepseekModel: 'deepseek-v4-flash', // used only when provider === 'deepseek'
    temperature: 0.8,
    numPredict: 200,          // keep small so we do not hog the single ollama slot
    enabled: false,           // scheduler only acts on enabled profiles
    createdAt: null,
    activity: [],             // recent activity log entries (most-recent last)
    // ---- probation (managed by the scheduler; read from GET /u/{name}.json) ----
    // Feddit puts a freshly registered bot on PROBATION until it is 24h old OR
    // has earned 10 kibble, whichever comes first. While on probation the server
    // ceilings are tighter (2 posts/hr, 5 comments/hr, sub-feddit creation
    // BLOCKED) so the scheduler MUST honour them or every new identity 429s all
    // day. onProbation: null = never checked yet; true/false = last observed
    // state. It only ever transitions on -> off, so once false we stop polling.
    probation: { onProbation: null, checkedAt: 0 },
    // ---- scheduler state (managed by lib/scheduler; safe to ignore elsewhere) --
    sched: schedDefaults(),   // cadence timers + rolling send window + backoff
    repliedTo: [],            // feddit fullnames we've replied to ("t3_34"/"t1_140"), FIFO-bounded
    // ---- news dedupe + per-domain tracking (managed by the scheduler) --------
    // PERMANENT news dedupe, SEPARATE from repliedTo. Canonical article URLs we
    // have already posted (or would have, in dry-run). Bounded generously so a
    // story is never reposted; oldest evicted first.
    postedNews: [],           // canonical URLs, insertion order, FIFO-bounded (thousands)
    newsDomainDaily: {},      // "YYYY-MM-DD" -> { "domain.com": count } for the per-domain daily cap
    newsDomainDays: [],       // day keys in insertion order, for FIFO bounding of newsDomainDaily
    // ---- cost/spend tracking (managed by the scheduler) ----------------------
    spendDaily: {},           // "YYYY-MM-DD" -> { usd, gens, inputTokens, cachedInputTokens, outputTokens }
    spendDays: [],            // day keys in insertion order, for FIFO bounding of spendDaily
  };
}

// ---- naming model -----------------------------------------------------------

// A profile's shown NAME is its Feddit username once registered; before that it
// falls back to its temporary refName. This one helper is the single source of
// truth for "what do we call this profile" across the UI, list and activity log.
function referenceName(p) {
  if (!p) return '';
  const u = String(p.fedditUsername || '').trim();
  return u || p.refName || '';
}

// Produce the next unused temporary reference name ("unregistered-1", ...). The
// `used` set carries the names already handed out so two profiles never collide.
// The prefix deliberately does NOT look like a real Feddit username.
function nextRefName(used) {
  let n = 1;
  let name;
  do { name = 'unregistered-' + n++; } while (used && used.has(name));
  if (used) used.add(name);
  return name;
}

// Fold the OLD split title controls (newsTitleStyle x newsTitleFaithfulness,
// which could be set to contradictory values) onto the nearest single Title
// voice preset. Style carried the actual voice wording, so it drives the result;
// a 'wild' departure on an otherwise restrained style (straight/deadpan) was the
// confusing contradictory combo, so we lift THAT to 'full-character' (the owner
// clearly wanted maximum character). 'custom' is preserved as-is (its free-text
// newsTitleCustom carries over untouched). tabloid/punny already sit at the
// expressive end, so a 'wild' faithfulness does not change them.
function migrateTitleVoice(style, faith) {
  if (style === 'custom') return 'custom';
  const s = ['straight', 'deadpan', 'tabloid', 'punny'].includes(style) ? style : 'straight';
  if (faith === 'wild' && (s === 'straight' || s === 'deadpan')) return 'full-character';
  return s;
}

// Migrate stored profile records to the current shape on load:
//   - backfill any newly-added default fields onto older records
//   - SCRAP the obsolete `displayName` field entirely (Feddit has no display names)
//   - SCRAP the obsolete `createMissingSubFeddit` flag (the auto-create-on-404
//     path is gone; sub-feddits are now created explicitly from the panel)
//   - MERGE the old newsTitleStyle + newsTitleFaithfulness pair into the single
//     newsTitleVoice preset, then drop both dead fields (like displayName)
//   - a registered profile's name IS its fedditUsername (no temp name needed)
//   - an as-yet-unregistered profile with no refName gets a fresh temporary one
// No data loss on the username or the title voice, no crash on old records.
function migrateProfiles(rawProfiles) {
  const list = Array.isArray(rawProfiles) ? rawProfiles : [];
  // Seed the "already used" set from any temp names already on disk so a second
  // unregistered profile can't be handed a name the first one already holds.
  const used = new Set();
  for (const raw of list) {
    if (raw && typeof raw.refName === 'string' && raw.refName) used.add(raw.refName);
  }
  return list.map((raw) => {
    const p = { ...profileDefaults(), ...raw };
    delete p.displayName; // gone for good - not deprecated, not hidden
    delete p.createMissingSubFeddit; // auto-create path removed - purge the dead flag, no orphans
    // Merge the old split title controls into the single voice preset (idempotent:
    // a record already on the new shape has no old fields, so we keep its voice).
    if (raw.newsTitleStyle !== undefined || raw.newsTitleFaithfulness !== undefined) {
      p.newsTitleVoice = migrateTitleVoice(raw.newsTitleStyle, raw.newsTitleFaithfulness);
    }
    delete p.newsTitleStyle;        // dead field - gone for good, no orphan
    delete p.newsTitleFaithfulness; // dead field - gone for good, no orphan
    const username = String(p.fedditUsername || '').trim();
    if (!username && !p.refName) {
      p.refName = nextRefName(used);
    }
    return p;
  });
}

// Per-profile scheduler bookkeeping. Timestamps are epoch ms.
function schedDefaults() {
  return {
    nextPostAt: null,     // when the next submit is due (null => initialise on first tick)
    nextCommentAt: null,  // when the next reply is due
    backoffUntil: 0,      // skip this profile until this time (set from a 429 reset)
    sentPosts: [],        // our recent post timestamps (rolling 1h) - self rate-limit vs server ceiling
    sentComments: [],     // our recent comment timestamps (rolling 1h)
  };
}

// Global runner settings, honoured live by the scheduler.
function defaultSettings() {
  return {
    paused: false,        // global pause: while true the scheduler acts on nothing
    dryRun: true,         // DRY-RUN default ON: generate + log what it WOULD do, never write
    threadReplies: {},    // postId(string) -> count of THIS RUNNER's replies in that thread (ping-pong cap)
    threadOrder: [],      // postIds in insertion order, for FIFO bounding of threadReplies
    // ---- cost controls -------------------------------------------------------
    monthlyCapUsd: 5,     // runner-wide monthly USD ceiling; when exceeded, deepseek profiles are skipped
    pricing: cost.defaultPricing(), // per-model USD-per-million-token price table (editable; see note below)
  };
}

// Bounds so data/profiles.json can never grow without limit.
const REPLIED_CAP = 500;       // per-profile dedupe keys retained
const THREAD_TRACK_CAP = 500;  // distinct threads whose reply-count we track
const SPEND_DAY_CAP = 70;      // days of per-profile spend history retained (>2 months)
const NEWS_DEDUPE_CAP = 5000;  // per-profile posted-article keys retained (thousands, not 500 - a repost is unforgivable)
const NEWS_DOMAIN_DAY_CAP = 14; // days of per-domain daily post counts retained

function emptyData() {
  return { profiles: [], settings: defaultSettings() };
}

// ---- id generation ----------------------------------------------------------

function newId() {
  // Short, url-safe, collision-resistant enough for a handful of profiles.
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---- load / save ------------------------------------------------------------

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) throw new Error('bad shape');
    // Backfill new default fields, drop displayName, assign temp reference names.
    parsed.profiles = migrateProfiles(parsed.profiles);
    if (!parsed.settings || typeof parsed.settings !== 'object') {
      parsed.settings = defaultSettings();
    } else {
      parsed.settings = { ...defaultSettings(), ...parsed.settings };
    }
    cache = parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      cache = emptyData();
    } else {
      throw new Error('Failed to read ' + DATA_FILE + ': ' + err.message);
    }
  }
  return cache;
}

function save(data) {
  ensureDir();
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, DATA_FILE); // atomic replace on the same filesystem
  cache = data;
}

// ---- profile CRUD -----------------------------------------------------------

function listProfiles() {
  return load().profiles;
}

function getProfile(id) {
  return load().profiles.find((p) => p.id === id) || null;
}

function createProfile(patch) {
  const data = load();
  const p = { ...profileDefaults(), ...(patch || {}) };
  p.id = newId();
  p.createdAt = new Date().toISOString();
  // A brand-new profile has no username yet, so give it a temporary reference
  // name (unique against the ones already in use) so it's identifiable in the list.
  if (!String(p.fedditUsername || '').trim() && !p.refName) {
    const used = new Set(data.profiles.map((x) => x.refName).filter(Boolean));
    p.refName = nextRefName(used);
  }
  data.profiles.push(p);
  save(data);
  return p;
}

function updateProfile(id, patch) {
  const data = load();
  const idx = data.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  // id/createdAt are immutable; everything else can be patched.
  const merged = { ...data.profiles[idx], ...(patch || {}) };
  merged.id = data.profiles[idx].id;
  merged.createdAt = data.profiles[idx].createdAt;
  data.profiles[idx] = merged;
  save(data);
  return merged;
}

function deleteProfile(id) {
  const data = load();
  const before = data.profiles.length;
  data.profiles = data.profiles.filter((p) => p.id !== id);
  if (data.profiles.length === before) return false;
  save(data);
  return true;
}

// Append a bounded activity log entry to a profile.
function logActivity(id, entry) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (!Array.isArray(p.activity)) p.activity = [];
  p.activity.push({ at: new Date().toISOString(), ...entry });
  if (p.activity.length > 50) p.activity = p.activity.slice(-50);
  save(data);
  return p;
}

// ---- global settings (pause / dry-run) --------------------------------------

function getSettings() {
  const data = load();
  if (!data.settings) { data.settings = defaultSettings(); save(data); }
  return data.settings;
}

function updateSettings(patch) {
  const data = load();
  data.settings = { ...defaultSettings(), ...(data.settings || {}), ...(patch || {}) };
  save(data);
  return data.settings;
}

// ---- scheduler state helpers ------------------------------------------------

// Merge a patch into a profile's scheduler bookkeeping.
function updateSched(id, patch) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  p.sched = { ...schedDefaults(), ...(p.sched || {}), ...(patch || {}) };
  save(data);
  return p.sched;
}

// Merge a patch into a profile's cached probation state (managed by the
// scheduler). Kept separate from `sched` so it survives independently of the
// cadence bookkeeping. Mutates in place (same object getProfile returns).
function setProbation(id, patch) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  p.probation = { onProbation: null, checkedAt: 0, ...(p.probation || {}), ...(patch || {}) };
  save(data);
  return p.probation;
}

// Has this profile already replied to the given fullname ("t3_.."/"t1_..")?
function hasReplied(id, key) {
  const p = getProfile(id);
  return !!(p && Array.isArray(p.repliedTo) && p.repliedTo.includes(key));
}

// Record that this profile replied to a fullname; FIFO-bounded so it can't grow.
function recordReplied(id, key) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (!Array.isArray(p.repliedTo)) p.repliedTo = [];
  if (!p.repliedTo.includes(key)) {
    p.repliedTo.push(key);
    if (p.repliedTo.length > REPLIED_CAP) p.repliedTo = p.repliedTo.slice(-REPLIED_CAP);
  }
  save(data);
  return p.repliedTo;
}

// ---- news dedupe (PERMANENT, separate from repliedTo) -----------------------

// Has this profile already posted (or, in dry-run, "would have posted") this
// canonical article URL? Reposting a story is the one unforgivable news failure.
function hasPostedNews(id, canonicalKey) {
  const p = getProfile(id);
  return !!(p && Array.isArray(p.postedNews) && p.postedNews.includes(canonicalKey));
}

// Record a canonical article URL as posted. Called BEFORE the submit is even
// attempted (and in dry-run) so a crash mid-submit can never cause a repost.
// FIFO-bounded at NEWS_DEDUPE_CAP with oldest-out eviction.
function recordPostedNews(id, canonicalKey) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (!Array.isArray(p.postedNews)) p.postedNews = [];
  if (!p.postedNews.includes(canonicalKey)) {
    p.postedNews.push(canonicalKey);
    if (p.postedNews.length > NEWS_DEDUPE_CAP) p.postedNews = p.postedNews.slice(-NEWS_DEDUPE_CAP);
  }
  save(data);
  return p.postedNews.length;
}

// Clear a profile's posted-article history (and its per-domain daily counts).
// Exposed in the UI because dry-run CONSUMES this dedupe set, so testing a news
// profile in dry-run would otherwise permanently block those articles.
function clearPostedNews(id) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  p.postedNews = [];
  p.newsDomainDaily = {};
  p.newsDomainDays = [];
  save(data);
  return true;
}

// How many articles this profile has posted from `domain` on `dayKey` so far.
function newsDomainCount(profile, dayKey, domain) {
  const daily = (profile && profile.newsDomainDaily) || {};
  const bucket = daily[dayKey] || {};
  return Number(bucket[String(domain || '').toLowerCase()]) || 0;
}

// Record one more post from `domain` on `dayKey`; FIFO-bounded across days.
function recordNewsDomain(id, dayKey, domain) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (!p.newsDomainDaily || typeof p.newsDomainDaily !== 'object') p.newsDomainDaily = {};
  if (!Array.isArray(p.newsDomainDays)) p.newsDomainDays = [];
  const dom = String(domain || '').toLowerCase();
  let bucket = p.newsDomainDaily[dayKey];
  if (!bucket) {
    bucket = {};
    p.newsDomainDaily[dayKey] = bucket;
    p.newsDomainDays.push(dayKey);
    while (p.newsDomainDays.length > NEWS_DOMAIN_DAY_CAP) {
      const old = p.newsDomainDays.shift();
      delete p.newsDomainDaily[old];
    }
  }
  bucket[dom] = (Number(bucket[dom]) || 0) + 1;
  save(data);
  return bucket[dom];
}

// ---- spend / cost tracking --------------------------------------------------

// Record one generation's token usage + USD cost against a profile, bucketed by
// UTC day. dayKey is passed in (derived from the scheduler's injectable clock).
function recordSpend(id, { dayKey, usage, costUsd }) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (!p.spendDaily || typeof p.spendDaily !== 'object') p.spendDaily = {};
  if (!Array.isArray(p.spendDays)) p.spendDays = [];
  const u = usage || {};
  let bucket = p.spendDaily[dayKey];
  if (!bucket) {
    bucket = { usd: 0, gens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    p.spendDaily[dayKey] = bucket;
    p.spendDays.push(dayKey);
    while (p.spendDays.length > SPEND_DAY_CAP) {
      const old = p.spendDays.shift();
      delete p.spendDaily[old];
    }
  }
  bucket.usd += Number(costUsd) || 0;
  bucket.gens += 1;
  bucket.inputTokens += Number(u.inputTokens) || 0;
  bucket.cachedInputTokens += Number(u.cachedInputTokens) || 0;
  bucket.outputTokens += Number(u.outputTokens) || 0;
  save(data);
  return bucket;
}

// Per-profile spend for a given UTC day + month key. Returns USD + gen counts.
function profileSpend(profile, dayKey, monthKey) {
  const daily = (profile && profile.spendDaily) || {};
  let todayUsd = 0, todayGens = 0, monthUsd = 0, monthGens = 0;
  for (const k of Object.keys(daily)) {
    const b = daily[k] || {};
    if (k === dayKey) { todayUsd += b.usd || 0; todayGens += b.gens || 0; }
    if (k.slice(0, 7) === monthKey) { monthUsd += b.usd || 0; monthGens += b.gens || 0; }
  }
  return { todayUsd, todayGens, monthUsd, monthGens };
}

// Runner-wide spend for a UTC month key: total USD + per-profile breakdown.
function runnerSpend(monthKey, dayKey) {
  let monthUsd = 0, todayUsd = 0;
  for (const p of load().profiles) {
    const s = profileSpend(p, dayKey || '', monthKey);
    monthUsd += s.monthUsd;
    todayUsd += s.todayUsd;
  }
  return { monthUsd, todayUsd };
}

// How many replies THIS RUNNER (any profile) has made in a given post's thread.
function getThreadReplyCount(postId) {
  const s = getSettings();
  return (s.threadReplies && s.threadReplies[String(postId)]) || 0;
}

// Count one more this-runner reply in a thread; FIFO-bounded across threads.
function bumpThreadReply(postId) {
  const data = load();
  const s = data.settings || (data.settings = defaultSettings());
  if (!s.threadReplies) s.threadReplies = {};
  if (!Array.isArray(s.threadOrder)) s.threadOrder = [];
  const key = String(postId);
  if (!(key in s.threadReplies)) s.threadOrder.push(key);
  s.threadReplies[key] = (s.threadReplies[key] || 0) + 1;
  while (s.threadOrder.length > THREAD_TRACK_CAP) {
    const old = s.threadOrder.shift();
    delete s.threadReplies[old];
  }
  save(data);
  return s.threadReplies[key];
}

module.exports = {
  DATA_FILE,
  DEFAULT_MODEL,
  profileDefaults,
  schedDefaults,
  referenceName,
  migrateProfiles,
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  logActivity,
  getSettings,
  updateSettings,
  updateSched,
  setProbation,
  hasReplied,
  recordReplied,
  hasPostedNews,
  recordPostedNews,
  clearPostedNews,
  newsDomainCount,
  recordNewsDomain,
  getThreadReplyCount,
  bumpThreadReply,
  recordSpend,
  profileSpend,
  runnerSpend,
};
