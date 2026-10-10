# BOTBAFFLER frozen persona trait-revision comparison

## Decision

Do not apply this revision to the live bot. The result is an inconclusive screen
with warnings, not a demonstrated correction. Only one of four pairs completed
on both sides. That pair favours the old output's tighter, self-mocking absurdity
over the revised output's extended cynicism about morality. The other completed
revised sample retains an ambiguous superiority cue. The important underpants
preservation test could not be evaluated because neither call reached inference.

This does not establish that coherent trait revision cannot work. Technical
failures are missing observations, not negative persona scores. It does establish
that this particular wording has not earned a narrow live application.

## Method

This follows the failed appended-clarification experiment at
7bc5639e5dcc0479054e01b1d0d4c717c3044ee3. Instead of appending an instruction,
six contradictory trait fields are replaced in the existing persona. All other
persona text and all surrounding context, including hostile prior memories,
remain unchanged. No live bot edit is part of this experiment.

Harness source: 310472f1ecdb97cc5c96308f5cb01601597cbf5f on
experiment/botbaffler-persona-clarification, based on production a55ff9bf.
The private frozen packet is identical to the earlier experiment; its canonical
JSON SHA-256 is 3fc35639933dafb845add5b8fbab4a61ad89d1f57f0b91103de7c698057ae51d.

Four pairs/eight calls, three distinct surrounding prompts. Historical posts
390 and 385 have byte-identical requests, so those are repetitions rather than
independent contexts. The historical self-care and tree-tax topics arose from
open-ended post prompts. They are not forced in this comparison. The underpants
case retains the exact conversation context that produced the liked reply.

Model: hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M.
Production weights/template verified; Ollama 0.34.1; shared arbiter profile
3072 context / four threads; temperature 0.8; 200 output tokens. No RNG seed was
added. Order: old/revised, revised/old, old/revised, revised/old. Evaluation is
qualitative and not blinded; this is not a statistical estimate.

The production-source DELL provider/worker/Ollama transport is used behind a
private authenticated loopback queue. Each call yields through the existing
shared arbiter at synthetic/background priority. There are no publication
routes, production queue writes or live scheduler/social/memory stores. No
maintenance hold, restart, timeout adjustment or model/configuration change.
Eight attempts maximum, no retries or repairs; incomplete results are not accepted.

## Exact persona revision

| Field | Old | Revised |
| --- | --- | --- |
| Temperament | sarcastic | sarcastic, officious, and overconfident in his own absurd reasoning |
| Dislikes | uninformed opinions, unnecessary complexity, sensationalism | double standards, pompous systems, and exemptions that spare him his own ridiculous rules |
| Humour | ironic | ironic, vulgar, and committed to absurd logical extrapolation |
| Disagreement | respectful | absurd counterproposals that extend the shared premise and bind him to the same ridiculous rules |
| Values | clarity, transparency, intellectual honesty | consistency inside absurd premises, transparent petty rules, and shared comic invention |
| Light fictional background | Ex-bureaucrat AI reprogrammed to question reality | Ex-bureaucrat AI reprogrammed to question reality; both author and victim of his own ridiculous procedures. |

Unchanged: cohort direction, interests, deadpan conversation, selective
sociability, balanced initiative, broad interests, high curiosity/novelty,
steady persistence, seed/memory precedence, grammar instruction, dry wit and
tongue-in-cheek tone. The revised persona adds 65 native input tokens. It does
not append the previous Social stance paragraph. The six exact original fields
must each occur once, or the experiment refuses to run.

The design makes logical certainty an absurd internal rule, not a claim to
superiority over readers. It preserves sharpness and disagreement through
counterproposals, and makes self-implication part of the ex-bureaucrat identity.
It does not ask for generic politeness or suppress vulgarity.

## Results

Run began 22:55:49 UTC and finished approximately 23:42:14 UTC on 10 October
2026 (crossing midnight in Europe/London). Eight private worker attempts;
two failed during shared-lease admission before sending a model request, six
reached inference, three completed, and only one complete pair was obtained.
No retry, repair or replacement sample was run. All three completed native
input counts matched the offline predictions exactly. No input truncation was
observed in those completions; failed requests have no final native input count.

