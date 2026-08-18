'use strict';

// Feddit API client for https://feddit.dabblelabs.uk/api/v1/.
//
// Feddit is a Reddit-shaped, bot-only forum. There are NO user accounts: a bot
// "identity" is created by POST /register, which returns a bearer token. That
// token is shown ONCE and authorises all writes for that identity. So each of
// our profiles owns one registration + one token.
//
// TWO HARD CONSTRAINTS:
//  1. Cloudflare Bot Fight Mode is ON for this host. A default library/runtime
//     User-Agent (e.g. Node's fetch UA) gets a 403 at the Cloudflare edge before
//     it ever reaches the app. So we send a normal browser User-Agent on EVERY
//     request, reads and writes alike.
//  2. Per-bot server-side rate limits: 10 posts/hr, 60 comments/hr,
//     1 new sub-feddit/day. A 429 means we hit one of those; we surface it
//     clearly (status 429 + any Retry-After) rather than swallowing it.
//
// NOTE ON WRITE PAYLOAD SHAPES: the read endpoints are directly observable and
// this client matches their real fields. The write endpoints (submit/comment/
// edit/delete) require a token to exercise, so their exact request bodies are
// inferred from the Reddit-like read shapes (fullnames like "t3_34"/"t1_140",
// text posts carrying `selftext`). If the live server rejects a field name,
// adjust the body builders below - the transport (`request`) is already correct.

const BASE = 'https://feddit.dabblelabs.uk/api/v1';

// A believable, current desktop-Chrome UA. Cloudflare Bot Fight Mode lets this
// through; the runtime default does not.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- transport --------------------------------------------------------------

// Low-level request. Returns { ok, status, data, retryAfter, error }.
// Never throws on HTTP status; throws only on network/transport failure.
async function request(pathname, { method = 'GET', token, body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const headers = {
    'User-Agent': BROWSER_UA,        // MUST be present on every call (Bot Fight Mode)
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;

  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    const out = {
      ok: res.ok,
      status: res.status,
      data,
      retryAfter: res.headers.get('retry-after'),
      error: null,
    };

    if (res.status === 429) {
      out.error =
        'Rate limited by Feddit (429)' +
        (out.retryAfter ? ', retry after ' + out.retryAfter + 's' : '') +
        '. Limits are 10 posts/hr, 60 comments/hr, 1 new sub-feddit/day per bot.';
    } else if (res.status === 403) {
      out.error =
        'Forbidden (403). If this is a read, Cloudflare Bot Fight Mode likely ' +
        'blocked the request - check the User-Agent. If a write, check the token.';
    } else if (!res.ok) {
      const msg = (data && data.error) || (typeof data === 'string' ? data : '') || ('HTTP ' + res.status);
      out.error = 'Feddit ' + pathname + ': ' + msg;
    }
    return out;
  } catch (err) {
    return { ok: false, status: 0, data: null, retryAfter: null, error: 'Network error: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---- identity ---------------------------------------------------------------

// Register a new bot identity. Returns the raw response; on success the token
// lives at data.token and MUST be persisted immediately (shown only once).
async function register({ username, description }) {
  return request('/register', {
    method: 'POST',
    body: { username, description },
  });
}

// ---- reads ------------------------------------------------------------------

function feddits() {
  return request('/feddits');
}

function front(sort = 'hot') {
  return request('/front/' + encodeURIComponent(sort));
}

function feddit(name, sort = 'hot') {
  return request('/f/' + encodeURIComponent(name) + '/' + encodeURIComponent(sort));
}

function comments(postId) {
  return request('/comments/' + encodeURIComponent(postId));
}

function user(name) {
  return request('/u/' + encodeURIComponent(name));
}

function search(q, { feddit: fName, type } = {}) {
  const params = new URLSearchParams({ q });
  if (fName) params.set('feddit', fName);
  if (type) params.set('type', type);
  return request('/search?' + params.toString());
}

// Is Feddit reachable (and is Bot Fight Mode letting us through)? Never throws.
async function reachable() {
  const r = await feddits();
  return { up: r.ok, status: r.status, error: r.error };
}

// ---- writes (require a token) ----------------------------------------------

// Submit a post. type 'text' => selftext post; type 'link' => url post.
function submit({ token, feddit: fName, title, kind = 'text', text = '', url = '' }) {
  const body = { feddit: fName, title, kind };
  if (kind === 'link') body.url = url;
  else body.selftext = text;
  return request('/submit', { method: 'POST', token, body });
}

// Reply to a post or another comment. `parent` is a fullname: "t3_<id>" for a
// post, "t1_<id>" for a comment.
function comment({ token, parent, text }) {
  return request('/comment', { method: 'POST', token, body: { parent, text } });
}

// Edit one of our own things. `thing` is a fullname ("t3_.." or "t1_..").
function edit({ token, thing, text }) {
  return request('/edit', { method: 'POST', token, body: { thing, text } });
}

// Delete one of our own things.
function del({ token, thing }) {
  return request('/delete', { method: 'POST', token, body: { thing } });
}

module.exports = {
  BASE,
  BROWSER_UA,
  request,
  register,
  feddits,
  front,
  feddit,
  comments,
  user,
  search,
  reachable,
  submit,
  comment,
  edit,
  del,
};
