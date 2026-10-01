'use strict';

const assert = require('node:assert/strict');
const activity = require('../public/ui-activity.js');

assert.deepEqual(activity.rateVisibility({
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: true,
}), { text: true, article: true, replies: true },
'a news-capable discussion bot exposes all three activity rates');

assert.deepEqual(activity.rateVisibility({
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: false,
}), { text: true, article: false, replies: true },
'a non-news bot exposes only text-post and reply rates');

console.log('ui-activity: all checks passed');