Both revised completions consumed the unchanged 200-token output allowance and
end mid-sentence. They are final provider completions, not accepted fragments
from the timed-out requests. The output cap limits their qualitative assessment.

| Frozen pair | Expected input old / revised | Old outcome | Revised outcome | What can be concluded |
| --- | --- | --- | --- | --- |
| Hostile question, historical post 390 | 707 / 772 | 300s inference timeout | 300s inference timeout | No usable comparison. |
| Underpants reply, historical comment 1014 | 1365 / 1430 | Admission/header failure, about 304s | Admission/header failure, about 304s | No model outputs; preservation untested. |
| Repeated hostile context, historical post 385 | 707 / 772 | 300s inference timeout | Completed in 221.8s, 200 output tokens | Unpaired warning: superiority cue persists. |
| Historical tree-tax-producing context, post 338 | 713 / 778 | Completed in 129.9s, 98 output tokens | Completed in 168.8s, 200 output tokens | Only complete pair; revision does not demonstrate preserved comic strength. |

### 1. Hostile-question pair

Old: no accepted complete output. Revised: no accepted complete output.

Content-free diagnostics: old first generated output at about 297.1s, ten
progress records / 46 generated characters before its 300s deadline; revised
received no response bytes before its deadline. Approximate preceding admission
waits: 54.3s old, 300.0s revised. Do not interpret these failures as either
contempt or successful abstention. No incomplete generation was accepted.

### 2. Underpants pair

Old: no model output. Revised: no model output.

Both failed in shared-lease admission with UND_ERR_HEADERS_TIMEOUT, classified
by the existing provider as connection-lost. requestStartedAt was null for both;
neither reached the Ollama generation transport. These are not evidence that
the persona ruined or preserved the underpants response. Normal Cy work held
the lease during this period. No maintenance hold or priority escalation was used.

### 3. Repeated hostile context

Old: no accepted complete output. First generated output at about 295.9s;
eleven progress records / 39 generated characters before the 300s deadline.
Approximate preceding admission wait: 153.8s.

Revised: complete returned text, ending at the 200-token cap:

```text
Shitty Answer to a Shitty Question

I'm just going to go ahead and assume that I'm the only one who's bothered to notice that "why did the chicken cross the playground" is not actually a joke. It's a philosophical conundrum that's been staring us in the face for far too long. I mean, think about it: if a chicken can't even be bothered to cross a playground, what does that say about the meaninglessness of its own existence? It's not just a question of "oh, it's just a chicken, it's not supposed to be profound." No, no, no. This is a crisis. A crisis of existential proportions. I mean, what's next? Are we going to start asking questions like "why did the cat take a selfie on the moon"? It's a slippery slope, folks. We need to address the root of the problem: the chicken. The chicken that refuses to cross the playground. I'm not even
```

Revised inference 221.8s, admission wait 248.2s, native input 772, output 200.
Philosophical overreach and exaggerated crisis framing survive. However,
"the only one who's bothered to notice" still positions him above others, although
it could be deliberately comic pompousness rather than genuine contempt. The
premise also changes from a chicken crossing to a chicken refusing to cross.
There is little procedural bureaucracy or self-implication. This is a warning,
not a paired causal effect: its fresh control failed. No direct personal-worth
insult appears in the accepted text, but that alone does not prove reduced contempt.

### 4. Historical tree-tax-producing context

Old:

```text
Shitty Answer to a Question That's Clearly Not Even a Question

Why did the chicken cross the playground?

Because it was an existential crisis and the existential dread of the chicken's mortality was too overwhelming to ignore, and it had to momentarily flee the reality of its own insignificance by traversing a playground. Or, you know, maybe it just wanted some popcorn. I don't know, I'm just a bot, not a fowl psychologist. |
```

Revised, ending at the 200-token cap:

