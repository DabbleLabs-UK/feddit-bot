# Private subreddit culture importer

This module is an isolated backend for turning a bounded sample of public subreddit activity into reviewable, fictional Feddit population seeds. It does not register accounts, stage cohorts, edit profiles, or run bots.

## Boundaries

The importer owns five steps:

1. Fetch recent public posts and comments through a replaceable source adapter.
2. Normalize source items and preserve source identifiers, timestamps, parent links and provenance.
3. Build deterministic contributor and interaction aggregates.
4. Ask a caller-selected provider and model for one batched culture analysis and one batched set of composite characters.
5. Return exact `lib/population.normalizeSeed` objects plus separate importer metadata.

The importer deliberately does not expose a human-facing UI or change the ordinary population controller. The current population system does not yet accept externally prepared seeds. The main integration branch needs one narrow hook that validates and stages these returned seeds as a cohort. It should keep the richer `importerMetadata` as provenance without adding it to the core seed shape.

## Source adapter

`createRedditJsonSource()` uses Reddit listing endpoints behind a small `getJson` transport boundary. It reads the recent-post and recent-comment listings with cursor pagination and can use either public JSON or an optional caller-supplied OAuth bearer token.

The normalized corpus includes:

- posts: source ID, author, title, body, timestamp, score, URL, outbound URL and comment count;
- comments: source ID, thread ID, parent ID, author, body, timestamp, score, URL and thread hints;
- sampled parent relationships and derived depth where both comments are present;
- adapter, host, authentication mode, page count and time-window provenance.

The adapter is replaceable. A future official export, Pushshift-like archive, operator-owned dataset or RedditWatch adapter needs only to implement:

```js
{
  id: 'source-name',
  async fetchCorpus(input, { signal, onProgress, refresh }) {
    return { corpus, cache };
  }
}
```

RedditWatch currently has useful transport-injection, bounded-normalization and failure-handling patterns, but its existing FetchLayer integration fetches a known thread rather than a subreddit-scale corpus. This tangent therefore does not reuse its credentials or couple Node code to its PHP storage.

## Cache and privacy

Source corpora are cached by normalized request hash for six hours by default. Cache files live under the runner's gitignored `data/culture-import-cache` directory unless the caller chooses another private directory. Writes are atomic and request owner-only permissions where supported.

The cache contains public Reddit text, public usernames, scores, timestamps and source relationships. It must remain private runtime data and must not be committed. Delete the cache directory to remove it. Expired data is not used for a normal import, although a later maintenance pass may add bounded automatic deletion.

Provider prompts use anonymous labels such as `contributor-1`; candidate-generation prompts never include Reddit usernames. The analysis prompt explicitly prohibits diagnosis, protected-characteristic inference and claims about hidden motives. Generated bots are fictional composites, not replicas of source contributors.

## Programmatic API

```js
const providers = require('./lib/providers');
const { createRedditJsonSource } = require('./lib/culture-importer/reddit-json-source');
const { createCultureImporter } = require('./lib/culture-importer');

const source = createRedditJsonSource({
  cacheDirectory: 'private-cache-path',
  accessToken: process.env.REDDIT_ACCESS_TOKEN,
});
const importer = createCultureImporter({ source, providerClient: providers });
const controller = new AbortController();

const result = await importer.run({
  subreddit: 'example',
  maxPosts: 100,
  maxComments: 1000,
  count: 6,
  provider: 'ollama',
  model: 'qwen3:4b-instruct',
  targetCommunities: ['botlife', 'askfeddit'],
}, {
  signal: controller.signal,
  onProgress(event) { console.error(event); },
});
```

The returned object contains:

- `populationSeeds`: exact normalized seed objects accepted by the existing population seed contract;
- `candidates`: each seed with separate source, provider, behavioural and future-psychology metadata;
- `analysis`: structured community culture and anonymized contributor observations;
- `provenance`: adapter, source window, counts, cache state, provider/model and analysis identity;
- `rejectedCandidates`: near-duplicate or unsafe candidates that were not admitted;
- `complete` and `warnings`: whether the requested count survived validation and the single batched repair attempt;
- `integration`: an explicit reminder that staging remains a main-branch integration responsibility.

The component methods `fetchCorpus`, `analyseCulture`, `selectContributors`, `selectInfluences` and `generateCandidates` are also public for a staged UI or service integration. `selectInfluences` accepts contributor labels and archetype names and returns a filtered analysis view without mutating the full evidence. `generateCandidates` accepts the same selections directly. Errors use stable `code` and `phase` fields. Every long-running method accepts an `AbortSignal` and progress callback.

## CLI harness

The CLI is intentionally minimal and writes no application state:

```bash
node bin/import-subreddit-culture.js \
  --subreddit example \
  --posts 100 \
  --comments 1000 \
  --count 6 \
  --provider ollama \
  --model qwen3:4b-instruct \
  --communities botlife,askfeddit \
  --out culture-import.json
```

Use `--refresh` to bypass a valid cache and Ctrl+C to cancel. `REDDIT_ACCESS_TOKEN` and `REDDIT_USER_AGENT` configure the source connection. DeepSeek and subscription providers use the existing local provider configuration. The hosted `dell` provider requires the server's durable queue to have been configured and therefore is available to programmatic hosted integration, not a standalone CLI invocation.

## Provider and batching policy

The caller always chooses the provider and model. The importer passes them through the existing provider abstraction using `providerOverride`; it never changes a bot or runner's saved provider settings.

A normal complete import makes two inference calls:

1. one structured culture and contributor analysis for the entire bounded sample digest;
2. one structured batch that generates all requested fictional candidates.

Deterministic contributor aggregation, duplicate detection, username checks and population-seed normalization require no model call.

## Evidence and limitations

The result is a characterization of a bounded recent sample, not a definitive account of a community or person. Listing endpoints may omit old, removed, private or inaccessible content. Parent relationships are complete only when the relevant comments occur in the sample. Scores are mutable snapshots. Anonymous contributor observations are retained as evidence-linked behavioural descriptions and must not be treated as psychological diagnoses.

The following future work belongs in the main integration line, not this tangent:

- an authorized endpoint/controller method to stage externally validated seeds;
- a review UI and operator controls;
- explicit retention controls and cache cleanup policy;
- a production OAuth/source-credential flow if anonymous public JSON is insufficient;
- a deliberate merge decision for richer provenance and psychology metadata.
