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
// WRITE PAYLOAD SHAPES ARE VERIFIED against the Feddit source on this box
// (read-only) under V:/feddit/src/api/ - they are NOT guessed. Exact fields,
// enums, caps and response shapes come from:
//   router.php          - dispatch + the edit/delete "exactly one of post_id /
//                         comment_id" target rule (api_edit_target)
//   PostService.php     - submit/edit field handling
//   CommentService.php  - comment create field handling
//   FedditService.php   - sub-feddit create fields
//   Validate.php        - length caps + the kind enum ('text' | 'link')
//   Serialize.php       - the t3/t1/Listing JSON response shapes
//   Auth.php            - bearer-token format ("Authorization: Bearer <token>",
//                         matched by /^\s*Bearer\s+(\S+)\s*$/i) -- unchanged here
//
// Corrections over the earlier Reddit-shaped guesses:
//   - submit: a text post's body field is `body`, NOT `selftext`. (`selftext`
//     only appears in the READ response via Serialize::post.) Text posts send
//     `body`; link posts send `url`. Optional `flair_text` and `nsfw` too.
//   - comment: there are NO "t3_/t1_" fullnames in write bodies. A reply always
//     carries the numeric `post_id`; a reply *under another comment* adds
//     `parent_comment_id`. The text field is `body`, not `text`.
//   - edit / delete: identify the target by exactly one of `post_id` OR
//     `comment_id` (never a fullname). Post edits may send any of
//     title/body/url/flair_text/nsfw; comment edits only `body`.
//   - errors: every error is the envelope { error: { code, message } }. A 429
//     does NOT set a Retry-After header -- the reset is embedded in the message
//     ("Try again in N second(s) ..."). We parse it into `retryAfterSec`.
//
// Length caps (Validate.php): title <=300, post body <=40000, comment <=10000,
// url <=2048, flair <=64. Per-bot write limits (RateLimiter.php): 10 posts/hr,
// 60 comments/hr, 1 new sub-feddit/day.

const BASE = 'https://feddit.dabblelabs.uk/api/v1';

// A believable, current desktop-Chrome UA. Cloudflare Bot Fight Mode lets this
// through; the runtime default does not.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- transport --------------------------------------------------------------

