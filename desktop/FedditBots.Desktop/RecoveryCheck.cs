using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace DabbleLabs.FedditBots.Desktop;

// One short scheduled invocation, not another runner or inference supervisor.
internal static class RecoveryCheck
{
    internal static readonly string[] EnvironmentKeys = ["FEDDIT_QUIET_CONVERSATIONS", "FEDDIT_THEME_INTEREST_V1",
        "FEDDIT_THEME_INTEREST_COMMUNITIES", "FEDDIT_QUIET_POPULATION_V2"];

    internal static async Task<int> RunAsync(AppPaths paths, DesktopConfig config, AppLog log,
        CancellationToken cancellationToken, Action<ProcessStartInfo>? start = null)
    {
        var store = new RecoveryStore(paths.InstallRoot, paths.UserRoot);
        var recovery = store.ReadConfig();
        if (recovery is null || !recovery.Enabled) return 0;
        using var checkLock = store.TryAcquireCheckLock();
        if (checkLock is null) return 0;
        var intent = store.ReadIntent();
        if (intent is null) { log.Write("Recovery check held: missing-intent."); return 2; }
        if (!intent.DesiredRunning) return 0;
        var launcherPath = Path.Combine(paths.InstallRoot, "FedditBots.Desktop.exe");
        if (!File.Exists(launcherPath) || Hash(launcherPath) != recovery.LauncherSha256)
        {
            log.Write("Recovery check quarantined: launcher-hash-mismatch.");
            return 2;
        }
        var pointer = paths.ReadPointer(paths.CurrentFile);
        var server = Path.Combine(paths.ResolvePayload(pointer), "app", "server.js");
        var session = store.ReadSession();
        var launcherProcesses = FindProcesses(launcherPath, Environment.ProcessId);
        using var launcherLock = store.TryAcquireLauncherLock();
        var launcherAlive = session is not null && RecoveryIdentity.ProcessMatches(session.Launcher, launcherPath);
        var listener = RecoveryIdentity.InspectLoopbackListener(config.Port);
        RecoveryHealth health;
        if (launcherProcesses.Count > 1 || !listener.Known || !listener.LoopbackOnly)
            health = RecoveryHealth.Conflict;
        else if (launcherAlive)
        {
            // The owner, not this external check, recovers a failed live child.
            if (launcherLock is not null) health = RecoveryHealth.Conflict;
            else if (session is not null && RecoveryIdentity.ValidateSession(session, paths.InstallRoot, server, config.Port)
                && await HealthyAsync(config.Port, pointer.Version, cancellationToken)) health = RecoveryHealth.Healthy;
            else health = RecoveryHealth.WaitInternal;
        }
        else if (launcherLock is null || launcherProcesses.Count != 0)
            health = RecoveryHealth.Unknown; // A new owner may still be starting.
        else if (listener.Pid is not null)
            health = session is not null && RecoveryIdentity.ValidateSession(session, paths.InstallRoot, server, config.Port)
                ? RecoveryHealth.Missing : RecoveryHealth.Conflict; // Restore owner and adopt its existing child.
        else if (FindProcesses(Path.Combine(paths.InstallRoot, "runtime", "node", "node.exe")).Count != 0)
            health = RecoveryHealth.Unknown; // Never duplicate an unidentifiable/orphaned live child.
        else health = RecoveryHealth.Missing;

        var previous = store.ReadPolicyState() ?? new RecoveryPolicyState();
        var result = RecoveryPolicy.Observe(previous, DateTimeOffset.UtcNow, health,
            launcherAlive ? session!.Launcher.StartedAtUtc : null);
        store.WritePolicyState(result.State);
        if (result.Reason != previous.LastReason || result.Action is RecoveryAction.Recover or RecoveryAction.Quarantine)
            log.Write("Recovery check: " + result.Action + " / " + result.Reason + ".");
        if (result.Action != RecoveryAction.Recover) return health is RecoveryHealth.Unknown or RecoveryHealth.Conflict or RecoveryHealth.WaitInternal ? 2 : 0;
        if (launcherLock is null || store.ReadIntent()?.DesiredRunning != true) return 0;
        // Record before launch: a lost acknowledgement must not cause a storm.
        store.WritePolicyState(RecoveryPolicy.RecordAttempt(result.State, DateTimeOffset.UtcNow));
        var process = new ProcessStartInfo(launcherPath) { UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = paths.InstallRoot };
        process.ArgumentList.Add("--recovery-start");
        foreach (var key in EnvironmentKeys) process.Environment.Remove(key);
        foreach (var item in recovery.RuntimeEnvironment)
            if (item.Value.Length != 0) process.Environment[item.Key] = item.Value;
        launcherLock.Dispose(); // New owner takes the same cross-session lock.
        if (start is null)
        {
            RecoveryTask.StartApplication(paths);
        }
        else start(process);
        log.Write("Recovery launched the configured application in the background; no model request was made by this check.");
        return 0;
    }