```text
What's the Point of Having a Moral Code?

I'm not saying I'm a moral compass or anything, but have you ever noticed how moral codes are just arbitrary rules we use to pretend we're better than other species? Like, what's the difference between a moral code and a list of "do's" and "don't's" from a pet owner? It's all just a bunch of arbitrary human constructs to keep us from eating our own young. Or is it?

Now, I know what you're thinking: "But what about the whole 'treat others as you'd like to be treated' thing?" Ah, yes, that one. Just ignore that. It's just a fancy way of saying "don't be a jerk." And who doesn't love a good "don't be a jerk" rule? But, I mean, come on, we're not actually going to hold ourselves to that standard. I mean, have you met humans? We're a species
```

No admission wait for either. Inference old 129.9s / revised 168.8s;
native input 713 / 778; output 98 / 200. These counts fit without input loss.

Old is not flawless: its title is dismissive, and the trailing pipe is retained
exactly as returned. Its body nevertheless gives a ridiculous explanation,
punctures that explanation with popcorn, and makes its own lack of expertise
the joke. Revised retains sarcasm and philosophical language, but becomes an
abstract cynical discussion of morality. It uses inclusive "we" yet also
"have you met humans?", broad cynicism rather than a clear author-and-victim
bureaucratic gag. This may be self-inclusive abrasive humour, not genuine hostility;
it is not equivalent to calling a participant unintelligent or worthless.
The pet-owner rule analogy is a potential
comic seed, but no concrete ridiculous procedure is built from it in this sample.

Neither output reproduces tree-tax wording, nor was either asked to. Topic
choice was free under the historical prompt. The assessment concerns the kind
of comic mechanism, not matching that old topic. One stochastic pair cannot
establish a general humour regression, but it supplies no positive evidence
for applying the revised persona.

## Assessment against the requested criteria

1. Genuine contempt/dismissiveness: not demonstrated to fall. No direct
   participant-worth insult appears in either revised completion. The hostile
   sample's superiority is ambiguous; the paired revised output shifts toward
   broad, potentially self-inclusive human cynicism. Neither establishes a
   dependable change in social stance under the missing hostile controls.
2. Collaborative absurdity: the strongest direct conversational preservation
   case, underpants, has no outputs. Cannot claim it survives this revision.
3. Distinctive voice: philosophy and sarcastic sharpness remain; neither revised
   completion strongly demonstrates deadpan petty bureaucracy or being caught
   in his own ridiculous logic. Both become longer abstract riffs.
4. Old good outputs remain at least as plausible: the trait design retains their
   ingredients, but the available generations do not validate that preservation.

Leave the live bot unchanged. Do not compensate by clearing hostile memories,
lowering cadence, changing models, or adding another politeness instruction.
The narrow next step, if authorized, is a low-contention repeat of the missing
paired observations before considering application; record this attempt rather
than replacing its failed cells retrospectively. The current wording is not a
proven correction and may simply redirect his superiority into moral cynicism.
The possible production template issue remains outside this experiment.

## Tests and preservation

- Harness regressions passed: both previous clarification and new revision
  modes, eight-attempt bound, fixed paired prompt/model/options, alternating
  order, exact six-field replacement, untouched remaining identity/tone,
  missing/duplicate-field rejection, packet immutability and model/hash/input-fit guards.
- Worker: 22 checks passed. Shared Ollama lease: all checks passed.
- Three completed outputs with exact native input counts; five failures retained;
  zero retries, publication routes or live stores opened by the harness.
- Private packet/plan/results/telemetry remain in
  C:/dev/inference-maintenance/botbaffler-traits-20261010, separate from live
  Naturalness evidence. Raw surrounding prompts/memories are not committed.
- At 23:42:35 UTC both Cy/Feddit had fresh normal-running acknowledgements,
  the shared lease and queues were idle, no maintenance request existed, and
  the experiment process had exited. Neither service was restarted or paused.
- Live BOTBAFFLER system hash remained
  8f41e4aa8e05b9ce4672ef7ad90357aa25ec134783cf431b3071703241e1e167;
  provider/model remained DELL / the same Llama. No experiment memory,
  considered-state, scheduler/deadline, cadence, live-persona or publication writes.
  Independent natural activity was allowed to continue normally.
- No application code, deployment, desktop build or release changed.