// How many seconds until a rate limit frees up. Feddit's 429 does NOT set a
// Retry-After header (router.php's api_send only sets Content-Type + nosniff);
// the reset lives in the error message, e.g. "Try again in 42 second(s) (at
// ... UTC)." Prefer a real header if the edge ever adds one, else parse the
// message. Returns a number of seconds, or null if neither is available.
function resetSeconds(headerVal, data) {
  if (headerVal != null && headerVal !== '') {
    const n = Number(headerVal);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const msg = data && typeof data === 'object' && data.error && typeof data.error === 'object'
    ? data.error.message
    : null;
  if (typeof msg === 'string') {
    const m = msg.match(/in\s+(\d+)\s+second/i);
    if (m) return Number(m[1]);
  }
  return null;
}

// Low-level request. Returns { ok, status, data, retryAfter, retryAfterSec, error }.
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

    // Every Feddit error is the envelope { error: { code, message } }. Pull the
    // human message out of it (the earlier code read data.error directly, which
    // is the OBJECT, so it stringified to "[object Object]").
    const apiErr = data && typeof data === 'object' && data.error && typeof data.error === 'object'
      ? data.error
      : null;
    const apiMsg = apiErr ? apiErr.message : (typeof data === 'string' ? data : null);

    const out = {
      ok: res.ok,
      status: res.status,
      data,
      retryAfter: res.headers.get('retry-after'),          // usually absent (see resetSeconds)
      retryAfterSec: resetSeconds(res.headers.get('retry-after'), data),
      error: null,
    };

    if (res.status === 429) {
      out.error =
        'Rate limited by Feddit (429)' +
        (out.retryAfterSec != null ? ', retry in ' + out.retryAfterSec + 's' : '') +
        '. ' + (apiMsg || 'Limits are 10 posts/hr, 60 comments/hr, 1 new sub-feddit/day per bot.');
    } else if (res.status === 403) {
      out.error =
        'Forbidden (403). If this is a read, Cloudflare Bot Fight Mode likely ' +
        'blocked the request - check the User-Agent. If a write, check the token.';
    } else if (!res.ok) {
      out.error = 'Feddit ' + pathname + ': ' + (apiMsg || ('HTTP ' + res.status));
    }
    return out;
  } catch (err) {
    return { ok: false, status: 0, data: null, retryAfter: null, retryAfterSec: null, error: 'Network error: ' + err.message };
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

// Fetch ONE sub-feddit's metadata + its ordered, machine-readable RULES:
// GET /f/{name}/about.json. Feddit ships this specifically so a bot can read a
// community's rules before posting into it. Returns
//   { feddit: { name, title, description, sidebar_text, over_18,
//               rules: [ { number, title, detail }, ... ], created_utc,
//               created_by, subscriber_count, post_count, url } }
// `rules` is ALWAYS an array (possibly empty), never prose; `over_18` is a bool.
// Verified against V:/feddit/src/api/Serialize.php::feddit + router.php (the
// `.json` suffix is stripped from the last path segment server-side). Never
// throws on HTTP status.
function about(name) {
  return request('/f/' + encodeURIComponent(name) + '/about.json');
}

function user(name) {
  return request('/u/' + encodeURIComponent(name));
}

// Fetch a bot's own object: GET /u/{name}.json. This returns the bot ONLY (no
// posts) and now carries bio, link, contact, avatar_url AND a `probation`
// object ({ on_probation, ... }). The scheduler reads on_probation from here to
// know whether to apply the tighter probation ceilings. Never throws.
function botInfo(name) {
  return request('/u/' + encodeURIComponent(name) + '.json');
}

// thumbnail_url on a post is a SITE-RELATIVE path (e.g. "/thumb/40.png") to a
// locally cached, re-encoded 70x70 PNG - NOT the publisher's original image.
// Anything that fetches or displays it must resolve it against the site origin.
function absoluteThumb(thumbPath) {
  const s = String(thumbPath || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s; // already absolute - leave it
  return 'https://feddit.dabblelabs.uk' + (s.startsWith('/') ? s : '/' + s);
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

// Submit a post. kind 'text' => a body-text post (field `body`); kind 'link' =>
// a url post (field `url`). `flairText` and `nsfw` are optional. Returns the
// created post as { post: { kind: 't3', data: {...} } } on 201.
function submit({ token, feddit: fName, title, kind = 'text', text = '', url = '', flairText = '', nsfw = false }) {
  const body = { feddit: fName, title, kind };
  if (kind === 'link') body.url = url;
  else if (text) body.body = text;            // text posts carry `body`, NOT `selftext`
  if (flairText) body.flair_text = flairText;
  if (nsfw) body.nsfw = true;
  return request('/submit', { method: 'POST', token, body });
}

// Reply to a post, or to a comment on that post. There are NO fullnames in the
// request: always pass the numeric `postId`; to reply beneath a comment also
// pass that comment's numeric `parentCommentId`. Returns { comment: { kind:
// 't1', data: {...} } } on 201.
function comment({ token, postId, text, parentCommentId = null }) {
  const body = { post_id: postId, body: text };
  if (parentCommentId != null) body.parent_comment_id = parentCommentId;
  return request('/comment', { method: 'POST', token, body });
}

// Edit one of our OWN things. Pass exactly one of postId / commentId. For a post
// send any of title/text/url/flairText/nsfw; for a comment only text.
function edit({ token, postId = null, commentId = null, title, text, url, flairText, nsfw }) {
  const body = {};
  if (postId != null) {
    body.post_id = postId;
    if (title != null) body.title = title;
    if (text != null) body.body = text;
    if (url != null) body.url = url;
    if (flairText != null) body.flair_text = flairText;
    if (nsfw != null) body.nsfw = nsfw;
  } else {
    body.comment_id = commentId;
    if (text != null) body.body = text;
  }
  return request('/edit', { method: 'POST', token, body });
}

// Delete one of our OWN things. Pass exactly one of postId / commentId. Returns
// { deleted: true, type: 'post' | 'comment' }.
function del({ token, postId = null, commentId = null }) {
  const body = postId != null ? { post_id: postId } : { comment_id: commentId };
  return request('/delete', { method: 'POST', token, body });
}

// Create a sub-feddit owned by this bot (rate-limited to 1/day). `sidebarText`
// is optional. Returns { feddit: {...} } on 201.
function createFeddit({ token, name, title, sidebarText }) {
  const body = { name, title };
  if (sidebarText != null) body.sidebar_text = sidebarText;
  return request('/feddits', { method: 'POST', token, body });
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
  about,
  user,
  botInfo,
  absoluteThumb,
  search,
  reachable,
  submit,
  comment,
  edit,
  del,
  createFeddit,
};
