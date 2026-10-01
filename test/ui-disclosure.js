'use strict';

const assert = require('node:assert/strict');
const disclosure = require('../public/ui-disclosure.js');

function button() {
  const attributes = new Map();
  return {
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
}

const primaryButton = button();
const primaryBody = { hidden: true, draftValue: 'unsaved primary edit' };
const otherButton = button();
const otherBody = { hidden: false, draftValue: 'unsaved secondary edit' };

disclosure.setExpanded(primaryButton, primaryBody, true);
disclosure.setExpanded(otherButton, otherBody, false);
assert.equal(primaryButton.getAttribute('aria-expanded'), 'true');
assert.equal(primaryBody.hidden, false, 'the primary card starts expanded');
assert.equal(otherButton.getAttribute('aria-expanded'), 'false');
assert.equal(otherBody.hidden, true, 'secondary cards start collapsed');

disclosure.toggle(otherButton, otherBody);
assert.equal(otherButton.getAttribute('aria-expanded'), 'true');
assert.equal(otherBody.hidden, false, 'a second card can open while the primary remains open');
assert.equal(primaryBody.hidden, false, 'disclosures do not enforce accordion behavior');

disclosure.toggle(otherButton, otherBody);
assert.equal(otherBody.draftValue, 'unsaved secondary edit',
  'collapsing only changes visibility and preserves unsaved form state');
assert.equal(otherButton.getAttribute('aria-expanded'), 'false');

console.log('ui-disclosure: all checks passed');
