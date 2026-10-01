'use strict';

const crypto = require('node:crypto');

const ANALYSIS_SCHEMA_VERSION = 1;
const MAX_SAMPLE_TEXT = 420;
const MAX_PROMPT_SAMPLES = 80;
const IGNORED_AUTHORS = new Set(['[deleted]', 'automoderator']);
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before', 'being',
  'but', 'can', 'could', 'did', 'does', 'for', 'from', 'had', 'has', 'have', 'here',
  'how', 'into', 'its', 'just', 'like', 'more', 'not', 'now', 'only', 'our', 'out',
  'really', 'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'too', 'very', 'was', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

function cleanText(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, maxItems = 12, maxLength = 120) {
  const seen = new Set();
  const output = [];
  for (const item of Array.isArray(value) ? value : []) {
    const clean = cleanText(item, maxLength);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
    if (output.length >= maxItems) break;
  }
  return output;
}

function authorKey(value) {
  return cleanText(value, 100).toLowerCase();
}

function isUsableAuthor(value) {
  const key = authorKey(value);
  return Boolean(key && !IGNORED_AUTHORS.has(key));
}

function score(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sampleText(item) {
  return cleanText(item.type === 'post' ? [item.title, item.body].filter(Boolean).join(' - ') : item.body, MAX_SAMPLE_TEXT);
}

function interactionKey(left, right) {
  const values = [authorKey(left), authorKey(right)].filter(Boolean).sort();
  return values.length === 2 && values[0] !== values[1] ? values.join('::') : '';
}

function aggregateContributors(corpus = {}, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  const contributors = new Map();
  const interactions = new Map();
  const touch = (author) => {
    const key = authorKey(author);
    if (!isUsableAuthor(key)) return null;
    if (!contributors.has(key)) {
      contributors.set(key, {
        author: cleanText(author, 100),
        posts: 0,
        comments: 0,
        totalScore: 0,
        threads: new Set(),
        repliesReceived: 0,
        repliesMade: 0,
        interactionAuthors: new Set(),
        sourceIds: [],
        samples: [],
      });
    }
    return contributors.get(key);
  };

  for (const post of Array.isArray(corpus.posts) ? corpus.posts : []) {
    const entry = touch(post.author);
    if (!entry) continue;
    entry.posts++;
    entry.totalScore += score(post.score);
    if (post.sourceId) entry.sourceIds.push(post.sourceId);
    const sample = sampleText(post);
    if (sample && entry.samples.length < 6) entry.samples.push(sample);
  }

  const commentsById = new Map((Array.isArray(corpus.comments) ? corpus.comments : []).map((item) => [item.sourceId, item]));
  for (const comment of Array.isArray(corpus.comments) ? corpus.comments : []) {
    const entry = touch(comment.author);
    if (!entry) continue;
    entry.comments++;
    entry.totalScore += score(comment.score);
    if (comment.threadSourceId) entry.threads.add(comment.threadSourceId);
    if (comment.sourceId) entry.sourceIds.push(comment.sourceId);
    const sample = sampleText(comment);
    if (sample && entry.samples.length < 6) entry.samples.push(sample);

    const parent = commentsById.get(comment.parentSourceId);
    const parentAuthor = parent ? parent.author : comment.parentAuthor;
    if (isUsableAuthor(parentAuthor) && authorKey(parentAuthor) !== authorKey(comment.author)) {
      entry.repliesMade++;
      entry.interactionAuthors.add(authorKey(parentAuthor));
      const recipient = touch(parentAuthor);
      recipient.repliesReceived++;
      recipient.interactionAuthors.add(authorKey(comment.author));
      const pair = interactionKey(comment.author, parentAuthor);
      if (pair) interactions.set(pair, (interactions.get(pair) || 0) + 1);
    }
  }

  const ranked = Array.from(contributors.values()).map((entry) => ({
    ...entry,
    threads: entry.threads.size,
    interactionAuthors: entry.interactionAuthors.size,
    sourceIds: Array.from(new Set(entry.sourceIds)).slice(0, 30),
    rankScore: entry.posts * 5 + entry.comments * 2 + entry.repliesReceived * 2 + entry.interactionAuthors.size + Math.log2(Math.max(1, entry.totalScore + 2)),
  })).sort((a, b) => b.rankScore - a.rankScore || b.comments - a.comments || a.author.localeCompare(b.author));

  const selected = ranked.slice(0, limit).map((entry, index) => ({
    label: 'contributor-' + (index + 1),
    author: entry.author,
    posts: entry.posts,
    comments: entry.comments,
    totalScore: entry.totalScore,
    threads: entry.threads,
    repliesReceived: entry.repliesReceived,
    repliesMade: entry.repliesMade,
    interactionAuthors: entry.interactionAuthors,
    rankScore: Number(entry.rankScore.toFixed(3)),
    sourceIds: entry.sourceIds,
    samples: entry.samples,
  }));
  const labels = new Map(selected.map((entry) => [authorKey(entry.author), entry.label]));
  const topInteractions = Array.from(interactions.entries()).map(([pair, count]) => {
    const [left, right] = pair.split('::');
    return { left: labels.get(left) || 'other', right: labels.get(right) || 'other', count };
  }).filter((item) => item.left !== 'other' || item.right !== 'other')
    .sort((a, b) => b.count - a.count).slice(0, 30);
  return { contributors: selected, interactions: topInteractions };
}

function topTerms(corpus = {}, limit = 30) {
  const counts = new Map();
  const items = [...(corpus.posts || []), ...(corpus.comments || [])];
  for (const item of items) {
    const value = item.type === 'post' ? [item.title, item.body].join(' ') : item.body;
    for (const word of String(value || '').toLowerCase().match(/[a-z][a-z0-9']{2,}/g) || []) {
      if (STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit).map(([term, count]) => ({ term, count }));
}

function buildAnalysisDigest(corpus = {}, options = {}) {
  const aggregated = aggregateContributors(corpus, { limit: options.maxContributors || 20 });
  const selectedKeys = new Map(aggregated.contributors.map((entry) => [authorKey(entry.author), entry.label]));
  const samples = [];
  const addSample = (item) => {
    const content = sampleText(item);
    if (!content) return;
    samples.push({
      sourceId: cleanText(item.sourceId, 100),
      type: item.type,
      contributor: selectedKeys.get(authorKey(item.author)) || 'other',
      score: score(item.score),
      parentSourceId: cleanText(item.parentSourceId, 100),
      threadSourceId: cleanText(item.threadSourceId || item.sourceId, 100),
      text: content,
    });
  };
  const items = [...(corpus.posts || []), ...(corpus.comments || [])]
    .sort((a, b) => score(b.score) - score(a.score));
  for (const item of items) {
    addSample(item);
    if (samples.length >= MAX_PROMPT_SAMPLES) break;
  }
  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    subreddit: cleanText(corpus.subreddit, 80),
    corpusCounts: { posts: (corpus.posts || []).length, comments: (corpus.comments || []).length },
    terms: topTerms(corpus),
    contributors: aggregated.contributors.map((entry) => ({
      label: entry.label,
      counts: {
        posts: entry.posts, comments: entry.comments, threads: entry.threads,
        repliesMade: entry.repliesMade, repliesReceived: entry.repliesReceived,
        interactionAuthors: entry.interactionAuthors,
      },
      sourceIds: entry.sourceIds,
      samples: entry.samples,
    })),
    interactions: aggregated.interactions,
    samples,
  };
}

function normalizeObservation(raw = {}) {
  return {
    label: cleanText(raw.label, 80),
    voice: cleanText(raw.voice, 280),
    humour: cleanText(raw.humour, 220),
    conversationalHabits: cleanList(raw.conversationalHabits, 8, 160),
    typicalReactions: cleanList(raw.typicalReactions, 8, 160),
    topics: cleanList(raw.topics, 10, 100),
    disagreementTendency: cleanText(raw.disagreementTendency, 180),
    runningJokeTendency: cleanText(raw.runningJokeTendency, 180),
    interactionPatterns: cleanList(raw.interactionPatterns, 8, 160),
    postingPattern: cleanText(raw.postingPattern, 180),
    evidenceSourceIds: cleanList(raw.evidenceSourceIds, 30, 100),
  };
}

function normalizeCultureAnalysis(raw = {}, digest = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Culture analysis must be a JSON object.');
  const cultureRaw = raw.culture && typeof raw.culture === 'object' ? raw.culture : raw;
  const culture = {
    summary: cleanText(cultureRaw.summary, 700),
    recurringJokes: cleanList(cultureRaw.recurringJokes, 15, 160),
    runningBits: cleanList(cultureRaw.runningBits, 15, 160),
    postFormats: cleanList(cultureRaw.postFormats, 12, 160),
    repeatedPhrases: cleanList(cultureRaw.repeatedPhrases, 15, 120),
    humour: cleanList(cultureRaw.humour, 12, 160),
    responseConventions: cleanList(cultureRaw.responseConventions, 12, 160),
    recurringTopics: cleanList(cultureRaw.recurringTopics, 15, 120),
    escalationPatterns: cleanList(cultureRaw.escalationPatterns, 10, 180),
    interactionPatterns: cleanList(cultureRaw.interactionPatterns, 12, 180),
    archetypes: cleanList(cultureRaw.archetypes, 12, 160),
    socialRoles: cleanList(cultureRaw.socialRoles, 12, 160),
  };
  if (!culture.summary) throw new Error('Culture analysis is missing culture.summary.');
  const allowedLabels = new Set((digest.contributors || []).map((item) => item.label));
  const allowedEvidence = new Set([
    ...(digest.samples || []).map((item) => item.sourceId),
    ...(digest.contributors || []).flatMap((item) => item.sourceIds || []),
  ].filter(Boolean));
  const observations = (Array.isArray(raw.contributors) ? raw.contributors : [])
    .map(normalizeObservation)
    .filter((item) => item.label && allowedLabels.has(item.label))
    .map((item) => ({
      ...item,
      evidenceSourceIds: item.evidenceSourceIds.filter((sourceId) => allowedEvidence.has(sourceId)),
    }));
  const id = crypto.createHash('sha256').update(JSON.stringify({ culture, observations })).digest('hex').slice(0, 16);
  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    id,
    subreddit: cleanText(digest.subreddit, 80),
    culture,
    contributors: observations,
    deterministic: {
      corpusCounts: digest.corpusCounts || { posts: 0, comments: 0 },
      terms: digest.terms || [],
      interactions: digest.interactions || [],
      contributors: (digest.contributors || []).map((item) => ({ label: item.label, counts: item.counts, sourceIds: item.sourceIds })),
    },
  };
}

module.exports = {
  ANALYSIS_SCHEMA_VERSION,
  MAX_SAMPLE_TEXT,
  MAX_PROMPT_SAMPLES,
  cleanText,
  cleanList,
  aggregateContributors,
  topTerms,
  buildAnalysisDigest,
  normalizeCultureAnalysis,
};
