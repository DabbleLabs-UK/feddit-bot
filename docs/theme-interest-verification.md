# Theme-interest v1 verification, 24 October 2026

Source-only implementation on `feature/emergent-theme-interest`, based on
deployed hosted reply-continuity `4f4d11e`. Remote inspection confirmed main is
still `633e808`, hosted reviewed source is `4f4d11e`, desktop reviewed source is
`10d6c7a`, and the separate default-off population controller remains on its own
unreleased branch. No branch was reset or production configuration changed.

## New pure/mocked suites

| Suite | Result |
|---|---:|
| theme-interest | 101 checks |
| theme-context | 40 checks |
| theme-interest-budget | 9 checks |
| theme-interest-store | 61 checks |
| theme-interest-scheduler | 133 checks |
| Total distinct new assertions | 344 |

The scheduler suite also passes with `FEDDIT_TEST_SEGMENTED_TURNS=1` (133),
in addition to legacy temporary-file storage. Repeating it is not counted as
another 133 distinct assertions. All runtime tests use mocks and disposable
stores; no retrieval, registration, publication, AI call or active pause occurs.

Important cases include default-off exact prompt equality despite existing
theme state, new v1 admission/restart after flag removal, exact legacy absent-v0
reconstruction under an enabled process, valid WAIT/NIL versus malformed
decisions, partial explicit ballots, complete token-budget deferral, no false
source exposure from repeated ancestor text, quiet/direct/renewed menu counts,
local live/rehearsal separation, simulated new-root use, failed/429/uncertain
publication, duplicate-body rejection, checkpoint and profile-save failures,
post-publication recovery without another HTTP/generation, immutable reads,
stale edits and explicit continuity versus reusable templates.

Two read-only review findings were repaired before final verification:

* Determine actual immediate-target visibility by its trailing source range,
  not a substring that might occur earlier in the root or ancestry.
* Omit only an optional hosted writing cue when exact complete-request
  measurement cannot fit it, and freeze that choice across replay.

The final follow-up review reported no remaining material findings.

## Adjacent regression suites

Passing:

* action-candidates 48; social-relationships 18; decision-contract 91;
  conversation-continuation 37; reply-continuity 43; reply-branch,
  autobiographical-memory and voting suites.
* hosted-decision-budget 32; hosted-decision-budget-v2 239;
  first-contact-budget 15; first-look-budget 96.
* first-contact-store 35; ordinary-candidates-store 21; profile-pack.
* durable-scheduler 601; reply-continuity-scheduler 60;
  first-contact-scheduler 108; ordinary-candidates-scheduler 79.
* quiet-conversations 118; quiet-conversations-scheduler 138;
  scheduler-dryrun 532; simulation-state; naturalness-scheduler.

The Windows sandbox produced the known EPERM failure on atomic replacement of
disposable fixture files. The exact affected tests were rerun outside the
sandbox with narrow approval and passed. No filesystem workaround was added to
production and no private runtime file was used.

`git diff --check`, JavaScript syntax checks and data-handling JSON parsing pass.
No full browser/package/signing suite or real-model semantic validation was
performed or claimed; this task does not build, install or release a desktop.

## Offline cost/evidence checks

The three-root tokenizer fixture retains identical C1/C2/C3 before/after, with
492 -> 562 input tokens (+70) for two hints. Existing hosted exact measurement
and complete-block packing remain authoritative under pressure. Maximal generated
96-record state is 69,147 serialized bytes per mode. The retained public
1953/1978 book-reaction duplicate produces matching lexical features; a
synonym-only paraphrase intentionally demonstrates the proxy's blind spot.

The numerical rise/saturation/fade/revival fixture in `theme-interest.md` is a
deterministic mechanism demonstration, not a prediction of model behavior or
proof of better conversation. A later separately authorized controlled natural
observation is still required to judge efficacy.
