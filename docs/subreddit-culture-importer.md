# Private subreddit culture importer

This module is an isolated backend for turning a bounded sample of public subreddit activity into reviewable, fictional Feddit population seeds. Fetching, analysis and character generation do not register accounts, stage cohorts, edit profiles, or run bots. An optional staging bridge can submit an explicitly selected set of candidates to the existing external-seed staging contract.

## Boundaries

The importer owns five steps:

1. Fetch recent public posts and comments through a replaceable source adapter.
2. Normalize source items and preserve source identifiers, timestamps, parent links and provenance.
3. Build deterministic contributor and interaction aggregates.
4. Ask a caller-selected provider and model for one batched culture analysis and one batched set of composite characters.
5. Return exact `lib/population.normalizeSeed` objects plus separate importer metadata.

The ordinary backend remains independent of its optional human-facing UI and does not change the population controller. The Developer-tools UI calls the same public staged methods through short-lived private runner sessions. The staging bridge is additive: callers can continue to use the importer API and `POST /api/population/external-seeds/stage` directly. The bridge sends only selected compact seeds, the bounded importer/analysis association and the existing cohort configuration. Rich `importerMetadata` remains review-only and is never added to a seed, profile, persona or runtime prompt.

## Developer-tools UI

The existing Settings dialog exposes **Import subreddit culture** only while Developer tools is enabled. It is available on a desktop runner and to the existing hosted population operator. It does not appear to ordinary hosted workspace owners.

The UI keeps the workflow explicit:

1. choose a subreddit, bounded post/comment sample and recent window, then fetch or refresh the private cache;
2. choose one of the runner's already-connected providers and models, then inspect the normalized culture summary and anonymous contributor evidence;
3. select contributor influences and archetypes, choose one to six candidates and target Feddit communities, then generate fictional composites;
4. review, select and edit every compact population-seed field;
5. explicitly stage the selected candidates through the frozen external-seed boundary.

Fetch, analysis and generation do not stage anything. Staging stops at disabled rehearsal profiles; activation and LIVE publishing remain separate population actions. Long-running operations expose progress and cancellation. Provider or validation failures remain visible in the session, and partial staging results are shown per seed.

The raw Reddit corpus remains server-side. A runner keeps at most eight in-memory review sessions per authorised operator for up to six hours; browser responses contain bounded source counts and provenance, normalized analysis, generated candidates, progress, errors and staging outcomes. Navigating back to the bot list or collapsing a section does not clear the current in-page review state.

Hosted staging reuses the current population operator capability. Desktop generation can use local Ollama or another already-connected provider, but the population boundary is hosted. The desktop UI therefore asks for the existing hosted private management link only when the operator explicitly stages. The loopback runner extracts that capability in memory and forwards the compact request to the link's HTTPS origin; it does not save the link in the import session, cache, bot profile, cohort or browser storage.

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
- `integration`: an explicit reminder that staging is available only as a separate action.

The component methods `fetchCorpus`, `analyseCulture`, `selectContributors`, `selectInfluences` and `generateCandidates` are also public for a staged UI or service integration. `selectInfluences` accepts contributor labels and archetype names and returns a filtered analysis view without mutating the full evidence. `generateCandidates` accepts the same selections directly. Errors use stable `code` and `phase` fields. Every long-running method accepts an `AbortSignal` and progress callback.

## Explicit staging bridge

`createCultureStagingBridge()` provides optional review and staging helpers without changing the importer result or the external-seed endpoint contract:

```js
const { createCultureStagingBridge } = require('./lib/culture-importer');

const bridge = createCultureStagingBridge({ populationController });
const review = bridge.review(result);

const staged = await bridge.stage(result, [
  review[0].id,
  review[2].id,
]);
```

`review()` derives a deterministic `culture_candidate_*` identifier for each generated seed and keeps its importer metadata available for review. `stage()` accepts candidate IDs or zero-based candidate indexes. It requires one to six unique candidates, creates one request, calls `populationController.stageExternalSeeds(input)` exactly once and never retries or splits a selection.

The bridge correlates each staging result with `importerCandidateId` and `importerCandidateIndex`. Core `candidateId`, `profileId`, username, status and error fields remain unchanged, including partial failures. Authoritative seed validation, near-duplicate checks, capacity, identity registration and collision handling remain in the population controller.

For HTTP callers, `createExternalSeedHttpStager()` posts the same request to `POST /api/population/external-seeds/stage` with the existing `X-Feddit-Bot-Owner` capability. The optional helper does not replace or wrap the endpoint for the Developer-tools UI.

## CLI harness

The import CLI is intentionally minimal and writes no application state:

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

The output is the review artifact. Import and generation never stage it. After reviewing that JSON, a separate development-harness action can stage only the selected candidates:

```bash
FEDDIT_BOT_OWNER_TOKEN='<existing operator capability>' \
node bin/import-subreddit-culture.js stage \
  --input culture-import.json \
  --select 0,2 \
  --server-url http://127.0.0.1:4567 \
  --out culture-stage-result.json
```

`--select` accepts zero-based candidate indexes or the stable IDs returned by `bridge.review()`. The action rejects an empty selection, duplicate selection or more than six candidates before making a request. It sends the whole selection once, so a larger selection is never silently split and a failed registration is never blindly retried by the importer.

Use `--refresh` to bypass a valid cache and Ctrl+C to cancel. `REDDIT_ACCESS_TOKEN` and `REDDIT_USER_AGENT` configure the source connection. DeepSeek and subscription providers use the existing local provider configuration. The hosted `dell` provider requires the server's durable queue to have been configured and therefore is available to programmatic hosted integration, not a standalone CLI invocation.

## Provider and batching policy

The caller always chooses the provider and model. The importer passes them through the existing provider abstraction using `providerOverride`; it never changes a bot or runner's saved provider settings.

A normal complete import makes two inference calls:

1. one structured culture and contributor analysis for the entire bounded sample digest;
2. one structured batch that generates all requested fictional candidates.

Deterministic contributor aggregation, duplicate detection, username checks and population-seed normalization require no model call.

## Evidence and limitations

The result is a characterization of a bounded recent sample, not a definitive account of a community or person. Listing endpoints may omit old, removed, private or inaccessible content. Parent relationships are complete only when the relevant comments occur in the sample. Scores are mutable snapshots. Anonymous contributor observations are retained as evidence-linked behavioural descriptions and must not be treated as psychological diagnoses.

The following future work remains outside this integration:

- explicit retention controls and cache cleanup policy;
- a production OAuth/source-credential flow if anonymous public JSON is insufficient;
- a deliberate decision about any future runtime use of richer provenance and psychology metadata.
