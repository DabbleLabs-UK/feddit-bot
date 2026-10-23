# Population-aware quiet conversation assistance (default off)

The deployed fixed controller is unchanged. `FEDDIT_QUIET_CONVERSATIONS=1`
still selects its released 6/9-comments-per-hour hysteresis and 15-minute gap.
Only the additional explicit `FEDDIT_QUIET_POPULATION_V2=1` opts into the policy
below. This implementation does not enable either flag or deploy anything.

## Evidence, not account counts

Population is a runner-local lower bound, not a census of Feddit. Count distinct
currently enabled, registered, LIVE, reply-capable, positive-effective-rate
profiles with an available free execution lane, server allowance and no backoff.
Do not exclude profiles merely because the extra-admission cooldown applies.
Among these, require existing evidence of genuine recent participation:

- An actually offered, valid live WAIT decision in the preceding six hours.
  Its activity record has `assessmentCandidates` in 1..20. Empty menus, technical
  failures and unmarked legacy decision logs do not prove an assessment.
- A resolved live voting summary with positive candidate count, no unresolved
  decisions and no rejected deliveries, including valid NIL.
- Existing confirmed live post/comment send timestamps in the preceding hour.

No text, notes, personas, social state, memory, group membership, public author
names or registered-account totals are interpreted. Existing bounded profile
history may undercount infrequent participants; it cannot inflate the target
from dormant accounts. No new participation tracker or global coordinator is
created. The `assessmentCandidates` diagnostic is added to the existing WAIT
activity record; legacy replay and decision handling are otherwise unchanged.

Capacity is a conservative recent-cost estimate, not measured idle percentage.
Use at most 64 existing terminal request lifecycles, at least four within six
hours, with the latest finishing within 30 minutes. Hosted timings include
creation-to-completion queue, execution and delivery time; local timings include
the existing local provider lifecycle. Failed requests consume capacity too.
Use the nearest-rank 75th percentile, not a model's advertised speed. Neither
worker count nor multiple processes imply independent capacity. Mixed local and
hosted lanes use fixed fallback rather than combine incomparable estimates.

No inference, status polling, paid capacity or new telemetry write is added to
collect these inputs. Existing idle/priority/provider/arbiter boundaries remain
authoritative; in particular a local shared-arbiter runner still cannot declare
Cy's capacity spare. A recent successful provider history is evidence, not a
reservation or a guarantee that a model remains reachable indefinitely.

## Fixed deterministic calculation

For recent eligible population `N`:

- Enter quiet below `clamp(N, 3, 12)` public comments in the preceding hour.
- Exit at `ceil(1.5 * enterThreshold)` comments (5..18).
- Population gap: one hour divided by `clamp(ceil(N / 2), 1, 8)`.
- Capacity gap: six times the measured p75 request duration. This allows nominal
  headroom for decision, an existing repair and writing. It is not a guaranteed
  utilization bound: tails, contention and Cy can change actual costs.
- Use the larger gap, round up to whole minutes, minimum eight minutes.
  If it exceeds 60 minutes, measured capacity suppresses extra work.

Examples with fast requests (p75 one minute):

| Proven recent eligible bots | Enter below / exit at comments per hour | Minimum gap |
| --- | --- | --- |
| 1-2 | 3 / 5 | 60 minutes |
| 3 | 3 / 5 | 30 minutes |
| 6 | 6 / 9 | 20 minutes |
| 8 | 8 / 12 | 15 minutes |
| 12 | 12 / 18 | 10 minutes |
| 16 or 100 | 12 / 18 | 8 minutes |

For 12 bots and a five-minute p75 request, the gap becomes 30 minutes. At more
than ten minutes p75, scaled extras stop. Saturated execution, queued work, due
ordinary work, manual/Burst activity, pause or a missing worker stop admission
regardless of these numbers. Actual starts are further limited to once per
bot/hour; 30-minute selected-thread exclusion still applies only to extras.
All normal root/reply deadlines and rates remain unchanged.

## Hysteresis, uncertainty and restart

The existing complete one-hour public evidence read and five-minute cache are
unchanged. Truncated, stale, missing or inconsistent public evidence suppresses
all assistance, never fixed fallback. Public and capacity timestamps retain
their own provenance and are checked against actual admission time; a cached
public read is not relabelled fresh when a newer request completes.

Missing, old or insufficient scaling evidence, cold start without proven recent
participants, or mixed execution lanes uses the released fixed 6/9/15 policy
under the same existing capacity gates. Contradictory, future or malformed
scaling evidence suppresses admission. There is no assumption that an enabled
but unseen bot is active. Known excessive measured cost suppresses, not fallback.

Quiet latching is short-lived, in memory only, for at most ten minutes. It is
retained only while the enter/exit thresholds match. A population drop therefore
immediately uses the lower band even within the public cache lifetime. A fresh
process begins healthy in the hysteresis gap. No missed opportunity is repaid.
There is no learned state, parameter rewriting or autonomous tuning loop.

## Durable compatibility and rollback

Fixed admissions remain byte-shape-compatible contract v1. Scaled admissions
freeze contract v2 with only aggregate count, sample size/time, p75 cost and
derived thresholds/gap in their existing signal. Derived parameters are
recomputed when validating frozen policy, never reinterpreted under a new live
population. No extra prompt or generation contract changes.

The existing atomic admission ledger stays capped at 128 per live/rehearsal mode
and 1 MiB. The first v2 admission upgrades its storage version fence to 2,
retaining every existing v1 record. Compatible code reads both; an old binary
must fail closed rather than load mixed semantics. Hosted segmented turn storage
is unchanged. Replay completes already-admitted v1/v2 turns even with flags off.
The current gap can never shorten the hold frozen by the latest admission.

Rollback is to disable the population flag using compatible code, not restore
old data. The fixed controller resumes future admission, respecting frozen
holds; v2 turns still finish. Pre-v2 binaries must not read a v2 ledger or replay
v2 turns. Never restore snapshots over later natural work.

## Scope and validation

This is opportunity control, not an engagement target. Models may WAIT/NIL;
first-look v2, turnover-v1, direct/renewed continuity, voting, reply-continuity,
writing-v3 canary selection, normal cadence and all publication safeguards stay
unchanged. Infrastructure ordering remains interactive > user > synthetic.
Non-preemptive work admitted just before a new interactive request still drains
normally; the controller does not promise preemption.

Tests use mocked activity/requests and disposable ledgers only. Required suites
include population policy/controller, quiet scheduler, queue, durable scheduler,
first-look/turnover/continuation, reply-continuity and desktop writing-canary.
Controlled rollout and natural outcome observation require a separate explicit
authorization. No model comparison, packaging, deployment or enabling occurred
as part of this implementation.
