# Hosted reply output correctness

## Evidence and scope

The private retained cohort contains 77 ordinary hosted reply opportunities from
the 28-29 October 2026 adaptive-controller checkpoint (excluding adaptive extras):
39 published replies, five empty-menu WAITs, and 33 technical failures. The owner
explicitly authorized a credential-excluded private transfer of all 77 records.
Prompts/responses remain ignored private artifacts, not repository fixtures.

All 33 failures occurred after successful decision inference and its existing
single repair attempt. Final responses comprise 22 malformed JSON bodies, ten
complete JSON objects followed by terminal protocol framing, and one complete
JSON object with other surrounding material. None of these 33 was a construction,
admission, provider, writing or publication failure. Exact recorded decision input
counts match frozen budgets; none reached its 640-token output ceiling. This does
not establish why the model produced each syntax error.

The hosted model emits ChatML end markers into otherwise complete decisions and
public writing. Its framing/template mismatch remains a likely contributor, not
a proven exclusive cause. This repair does not change the model, template,
native-schema mode, prompts, request bytes, packing, token ceilings or repair
count. The prior native-schema comparison remains HOLD.

Among the 39 published writing responses, 15 have exact terminal `|im_end|>`
framing, three have the attested terminal site/community tag train, and one has
an explicit model self-instruction `Note:` appendix. That appendix was not in its
input prompt. Ten of the 15 marker cases did not have the marker in their input;
five did, illustrating possible public-context feedback, not a complete causal
account. Previous handling trimmed/sliced the raw generation directly into the
publication body, so it had no output/framing boundary.

## Repair

`lib/hosted-output-boundary.js` is a pure, bounded transport/public-output boundary:

* Decode only exact terminal `<|im_end|>` / `|im_end|>` tokens before the existing
  strict decision parser. Do not extract embedded JSON, repair syntax, infer IDs,
  invent votes/NILs, or accept prose wrappers.
* Before reply publication, decode the same exact terminal markers. Reject the
  whole output for the identified out-of-band role framing, site/community tag
  train or explicit self-instruction appendix. Reject empty/oversize bodies
  before any old truncation could hide the invalid suffix.
* Preserve quoted/code/blockquote tokens and explicit technical discussion.
  Ordinary notes, literal tags and ambiguous bare `|` / `|i` endings are not
  broadly censored. This is not a general semantic detector: novel scaffolding
  forms can remain, and ambiguous discussed/quoted text is deliberately retained.
* Rejection is explicit, recorded and terminal for that writing opportunity. It
  reschedules using the existing rule, does not reserve a duplicate fingerprint,
  attempt publication, create outgoing social/memory facts, or regenerate.
  Independently valid decisions/votes keep their existing semantics.
* Accepted normalized text is used consistently for fingerprint, publication and
  outgoing evidence. Raw provider results remain byte-for-byte in the existing
  durable generation record.

## Replay and compatibility

New hosted ordinary reply-capable turns and hosted quiet reply turns freeze
`input.hostedOutputVersion = 1`. Post-only/news-only, desktop, manual and Burst
paths are unchanged. Missing/zero means exact legacy output interpretation.
Unknown versions block before inference/effects. A durable
`comment-public-output-v1` checkpoint freezes acceptance/rejection across restart.
Existing publication-attempt fences, worker outbox, claim fencing and segmented
storage are unchanged. There is no historical-state rewrite.

Rollback must retain the v1 reader/boundary while admitted v1 turns remain. An old
binary does not know this new field, so do not downgrade merely by switching to
the old release with unfinished v1 turns. Disable new admission at a normal safe
handover, drain compatible turns, and preserve later data; never restore an old
snapshot over subsequent activity.

## Frozen offline results

Exact replay of the original initial/repair responses recovers valid primary
choices in 13/33 failed opportunities; seven recover at the initial response and
would not require the existing repair call. Twenty remain strict failures. The
39 already valid primary choices and five empty-menu WAITs are preserved. Missing
or invalid votes remain unresolved; primary recovery is not full vote-contract
completion or evidence that 13 new replies would have been published.

Writing replay cleans 15 exact marker suffixes, rejects three tag trains and one
self-instruction appendix, and leaves 20 outputs unchanged. No model or
publication calls were made. The private source corpus digest remained
`fdcdd7f19f2b20751e0cb60551e99c710a5c56b071980fbc3c35c6e97e7b41b7`.

Focused tests cover strict decisions/partial votes, false-acceptance boundaries,
legitimate quoted/discussed text, same-request replay, raw evidence preservation,
legacy/unsupported versions, normalized fingerprint/publication, rejection before
publication intent, no outgoing memory effects, no regeneration and terminal
replay without duplicate publication. Production deployment and natural results
are recorded separately; offline recovery is not a measured future failure rate.
