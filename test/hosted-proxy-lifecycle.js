'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const config = fs.readFileSync(path.join(__dirname, '../deploy/feddit-bots.dabblelabs.uk.Caddyfile'), 'utf8');
const server = http.createServer(); // Never listens or sends a request.
const idle = config.match(/transport http\s*{\s*keepalive (\d+)s\s*}/);
assert(idle, 'hosted upstream idle recycling is explicit');
assert(Number(idle[1]) * 1000 < server.keepAliveTimeout,
  'Caddy retires pooled sockets before Node closes them');
assert(config.includes('reverse_proxy 127.0.0.1:8770 {'), 'same loopback runner');
assert(!/lb_try|retry|read_timeout|write_timeout|response_header_timeout|keepalive off/.test(
  config.replace(/^\s*#.*$/gm, '')), 'no POST retry or request-timeout workaround');
assert(config.includes('handle /desktop/*'), 'desktop artifacts remain static');
assert(config.includes('redir https://feddit-bots.dabblelabs.uk{uri} permanent'), 'compatibility origin unchanged');
server.close();
console.log('hosted proxy lifecycle: 6 checks passed (offline)');
