'use strict';

// Offline only: public source text plus genuine retained encounter/use receipts.
const fs = require('node:fs');
const theme = require('../lib/theme-interest');
const motif = require('../lib/theme-motif');
const context = require('../lib/theme-context');
const retained = require('../test/fixtures/theme-motif-milt-gable.json');
const scope = { version: 1, communities: ['shittyaskfeddit'] };
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

function candidate(source, index) {
  const comment = source.key.startsWith('t1_');
  const body = source.body === undefined ? source.text : source.body;
  const text = comment ? body : [source.title, body].filter(Boolean).join('\n');
  return { id: 'C' + index, kind: 'reply', context: text,
    target: { key: source.key, postId: Number(source.threadKey.slice(3)),
      ...(comment ? { commentId: Number(source.key.slice(3)) } : {}),
      author: source.author, feddit: source.community,
      replyBranch: { post: comment ? {} : { title: source.title, body }, target: { body } } },
    voteItems: comment ? [{ targetType: 'comment', targetId: Number(source.key.slice(3)), content: body }] : [] };
}

function summarize(state, source, at, identityVersion) {
  const identity = motif.forVersion(identityVersion).snapshot(state, at);
  const view = theme.describe(state, source, { at, identity });
  return { known: view.known, independentSources: view.independentSources,
    independentAuthors: view.independentAuthors, exposures: view.exposures, uses: view.uses,
    familiarity: Number(view.familiarity.toFixed(6)), satiation: Number(view.satiation.toFixed(6)),
    summary: view.summary };
}

function replay(fixture = retained, subjectText = 'Milt Gable', identityVersion = 3) {
  const sources = new Map(fixture.sources.map(item => [item.key, { ...item,
    community: item.community || 'shittyaskfeddit', threadKey: item.threadKey || (item.key.startsWith('t3_') ? item.key : 't3_834') }]));
  const bots = new Map();
  const groups = new Map();
  for (const receipt of fixture.events.slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    const group = receipt.bot + ':' + receipt.at + ':' + receipt.kind;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(receipt);
  }
  let generatedReceipts = 0;
  for (const receipts of groups.values()) {
    const first = receipts[0];
    const bot = bots.get(first.bot) || { state: theme.normalize(), progression: [] };
    const snapshot = context.decorate({ candidates: receipts.map((e, index) => candidate(sources.get(e.sourceKey), index + 1)),
      voteCandidates: [] }, bot.state, first.at, 'offline:' + first.id, scope, identityVersion);
    const before = snapshot.candidates.filter(item => item.themeInterest).length;
    const generated = first.kind === 'exposure'
      ? context.exposure(snapshot, { valid: true, candidates: snapshot.candidates, votes: [] }, first.bot)
      : receipts.flatMap(e => context.participation(snapshot.themeInterestContext, { ...sources.get(e.sourceKey),
        sourceKey: e.sourceKey, threadKey: e.threadKey }));
    const bySource = new Map(receipts.map(e => [e.sourceKey, e]));
    // Preserve the real receipt identities and times; only detector fields are counterfactual.
    const corrected = generated.map(e => ({ ...e, id: bySource.get(e.sourceKey).id }));
    generatedReceipts += corrected.length;
    bot.state = theme.record(bot.state, corrected);
    const target = { community: first.community, text: subjectText };
    const view = summarize(bot.state, target, first.at, identityVersion);
    bot.progression.push({ at: new Date(first.at).toISOString(), kind: first.kind,
      sources: receipts.map(e => e.sourceKey), proposals: [...new Set(corrected.flatMap(e => e.proposals || []))],
      motifs: [...new Set(corrected.flatMap(e => e.motifs || []))], preEncounterCueCandidates: before,
      counterfactualCueAvailableAfter: view.known && Boolean(view.summary), ...view });
    bots.set(first.bot, bot);
  }
  return { description: 'Counterfactual offline replay only. Recognition/cue availability does not prove cue delivery, participation or behavioural causation.',
    identityVersion, sources: sources.size, retainedReceipts: fixture.events.length, generatedReceipts,
    publishingBots: [...new Set(fixture.events.filter(e => e.kind === 'participation').map(e => e.bot))],
    readingBots: [...new Set(fixture.events.filter(e => e.kind === 'exposure').map(e => e.bot))],
    legacyMotifs: [...new Set(fixture.events.flatMap(e => e.motifs || []))],
    correctedMotifs: [...new Set([...bots.values()].flatMap(bot => bot.state.events.flatMap(e => e.motifs || [])))].sort(),
    bots: Object.fromEntries([...bots].map(([name, bot]) => {
      const actual = fixture.events.filter(e => e.bot === name);
      return [name, { retainedExposureReceipts: actual.filter(e => e.kind === 'exposure').length,
        retainedParticipationReceipts: actual.filter(e => e.kind === 'participation').length,
        actuallyEncounteredSources: [...new Set(actual.filter(e => e.kind === 'exposure').map(e => e.sourceKey))],
        final: bot.progression.at(-1), progression: bot.progression }];
    })) };
}

function corpus(raw) {
  const detector = motif.forVersion(3);
  const sources = [...raw.posts.map(item => ({ ...item, key: 't3_' + item.id, text: [item.title, item.body].filter(Boolean).join('\n') })),
    ...raw.comments.map(item => ({ ...item, key: 't1_' + item.id, text: item.body }))];
  const proposals = new Map();
  const communitySeeds = new Map();
  for (const source of sources) {
    const seeds = communitySeeds.get(source.community) || new Set();
    for (const name of detector.propose(source.text)) seeds.add(name);
    communitySeeds.set(source.community, seeds);
  }
  // Screening only: recognise conservative aliases after discovering a lexical
  // seed somewhere in the corpus. This is never used to fabricate bot receipts.
  for (const source of sources) for (const name of detector.propose(source.text, [...communitySeeds.get(source.community)])) {
    const identity = source.community + ':' + name;
    if (!proposals.has(identity)) proposals.set(identity, []);
    proposals.get(identity).push({ key: source.key, author: source.author, community: source.community,
      excerpt: clean(source.text).slice(0, 220) });
  }
  return { description: 'Corpus-only detector screen, not bot encounters or production state. Repeated wording is not proof of social-theme relevance.',
    roots: raw.posts.length, comments: raw.comments.length, proposalNames: proposals.size,
    proposedSources: new Set([...proposals.values()].flatMap(items => items.map(item => item.key))).size,
    repeatedIndependentNames: [...proposals].filter(([, items]) => new Set(items.map(item => item.author)).size >= 2)
      .map(([identity, items]) => ({ name: identity.slice(identity.indexOf(':') + 1), community: items[0].community,
        sourceCount: items.length, authors: [...new Set(items.map(item => item.author))], sources: items })),
    allProposals: Object.fromEntries(proposals) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--corpus')) throw new Error('Usage: node bin/replay-theme-phrase.js [--corpus public.json]');
  console.log(JSON.stringify(args.length ? corpus(JSON.parse(fs.readFileSync(args[1], 'utf8'))) : replay(), null, 2));
}
module.exports = { replay, corpus, candidate };
