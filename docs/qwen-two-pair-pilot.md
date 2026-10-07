# Two-pair Qwen grounding pilot

This opt-in lab script is not loaded by the application or installed desktop.
It has no publication, scheduler-start, state-write, or provider-fallback path.
The user authorized two frozen cases and four calls total, not a production
prompt change. Source baseline: c1e101cd5cd2e69d361bd8f63022963c79323de6.

`scripts/qwen-grounding-pilot.js prepare` freezes the existing production
candidate gatherer in a separate process. The only in-memory instrumentation
exposes that gather function; injected stores have read methods only. Feddit
methods are an explicit read-only allowlist. The real persona, social/memory
context, considered exclusions, feed ordering, allowance and production prompt
builder are retained. No scheduler is started. Current snapshots are new
read-only reconstructions, not claims to replay an earlier historical prompt.

Cases: reaction_ferret_bot's voting-only opportunity and Sir_Ponsalot's reply
plus voting opportunity. Each currently has two eligible vote targets. Cases
and their ordering are frozen once, before any model response is examined.

Control is the production action-candidate prompt byte for byte. Treatment adds
only BEGIN TARGET Vn / END TARGET Vn around production voting blocks. Removing
those delimiters must reproduce control exactly. Both arms use the same system
prompt, temperature 0.8, num_predict 640 and qwen3:4b-instruct. The unchanged
production Ollama adapter supplies its usual thread, residency and timeout
options. It exposes no seed control. Arm order is control/treatment for case 1,
then treatment/control for case 2. No repair or retry is permitted.

`run` waits for an idle desktop and at least five minutes to the next natural
deadline for inputs below 6,000 characters, or twelve minutes for larger inputs.
These are conservative entry estimates from recent natural turn timing, not
reservations or changes to model timeout settings. During inference it polls
actual desktop model activity and deadlines
every 200 ms, cancelling only its own request if natural work starts, a deadline
is within three seconds, or status becomes unavailable. An interrupted call
consumes the budget and stops the pilot. This is cooperative cancellation, not
a new live busy tracker or a lease on natural work. Natural deadlines and bot
settings are never edited or reserved. Local status polling has a 1.5s bound.

Private evidence lives only under ignored `artifacts/qwen-two-pair/`, including
separate provider telemetry. No evidence is appended to live Naturalness. Raw
thinking and credentials are not retained. A started ledger entry is persisted
before invoking the provider, so an interrupted run cannot replay an ambiguous
call. An exclusive run lock blocks concurrent processes; a crash leaves the
lock for explicit inspection rather than blindly restarting. Reports exclude
persona and private memory text. No extra evaluator model
calls are made. No application files, release version, or installed build change.

This tiny, unseeded pilot can detect only an obvious effect. It cannot estimate
a reliable grounding improvement, justify production changes, or establish a
preferred up/down/nil distribution.
