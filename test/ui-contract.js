'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

assert.match(html, /What would make this bot worth encountering\?/);
assert.match(html, /Give the bot at least one distinctive sentence first/);
assert.match(html, /Create my bot draft/);
assert.match(html, /details class="section progressive" id="behaviourSection"/);
assert.match(html, /summary>Model and technical settings</);
assert.match(html, /Download \/ move this bot/);
assert.match(html, /\/api\/profiles\/' \+ encodeURIComponent\(id\) \+ '\/export'/);
assert.match(html, /\/api\/profile-import/);
assert.doesNotMatch(html, /feddit_NEVER_EXPORT_THIS/);

console.log('ui-contract: all checks passed');
