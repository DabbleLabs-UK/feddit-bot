using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Principal;
using DabbleLabs.FedditBots.Desktop;

internal static class RecoveryCoreTests
{
    public static int Run()
    {
        var checks = 0;
        void Check(bool condition, string message)
        {
            if (!condition) throw new Exception("FAIL: recovery " + message);
            checks++;
        }
        void Reject(Action action, string message)
        {
            try { action(); throw new Exception("FAIL: recovery accepted " + message); }
            catch (InvalidDataException) { checks++; }
        }
        var time = new DateTimeOffset(2026, 10, 28, 1, 0, 0, TimeSpan.Zero);
        var state = new RecoveryPolicyState();
        for (var minute = 0; minute < 3; minute++)
        {
            var result = RecoveryPolicy.Observe(state, time.AddMinutes(minute), RecoveryHealth.Missing);
            state = result.State;
            Check(result.Action == RecoveryAction.None, "absence grace prevents immediate restart");
        }
        var ready = RecoveryPolicy.Observe(state, time.AddMinutes(3), RecoveryHealth.Missing);
        Check(ready.Action == RecoveryAction.Recover, "persistent absence becomes recoverable");
        state = RecoveryPolicy.RecordAttempt(ready.State, time.AddMinutes(3));
        Check(state.NextAttemptAt == time.AddMinutes(4), "first attempt has one-minute backoff");
        Check(RecoveryPolicy.Observe(state, time.AddSeconds(210), RecoveryHealth.Missing).Action == RecoveryAction.Quarantine, "backoff blocks another attempt");
        Check(RecoveryPolicy.Observe(state, time.AddMinutes(10), RecoveryHealth.Missing).Action == RecoveryAction.None, "stale probe never catches up immediately");
        Check(RecoveryPolicy.Observe(state, time.AddMinutes(2), RecoveryHealth.Missing).Action == RecoveryAction.None, "clock regression resets grace");
        Check(RecoveryPolicy.Observe(state, time.AddMinutes(4), RecoveryHealth.Healthy).State.ConsecutiveFailures == 0, "healthy probe resets failure streak");
        Check(RecoveryPolicy.Observe(state, time.AddMinutes(4), RecoveryHealth.Unknown).Action == RecoveryAction.None, "unknown identity fails closed");
        Check(RecoveryPolicy.Observe(state, time.AddMinutes(4), RecoveryHealth.Conflict).Action == RecoveryAction.None, "conflicting identity fails closed");
        Check(RecoveryPolicy.Observe(state, time.AddMinutes(4), RecoveryHealth.WaitInternal).Action == RecoveryAction.WaitInternal, "internal recovery is not an external attempt");
        Check(RecoveryPolicy.Observe(state, time.AddMinutes(4), RecoveryHealth.Unhealthy, time.AddMinutes(3)).Action == RecoveryAction.None, "startup grace tolerates slow startup");
        state = RecoveryPolicy.RecordAttempt(state, time.AddMinutes(4));
        Check(state.NextAttemptAt == time.AddMinutes(9), "second attempt has five-minute backoff");
        state = RecoveryPolicy.RecordAttempt(state, time.AddMinutes(9));
        Check(state.NextAttemptAt == time.AddMinutes(24), "third attempt has fifteen-minute backoff");
        state = RecoveryPolicy.RecordAttempt(state, time.AddMinutes(24));
        Check(state.NextAttemptAt == time.AddMinutes(54), "fourth attempt has thirty-minute backoff");
        state = state with { LastProbeAt = time.AddMinutes(54), FailureSince = time.AddMinutes(50), ConsecutiveFailures = 4 };
        Check(RecoveryPolicy.Observe(state, time.AddMinutes(55), RecoveryHealth.Unhealthy).Action == RecoveryAction.Quarantine, "four attempts per hour are bounded");
        Reject(() => RecoveryPolicy.RecordAttempt(state, time.AddMinutes(55)), "fifth hourly attempt");
        Reject(() => RecoveryPolicy.Validate(state with { SchemaVersion = 2 }), "unknown policy schema");
        Reject(() => RecoveryPolicy.Validate(state with { Attempts = Enumerable.Repeat(time, 17).ToArray() }), "unbounded attempts");

        var temporary = Path.Combine(Path.GetTempPath(), "feddit-recovery-core-" + Guid.NewGuid().ToString("N"));
        try
        {
            var install = Path.Combine(temporary, "install");
            var store = new RecoveryStore(install, temporary);
            store.InitializePrivateDirectory();
            Check(store.ReadIntent() is null, "absent intent does not imply running");
            store.WriteIntent(new RecoveryIntent { DesiredRunning = false, UpdatedAt = time });
            Check(store.ReadIntent()?.DesiredRunning == false, "explicit stop persists");
            store.WriteIntent(new RecoveryIntent { DesiredRunning = true, UpdatedAt = time.AddSeconds(1) });
            Check(store.ReadIntent()?.DesiredRunning == true, "atomic intent replacement persists");
            store.WriteConfig(new RecoveryConfig { InstallRoot = install });
            Check(store.ReadConfig()?.Enabled == false, "configuration defaults off");
            Reject(() => store.WriteConfig(new RecoveryConfig { InstallRoot = install, Enabled = true }), "enabled recovery without pinned launcher hash");
            store.WriteConfig(new RecoveryConfig { InstallRoot = install, Enabled = true, LauncherSha256 = new string('a', 64) });
            Check(store.ReadConfig()?.Enabled == true, "enabled recovery pins the immutable launcher hash");
            Reject(() => store.WriteConfig(new RecoveryConfig { InstallRoot = install, RuntimeEnvironment = new() { ["SECRET"] = "not-allowed" } }), "unapproved environment");
            Reject(() => store.WriteConfig(new RecoveryConfig { InstallRoot = temporary }), "other installation");
            using (var held = store.TryAcquireLauncherLock())
            {
                Check(held is not null, "launcher lock obtained");
                Check(new RecoveryStore(install, temporary).TryAcquireLauncherLock() is null, "second launcher excluded");
                using var independent = store.TryAcquireCheckLock();
                Check(independent is not null, "check lock is independent");
            }
            using (var acquired = store.TryAcquireLauncherLock()) Check(acquired is not null, "launcher lock released on disposal");
            store.WritePolicyState(state);
            store.WritePolicyState(new RecoveryPolicyState(), "child");
            Check(store.ReadPolicyState()?.Attempts.Length == 4, "external policy survives restart");
            Check(store.ReadPolicyState("child")?.Attempts.Length == 0, "child policy does not overwrite external attempts");
            File.WriteAllText(Path.Combine(store.DirectoryPath, "intent.json"), "{\"schemaVersion\":2,\"desiredRunning\":true,\"updatedAt\":\"2026-10-28T01:00:00Z\"}");
            Reject(() => store.ReadIntent(), "unknown intent schema");
            File.WriteAllText(Path.Combine(store.DirectoryPath, "intent.json"), new string(' ', 65537));
            Reject(() => store.ReadIntent(), "oversize intent");
            File.WriteAllText(Path.Combine(store.DirectoryPath, "intent.json"), "{}");
            Reject(() => store.ReadIntent(), "missing intent timestamp");
            File.WriteAllText(Path.Combine(store.DirectoryPath, "intent.json"), "{\"desiredRunning\":true,\"updatedAt\":\"2026-10-28T01:00:00Z\"}");
            Reject(() => store.ReadIntent(), "missing explicit schema");
            File.WriteAllText(Path.Combine(store.DirectoryPath, "intent.json"), "{\"schemaVersion\":1,\"desiredRunning\":false,\"DesiredRunning\":true,\"updatedAt\":\"2026-10-28T01:00:00Z\"}");
            Reject(() => store.ReadIntent(), "duplicate case-insensitive fields");
            using var current = Process.GetCurrentProcess();
            var identity = RecoveryIdentity.Capture(current.Id);
            Check(RecoveryIdentity.ProcessMatches(identity, identity.ExecutablePath), "current process identity verified without inference");
            Check(!RecoveryIdentity.ProcessMatches(identity with { StartedAtUtc = identity.StartedAtUtc.AddSeconds(-1) }, identity.ExecutablePath), "PID reuse or birth mismatch rejected");
            Check(!RecoveryIdentity.ProcessMatches(identity, Path.Combine(temporary, "other.exe")), "wrong executable rejected");
            Check(identity.UserSid == WindowsIdentity.GetCurrent().User?.Value, "process owner matches current user");
            using (var listener = new TcpListener(IPAddress.Loopback, 0))
            {
                listener.Start();
                var port = ((IPEndPoint)listener.LocalEndpoint).Port;
                var owner = RecoveryIdentity.InspectLoopbackListener(port);
                Check(owner.Known && owner.LoopbackOnly && owner.Pid == current.Id, "Windows TCP table verifies an owned isolated loopback listener");
                listener.Stop();
                Check(RecoveryIdentity.InspectLoopbackListener(port).Pid is null, "closed listener is not retained as available");
            }
            using (var listener = new TcpListener(IPAddress.Any, 0))
            {
                listener.Start();
                var port = ((IPEndPoint)listener.LocalEndpoint).Port;
                Check(!RecoveryIdentity.InspectLoopbackListener(port).Known, "wildcard listener is not trusted as loopback-only");
            }
            var capability = "private-capability-not-for-logs";
            store.WriteSession(new RecoverySession { InstallRoot = install, Launcher = identity, Capability = capability, UpdatedAt = time });
            Check(store.ReadSession()?.Capability == capability, "private session capability survives atomic storage");
            Check(!store.ReadSession()!.ToString().Contains(capability, StringComparison.Ordinal), "record formatting never exposes the capability");
            Check(!RecoveryIdentity.ValidateSession(store.ReadSession()!, install, "server.js", 8770), "missing runner cannot be adopted");
        }
        finally { if (Directory.Exists(temporary)) Directory.Delete(temporary, true); }
        return checks;
    }
}
