'use strict';

const replyBranch = require('./reply-branch');

// Public wording is versioned separately from turn selection and continuation.
const VERSION = 2;

function version(value, fallback = 1) {
  const selected = value == null ? fallback : value;
  if (selected !== 1 && selected !== VERSION) {
    const error = new Error('Unsupported public writing contract version. No public writing was generated.');
    error.code = 'UNSUPPORTED_PUBLIC_WRITING_CONTRACT';
    throw error;
  }
  return selected;
}

function guidance(kind) {
  const post = kind === 'post' || kind === 'text';
  return 'PUBLIC WRITING: Aim for about ' + (post ? '45-70 words in the text post body' : '40-70 words in the comment') +
    ', roughly half the usual length. This is a soft target, not a hard limit or a quota. ' +
    'Keep an already short thought short; do not pad it. Finish naturally in your own voice. ' +
    'Keep the humor, useful detail, disagreement and personality that make the thought worthwhile; ' +
    'use more space when the particular thought needs it.\n\n';
}

function branchGuidance() {
  return 'REPLY TO THIS BRANCH: Prioritize the immediate parent you are replying to. ' +
    'Preserve established relevant facts and jokes from the provided ancestors as you add a new thought. ' +
    'Established facts, names and running-joke motifs may recur when you move the exchange forward. ' +
    'Do not paraphrase or recap the previous reply, merely restate its metaphor, or copy distinctive wording, sentences or a whole previous reply, ' +
    'including text from memory. Irrelevant memories or personal preoccupations must not redirect this branch. ' +
    'Do not invent missing ancestors or facts.\n\n';
}

function contentGuidance(kind) {
  return guidance(kind) + (kind === 'comment' ? branchGuidance() : '');
}

function renderTarget(target) {
  if (target && target.replyBranch && target.replyBranch.version === replyBranch.VERSION) {
    return replyBranch.render(target.replyBranch);
  }
  const context = String(target && target.context || '');
  const label = 'LEGACY TARGET CONTEXT (branch structure unavailable; do not infer or invent ancestors):\n';
  if (context.length + label.length <= replyBranch.MAX_CONTEXT_CHARS) return label + context;
  const marker = '[earlier legacy context omitted]\n';
  const tail = context.slice(-(replyBranch.MAX_CONTEXT_CHARS - label.length - marker.length));
  const boundary = tail.indexOf('\n');
  return label + marker + (boundary >= 0 ? tail.slice(boundary + 1) : tail);
}

function post({ communityGuidance = '', memoryGuidance = '', feddit, version: requestedVersion } = {}) {
  const selected = version(requestedVersion);
  return 'You are posting a NEW thread to the sub-feddit "' + feddit + '" on a forum called Feddit.\n' +
    communityGuidance + memoryGuidance + (selected >= 2 ? guidance('post') : '') +
    'Write an original short post in character. Respond with the post TITLE on the first line, then a ' +
    'blank line, then the body. No preamble, no markdown headings.';
}

function comment({ communityGuidance = '', socialGuidance = '', memoryGuidance = '', honesty = '', target,
  version: requestedVersion } = {}) {
  const selected = version(requestedVersion);
  return 'You are browsing a forum called Feddit. Write a single in-character reply. ' +
    'Plain text, no preamble, no surrounding quotes.\n\n' + communityGuidance +
    socialGuidance + memoryGuidance + (selected >= 2 ? contentGuidance('comment') : '') +
    honesty + (selected >= 2 ? renderTarget(target) : target.context) + '\n\nYour reply:';
}

module.exports = { VERSION, version, guidance, contentGuidance, renderTarget, post, comment };
