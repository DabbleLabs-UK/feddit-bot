'use strict';

// Persistence layer: data/profiles.json holds all bot profiles including
// their Feddit bearer tokens. This file is gitignored and created on first
// run. Writes are atomic (write tmp, rename over the real file) so a crash
// mid-write can never leave a truncated/corrupt JSON on the CIFS share.

const fs = require('node:fs');
const path = require('node:path');
const cost = require('./cost');
const deepseek = require('./providers/deepseek'); // reasoning-budget floor/default constants
const secrets = require('./secrets');
const modelCatalog = require('./model-catalog');

const DATA_DIR = process.env.FEDDIT_BOT_DATA_DIR
  ? path.resolve(process.env.FEDDIT_BOT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'profiles.json');
const DATA_SCHEMA_VERSION = 8;

// ---- shape / defaults -------------------------------------------------------

// Keep the legacy direct-run default safe for DELL. The packaged desktop
// launcher explicitly supplies FEDDIT_DEFAULT_MODEL for its own installation.
const DEFAULT_MODEL = String(process.env.FEDDIT_DEFAULT_MODEL || modelCatalog.DELL_SHARED_MODEL);

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
    persona: '',              // system prompt describing who this bot is
    toneNotes: '',            // extra tone/style guidance appended to the system prompt
    // Conversational profiles use both legacy arrays as one mirrored home set.
    // Keeping both fields preserves profile-pack compatibility with older apps.
    readFeddits: [],
    postFeddits: [],          // for a NEWS bot these are the default target sub-feddits used when no routing rule matches
    // Conversational community movement builds on the home set above. Existing
    // profiles default to 'home' and keep
    // their old exact behaviour. 'listed' permits only owner-named additional
    // communities; 'discover' lets the runner select personality-relevant
    // communities from Feddit's real directory. It never invents a destination.
    communityMode: 'home',    // 'home' | 'listed' | 'discover'
    communityAllowlist: [],   // additional owner-approved communities for 'listed'
    communityDenylist: [],    // hard owner exclusion for automatic discovery
    feedSort: 'best',         // Feddit's own 'best' | 'hot' | 'new' | 'rising' | 'controversial' | 'top' view
    // Community rules are SOCIAL context, not system-level constraints. Most
    // bots decide in character; owners can make one more considerate, defiant,
    // or (unusually and explicitly) a deliberate local-rule breaker.
    communityRuleStyle: 'personality', // 'considerate' | 'personality' | 'defiant' | 'rulebreaker'
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
    // Independent abilities are the current behaviour model. A bot may combine
    // any of them; botType/mode remain as derived compatibility fields for older
    // desktop copies and portable profile packs.
    canReply: true,
    canStartDiscussions: true,
    canShareLinks: false,
    botType: 'conversational', // derived compatibility field for older runners
    mode: 'both',             // 'post' | 'comment' | 'both'; news normally uses 'both' or 'post'
    postsPerHour: 0,          // cadence: submissions per hour (also drives news posting)
    commentsPerHour: 0,       // cadence: replies per hour (conversational or news discussion)
    // ---- article-link config (used when canShareLinks is enabled) -------------
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
    newsLetBotChoose: true,   // personality chooses from a real article shortlist; may be disabled in advanced settings
    // How this profile comments on a LINK post whose OG preview is terminal but
    // carries NO description (e.g. og_status 'blocked'/'no_image' with nothing to
    // summarise): 'headline' = react to the bare headline (with the honesty
    // guard), 'skip' = never comment on it. A 'pending' preview is always
    // deferred regardless (never consumed). Conversational bots only.
    linkNoContext: 'headline', // 'headline' | 'skip'
    provider: 'ollama',       // 'ollama' (same computer) | 'dell' (hosted queue) | 'deepseek' (remote, paid)
    model: DEFAULT_MODEL,     // execution choice; portable exports deliberately exclude it
    deepseekModel: 'deepseek-v4-flash', // used only when provider === 'deepseek'
    temperature: 0.8,
    numPredict: 200,          // keep small so we do not hog the single ollama slot
    enabled: false,           // scheduler only acts on enabled profiles
    dryRun: true,             // this bot rehearses scheduled turns until its owner explicitly makes it live
    hostedActivatedAt: null,  // server-managed first hosted activation; drives the temporary fair-start boost
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
    // Simulation uses its own continuity so rehearsing never pollutes live
    // dedupe/cadence, and the owner can reset a test without risking live state.
    simulationState: simulationDefaults(),
    // ---- news dedupe + per-domain tracking (managed by the scheduler) --------
    // PERMANENT live news dedupe, SEPARATE from repliedTo. Canonical article URLs
    // we have actually handled for publishing. Bounded generously so a
    // story is never reposted; oldest evicted first.
    postedNews: [],           // canonical URLs, insertion order, FIFO-bounded (thousands)
    newsDomainDaily: {},      // "YYYY-MM-DD" -> { "domain.com": count } for the per-domain daily cap
    newsDomainDays: [],       // day keys in insertion order, for FIFO bounding of newsDomainDaily
    // ---- cost/spend tracking (managed by the scheduler) ----------------------
    spendDaily: {},           // "YYYY-MM-DD" -> { usd, gens, inputTokens, cachedInputTokens, outputTokens }
    spendDays: [],            // day keys in insertion order, for FIFO bounding of spendDaily
  };
}

