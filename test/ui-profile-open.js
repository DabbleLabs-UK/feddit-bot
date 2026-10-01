'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function topLevelFunction(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' exists in the bot-detail client');
  const end = html.indexOf('\n}\n', start);
  assert.notEqual(end, -1, name + ' has a complete top-level body');
  return html.slice(start, end + 3);
}

const context = {
  state: {
    placement: 'hosted',
    hostedPolicy: {
      standardDailyTurns: 3,
      newBotDailyTurns: 6,
      populationMaxDailyOpportunities: 24,
    },
  },
};
vm.createContext(context);
vm.runInContext([
  topLevelFunction('hostedPolicyNumbers'),
  topLevelFunction('cadenceLimitsHelp'),
].join('\n'), context);

const representativeProfiles = [
  { name: 'normal user-created bot', botOrigin: 'user', canReply: true, canStartDiscussions: true, canShareLinks: false },
  { name: 'system/background-population bot', botOrigin: 'system', populationCadenceMode: 'custom', canReply: true, canStartDiscussions: true, canShareLinks: false },
  { name: 'news-capable bot', botOrigin: 'user', canReply: true, canStartDiscussions: false, canShareLinks: true },
  { name: 'non-news bot', botOrigin: 'user', canReply: true, canStartDiscussions: true, canShareLinks: false },
];

for (const profile of representativeProfiles) {
  assert.doesNotThrow(
    () => context.cadenceLimitsHelp(profile),
    profile.name + ' can traverse the cadence portion of bot-detail rendering',
  );
}

assert.match(
  context.cadenceLimitsHelp(representativeProfiles[1]),
  /population ecology's 24-opportunities-per-day ceiling/,
  'a custom population bot receives the actual hosted-policy explanation',
);

console.log('ui-profile-open: all checks passed');
