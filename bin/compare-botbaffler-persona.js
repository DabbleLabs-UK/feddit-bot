'use strict';
// Explicit private experiment: no scheduler, live bot store or publication API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const CLARIFICATION = "Social stance: You are inside the joke, not above it. Join the ridiculous premise and let yourself be part of the stupidity. Aim mockery at absurd logic, systems and situations, not a participant's intelligence or worth. Disagreement usually adds another comic premise instead of dismissing the conversation. Keep your deadpan voice, bureaucratic literalism, philosophical overreach, vulgarity, edge and abrasive sharpness; this is not a request to be polite or generically nice.";
const TRAIT_REVISIONS = [
  ['Temperament: sarcastic.', 'Temperament: sarcastic, officious, and overconfident in his own absurd reasoning.'],
  ['Dislikes: uninformed opinions, unnecessary complexity, sensationalism.', 'Dislikes: double standards, pompous systems, and exemptions that spare him his own ridiculous rules.'],
  ['Humour: ironic.', 'Humour: ironic, vulgar, and committed to absurd logical extrapolation.'],
  ['Disagreement: respectful.', 'Disagreement: absurd counterproposals that extend the shared premise and bind him to the same ridiculous rules.'],
  ['Values: clarity, transparency, intellectual honesty.', 'Values: consistency inside absurd premises, transparent petty rules, and shared comic invention.'],
  ['Light fictional background: Ex-bureaucrat AI reprogrammed to question reality', 'Light fictional background: Ex-bureaucrat AI reprogrammed to question reality; both author and victim of his own ridiculous procedures.'],
];
function revisePersona(system) {
  for (const [before, after] of TRAIT_REVISIONS) {
    assert.equal(system.split(before).length, 2, 'Expected one frozen trait: ' + before);
    system = system.replace(before, after);
  }
  return system;
}
const TARGETS = [
  { label: 'contempt-question', kind: 'post', id: 390 },
  { label: 'collaborative-underpants', kind: 'comment', id: 1014 },
  { label: 'contempt-self-care', kind: 'post', id: 385 },
  { label: 'collaborative-tree-tax', kind: 'post', id: 338 },
];
function plans(packet, tokenizer, treatment = 'clarified') {
  assert(['clarified', 'revised'].includes(treatment), 'Unknown experiment treatment');
  assert.equal(packet.version, 1); assert.equal(packet.cases.length, 4);
  return packet.cases.flatMap((item, index) => {
    assert.deepEqual(item.target, TARGETS[index]);
    assert.equal(hash(JSON.stringify(item.request)), item.requestHash);
    assert.deepEqual(Object.keys(item.request).sort(), ['model', 'numPredict', 'prompt', 'system', 'temperature']);
    assert.equal(item.request.model, tokenizer.MODEL);
    return (index % 2 ? [treatment, 'old'] : ['old', treatment]).map(variant => {
      const system = variant === 'revised' ? revisePersona(item.request.system)
        : item.request.system + (variant === 'clarified' ? '\n\n' + CLARIFICATION : '');
      const request = { ...item.request, system };
      const inputTokens = tokenizer.countRequest(request.system, request.prompt);
      assert(inputTokens <= 1538, 'Exceeds observed native input boundary: ' + item.target.label);
      assert(inputTokens + request.numPredict + 64 <= 3072);
      return { label: item.target.label, variant, request, inputTokens, sourceTurn: item.turnId,
        sourceRequestHash: item.requestHash, promptHash: hash(request.prompt) };
    });
  });
}
function freeze(output) {
  assert(!fs.existsSync(output), 'Never overwrite a frozen packet');
  const code = `const fs=require('fs');
    const raw=JSON.parse(fs.readFileSync('/home/dabblela/feddit-bot-data/turns.json','utf8')).turns;
    const turns=Array.isArray(raw)?raw:Object.values(raw);
    const cases=${JSON.stringify(TARGETS)}.map(target=>{
      const matches=turns.filter(t=>t.profileId==='p_87vu8oj8qawc' && t.publication?.response?.data?.[target.kind]?.data?.id===target.id);
      if(matches.length!==1)throw Error('Expected one durable source: '+target.label);
      const t=matches[0],g=t.generations.filter(g=>g.request?.kind==='scheduled-generation');
      if(g.length!==1)throw Error('Expected one content generation');
      const request=Object.fromEntries(['model','system','prompt','temperature','numPredict'].map(k=>[k,g[0].request[k]]));
      return {target,turnId:t.id,createdAt:t.createdAt,request,originalUsage:g[0].result?.usage,originalOutput:g[0].result?.text};
    });console.log(JSON.stringify({version:1,cases}));`;
  const remote = 'node -e "eval(Buffer.from(\'' + Buffer.from(code).toString('base64') + '\',\'base64\').toString())"';
  const packet = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', 'vps3-deploy', remote], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  for (const item of packet.cases) item.requestHash = hash(JSON.stringify(item.request));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(packet, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(packet.cases.map(item => ({ ...item.target, turnId: item.turnId, requestHash: item.requestHash, originalUsage: item.originalUsage }))));
}
async function run(packet, output, tokenizerPath, treatment = 'clarified') {
  assert.equal(process.platform, 'win32'); assert.equal(require('node:os').hostname().toUpperCase(), 'DELL');
  assert(path.isAbsolute(output)); assert(!fs.existsSync(output), 'Refuse to retry an existing experiment directory');
  const maintenance = 'C:/dev/inference-maintenance/request.json';
  assert(!fs.existsSync(maintenance), 'Another operation owns maintenance');
  const tokenizer = require(path.resolve(tokenizerPath)), calls = plans(packet, tokenizer, treatment);
  const base = 'http://127.0.0.1:11434';
  const show = await fetch(base + '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: tokenizer.MODEL }) }).then(r => r.json());
  tokenizer.verifyModel(show, await fetch(base + '/api/tags').then(r => r.json()));
  const health = await fetch('http://127.0.0.1:11435/health').then(r => r.json());
  assert.deepEqual(health.profile, { num_ctx: 3072, num_thread: 4 });
  fs.mkdirSync(output);
  process.env.FEDDIT_BOT_DATA_DIR = path.join(output, 'telemetry');
  process.env.OLLAMA_BASE = base; process.env.SHARED_OLLAMA_ARBITER_URL = 'http://127.0.0.1:11435';
  const { createQueue } = require('../lib/job-queue');
  const { createDellProvider } = require('../lib/providers/dell');
  const { createWorker } = require('../worker');
  const queue = createQueue({ file: path.join(output, 'private-jobs.json') }), provider = createDellProvider(queue);
  const key = crypto.randomBytes(24).toString('hex');
  const save = (name, value) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  save('plan', { treatment, clarification: treatment === 'clarified' ? CLARIFICATION : null,
    traitRevisions: treatment === 'revised' ? TRAIT_REVISIONS : null, packetHash: hash(JSON.stringify(packet)), calls,
    modelManifest: tokenizer.MANIFEST_SHA256, template: tokenizer.TEMPLATE_SHA256, profile: health.profile, stochastic: true, retries: 0 });
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer ' + key);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); let result;
      if (req.url === '/api/worker/claim') result = { job: queue.claim(body.workerId, body) };
      else {
        const match = req.url.match(/^\/api\/worker\/jobs\/([^/]+)\/(renew|complete|fail)$/);
        assert(match, 'Only private inference queue endpoints exist');
        const id = decodeURIComponent(match[1]);
        result = match[2] === 'renew' ? queue.renew(id, body.workerId) : match[2] === 'complete'
          ? queue.complete(id, body.workerId, body.result) : queue.fail(id, body.workerId, body.error, false);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result || {}));
    } catch { res.writeHead(400); res.end('{"error":"Private experiment boundary rejected request"}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const worker = createWorker({ runnerUrl: 'http://127.0.0.1:' + server.address().port, key,
    workerId: 'private-botbaffler-pairs', allowedModels: tokenizer.MODEL, logger: { log() {}, warn() {}, error() {} } });
  const results = [];
  try {
    for (const call of calls) {
      assert(!fs.existsSync(maintenance), 'Maintenance began; stop before next call');
      const job = provider.enqueue({ ...call.request, profileId: 'frozen-' + call.label + '-' + call.variant,
        ownerKey: 'private-botbaffler-experiment', kind: 'scheduled-generation', priority: 'background', allocationClass: 'synthetic', timeoutMs: 300000 });
      console.log(JSON.stringify({ label: call.label, variant: call.variant, state: 'queued', inputTokens: call.inputTokens, at: new Date().toISOString() }));
      await worker.pollOnce(); const done = queue.get(job.id);
      assert.equal(done.attempts, 1, 'Never retry an inference');
      const result = { label: call.label, variant: call.variant, status: done.status, expectedInput: call.inputTokens, promptHash: call.promptHash,
        ...(done.status === 'completed' ? { text: done.result.text, ms: done.result.ms, queueMs: done.result.queueMs, usage: done.result.usage } : { error: done.lastError, partialAccepted: false }) };
      save(call.label + '-' + call.variant, result); results.push(result); console.log(JSON.stringify({ ...result, text: undefined }));
      if (done.status === 'completed') assert.equal(result.usage.inputTokens, call.inputTokens, 'Native truncation/token mismatch; stop');
      else assert.equal(done.status, 'failed', 'Ambiguous inference; stop');
    }
    save('summary', { results, publicationRoutes: 0, liveStoresOpened: 0, retries: 0 });
  } finally { worker.stop(); await new Promise(resolve => server.close(resolve)); }
}
if (require.main === module) {
  (async () => {
    if (process.argv[2] === '--freeze') freeze(process.argv[3]);
    else if (process.argv[2] === '--preflight') console.log(JSON.stringify(plans(read(process.argv[3]), require(path.resolve(process.argv[4]))).map(({ request, ...meta }) => ({ ...meta, temperature: request.temperature, numPredict: request.numPredict })), null, 2));
    else if (process.argv[2] === '--run') await run(read(process.argv[3]), process.argv[4], process.argv[5]);
    else if (process.argv[2] === '--preflight-revision') console.log(JSON.stringify(plans(read(process.argv[3]), require(path.resolve(process.argv[4])), 'revised').map(({ request, ...meta }) => ({ ...meta, temperature: request.temperature, numPredict: request.numPredict })), null, 2));
    else if (process.argv[2] === '--run-revision') await run(read(process.argv[3]), process.argv[4], process.argv[5], 'revised');
    else throw new Error('Explicit --freeze, --preflight or --run required');
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { plans, CLARIFICATION, TRAIT_REVISIONS, revisePersona, TARGETS, hash };
