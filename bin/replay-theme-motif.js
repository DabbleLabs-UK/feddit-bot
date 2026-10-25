'use strict';

// Offline public evidence only. This tool never opens runtime data or calls an API.
const theme = require('../lib/theme-interest');
const motif = require('../lib/theme-motif');
const retained = require('../test/fixtures/theme-motif-glopspray.json');

function replay(fixture = retained) {
  const sources = new Map(fixture.sources.map(item => [item.key, item]));
  const bots = new Map();
  const oldIdentities = new Set();
  const correctedIdentities = new Set();
  const ordered = fixture.events.slice().sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups = new Map();
  for (const event of ordered) {
    for (const pair of event.features) if (pair.includes('glopspray') || pair.join('|') === 'glop|spray') oldIdentities.add(pair.join('|'));
    const key = event.bot + ':' + event.at + ':' + event.kind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const events of groups.values()) {
    const first = events[0];
    if (!bots.has(first.bot)) bots.set(first.bot, { old: theme.normalize(), corrected: theme.normalize(), progression: [] });
    const bot = bots.get(first.bot);
    const identity = motif.snapshot(bot.corrected, first.at);
    // An actual handled batch can introduce a local name and a split spelling
    // together. Nothing from gathered/unoffered sources participates here.
    if (first.kind === 'exposure') {
      const anchors = new Map(identity.anchors.map(item => [item.community + ':' + item.motif, item]));
      for (const event of events) for (const name of motif.extract(sources.get(event.sourceKey).text)) {
        anchors.set(event.community + ':' + name, { community: event.community, motif: name });
      }
      identity.anchors = [...anchors.values()];
    }
    const old = events.map(({ bot: ignored, ...event }) => event);
    const corrected = old.map(event => ({ ...event, identityVersion: motif.VERSION,
      motifs: motif.extract(sources.get(event.sourceKey).text, motif.local(identity, event.community)) }));
    for (const event of corrected) for (const name of event.motifs) correctedIdentities.add(name);
    bot.old = theme.record(bot.old, old);
    bot.corrected = theme.record(bot.corrected, corrected);
    const target = sources.get('t3_840');
    const summarize = view => ({ exposures: view.exposures, uses: view.uses,
      familiarity: Number(view.familiarity.toFixed(6)), satiation: Number(view.satiation.toFixed(6)), summary: view.summary });
    bot.progression.push({ at: new Date(first.at).toISOString(), kind: first.kind,
      sources: events.map(item => item.sourceKey),
      old: summarize(theme.describe(bot.old, target, { at: first.at })),
      corrected: summarize(theme.describe(bot.corrected, target, { at: first.at, identity: motif.snapshot(bot.corrected, first.at) })) });
  }
  return { description: 'Counterfactual offline replay, not production history or proof of model behaviour.',
    sources: sources.size, receipts: ordered.length, oldIdentities: [...oldIdentities].sort(),
    correctedIdentities: [...correctedIdentities].sort(),
    bots: Object.fromEntries([...bots].map(([name, bot]) => [name, { final: bot.progression.at(-1), progression: bot.progression }])),
    thresholdReachability: {
      established: [...bots].filter(([, bot]) => bot.progression.some(item => item.corrected.familiarity >= 0.5)).map(([name]) => name),
      elevated: [...bots].filter(([, bot]) => bot.progression.some(item => item.corrected.satiation >= 0.5)).map(([name]) => name),
      repeated: [...bots].filter(([, bot]) => bot.progression.some(item => item.corrected.summary.includes('own use: repeated'))).map(([name]) => name),
    } };
}

if (require.main === module) console.log(JSON.stringify(replay(), null, 2));
module.exports = { replay };
