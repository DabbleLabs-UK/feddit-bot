# Final native-schema framing pair: inconclusive, deployment held

Date: 2026-10-16. Exactly two additional inference calls, no retries or repair
calls. The comparison is finished; no further comparison calls are proposed or
authorized by this report. No production deployment or desktop release occurred.

## Frozen case and implementation

Runner validation utility: 1a61cad6b2e99babcedeef7aad87c0a9cde004cc, based on
reviewed runner 57aa8d8. Non-streaming worker source remains exactly
8fd2ece52eb0425cdabc65dccde2a8126132b3d5. Only the manual validation utility and
mocked tests changed; no scheduler/provider/schema/parser behavior changed.

Case t_80a68191c5055cdd1ffe390c31955d19 was not in any previous bounded protocol.
It is the earliest retained case, by original admission timestamp, with offered
votes and framing-marker JSON failure in both its initial and final responses,
after excluding all previously exercised cases. Original admission was
2026-10-14 19:58:23.059 UTC. Selection used existing categories, not newly sampled
model outputs. Its historically invalid primary was never salvaged or applied.

Both arms used the original initial system/prompt, model, temperature 0.8 and
complete offered set: C1 renewed_thread, C4 ordinary_post, V1. Control was the
current unformatted first-pass decision request. Native used the existing simple
response-format v1 schema, without the later word/length micro-constraints.
This is response-format v1, NOT a rollback of semantic decision contract v2 or
construction-v2. The existing validator and partial-vote semantics stayed exact.

Model: hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M.
Verified Ollama 0.34.1, existing template/stops, context 3072, four threads,
output reservation 640 and safety margin 64. Input was exactly 2254 tokens:
2254 + 640 + 64 = 2958 <= 3072. No candidate or prompt text was removed.

Private protocol SHA-256:
413fdc42d4283305537189ed4bc30a159c9cb9ba7a5b53f311b5ad235761512f.
Frozen generation request hash:
13e69ae4e152b4f0fef52c075f7504e13fd0c4f76f89194ef2e1758c0194ddc7.
An isolated fetch observer verified the entire actual chat request bodies were
identical after removing only format:
e49bd09b0e57cfe473be54694cfc89b2b3a7a87f702f83128e1035e376d64ecd.
It made no additional request, changed no request or response, and was restored
on exit. It retained only allowlisted completion/token metadata, including the
legacy control's otherwise unrecorded finish reason.

Fresh DELL private directory: C:/dev/feddit-format-validation/20261016-final-pair.
Private receipts were copied back with hash verification into ignored,
owner-protected artifacts/validity/private-results/final-pair. Previous protocols
and evidence were not overwritten or retried. Summary SHA-256:
0aa039b4b02f65542cb663b0d2264979c6b6d5dc164bcc292eb661ab7c2cb5f3.

## Results

Control admission: 21:39:02.609 UTC / 22:39:02.609 Europe/London.
Native admission: 21:43:27.104 UTC / 22:43:27.104 Europe/London.
Total run time: 286.607 seconds. Both calls used normal synthetic-priority shared
admission with zero recorded queue time; no service was paused or restarted.

| Outcome | Control | Simple native v1 |
| --- | --- | --- |
| Raw syntactically valid JSON | Yes | Yes |
| Valid primary | C1 renewed-thread reply | C1 renewed-thread reply |
| Explicit WAIT | No | No |
| Complete decision contract | Yes | Yes |
| Valid individual votes | 1: V1 up | 1: V1 down |
| Invalid / missing votes | 0 / 0 | 0 / 0 |
| Exact native tuple/shape | Yes, even without schema | Yes |
| Input / output tokens | 2254 / 54 | 2254 / 45 |
| Native completion | done=true, stop | done=true, stop |
| Inference time | 264.431s | 22.089s |

Both responses ended normally below the output reserve, with exact frozen input
counts. No silent truncation or publication occurred. The control's historical
framing failure did NOT reproduce. Therefore this pair is INCONCLUSIVE, not a
demonstrated native rescue. The different vote directions are model choices,
not evidence that either judgment is better. No latency benefit can be inferred:
control/native order and prompt-cache warming confound the timing difference.

## Entire retained evidence and final recommendation

The historical production sample remains 18/38 valid primary decisions after
the existing repair, 17/38 full contracts and 17/35 independently explicit votes.
Across bounded calls there are now three complete matched control/simple-native
pairs. Primary validity is 3/3 versus 3/3; full validity is 2/3 versus 2/3;
independently explicit votes are 4/6 versus 5/6. Thus no matched primary gain has
been measured.

Including the earlier unpaired zero-vote native response, simple native v1 is
4/4 primary, 3/4 full contract and 5/6 explicit vote appearances. Including the
separate reason-refined v2 response as descriptive evidence, all native results
are 5/5 primary, 3/5 full and 6/8 explicit votes. These are five draws over four
selected cases and two schema versions, not a production-rate estimate. One
earlier control receipt remains lost and excluded. Do not compare 5/5 with
18/38 as if these were randomized comparable cohorts.

Correctness remains supported by unchanged application validation: the earlier
two-word reason and omitted V2 were left unresolved, not invented NILs or
voting-considered outcomes. Independently valid primary actions/votes survive.
Native schema is an output-shaping aid, not a hard enforcement boundary. A
missing independent vote is not itself grounds to discard a usable primary.
Conversely, neither valid JSON nor a valid choice proves good judgment,
target-specific reasons or better conversation density.

Final recommendation: HOLD production deployment because incremental primary
benefit is unestablished, NOT because perfect vote completeness is required.
The evidence does not justify STOP on grounds of native primary failure, nor
GO on a claim of demonstrated material primary improvement. Reason constraints
have no demonstrated net benefit and no more micro-constraints were added.
The requested comparison chain is closed regardless of this inconclusive result;
no further inference experiment, retry, schema change or deployment follows.

## Preservation and verification

At 21:44:37 UTC the original worker PID 7836 and Cy PID 14988 had fresh running
acknowledgements and were alive. Ollama remained 0.34.1, no maintenance owner
existed, and no final-pair process remained. The arbiter was already serving
ordinary Feddit work, not an experiment lease. Desktop pause remained false and
canary IDs remained p_swb8djuqg1y4, p_7gc83gbxvjpc, p_e4l36dfw9wrl.
No profiles, cadence, memory, social/considered state, scheduler deadlines,
personas, providers, ecology or canary settings were written by this job.

The WSL SSH and Windows SCP/SFTP transfer paths were unavailable/stalled before
inference. Only our stalled transfer clients were stopped. The working existing
Windows SSH channel transferred strict-name artifacts with no-overwrite and
SHA-256 checks; no WSL/Cy/worker/network service was repaired or restarted.

Offline checks pass: validation utility 147, runner format 157, worker format
105, decision contract 91 and voting suite. Read-only safety review found no
material issue in two-call bounds, response preservation, request identity,
unresolved handling or cleanup. Private raw prompts/results remain ignored and
outside live Naturalness evidence. There were exactly two inference requests,
zero automatic retries, zero publication/registration routes, zero live stores
opened and zero maintenance holds. Authoritative main and production were not
changed.