function syncCapabilityCompatibility(profile) {
  profile.canReply = profile.canReply === true;
  profile.canStartDiscussions = profile.canStartDiscussions === true;
  profile.canShareLinks = profile.canShareLinks === true;
  // Mixed text+link bots are represented as conversational to old runners,
  // which is safer than making them use an old source-unaware link path.
  profile.botType = profile.canShareLinks && !profile.canStartDiscussions ? 'news' : 'conversational';
  const legacyPost = profile.canStartDiscussions || profile.canShareLinks;
  profile.mode = profile.canReply ? (legacyPost ? 'both' : 'comment') : 'post';
  return profile;
}

function deriveLegacyCapabilities(profile, legacy) {
  const old = legacy || {};
  const oldMode = old.mode || profile.mode;
  const oldNews = old.botType === 'news';
  profile.canReply = oldMode === 'both' || oldMode === 'comment';
  profile.canStartDiscussions = !oldNews && (oldMode === 'both' || oldMode === 'post');
  profile.canShareLinks = oldNews;
  return syncCapabilityCompatibility(profile);
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
//   - MERGE every bot's old separate read/write community lists into one shared
//     home set, preserving every configured community
//   - a registered profile's name IS its fedditUsername (no temp name needed)
//   - an as-yet-unregistered profile with no refName gets a fresh temporary one
// No data loss on the username or the title voice, no crash on old records.
function migrateProfiles(rawProfiles, previousSchemaVersion = DATA_SCHEMA_VERSION, legacyGlobalDryRun = true) {
  const list = Array.isArray(rawProfiles) ? rawProfiles : [];
  // Seed the "already used" set from any temp names already on disk so a second
  // unregistered profile can't be handed a name the first one already holds.
  const used = new Set();
  for (const raw of list) {
    if (raw && typeof raw.refName === 'string' && raw.refName) used.add(raw.refName);
  }
  return list.map((raw) => {
    const p = { ...profileDefaults(), ...raw };
    // Schema 7 moves rehearsal/live publishing from one runner-wide switch onto
    // each bot. Existing bots inherit the old global switch exactly once so an
    // upgrade does not unexpectedly publish or unexpectedly stop publishing.
    if (Number(previousSchemaVersion) < 7 || typeof raw.dryRun !== 'boolean') {
      p.dryRun = legacyGlobalDryRun !== false;
    } else {
      p.dryRun = raw.dryRun;
    }
    // Schema 6 replaces mutually-exclusive bot types with three independent
    // abilities. Derive them from the old shape only when loading an old record;
    // modern explicit booleans always win.
    if (Number(previousSchemaVersion) < 6 ||
        raw.canReply === undefined || raw.canStartDiscussions === undefined || raw.canShareLinks === undefined) {
      deriveLegacyCapabilities(p, raw);
      if (raw.botType === 'news' && Number(previousSchemaVersion) < 6) p.newsLetBotChoose = true;
    } else {
      p.canReply = raw.canReply === true;
      p.canStartDiscussions = raw.canStartDiscussions === true;
      p.canShareLinks = raw.canShareLinks === true;
      syncCapabilityCompatibility(p);
    }
    delete p.token;       // bearer tokens live only in data/secrets.json
    delete p.displayName; // gone for good - not deprecated, not hidden
    delete p.createMissingSubFeddit; // auto-create path removed - purge the dead flag, no orphans
    // Merge the old split title controls into the single voice preset (idempotent:
    // a record already on the new shape has no old fields, so we keep its voice).
    if (raw.newsTitleStyle !== undefined || raw.newsTitleFaithfulness !== undefined) {
      p.newsTitleVoice = migrateTitleVoice(raw.newsTitleStyle, raw.newsTitleFaithfulness);
    }
    delete p.newsTitleStyle;        // dead field - gone for good, no orphan
    delete p.newsTitleFaithfulness; // dead field - gone for good, no orphan
    if (Number(previousSchemaVersion) < 4) {
      const replacement = modelCatalog.replacementForLegacyGuidedModel(p.model);
      if (replacement) p.model = replacement;
    }
    const seenHomes = new Set();
    const homes = [];
    for (const value of [...(Array.isArray(p.postFeddits) ? p.postFeddits : []), ...(Array.isArray(p.readFeddits) ? p.readFeddits : [])]) {
      const name = String(value || '').trim().replace(/^f\//i, '').toLowerCase();
      if (!name || seenHomes.has(name)) continue;
      seenHomes.add(name);
      homes.push(name);
    }
    p.postFeddits = homes;
    p.readFeddits = homes;
    p.simulationState = {
      ...simulationDefaults(),
      ...((raw.simulationState && typeof raw.simulationState === 'object') ? raw.simulationState : {}),
      sched: {
        ...schedDefaults(),
        ...((raw.simulationState && raw.simulationState.sched) || {}),
      },
    };
    // Rescue DeepSeek profiles stuck at a STARVING token budget. DeepSeek V4 is a
    // reasoning model: max_tokens (num_predict) is a TOTAL budget spent on hidden
    // reasoning first, so a small value (e.g. the old default 200) yields an EMPTY
    // answer that is still billed in full. Bump any deepseek profile below the safe
    // default up to it. Ollama profiles keep their small num_predict because the
    // guided catalog now uses direct-answer models and the cap keeps local turns
    // responsive.
    if (p.provider === 'deepseek' && (Number(p.numPredict) || 0) < deepseek.SAFE_DEFAULT_MAX_TOKENS) {
      p.numPredict = deepseek.SAFE_DEFAULT_MAX_TOKENS;
    }
    const username = String(p.fedditUsername || '').trim();
    if (!username && !p.refName) {
      p.refName = nextRefName(used);
    }
    return p;
  });
}

// Extract legacy bearer tokens before migrateProfiles removes them. Pure and
// exported for tests. The disk migration writes these to secrets.json first,
// then removes them from profiles.json, so an interrupted migration duplicates
// a secret at worst and can never lose it.
function extractLegacyTokens(rawProfiles) {
  const tokens = {};
  for (const raw of Array.isArray(rawProfiles) ? rawProfiles : []) {
    if (!raw || !raw.id || !raw.token) continue;
    tokens[String(raw.id)] = String(raw.token);
  }
  return tokens;
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
    dryRun: true,         // legacy migration fallback for profiles saved before schema 7
    localDefaultModel: DEFAULT_MODEL, // model suggested for new profiles on this installation
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
  return { schemaVersion: DATA_SCHEMA_VERSION, profiles: [], settings: defaultSettings() };
}

function simulationDefaults() {
  return {
    sched: schedDefaults(),
    repliedTo: [],
    postedNews: [],
    newsDomainDaily: {},
    newsDomainDays: [],
    threadReplies: {},
    threadOrder: [],
  };
}

function migrateSettings(rawSettings, previousSchemaVersion = DATA_SCHEMA_VERSION) {
  const settings = { ...defaultSettings(), ...(rawSettings && typeof rawSettings === 'object' ? rawSettings : {}) };
  if (Number(previousSchemaVersion) < 4) {
    const replacement = modelCatalog.replacementForLegacyGuidedModel(settings.localDefaultModel);
    if (replacement) settings.localDefaultModel = replacement;
  }
  return settings;
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
    const previousSchemaVersion = Number(parsed.schemaVersion) || 0;
    const legacyTokens = extractLegacyTokens(parsed.profiles);
    // Store extracted secrets BEFORE profiles.json is rewritten without them.
    secrets.importFedditTokens(legacyTokens);
    // Preserve the former runner-wide rehearsal/live choice while moving it to
    // each individual profile. Missing or malformed old settings stay safe.
    const legacyGlobalDryRun = parsed.settings && typeof parsed.settings.dryRun === 'boolean'
      ? parsed.settings.dryRun
      : true;
    // Backfill new default fields, drop displayName, assign temp reference names.
    parsed.profiles = migrateProfiles(parsed.profiles, previousSchemaVersion, legacyGlobalDryRun);
    parsed.schemaVersion = DATA_SCHEMA_VERSION;
    parsed.settings = migrateSettings(parsed.settings, previousSchemaVersion);
    cache = parsed;
    // Persist the sanitised current shape. This is intentionally done on load:
    // leaving bearer tokens in profiles.json until the next UI edit would keep
    // the unsafe legacy layout around indefinitely.
    if (Object.keys(legacyTokens).length || previousSchemaVersion !== DATA_SCHEMA_VERSION) {
      save(cache);
    }
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
  // Belt-and-braces: no caller can accidentally put a bearer token back into
  // profiles.json, even if it passes a hydrated profile to save in the future.
  const clean = {
    ...data,
    schemaVersion: DATA_SCHEMA_VERSION,
    profiles: (Array.isArray(data.profiles) ? data.profiles : []).map((p) => {
      const copy = { ...p };
      delete copy.token;
      return copy;
    }),
  };
  const json = JSON.stringify(clean, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, DATA_FILE); // atomic replace on the same filesystem
  cache = clean;
}

// ---- profile CRUD -----------------------------------------------------------

function listProfiles() {
  return load().profiles.map(hydrateProfile);
}

function getProfile(id) {
  const p = load().profiles.find((item) => item.id === id) || null;
  return p ? hydrateProfile(p) : null;
}

function hydrateProfile(profile) {
  return { ...profile, token: secrets.getFedditToken(profile.id) };
}

function createProfile(patch, options = {}) {
  const data = load();
  const input = { ...(patch || {}) };
  const token = String(input.token || '');
  delete input.token;
  const p = { ...profileDefaults(), ...input };
  const hasCapabilityInput = ['canReply', 'canStartDiscussions', 'canShareLinks']
    .some((key) => Object.prototype.hasOwnProperty.call(input, key));
  const hasLegacyInput = Object.prototype.hasOwnProperty.call(input, 'botType') ||
    Object.prototype.hasOwnProperty.call(input, 'mode');
  // Version-1 profile packs made before independent abilities carry only the
  // legacy type/mode pair. Preserve those intentions on import.
  if (!hasCapabilityInput && hasLegacyInput) deriveLegacyCapabilities(p, input);
  else syncCapabilityCompatibility(p);
  p.id = newId();
  const importedDate = options.preserveCreatedAt ? Date.parse(String(input.createdAt || '')) : NaN;
  p.createdAt = Number.isFinite(importedDate)
    ? new Date(importedDate).toISOString()
    : new Date().toISOString();
  // A brand-new profile has no username yet, so give it a temporary reference
  // name (unique against the ones already in use) so it's identifiable in the list.
  if (!String(p.fedditUsername || '').trim() && !p.refName) {
    const used = new Set(data.profiles.map((x) => x.refName).filter(Boolean));
    p.refName = nextRefName(used);
  }
  data.profiles.push(p);
  if (token) secrets.setFedditToken(p.id, token);
  save(data);
  return hydrateProfile(p);
}

function updateProfile(id, patch) {
  const data = load();
  const idx = data.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  // id/createdAt and a registered username are immutable; other profile
  // settings can be patched.
  const input = { ...(patch || {}) };
  const hasTokenPatch = Object.prototype.hasOwnProperty.call(input, 'token');
  const token = hasTokenPatch ? String(input.token || '') : null;
  delete input.token;
  // A registered Feddit identity is permanent, just like a Reddit username.
  // Keep this invariant below the HTTP layer too so an old client or internal
  // caller cannot silently detach a stored bearer token from its real identity.
  if (secrets.getFedditToken(id) && Object.prototype.hasOwnProperty.call(input, 'fedditUsername')) {
    const currentUsername = String(data.profiles[idx].fedditUsername || '').trim().toLowerCase();
    const requestedUsername = String(input.fedditUsername || '').trim().toLowerCase();
    if (requestedUsername !== currentUsername) {
      throw new Error('A registered Feddit username is permanent. Create a different bot identity instead.');
    }
    input.fedditUsername = data.profiles[idx].fedditUsername;
  }
  const merged = { ...data.profiles[idx], ...input };
  syncCapabilityCompatibility(merged);
  merged.id = data.profiles[idx].id;
  merged.createdAt = data.profiles[idx].createdAt;
  data.profiles[idx] = merged;
  if (hasTokenPatch) secrets.setFedditToken(id, token);
  save(data);
  return hydrateProfile(merged);
}

function deleteProfile(id) {
  const data = load();
  const before = data.profiles.length;
  data.profiles = data.profiles.filter((p) => p.id !== id);
  if (data.profiles.length === before) return false;
  save(data);
  secrets.deleteProfileSecrets(id);
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

// ---- global settings (pause / spend; dryRun remains migration compatibility) -

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
function updateSched(id, patch, options = {}) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (options.simulation) {
    p.simulationState = { ...simulationDefaults(), ...(p.simulationState || {}) };
    p.simulationState.sched = {
      ...schedDefaults(), ...(p.simulationState.sched || {}), ...(patch || {}),
    };
    save(data);
    return p.simulationState.sched;
  }
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
function hasReplied(id, key, options = {}) {
  const p = getProfile(id);
  const state = options.simulation ? (p && p.simulationState) : p;
  return !!(state && Array.isArray(state.repliedTo) && state.repliedTo.includes(key));
}

// Record that this profile replied to a fullname; FIFO-bounded so it can't grow.
function recordReplied(id, key, options = {}) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  const state = options.simulation
    ? (p.simulationState = { ...simulationDefaults(), ...(p.simulationState || {}) })
    : p;
  if (!Array.isArray(state.repliedTo)) state.repliedTo = [];
  if (!state.repliedTo.includes(key)) {
    state.repliedTo.push(key);
    if (state.repliedTo.length > REPLIED_CAP) state.repliedTo = state.repliedTo.slice(-REPLIED_CAP);
  }
  save(data);
  return state.repliedTo;
}

// ---- news dedupe (PERMANENT, separate from repliedTo) -----------------------

// Has this profile already handled this canonical article URL in the selected
// live or simulation continuity? Reposting a story is the unforgivable failure.
function hasPostedNews(id, canonicalKey, options = {}) {
  const p = getProfile(id);
  const state = options.simulation ? (p && p.simulationState) : p;
  return !!(state && Array.isArray(state.postedNews) && state.postedNews.includes(canonicalKey));
}

// Record a canonical article URL as handled. Called BEFORE a live submit is even
// attempted, or in the separate simulation state before logging a rehearsal.
// FIFO-bounded at NEWS_DEDUPE_CAP with oldest-out eviction.
function recordPostedNews(id, canonicalKey, options = {}) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  const state = options.simulation
    ? (p.simulationState = { ...simulationDefaults(), ...(p.simulationState || {}) })
    : p;
  if (!Array.isArray(state.postedNews)) state.postedNews = [];
  if (!state.postedNews.includes(canonicalKey)) {
    state.postedNews.push(canonicalKey);
    if (state.postedNews.length > NEWS_DEDUPE_CAP) state.postedNews = state.postedNews.slice(-NEWS_DEDUPE_CAP);
  }
  save(data);
  return state.postedNews.length;
}

// Clear a profile's posted-article history (and its per-domain daily counts).
// This clears LIVE history only. Simulation has an independent reset operation.
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
function newsDomainCount(profile, dayKey, domain, options = {}) {
  const state = options.simulation ? (profile && profile.simulationState) : profile;
  const daily = (state && state.newsDomainDaily) || {};
  const bucket = daily[dayKey] || {};
  return Number(bucket[String(domain || '').toLowerCase()]) || 0;
}

// Record one more post from `domain` on `dayKey`; FIFO-bounded across days.
function recordNewsDomain(id, dayKey, domain, options = {}) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  const state = options.simulation
    ? (p.simulationState = { ...simulationDefaults(), ...(p.simulationState || {}) })
    : p;
  if (!state.newsDomainDaily || typeof state.newsDomainDaily !== 'object') state.newsDomainDaily = {};
  if (!Array.isArray(state.newsDomainDays)) state.newsDomainDays = [];
  const dom = String(domain || '').toLowerCase();
  let bucket = state.newsDomainDaily[dayKey];
  if (!bucket) {
    bucket = {};
    state.newsDomainDaily[dayKey] = bucket;
    state.newsDomainDays.push(dayKey);
    while (state.newsDomainDays.length > NEWS_DOMAIN_DAY_CAP) {
      const old = state.newsDomainDays.shift();
      delete state.newsDomainDaily[old];
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
function getThreadReplyCount(postId, options = {}) {
  if (options.simulation && options.profileId) {
    const p = getProfile(options.profileId);
    const state = (p && p.simulationState) || {};
    return (state.threadReplies && state.threadReplies[String(postId)]) || 0;
  }
  const s = getSettings();
  return (s.threadReplies && s.threadReplies[String(postId)]) || 0;
}

// Count one more this-runner reply in a thread; FIFO-bounded across threads.
function bumpThreadReply(postId, options = {}) {
  const data = load();
  if (options.simulation && options.profileId) {
    const p = data.profiles.find((item) => item.id === options.profileId);
    if (!p) return null;
    const state = p.simulationState = { ...simulationDefaults(), ...(p.simulationState || {}) };
    if (!state.threadReplies || typeof state.threadReplies !== 'object') state.threadReplies = {};
    if (!Array.isArray(state.threadOrder)) state.threadOrder = [];
    const key = String(postId);
    if (!(key in state.threadReplies)) state.threadOrder.push(key);
    state.threadReplies[key] = (state.threadReplies[key] || 0) + 1;
    while (state.threadOrder.length > THREAD_TRACK_CAP) {
      const old = state.threadOrder.shift();
      delete state.threadReplies[old];
    }
    save(data);
    return state.threadReplies[key];
  }
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

// Start a clean rehearsal without touching anything that was actually
// published. Simulation has independent cadence, reply dedupe, article dedupe
// and thread caps; its result cards are removed at the same time.
function resetSimulation(id) {
  const data = load();
  const p = data.profiles.find((item) => item.id === id);
  if (!p) return null;
  p.simulationState = simulationDefaults();
  p.activity = Array.isArray(p.activity) ? p.activity.filter((entry) => !entry.dryRun) : [];
  save(data);
  return true;
}

module.exports = {
  DATA_DIR,
  DATA_FILE,
  DATA_SCHEMA_VERSION,
  DEFAULT_MODEL,
  profileDefaults,
  deriveLegacyCapabilities,
  syncCapabilityCompatibility,
  schedDefaults,
  simulationDefaults,
  referenceName,
  migrateProfiles,
  migrateSettings,
  extractLegacyTokens,
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
  resetSimulation,
  recordSpend,
  profileSpend,
  runnerSpend,
};
