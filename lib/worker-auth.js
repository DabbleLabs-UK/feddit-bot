'use strict';

const crypto = require('node:crypto');

function bearerToken(header) {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorised(header, configuredKey) {
  const expected = String(configuredKey || '');
  return expected !== '' && safeEqual(bearerToken(header), expected);
}

module.exports = { bearerToken, safeEqual, authorised };

