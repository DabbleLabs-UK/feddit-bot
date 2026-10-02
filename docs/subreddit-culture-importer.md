# Private subreddit culture importer

This module is an isolated backend for turning a bounded sample of public subreddit activity into reviewable, fictional Feddit population seeds. Fetching, analysis and character generation do not register accounts, stage cohorts, edit profiles, or run bots. An optional staging bridge can submit an explicitly selected set of candidates to the existing external-seed staging contract.

## Boundaries

The importer owns five steps:

1. Fetch recent public posts and comments through a replaceable source adapter.
2. Normalize source items and preserve source identifiers, timestamps, parent links and provenance.
3. Build deterministic contributor and interaction aggregates.
4. Ask a caller-selected provider and model for one batched culture analysis and one or more bounded batches of composite characters.
5. Return exact `lib/population.normalizeSeed` objects plus separate importer metadata.

The ordinary backend remains independent of its optional human-facing UI and does not change the population controller. The Developer-tools UI calls the same public staged methods through private runner workspaces. The staging bridge is additive: callers can continue to use the importer API and `POST /api/population/external-seeds/stage` directly. The bridge sends only selected compact seeds, the bounded importer/analysis association and the existing cohort configuration. Rich `importerMetadata` remains review-only and is never added to a seed, profile, persona or runtime prompt.

## Developer-tools UI

The existing Settings dialog exposes **Import subreddit culture** only while Developer tools is enabled. It is available on a desktop runner and to the existing hosted population operator. It does not appear to ordinary hosted workspace owners.

On desktop, the same Developer-tools area exposes a separate masked FetchLayer key control. It writes to the runner's existing gitignored, atomic `data/secrets.json` store, immediately clears the entry field and returns only configured/not-configured state. The packaged launcher already points every replaceable application version at the update-safe `%LOCALAPPDATA%\DabbleLabs\FedditBots\data` directory, so application updates do not copy or replace this credential. The Test connection action makes one no-retry listing request for one recent post and no comments, then returns only connection status and a count. Hosted runners do not accept browser writes for this key and read it only from the server process environment; authorised population operators see only configured/not-configured state and can run the same bounded connection check.

The UI keeps the workflow explicit:

1. choose a subreddit, bounded post/comment sample and recent window, then reuse a compatible private cache entry or explicitly retrieve fresh source data;
2. choose one of the runner's already-connected providers and models, then inspect the normalized culture summary and anonymous contributor evidence;
3. select contributor influences and archetypes, choose how many fictional composites to add and target Feddit communities, then generate them into the persisted review collection;
4. review, select and edit every compact population-seed field;
5. explicitly stage the selected candidates through the frozen external-seed boundary.

Fetch, analysis and generation do not stage anything. The review collection holds up to 24 candidates. Each generation action can request 1-24 candidates within the remaining collection capacity and appends them without replacing earlier candidates, edits, selections or staging evidence. Provider requests are split into batches of at most six. Each completed batch is persisted immediately, so a later batch failure or cancellation leaves completed candidates reviewable. Generation reuses the saved corpus and completed analysis; it never refetches or re-analyses automatically.

Staging remains a separate 1-6 seed action. A larger selection is rejected before registration and is never split into several cohorts. Staging stops at disabled rehearsal profiles; activation and LIVE publishing remain separate population actions. Long-running operations expose progress and cancellation. Provider or validation failures remain visible in the session, and partial staging results are shown per seed.

The raw Reddit corpus remains server-side. A runner keeps at most eight review workspaces per authorised operator for up to six hours and writes their secret-free snapshots atomically to the gitignored `data/culture-import-workspaces.json` file. The workspace stores the exact source settings, a cache key rather than a second raw-corpus copy, normalized analysis, up to 24 generated candidates with stable deterministic IDs and completed-batch provenance, progress, errors and staging outcomes. A backend restart rehydrates the corpus from that private reference. A running or cancelling action interrupted by restart becomes a visible terminal error and is never resumed automatically; candidates from batches completed before interruption remain saved.

The browser stores only the opaque workspace ID and secret-free review state needed to preserve edits across a page refresh. It never stores the FetchLayer key or hosted management link. On reopen it first reads the saved workspace. When upgrading the single-owner desktop from the older in-memory-only implementation, the backend can reconstruct a workspace from the newest private corpus cache entry without calling FetchLayer. Hosted restoration remains owner-bound and does not adopt an unowned cache entry. Restoration never calls an AI provider and never repeats staging.

Hosted staging reuses the current population operator capability. Desktop generation can use local Ollama or another already-connected provider, but the population boundary is hosted. The desktop UI therefore asks for the existing hosted private management link only when the operator explicitly stages. The loopback runner extracts that capability in memory and forwards the compact request to the link's HTTPS origin; it does not save the link in the import session, cache, bot profile, cohort or browser storage.

## Source adapter

`createFetchLayerSource()` uses the same third-party provider proven by RedditWatch, but does not couple Feddit Bots to RedditWatch as a running service or share its credentials. It calls FetchLayer's current `POST /reddit/community-posts` endpoint for the recent subreddit listing, then calls `POST /reddit/post` for a bounded set of comment-bearing threads. It never calls Reddit's official API and has no Reddit OAuth or direct-Reddit fallback.

