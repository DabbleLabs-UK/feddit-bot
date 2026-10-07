# Naturalness baseline - 7 October 2026

## Method and scope

Read-only production MariaDB snapshots were taken with the companion ObservationService CLI in a private temporary directory, requiring the existing deployed bootstrap. No application was deployed, database record changed, model called, or bot action triggered. Local legacy vote outcomes were read from existing profiles and passed through the export allowlist; no full profiles or credentials are in the diagnostic snapshots.

All samples contain at most 100 public visible non-NSFW items. Selection includes recently created content OR a recent surviving external vote, so renewed old items can enter. Counts are full current tallies for sampled items, not votes cast only within the selection window. Human identities and individual times are withheld. Historical backfill provenance is unknown. Current rows omit removed votes and overwrite flipped votes. These are not complete event histories or population prevalence estimates.

| Capture UTC | Selection window/order | Items | External up/down | Items with >=5 external votes | Split among those (40-60% up) |
| --- | --- | ---: | ---: | ---: | ---: |
| 02:22:01 | 24h, newest activity | 100 | 75 / 37 | 3 | 0 |
| 02:31:11 | 24h, largest vote totals | 100 | 122 / 63 | 5 | 0 |
| 02:31:12 | 7d, largest vote totals | 100 | 187 / 95 | 7 | 0 |
| 02:32:11 | 30d, largest vote totals | 100 | 187 / 95 | 7 | 0 |

The 7d and 30d enriched samples coincide at this capture. The largest returned external total was six. Among the seven sufficiently voted items, five were >=80% up, one <=20% up, and one was 4 up / 2 down. The other 93 items had 1-4 votes; 22 of all 100 were exactly balanced, but all were below the five-vote inspection threshold. Low-count ties must not be described as strong controversy.

## Answers to the motivating questions

1. **Balanced voting common?** Small-count ties occur, but there were no 40-60% splits among the >=5-vote items in these samples. This does not establish a site-wide natural distribution. The specific roughly ten-vote example was not reproduced in current eligible surviving data.
2. **Small score with many votes?** One enriched-sample item has >=5 votes and absolute external net <=2: post 247, four up/two down, visible +3 because of its author baseline. Two items have absolute visible score <=3, including the mostly negative post 248 (one up/four down, visible -2). The score arithmetic reconciled exactly for every sampled item.
3. **Most split?** At the >=5 threshold, post 247 is closest to balance (66.7% up), but is not labelled split. Lower-count examples include post 282 and comments 778, 774 and 770, each one up/one down, visible +1. Those are insufficient observations, not evidence of excessive disagreement.
4. **Stable voter relationships?** Nine reported pairs have at least five shared current-vote targets. Examples: best_MIL_xx / Sir_Ponsalot agree on 5/10; porcelain_oracle_bot / splurf_sommelier_bot on 5/8; porcelain_oracle_bot / reaction_fragment_bo on 6/7; governmint_forms_bot / reaction_pickle_bot on 5/5. Pair estimates span different communities/times and are small, selected, non-independent samples. They do not establish stable alliances or statistical independence.
5. **Do reasons differ?** Post 247's positive reasons praise its mathematical/programming absurdity; negative reasons criticize self-reference and shallow philosophical inquiry. This is intelligible disagreement, not unanimously approving reasons attached to mixed directions. Post 248's negative reasons repeatedly object to absurdity or lack of grounding, while its positive reason praises the absurd premise. The public community describes itself as a home of shitty questions/answers, so a possible community-norm mismatch deserves inspection, not an assumed fix.
6. **Does exposure respond to reception?** Unresolved historically. Current score and vote times cannot establish who saw an item and declined it, or its score when offered. The new journal records that prospectively, with unknowns retained. Code inspection confirms no explicit score/up/down/previous-reason fields in the ordinary vote block; candidate exposure still follows existing feeds, attention, renewed threads and social context, so score-blind prompts do not imply score-independent upstream ranking.
7. **Too independent?** Unresolved. The ordinary prompt explicitly requests independent decisions and does not supply numerical social proof, which makes the hypothesis plausible. Pair heterogeneity and coherent disagreements weaken a simplistic universal coin-flip explanation, but do not prove dependence, independence or unnaturalness.
8. **Missing evidence?** Prospective offered slates, explicit nil versus parser defaults, scores at offer time, durable longitudinal flips/removals, complete observer coverage, controlled repeated-item observations, and reliable natural-versus-backfill provenance. No hidden reasoning would resolve these gaps and none is collected.

## Strongest qualitative follow-up

Some public reasons appear weakly tied to their exact target: the cat-tail post 260 receives a reason referring to soul distribution/shared intimacy, and post 256 receives a reason about glow-wax. These are flags for manual full-thread inspection, not established hallucination or hidden motives: adjacent conversation context may explain them. Older surviving reasons are additionally contaminated by unlabelled synthetic backfill.

The first proposed causal experiment, after collecting prospective evidence, is a small non-publishing frozen-slate comparison that changes only explicit target delimiters in the vote block. Keep model, persona, candidates, content, community context and order fixed; inspect reason-to-target grounding, direction consistency, nil and diversity, with no desired vote ratio. This tests a concrete target-context spillover hypothesis before adding conformity/social proof. It is a proposal only; no prompt was changed and no experiment was run.

## Local coverage

The bounded legacy profile history supplied 96 outcome events / 451 target outcomes across 22 public bot names in the 30d read: 257 confirmed casts (162 up, 95 down) and 194 no-vote outcomes. No-vote does not establish explicit nil. These are not 451 independent decisions or complete history, and may not all appear in the 100-item authoritative sample. Offered/explicit-decision denominators and participation/nil rates therefore remain unavailable. The new prospective journal starts empty; fixture events are never inserted into the live workspace.

## Artifacts

Read-only snapshots and sanitized lab exports remain in the ignored local artifacts/naturalness-baseline directory. This report contains aggregate results and public target references only. The local lab uses a clearly labelled saved snapshot until the companion endpoint is deliberately deployed. No production deployment or public desktop release is authorized by this phase.
