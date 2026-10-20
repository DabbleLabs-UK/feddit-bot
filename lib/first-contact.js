'use strict';

// An assessment is a handled model offer, not a promised social reaction.
const ordinary = require('./ordinary-candidates');
const voting = require('./voting');
const VERSION = 2;
const ENTRY_CAP = ordinary.ENTRY_CAP;
const RECEIPT_CAP = 20;

function version(raw, fallback = 0) {
  const selected = raw == null ? fallback : raw;
  if (selected !== 0 && selected !== 1 && selected !== VERSION) {
    const error = new Error('Unsupported first-contact contract version. No assessment state was changed.');
    error.code = 'UNSUPPORTED_FIRST_CONTACT';
    throw error;
  }
  return selected;
}

function key(raw) {
  return typeof raw === 'string' && raw.length <= 64 && /^t3_[0-9]+$/.test(raw) ? raw : '';
}

function root(candidate) {
  const target = candidate && (candidate.target || candidate);
  return target && target.kind === 'post' && target.candidateType === 'ordinary_post' && key(target.key)
    ? target : null;
}

function select(roots, presentation, voteState, selectedVersion = VERSION, excludeKeys = []) {
  const contract = version(selectedVersion);
  if (!contract) return null;
  const state = ordinary.normalize(presentation);
  const assessed = new Set((state.assessed || []).map((entry) => entry.key));
  const excluded = new Set(excludeKeys);
  const considered = new Set(voting.normalize(voteState).considered);
  const timestamps = new Map(state.entries.map((entry) => [entry.key, entry.at]));
  const eligible = (Array.isArray(roots) ? roots : [])
    .map((candidate, order) => ({ candidate, target: root(candidate), order }))
    .filter(({ target }) => target && (contract >= 2 || target.independentlyAssessed === false) && !excluded.has(target.key) &&
      !assessed.has(target.key) && !considered.has('post:' + target.key.slice(3)))
    .sort((a, b) => (timestamps.get(a.target.key) || 0) - (timestamps.get(b.target.key) || 0) || a.order - b.order);
  return eligible.length ? eligible[0].candidate : null;
}

function inject(selected, candidate, limit = ordinary.SHORTLIST_LIMIT) {
  const maximum = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, ordinary.SHORTLIST_LIMIT) : ordinary.SHORTLIST_LIMIT;
  const current = Array.isArray(selected) ? selected : [];
  const target = root(candidate);
  if (!target || maximum === 0) return current.slice(0, maximum);
  return [{ ...candidate, firstContact: true }, ...current.filter((item) => {
    const other = item && (item.target || item);
    return other && other.key !== target.key;
  })].slice(0, maximum);
}

function plan(handled, at, selectedVersion = VERSION) {
  const contract = version(selectedVersion);
  if (!contract) throw new Error('An active first-contact contract is required.');
  if (!Number.isFinite(at) || at <= 0) throw new Error('A positive first-contact timestamp is required.');
  const keys = [];
  const add = (identity) => {
    if (key(identity) && !keys.includes(identity) && keys.length < RECEIPT_CAP) keys.push(identity);
  };
  if (handled && handled.valid === true) {
    for (const candidate of handled.candidates || []) {
      const target = root(candidate);
      if (target) add(target.key);
    }
  }
  for (const vote of handled && handled.votes || []) {
    if (!vote || vote.decisionKind !== 'explicit' || vote.status === 'unresolved' ||
        vote.targetType !== 'post' || !['up', 'down', 'nil'].includes(vote.direction) ||
        !Number.isSafeInteger(Number(vote.targetId)) || Number(vote.targetId) <= 0) continue;
    add('t3_' + Number(vote.targetId));
  }
  return { version: contract, at, keys };
}

function record(state, receipt) {
  if (!receipt || !version(receipt.version) || !Number.isFinite(receipt.at) || receipt.at <= 0 ||
      !Array.isArray(receipt.keys) || receipt.keys.length > RECEIPT_CAP ||
      receipt.keys.some((identity) => !key(identity)) || new Set(receipt.keys).size !== receipt.keys.length) {
    throw new Error('A valid first-contact assessment receipt is required.');
  }
  const current = ordinary.normalize(state);
  if (!receipt.keys.length) return current;
  return ordinary.normalize({ ...current, assessed: (current.assessed || []).concat(
    receipt.keys.map((identity) => ({ key: identity, at: receipt.at })),
  ) });
}

module.exports = { VERSION, ENTRY_CAP, RECEIPT_CAP, version, select, inject, plan, record };
