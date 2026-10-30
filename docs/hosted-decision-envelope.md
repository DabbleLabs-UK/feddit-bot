# Final hosted decision-envelope repair

## Retained failure and design

The 29 October post-6500649 checkpoint contains 16 ordinary hosted opportunities:
11 published replies, one empty-menu WAIT, and four failed primary decisions after
the existing single repair. All four final responses contain the explicit action,
reason and complete vote array. Three omit only the outermost closing object brace;
one has the literal malformed key `votes":` instead of `"votes":`.
Input budgets match and decision output ceilings were not reached.

`lib/hosted-decision-envelope.js` permits exactly one punctuation insertion:

1. Append one final outer `}` only if the result is a complete bare JSON object.
2. Insert the missing opening quote on the exact `votes"` key, only after a
   separately strict-parsed primary prefix containing exactly choice/reason.

In both cases the full result must pass native JSON parsing and the existing
duplicate-key-rejecting parser, with exactly string choice, string reason and
array votes. There must be exactly one possible approved repair. The rules never
compose, guess values, complete nested structures, close strings, add commas,
extract embedded objects, remove prose, invent missing ballots or choose IDs.
Missing/nonpositive/noninteger token usage or an exhausted frozen output ceiling
disables repair. Already-valid objects retain their exact text/interpretation.
Existing strict action and independent-vote semantic validation is unchanged.

This is a response-envelope repair, not a new model/schema experiment or an
inference retry. Prompts, candidate IDs/order, request bytes, token budgets,
provider, model, scheduler ecology and ordinary single repair allowance are
unchanged. Genuine WAIT/NIL remain valid; missing, conflicting or invalid votes
remain unresolved, not considered. An unknown action remains a technical failure.

## Scope and durable compatibility

New hosted reply-capable ordinary turns and hosted quiet reply turns freeze
`hostedDecisionEnvelopeVersion: 1` separately from existing output-boundary v1,
decision contract v2 and packing v2. Missing/zero preserves exact prior behavior;
unsupported versions block before inference/effects. Desktop, manual, Burst and
post-only hosted admissions are unchanged.

The existing durable primary/repair decision checkpoint optionally records the
content-free `envelopeRepair` classification. Original provider text is retained
unchanged, and no new response/prompt copy or separate store is added. Publication,
fingerprint, claim fencing, worker outbox and segmented-storage code are unchanged.

For rollback keep a compatible envelope-v1 reader until admitted turns have
finished at a normal safe boundary. Do not restore old data over later work, or
put an older binary onto unfinished new-version turns. No historical decisions,
votes, considered receipts or public replies are rewritten.

## Frozen replay

Owner-requested fixtures contain only 16 decision-response records, stable IDs,
token metadata and already-public writing. No persona/context prompts or
credentials were transferred. They remain ignored/private, SHA-256
`21bc999d3159b9cb79ff41ee91a06e5ca56a4ae2b54e7292b0a1d014c4a76067`.
No inference or publication call was made.

All four formerly failed primary choices become valid. Replaying the normal
initial-then-existing-repair path uses two key-quote repairs and two outer-brace
repairs; one initial response now succeeds without the existing repair call.
The recovered records contain seven independently valid explicit vote decisions
and five unresolved/missing items. No value or missing decision is fabricated.
All 11 already-valid primary/vote outcomes and the one empty-menu WAIT are exact.
This is offline parsing evidence, not a future production failure-rate estimate.

Synthetic regressions additionally cover WAIT/UP/DOWN/NIL, conflicting ballots,
unknown IDs, invalid reasons, missing data, duplicate object keys, nested damage,
missing quotes/commas in reasons, code/prose wrappers, two simultaneous errors,
output-ceiling/missing-usage refusal, legacy replay and restart without duplicate
inference/publication. Existing framing/public-output rejection tests remain.

## Trailing public pipes

The four public trailing `|` bodies are byte-identical to their retained raw
writing results. They were not introduced by 6500649 decoding. No complete
ChatML delimiter or trustworthy retained termination detail proves those literal
pipes are protocol framing rather than generated prose. Decision-only envelope
repair does not authorize deleting arbitrary characters from public writing.
They therefore remain unchanged; no general pipe stripping, censorship or
regeneration was added. Literal quotations, code and ordinary prose retain the
previous public-output interpretation. Existing exact full framing and explicit
self-instruction guards remain active.
