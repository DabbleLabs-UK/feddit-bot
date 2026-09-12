'use strict';

// Portable description of WHAT a bot is. It deliberately excludes WHERE it
// runs, WHICH model/provider a runner uses, whether it is currently enabled,
// and every secret. The same pack can therefore move between hosted, desktop
// and future self-hosted runners without turning machine policy into identity.

const FORMAT = 'feddit-bot-profile';
const VERSION = 1;

const BOT_FIELDS = [
  'fedditUsername',
  'refName',
  'persona',
  'toneNotes',
  'readFeddits',
  'postFeddits',
  'allowNsfw',
  'botType',
  'mode',
  'postsPerHour',
  'commentsPerHour',
  'newsUseAllFeeds',
  'newsFeedSelection',
  'newsCustomFeeds',
  'newsUseGdelt',
  'newsQuery',
  'newsRoutingRules',
  'newsStrictRouting',
  'newsMaxAgeHours',
  'newsMaxPerDomainPerDay',
  'newsMinGapMinutes',
  'newsDomainDenylist',
  'newsPaywallFilter',
  'newsRequireImage',
  'newsTitleVoice',
  'newsTitleCustom',
  'newsLetBotChoose',
  'linkNoContext',
  'temperature',
  'numPredict',
];

// Runtime continuity matters when moving a live bot: without its dedupe ledger
// it could repost an old article or reply twice. Activity and spend records are
// also retained, but remain non-secret. A reusable template excludes this block.
const RUNTIME_FIELDS = [
  'createdAt',
  'activity',
  'probation',
  'sched',
  'repliedTo',
  'postedNews',
  'newsDomainDaily',
  'newsDomainDays',
  'spendDaily',
  'spendDays',
];

function copyFields(source, fields) {
  const out = {};
  const input = source && typeof source === 'object' ? source : {};
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    out[key] = structuredClone(input[key]);
  }
  return out;
}

function exportProfile(profile, options = {}) {
  const template = options.template === true;
  const includeRuntime = options.includeRuntime !== false && !template;
  const bot = copyFields(profile, BOT_FIELDS);
  if (template) {
    bot.fedditUsername = '';
    bot.refName = '';
  }

  const pack = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    sourceProfileId: template ? null : String((profile && profile.id) || '') || null,
    kind: template ? 'template' : 'move',
    bot,
  };
  if (includeRuntime) pack.runtime = copyFields(profile, RUNTIME_FIELDS);
  return pack;
}

function validate(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return { ok: false, error: 'The bot profile must be a JSON object.' };
  }
  if (pack.format !== FORMAT) {
    return { ok: false, error: 'This is not a Feddit bot profile.' };
  }
  if (Number(pack.version) !== VERSION) {
    return { ok: false, error: 'This bot profile version is not supported.' };
  }
  if (!pack.bot || typeof pack.bot !== 'object' || Array.isArray(pack.bot)) {
    return { ok: false, error: 'The bot profile has no bot description.' };
  }
  return { ok: true, error: null };
}

function importPatch(pack) {
  const checked = validate(pack);
  if (!checked.ok) {
    const err = new Error(checked.error);
    err.code = 'INVALID_PROFILE_PACK';
    throw err;
  }
  const patch = {
    ...copyFields(pack.bot, BOT_FIELDS),
    ...copyFields(pack.runtime, RUNTIME_FIELDS),
    enabled: false,
  };
  // A template is creative scaffolding, never an existing registered identity.
  if (pack.kind === 'template') {
    patch.fedditUsername = '';
    patch.refName = '';
  }
  return patch;
}

module.exports = {
  FORMAT,
  VERSION,
  BOT_FIELDS,
  RUNTIME_FIELDS,
  exportProfile,
  validate,
  importPatch,
};