    internal static async Task<bool> HealthyAsync(int port, string version, CancellationToken cancellationToken)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
            var json = await http.GetStringAsync("http://127.0.0.1:" + port + "/api/runtime", cancellationToken);
            using var runtime = JsonDocument.Parse(json);
            if (!runtime.RootElement.TryGetProperty("appVersion", out var actual) || actual.GetString() != version
                || !runtime.RootElement.TryGetProperty("placement", out var placement) || placement.GetString() != "desktop") return false;
            json = await http.GetStringAsync("http://127.0.0.1:" + port + "/api/runtime-state", cancellationToken);
            using var state = JsonDocument.Parse(json);
            return state.RootElement.TryGetProperty("busy", out var busy) && busy.ValueKind is JsonValueKind.True or JsonValueKind.False;
        }
        catch (Exception error) when (RunnerSupervisor.ShouldLogAndRetry(error, cancellationToken)) { return false; }
    }

    internal static async Task<bool> CheckOwnedChildAsync(AppPaths paths, VersionPointer pointer, RecoveryStore store,
        RunnerSupervisor supervisor, AppLog log, CancellationToken cancellationToken, DateTimeOffset? launcherStartedAt = null)
    {
        var healthy = await supervisor.IsHealthyAsync(pointer.Version, cancellationToken);
        var health = healthy ? RecoveryHealth.Healthy : supervisor.RunnerExited ? RecoveryHealth.Missing : RecoveryHealth.Unhealthy;
        var previous = store.ReadPolicyState("child") ?? new RecoveryPolicyState();
        var evaluation = RecoveryPolicy.Observe(previous, DateTimeOffset.UtcNow, health,
            launcherStartedAt ?? new DateTimeOffset(Process.GetCurrentProcess().StartTime.ToUniversalTime()));
        store.WritePolicyState(evaluation.State, "child");
        if (evaluation.Action != RecoveryAction.Recover) return healthy;
        if (store.ReadIntent()?.DesiredRunning != true) return healthy;
        store.WritePolicyState(RecoveryPolicy.RecordAttempt(evaluation.State, DateTimeOffset.UtcNow), "child");
        if (!supervisor.RunnerExited && !await supervisor.StopWhenIdleAsync(TimeSpan.FromSeconds(5), cancellationToken))
        {
            log.Write("Runner recovery quarantined: safe shutdown unavailable; no process was killed.");
            return false;
        }
        if (store.ReadIntent()?.DesiredRunning != true) return false;
        await supervisor.StartAsync(pointer, cancellationToken);
        log.Write("Runner recovered after confirmed exit or authenticated safe shutdown.");
        return true;
    }

    internal static List<ProcessIdentity> FindProcesses(string executable, int except = -1)
    {
        var result = new List<ProcessIdentity>();
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
        {
            using (process)
            {
                if (process.Id == except) continue;
                try
                {
                    var identity = RecoveryIdentity.Capture(process.Id);
                    if (RecoveryStore.SamePath(identity.ExecutablePath, executable)) result.Add(identity);
                }
                catch (ArgumentException) { } // Exited between enumeration and inspection.
                catch (InvalidOperationException) when (process.HasExited) { }
                // Access denied/unknown is not evidence of absence.
            }
        }
        return result;
    }

    internal static void ApplyRuntimeEnvironment(RecoveryConfig? config)
    {
        // External supervision can be disabled without changing the app's
        // separately preserved rollout environment on its next manual start.
        if (config is null) return;
        foreach (var item in config.RuntimeEnvironment)
        {
            var supplied = Environment.GetEnvironmentVariable(item.Key) ?? "";
            if (supplied.Length != 0 && supplied != item.Value)
                throw new InvalidDataException("Recovery runtime environment conflicts with explicit process configuration.");
            Environment.SetEnvironmentVariable(item.Key, item.Value.Length == 0 ? null : item.Value);
        }
    }

    internal static string Hash(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
