'use strict';

// Freeze a fresh private comparison. Never starts a scheduler or provider.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const child = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function prepare(directory) {
  const destination = path.resolve(directory);
  assert(destination.startsWith(path.join(root, 'artifacts') + path.sep), 'Private output must be inside ignored artifacts.');
  assert(!fs.existsSync(destination), 'Never replace an existing comparison directory.');
  const data = read('C:/Users/jodyf/AppData/Local/DabbleLabs/FedditBots/data/profiles.json');
  const at = Date.now();
  const baseline = read(path.join(root, 'artifacts/concise-baseline/complete-public-snapshot.json'));
  const inputs = read(path.join(root, 'artifacts/concise-baseline/frozen-public-cases.json'));
  const file = path.join(root, 'lib/scheduler.js');
  let source = fs.readFileSync(file, 'utf8');
  const marker = '  const api = {';
  assert.equal(source.split(marker).length, 2);
  // Instrument a COPY in memory to reuse actual pure retrieval/rules seams.
  // It has no writable store, provider or Feddit client and cannot act.
  source = source.replace(marker, marker + `
    inspectWriting: (profile, target, community, about, writingVersion) => {
      const memory = memoryContextFor(profile, target, false);
      const social = socialContextFor(profile, target, false);
      const socialGuidance = social && social.known !== false && social.summary
        ? 'SOCIAL CONTEXT FROM YOUR OWN PRIOR PUBLIC INTERACTIONS: ' + String(social.summary).slice(0, 500) +
          ' Treat this as limited evidence of familiarity, not proof of friendship or a requirement to continue.\\n\\n' : '';
      const common = { communityGuidance: communityGuidance(about, community, profile),
        memoryGuidance: memoryPrompt(memory), version: writingVersion };
      return target.task === 'post' ? publicWriting.post({ ...common, feddit: community })
        : publicWriting.comment({ ...common, socialGuidance, target, honesty: '' });
    },`);
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(source, file);
  const api = mod.exports.createScheduler({ store: {}, feddit: {}, providers: {}, now: () => at });
  const branch = require('../lib/reply-branch');
  const categories = ['text-post', 'root-reply', 'good-deep-continuation', 'drift', 'copying'];
  const cases = inputs.cases.map((item, index) => {
    const bot = item.task === 'post' ? 'splurf_sommelier_bot' : item.observedResponse.author;
    const profile = data.profiles.find(p => p.fedditUsername === bot);
    assert(profile && profile.provider === 'ollama' && profile.model === 'qwen3:4b-instruct');
    const original = item.task === 'post' ? item.publicTopicAnchor
      : item.target.type === 'post' ? item.target : item.ancestors.find(p => p.type === 'post');
    const community = original.community;
    const c = baseline.communities.find(c => c.name === community);
    assert(c && !c.rules, 'These cases use the real rule-free source community.');
    const about = { description: c.description, rules: [] };
    const post = { id: original.id, title: original.title, selftext: original.text, kind: original.kind };
    const comments = item.task === 'comment' && item.target.type === 'comment'
      ? [...item.ancestors.filter(c => c.type === 'comment'), item.target].map(c => ({
        id: c.id, post_id: c.postId, parent_id: c.parentKey.startsWith('comment:') ? Number(c.parentKey.split(':')[1]) : null,
        author: c.author, body: c.text,
      })) : [];
    const selected = comments.at(-1);
    const target = item.task === 'post' ? { task: 'post', context: 'COMMUNITY: f/' + community + '\n' + c.description }
      : { task: 'comment', postId: post.id, commentId: selected && selected.id || null, feddit: community,
        author: selected ? selected.author : original.author,
        context: selected ? 'POST TITLE: ' + post.title + (post.selftext ? '\nPOST BODY: ' + post.selftext : '') +
          '\nA COMMENT (by ' + selected.author + ') you are replying to: ' + selected.body
          : 'POST in f/' + community + '\nTITLE: ' + post.title + (post.selftext ? '\nBODY: ' + post.selftext : ''),
        replyBranch: selected ? branch.fromComment(post, selected, comments) : branch.forPost(post) };
    // Prior observed answers and diagnostic cross-thread text are not inputs.
    const system = mod.exports.buildSystem(profile.persona, profile.toneNotes);
    const control = api.inspectWriting(profile, target, community, about, 1);
    const treatment = api.inspectWriting(profile, target, community, about, 2);
    const temperature = Number(profile.temperature) || 0.8;
    const numPredict = Number(profile.numPredict) || 200;
    return { id: item.id, category: categories[index], kind: item.task, bot, model: profile.model,
      temperature, numPredict, frozenAt: at, system, control, treatment, frozenTarget: target,
      profile: { id: profile.id, bot, provider: profile.provider, model: profile.model,
        temperature, numPredict, persona: profile.persona, toneNotes: profile.toneNotes },
      hashes: { system: sha(system), control: sha(control), treatment: sha(treatment) } };
  });
  assert.equal(cases.length, 5);
  const sources = ['lib/public-writing.js', 'lib/reply-branch.js', 'lib/scheduler.js', 'lib/providers/ollama.js'];
  const snapshot = { protocolId: crypto.randomUUID(), preparedAt: at,
    sourceCommit: child.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    implementationCommit: '831727c905dacec8540b6a7b04fc6ee61591602a',
    sourceHashes: Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(root, name)))])),
    maxCalls: 10, model: 'qwen3:4b-instruct', cases };
  const encoded = JSON.stringify(snapshot, null, 2) + '\n';
  // Explicit credentials are never retained even if a future profile schema carries them.
  for (const profile of data.profiles) {
    for (const key of ['token', 'apiKey', 'accessToken', 'refreshToken']) {
      if (typeof profile[key] === 'string' && profile[key]) assert(!encoded.includes(profile[key]));
    }
  }
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'cases.json'), encoded, { flag: 'wx', mode: 0o600 });
  return { protocolId: snapshot.protocolId, preparedAt: at, casesHash: sha(encoded),
    cases: cases.map(c => ({ id: c.id, category: c.category, bot: c.bot, model: c.model,
      temperature: c.temperature, numPredict: c.numPredict, hashes: c.hashes })) };
}

module.exports = { prepare };
if (require.main === module) {
  assert(process.argv.length === 4 && process.argv[2] === '--directory', 'Explicit --directory required.');
  console.log(JSON.stringify(prepare(process.argv[3])));
}
