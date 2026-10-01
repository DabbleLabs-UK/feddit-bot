#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const providers = require('../lib/providers');
const secrets = require('../lib/secrets');
const { createFetchLayerSource } = require('../lib/culture-importer/fetchlayer-source');
const {
  createCultureImporter,
  createCultureStagingBridge,
  createExternalSeedHttpStager,
} = require('../lib/culture-importer');

function usage() {
  return [
    'Usage: node bin/import-subreddit-culture.js --subreddit NAME --communities NAME[,NAME] [options]',
    '       node bin/import-subreddit-culture.js stage --input FILE --select INDEX[,INDEX] --server-url URL [options]',
    '',
    'Options:',
    '  --posts N             Recent posts to fetch (default 100, max 1000)',
    '  --comments N          Recent comments to fetch (default 1000, max 5000)',
    '  --count N             Composite Feddit bot seeds to create (default 6, max 24)',
    '  --provider ID         ollama, deepseek, chatgpt-plan, claude-plan, or dell',
    '  --model ID            Caller-selected provider model',
    '  --since DATE          Earliest source timestamp',
    '  --until DATE          Latest source timestamp',
    '  --cache-dir PATH      Private source-corpus cache directory',
    '  --refresh             Ignore a valid cached corpus',
    '  --out PATH            Write JSON to a file instead of stdout',
    '  --help                Show this help',
    '',
    'Explicit staging options:',
    '  --input PATH          Completed import JSON to review and stage from',
    '  --select VALUES       One to six zero-based candidate indexes or stable candidate IDs',
    '  --server-url URL      Feddit bot server hosting the external-seed staging endpoint',
    '  --out PATH            Write the correlated staging result to a file instead of stdout',
    '',
    'FETCHLAYER_API_KEY configures the third-party source adapter. Reddit OAuth and the official API are not used.',
    'The dell provider needs a programmatic hosted queue and is not initialized by this standalone CLI.',
    'FEDDIT_BOT_OWNER_TOKEN supplies the existing population operator capability for the stage action.',
    'Import and generation never stage candidates. The stage action submits the selected seeds once and never splits or retries them.',
  ].join('\n');
}

function parseArgs(argv) {
  const action = argv[0] === 'stage' ? 'stage' : 'import';
  const start = action === 'stage' ? 1 : (argv[0] === 'import' ? 1 : 0);
  const output = { action, refresh: false };
  const aliases = new Set([
    'subreddit', 'posts', 'comments', 'count', 'provider', 'model', 'since', 'until',
    'cache-dir', 'communities', 'out', 'input', 'select', 'server-url',
  ]);
  for (let index = start; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') output.help = true;
    else if (arg === '--refresh') output.refresh = true;
    else if (arg.startsWith('--') && aliases.has(arg.slice(2))) {
      const value = argv[++index];
      if (value == null || value.startsWith('--')) throw new Error(arg + ' needs a value.');
      output[arg.slice(2)] = value;
    } else throw new Error('Unknown argument: ' + arg);
  }
  return output;
}

function selectedValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function readImportResult(file) {
  if (!file) throw new Error('--input is required for the stage action.');
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

async function stageImportResult(args, options = {}) {
  const selection = selectedValues(args.select);
  if (!selection.length) throw new Error('--select needs one to six candidate indexes or IDs.');
  if (!args['server-url']) throw new Error('--server-url is required for the stage action.');
  const importResult = readImportResult(args.input);
  const stageExternalSeeds = createExternalSeedHttpStager({
    serverUrl: args['server-url'],
    ownerToken: options.ownerToken || process.env.FEDDIT_BOT_OWNER_TOKEN,
    fetch: options.fetch,
  });
  const bridge = createCultureStagingBridge({ stageExternalSeeds });
  return bridge.stage(importResult, selection);
}

function stagingErrorResult(error) {
  return {
    ok: false,
    error: {
      code: String(error && error.code || 'CULTURE_STAGING_FAILED'),
      message: String(error && error.message || error),
    },
    association: error && error.association || null,
    importerSelection: error && error.importerSelection || [],
    results: error && Array.isArray(error.results) ? error.results : [],
  };
}

function writeOutput(result, destination) {
  const content = JSON.stringify(result, null, 2) + '\n';
  if (!destination) {
    process.stdout.write(content);
    return;
  }
  const file = path.resolve(destination);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  process.stderr.write('Wrote ' + file + '\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (args.action === 'stage') {
    const result = await stageImportResult(args);
    writeOutput(result, args.out);
    if (result.ok === false) process.exitCode = 2;
    return result;
  }
  if (!args.subreddit) throw new Error('--subreddit is required.');
  const communities = String(args.communities || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!communities.length) throw new Error('--communities needs at least one existing Feddit community.');

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    providers.configureRuntime({ secrets, placement: 'desktop' });
    const source = createFetchLayerSource({
      cacheDirectory: args['cache-dir'],
      apiKey: process.env.FETCHLAYER_API_KEY,
    });
    const importer = createCultureImporter({ source, providerClient: providers });
    const result = await importer.run({
      subreddit: args.subreddit,
      maxPosts: args.posts,
      maxComments: args.comments,
      count: args.count,
      since: args.since,
      until: args.until,
      refresh: args.refresh,
      provider: args.provider || 'ollama',
      model: args.model || '',
      targetCommunities: communities,
    }, {
      signal: controller.signal,
      refresh: args.refresh,
      onProgress(event) {
        process.stderr.write('[' + event.phase + '] ' + event.state + ': ' + event.message + '\n');
      },
    });
    writeOutput(result, args.out);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error && error.name === 'AbortError') process.stderr.write('Import cancelled.\n');
    else if (error && Array.isArray(error.results) && error.results.length) {
      process.stderr.write(JSON.stringify(stagingErrorResult(error), null, 2) + '\n');
    }
    else process.stderr.write((error && error.code ? error.code + ': ' : '') + String(error && error.message || error) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  usage, parseArgs, selectedValues, readImportResult, stageImportResult,
  stagingErrorResult, writeOutput, main,
};