The listing request asks FetchLayer for enough 25-item pages to cover the bounded post sample. Comment retrieval prioritises the sampled posts with the most discussion, is capped at 24 thread requests and five comment pages per thread, and stops as soon as the requested comment count is reached. A fetched thread can replace the listing preview with FetchLayer's full post body. FetchLayer's provider-side pagination may still return less than the requested sample. The corpus then remains usable but is explicitly marked incomplete with bounded warnings and per-thread failure classes.

The normalized corpus includes:

- posts: source ID, author, title, body, timestamp, score, URL, outbound URL and comment count;
- comments: source ID, thread ID, parent ID, author, body, timestamp, score, URL and thread hints;
- sampled parent relationships and derived depth where both comments are present;
- adapter, provider host, page/thread request counts, completeness, bounded failures and time-window provenance.

The adapter is replaceable. A future operator-owned dataset or other third-party source needs only to implement:

```js
{
  id: 'source-name',
  async fetchCorpus(input, { signal, onProgress, refresh }) {
    return { corpus, cache };
  }
}
```

RedditWatch currently uses FetchLayer's known-thread endpoint for full thread enrichment; broad monitoring discovery in that project comes from F5Bot email and Reddit RSS rather than FetchLayer subreddit listings. Feddit Bots reuses the proven FetchLayer transport pattern and same upstream provider while adding the provider's current subreddit-feed endpoint. The two applications remain independent and their credentials are configured separately.

## Cache and privacy

Source corpora are cached by normalized request hash for six hours by default. Cache files live under the runner's gitignored `data/culture-import-cache` directory unless the caller chooses another private directory. Writes are atomic and request owner-only permissions where supported. The cache records the normalized source request for new entries so a later compatible, narrower request can be answered locally from the same corpus.

The cache contains public Reddit text, public usernames, scores, timestamps and source relationships received from FetchLayer. It must remain private runtime data and must not be committed. Delete the cache directory to remove it. Expiry marks a sample stale rather than silently triggering a paid retrieval: stale samples remain reviewable with their age and completeness shown. `Use matching saved sample` is cache-only and reports a miss without network activity. `Retrieve fresh source sample` is the separate explicit action that bypasses saved data. Hosted `FETCHLAYER_API_KEY` and the desktop secret-store value stay server-side and are never placed in the cache, browser response, provider prompt or importer result.

Provider prompts use anonymous labels such as `contributor-1`; candidate-generation prompts never include Reddit usernames. The analysis prompt explicitly prohibits diagnosis, protected-characteristic inference and claims about hidden motives. Generated bots are fictional composites, not replicas of source contributors.

## Programmatic API

```js
const providers = require('./lib/providers');
const { createFetchLayerSource } = require('./lib/culture-importer/fetchlayer-source');
const { createCultureImporter } = require('./lib/culture-importer');

const source = createFetchLayerSource({
  cacheDirectory: 'private-cache-path',
  apiKey: process.env.FETCHLAYER_API_KEY,
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

`POST /api/culture-imports` retains its ordinary explicit-fetch behavior. Passing `{ "restore": true }` selects the owner's newest saved workspace or reconstructs one from the newest private cache entry. This restore form does not invoke the source adapter transport. Passing `cacheOnly: true` on an ordinary source request permits exact or compatible cache reuse but returns `FETCHLAYER_CACHE_MISS` instead of retrieving when no saved sample is available.

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

Use `--refresh` to bypass a valid cache and Ctrl+C to cancel. The standalone CLI reads `FETCHLAYER_API_KEY`; hosted reads the same protected environment variable; desktop reads the existing local secret store. A missing, rejected, forbidden, rate-limited, unavailable, malformed, blocked or empty source receives a stable FetchLayer-specific error. Retryable network, timeout, HTTP 429 and HTTP 5xx failures receive at most two bounded retries. A thread-specific blocked or malformed response retains any usable posts/comments and allows the bounded sample to continue. Authentication and permission failures stop immediately. After a provider-wide rate-limit, availability, network or timeout failure exhausts its bounded retries, remaining thread sampling stops instead of repeating the failure across every candidate thread; the retained corpus, warning and stop code remain reviewable.

## Provider and batching policy

The caller always chooses the provider and model. The importer passes them through the existing provider abstraction using `providerOverride`; it never changes a bot or runner's saved provider settings.

A direct complete import requesting at most six candidates normally makes two inference calls:

1. one structured culture and contributor analysis for the entire bounded sample digest;
2. one structured batch that generates the requested fictional candidates.

The Developer-tools collection can request up to 24 candidates. It keeps the culture analysis fixed and divides generation into provider requests of at most six candidates. Each provider batch retains the existing single optional repair attempt, so the number and size of calls remain bounded. Successive generation includes all registered population seeds and all already accepted review candidates in duplicate detection.

Deterministic contributor aggregation, duplicate detection, username checks and population-seed normalization require no model call.

## Evidence and limitations

The result is a characterization of a bounded recent sample, not a definitive account of a community or person. FetchLayer's scraped listing and thread endpoints may omit old, removed, private, inaccessible or unexpanded content. Parent relationships are complete only when the relevant comments occur in the sample. Scores are mutable snapshots. Anonymous contributor observations are retained as evidence-linked behavioural descriptions and must not be treated as psychological diagnoses.

The following future work remains outside this integration:

- explicit retention controls and cache cleanup policy;
- a deliberate decision about any future runtime use of richer provenance and psychology metadata.
