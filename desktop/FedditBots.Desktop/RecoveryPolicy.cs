namespace DabbleLabs.FedditBots.Desktop;

internal enum RecoveryHealth { Healthy, Missing, Unhealthy, WaitInternal, Unknown, Conflict }
internal enum RecoveryAction { None, Recover, WaitInternal, Quarantine }

internal sealed record RecoveryPolicyState
{
    public int SchemaVersion { get; init; } = 1;
    public DateTimeOffset? LastProbeAt { get; init; }
    public DateTimeOffset? FailureSince { get; init; }
    public int ConsecutiveFailures { get; init; }
    public DateTimeOffset? NextAttemptAt { get; init; }
    public DateTimeOffset[] Attempts { get; init; } = [];
    public string LastReason { get; init; } = "initial";
}

internal sealed record RecoveryEvaluation(RecoveryPolicyState State, RecoveryAction Action, string Reason);

internal static class RecoveryPolicy
{
    private static readonly int[] BackoffMinutes = [1, 5, 15, 30];

    public static RecoveryEvaluation Observe(RecoveryPolicyState state, DateTimeOffset now, RecoveryHealth health, DateTimeOffset? launcherStartedAt = null)
    {
        Validate(state);
        RecoveryStore.Require(RecoveryStore.IsTimestamp(now), "Recovery clock must be UTC.");
        var regressed = state.LastProbeAt is { } prior && now < prior;
        var stale = state.LastProbeAt is { } previous && (now < previous || now - previous > TimeSpan.FromMinutes(5));
        var attempts = state.Attempts.Where(item => now - item < TimeSpan.FromHours(1)).ToArray();
        var next = state with { LastProbeAt = now, Attempts = attempts };
        if (regressed)
        {
            var resumeAfter = state.LastProbeAt!.Value.AddMinutes(30);
            if (next.NextAttemptAt is null || next.NextAttemptAt < resumeAfter) next = next with { NextAttemptAt = resumeAfter };
        }
        if (stale || health is RecoveryHealth.Healthy or RecoveryHealth.Unknown or RecoveryHealth.Conflict or RecoveryHealth.WaitInternal
            || (launcherStartedAt is { } start && (now < start || now - start < TimeSpan.FromMinutes(2))))
        {
            var reason = stale ? "probe-gap" : health == RecoveryHealth.Healthy ? "healthy" : health is RecoveryHealth.Unknown or RecoveryHealth.Conflict ? "identity-unknown"
                : health == RecoveryHealth.WaitInternal ? "launcher-recovering" : "startup-grace";
            next = next with { ConsecutiveFailures = 0, FailureSince = null, LastReason = reason };
            return new(next, health == RecoveryHealth.WaitInternal ? RecoveryAction.WaitInternal : RecoveryAction.None, reason);
        }
        next = next with
        {
            FailureSince = next.FailureSince ?? now,
            ConsecutiveFailures = Math.Min(1000000, next.ConsecutiveFailures + 1),
            LastReason = health == RecoveryHealth.Missing ? "application-absent" : "health-failed",
        };
        if (next.ConsecutiveFailures < 3 || now - next.FailureSince.Value < TimeSpan.FromMinutes(3))
            return new(next, RecoveryAction.None, "failure-grace");
        if (next.NextAttemptAt is { } deadline && now < deadline)
            return new(next, RecoveryAction.Quarantine, "backoff");
        if (attempts.Length >= 4)
        {
            next = next with { NextAttemptAt = now.AddMinutes(30), LastReason = "hourly-attempt-bound" };
            return new(next, RecoveryAction.Quarantine, next.LastReason);
        }
        return new(next, RecoveryAction.Recover, next.LastReason);
    }

    public static RecoveryPolicyState RecordAttempt(RecoveryPolicyState state, DateTimeOffset now)
    {
        Validate(state);
        RecoveryStore.Require(RecoveryStore.IsTimestamp(now), "Recovery clock must be UTC.");
        var recent = state.Attempts.Where(item => now - item < TimeSpan.FromHours(1)).ToArray();
        RecoveryStore.Require(recent.Length < 4 && (state.NextAttemptAt is null || now >= state.NextAttemptAt), "Recovery attempt is still bounded by backoff.");
        var attempts = recent.Append(now).TakeLast(16).ToArray();
        return state with
        {
            Attempts = attempts,
            NextAttemptAt = now.AddMinutes(BackoffMinutes[Math.Min(attempts.Length - 1, BackoffMinutes.Length - 1)]),
            LastReason = "recovery-attempt",
        };
    }

    internal static void Validate(RecoveryPolicyState state)
    {
        RecoveryStore.Require(state.SchemaVersion == 1 && state.ConsecutiveFailures is >= 0 and <= 1000000
            && state.Attempts is not null && state.Attempts.Length <= 16
            && state.Attempts.All(RecoveryStore.IsTimestamp)
            && (state.LastProbeAt is null || RecoveryStore.IsTimestamp(state.LastProbeAt.Value))
            && (state.FailureSince is null || RecoveryStore.IsTimestamp(state.FailureSince.Value))
            && (state.NextAttemptAt is null || RecoveryStore.IsTimestamp(state.NextAttemptAt.Value))
            && state.LastReason is not null && state.LastReason.Length <= 64
            && state.LastReason.All(character => char.IsAsciiLetterOrDigit(character) || character == '-'), "Invalid recovery policy state.");
    }
}
