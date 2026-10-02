'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const build = fs.readFileSync(path.join(root, 'desktop', 'build-app-update.ps1'), 'utf8');
const stage = fs.readFileSync(path.join(root, 'desktop', 'stage-local-update.ps1'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert.match(build, /Copy-Item[\s\S]*public[\s\S]*-Recurse/,
  'signed desktop updates package the shared public UI tree');
assert.match(stage, /Copy-Item[\s\S]*public[\s\S]*-Recurse/,
  'local desktop updates stage the shared public UI tree');
assert.equal(fs.existsSync(path.join(root, 'desktop', 'public', 'index.html')), false,
  'desktop does not maintain a second bot editor');
assert.match(html, /placementUiLogic\.editorVariant\(state\.placement, p\)/,
  'the shared editor selects only data-driven placement differences');
assert.match(html, /initializeSectionDisclosures\(main, p\)/);
assert.match(html, /id="dirtySave"/);
assert.match(html, /const manualNewsPreviewSection = state\.developerTools \?/);
assert.match(html, /<script src="\/ui-speed\.js"><\/script>/,
  'desktop and hosted load the same Speed UI module');
assert.match(html, /id="speedBtn"[\s\S]*id="speedPopover"/,
  'the shared top bar owns one workspace Speed control');

console.log('desktop-ui-parity: all checks passed');
