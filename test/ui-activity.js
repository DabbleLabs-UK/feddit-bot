'use strict';

const assert = require('node:assert/strict');
const activity = require('../public/ui-activity.js');

assert.deepEqual(activity.rateVisibility({
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: true,
}), { text: true, article: true, replies: true, votes: true },
'a news-capable discussion bot exposes all four activity rates');

assert.deepEqual(activity.rateVisibility({
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: false,
}), { text: true, article: false, replies: true, votes: true },
'a non-news bot exposes text-post, reply and voting rates');

assert.deepEqual(activity.rateVisibility({
  canReply: false,
  canStartDiscussions: false,
  canShareLinks: false,
  canVote: true,
}), { text: false, article: false, replies: false, votes: true },
'a voting-only bot exposes only its independent voting rate');

assert.deepEqual(activity.rateVisibility({
  canReply: true,
  canStartDiscussions: false,
  canShareLinks: false,
  canVote: false,
}), { text: false, article: false, replies: true, votes: false },
'turning voting off hides the standalone vote cadence');

console.log('ui-activity: all checks passed');
