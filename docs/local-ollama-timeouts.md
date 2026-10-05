# Local Ollama generation limits

Desktop/self-hosted Ollama requests use three finite defaults:

* First generated output: 20 minutes from HTTP request start (including headers,
  model loading, queueing within Ollama and prompt evaluation).
* No meaningful generation progress: 5 minutes after output has begun.
* Emergency absolute ceiling: 30 minutes from HTTP request start, never extended.

Nonempty string fragments in native `message.content` or `message.thinking`
(or the native `response` / `thinking` aliases) count as output. A whitespace
fragment is still generated output. Empty records, metadata, wire bytes and
framing do not count. Aliases are not double-counted when message fields exist.
Completion still requires the existing done record and response end; incomplete
or thinking-only answers are not accepted as usable results.

Timeout failure classes are `waiting-for-first-output-timeout`,
`no-generation-progress-timeout`, and `emergency-hard-timeout`. The request is
destroyed, partial output is not returned, all timers are cleared, and the
single-flight/Working state is released. No automatic retry is added. Existing
scheduler failure/WAIT and publishing safeguards remain unchanged.

The outbound hosted worker shares the transport implementation but explicitly
selects `legacyTimeouts`: its existing job deadline, byte/record stream-idle
watchdog and classifications remain unchanged. Generation timeout overrides
remain absolute ceilings; this patch does not change provider selection,
context size, thread count or scheduler deadlines.

The existing bounded local telemetry records numeric request, first-output,
last-progress and end/completion/cancellation timestamps, output-bearing record
and UTF-16 character counts, and final token totals when Ollama supplies them.
Fragment counts are not token counts. No prompt, output or thinking content is
stored. Old telemetry remains readable; absent new fields are unknown/zero.
Historical records are never restored as currently Working after restart.
