using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using DabbleLabs.FedditBots.Desktop;

internal static class RecoveryIntegrationTests
{
    private const string Version = "0.27.13";

    internal static async Task<bool> TryRunFixtureAsync(string[] args)
    {
        if (args.Length == 0 || (args[0] != "--recovery-start" && args[0] != "--fixture-launcher"
            && !args[0].EndsWith("server.js", StringComparison.OrdinalIgnoreCase))) return false;
        var install = Environment.GetEnvironmentVariable("FEDDIT_FIXTURE_INSTALL");
        var user = Environment.GetEnvironmentVariable("FEDDIT_FIXTURE_USER");
        if (string.IsNullOrEmpty(install) || string.IsNullOrEmpty(user))
            throw new InvalidOperationException("A fake process requires explicit isolated fixture paths.");
        var paths = new AppPaths(install, user);
        RecordProcess(paths);
        try
        {
            if (args[0].EndsWith("server.js", StringComparison.OrdinalIgnoreCase)) await RunServerAsync(paths);
            else await RunOwnerAsync(paths);
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(paths.UserRoot, "fixture-error.txt"), error.ToString());
            throw;
        }
        return true;
    }

    internal static async Task<int> RunAsync()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Recovery process tests require Windows.");
        var checks = 0;
        void Check(bool value, string message)
        {
            if (!value) throw new Exception("FAIL recovery process: " + message);
            checks++;
        }

        await using (var fixture = new Fixture(false))
        {
            var initial = fixture.StateHashes();
            await fixture.ExternalCheckAsync();
            Check(fixture.Launchers().Count == 0, "first absent probe observes failure grace without launch");
            fixture.SeedFailure();
            await Task.WhenAll(fixture.ExternalCheckAsync(), fixture.ExternalCheckAsync());
            await fixture.WaitHealthyAsync();
            Check(fixture.Launchers().Count == 1 && fixture.Runners().Count == 1, "absence and concurrent checks restore exactly one owner and child");
            var first = fixture.Store.ReadSession()!;
            Check(await RecoveryCheck.HealthyAsync(fixture.Config.Port, Version, CancellationToken.None), "real loopback runtime and runtime-state probes are healthy");
            await fixture.ExternalCheckAsync();
            await fixture.ExternalCheckAsync();
            Check(fixture.Store.ReadSession()!.Runner!.Pid == first.Runner!.Pid, "healthy repeated checks do not replace the child");

            fixture.Mode("busy");
            await fixture.ExternalCheckAsync();
            await fixture.CommandAsync("check");
            Check(fixture.Store.ReadSession()!.Runner!.Pid == first.Runner.Pid, "healthy busy inference state is not a throughput failure");
            fixture.Mode("versionbad");
            await fixture.CommandAsync("check");
            Check(fixture.Store.ReadSession()!.Runner!.Pid == first.Runner.Pid, "a short health failure does not restart");
            fixture.Mode("healthy");
            await fixture.CommandAsync("check");
            Check(fixture.Store.ReadPolicyState("child")!.ConsecutiveFailures == 0, "healthy recovery clears transient failure history");

            fixture.Mode("versionbad");
            fixture.SeedFailure("child");
            await fixture.CommandAsync("check-aged");
            await fixture.WaitHealthyAsync();
            var recovered = fixture.Store.ReadSession()!;
            Check(recovered.Runner!.Pid != first.Runner.Pid, "persistent unhealthy child recovers through authenticated idle shutdown");
            Check(fixture.Launchers().Count == 1 && fixture.Runners().Count == 1, "child replacement leaves one launcher and one runner");
            Check(File.ReadAllText(Path.Combine(fixture.Paths.DataRoot, "shutdown-authenticated.txt")).Contains(first.Runner.Pid.ToString()), "old child received its private authenticated shutdown capability");

            fixture.Mode("silent");
            fixture.SeedFailure("child");
            await fixture.CommandAsync("check-aged");
            Check(RecoveryIdentity.ProcessMatches(recovered.Runner, fixture.NodePath), "unverifiable safe shutdown never kills a live child");
            Check(fixture.Runners().Count == 1, "quarantined live child is never duplicated");
            Check(fixture.Store.ReadPolicyState("child")!.Attempts.Length == 1, "failed shutdown records one bounded recovery attempt");
            await fixture.CommandAsync("check-aged");
            Check(fixture.Store.ReadPolicyState("child")!.Attempts.Length == 1, "backoff prevents repeated shutdown attempts");
            fixture.Mode("healthy");

            await fixture.ReleaseChildListenerAsync();
            await using (var foreign = new ForeignListener(fixture.Config.Port))
            {
                fixture.SeedFailure("child");
                await fixture.CommandAsync("check-aged");
                Check(RecoveryIdentity.ProcessMatches(recovered.Runner, fixture.NodePath), "live child that lost its listener is not killed");
                Check(foreign.AuthenticatedRequests == 0, "private shutdown capability is never sent to a foreign listener");
                Check(foreign.Requests == 0, "foreign listener is rejected before trusting its idle response");
                Check(fixture.Runners().Count == 1, "foreign listener conflict cannot duplicate a runner");
            }
            fixture.Mode("healthy");

            await fixture.KillTrackedAsync(recovered.Runner);
            await fixture.ExternalCheckAsync();
            Check(fixture.Launchers().Count == 1, "external check defers child-only failure to live owner");
            fixture.SeedFailure("child");
            await fixture.CommandAsync("check-aged");
            await fixture.WaitHealthyAsync();
            var childRecovered = fixture.Store.ReadSession()!;
            Check(childRecovered.Launcher.Pid == recovered.Launcher.Pid && childRecovered.Runner!.Pid != recovered.Runner.Pid, "existing owner alone restores exited child");

            await fixture.KillTrackedAsync(childRecovered.Launcher);
            fixture.SeedFailure();
            await fixture.ExternalCheckAsync();
            await fixture.WaitHealthyAsync();
            var adopted = fixture.Store.ReadSession()!;
            Check(adopted.Launcher.Pid != childRecovered.Launcher.Pid, "external recovery restores missing owner");
            Check(adopted.Runner!.Pid == childRecovered.Runner!.Pid && fixture.Runners().Count == 1, "new owner adopts authenticated orphan without second child");

            await fixture.KillTrackedAsync(adopted.Launcher);
            await fixture.KillTrackedAsync(adopted.Runner);
            fixture.Store.WritePolicyState(new RecoveryPolicyState
            {
                LastProbeAt = DateTimeOffset.UtcNow.AddHours(-2), FailureSince = DateTimeOffset.UtcNow.AddHours(-2), ConsecutiveFailures = 99,
            });
            await fixture.ExternalCheckAsync();
            Check(fixture.Launchers().Count == 0, "resume after stale probes does not immediately restart");
            Check(fixture.Store.ReadPolicyState()!.LastReason == "probe-gap", "sleep/resume resets stale failure history");
            fixture.Store.WriteIntent(new RecoveryIntent { DesiredRunning = false, UpdatedAt = DateTimeOffset.UtcNow });
            fixture.SeedFailure();
            await fixture.ExternalCheckAsync();
            Check(fixture.Launchers().Count == 0, "manual desired-stop suppresses external recovery");
            Check(initial.SequenceEqual(fixture.StateHashes()), "all recovery scenarios leave saved unpaused data and application state byte-identical");
        }

        await using (var paused = new Fixture(true))
        {
            var initial = paused.StateHashes();
            paused.SeedFailure();
            await paused.ExternalCheckAsync();
            await paused.WaitHealthyAsync();
            Check(initial.SequenceEqual(paused.StateHashes()), "saved pause and protected data survive actual recovery byte-identically");
            Check(File.ReadAllText(Path.Combine(paused.Paths.DataRoot, "runtime.json")) == "{\"globalPaused\":true}", "recovered application retains saved pause true");
        }

        await using (var stopping = new Fixture(true))
        {
            var initial = stopping.StateHashes();
            var preparing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var prepared = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            using var supervisor = new RunnerSupervisor(stopping.Paths, stopping.Config, new AppLog(stopping.Paths.LogsRoot), stopping.Store,
                async token =>
                {
                    preparing.SetResult();
                    await prepared.Task.WaitAsync(token);
                });
            var starting = supervisor.StartAsync(stopping.Paths.ReadCurrent(stopping.Config), timeout.Token);
            try
            {
                await preparing.Task.WaitAsync(TimeSpan.FromSeconds(10));
                Check(stopping.Runners().Count == 0, "asynchronous provider preparation has not admitted a child");
                stopping.Store.WriteIntent(new RecoveryIntent { DesiredRunning = false, UpdatedAt = DateTimeOffset.UtcNow });
                prepared.SetResult();
                var refused = false;
                try { await starting; }
                catch (InvalidOperationException error) when (error.Message.Contains("stop request", StringComparison.Ordinal)) { refused = true; }
                Check(refused, "manual stop arriving during preparation refuses the child fork after await");
                Check(stopping.Runners().Count == 0 && stopping.Store.ReadSession() is null, "refused admission creates no node process or launch session");
                Check(stopping.Store.ReadIntent()?.DesiredRunning == false, "manual stop remains persisted after refused preparation");
                Check(initial.SequenceEqual(stopping.StateHashes()), "stop during preparation preserves saved pause and all application data hashes");
            }
            finally { prepared.TrySetResult(); }
        }
        return checks;
    }

    private static void RecordProcess(AppPaths paths)
    {
        var identity = RecoveryIdentity.Capture(Environment.ProcessId);
        File.WriteAllText(Path.Combine(paths.UserRoot, "process-" + identity.Pid + ".json"), JsonSerializer.Serialize(identity, JsonDefaults.Options));
    }

    private static async Task RunOwnerAsync(AppPaths paths)
    {
        var store = new RecoveryStore(paths.InstallRoot, paths.UserRoot);
        using var owner = store.TryAcquireLauncherLock();
        if (owner is null) return;
        var config = DesktopConfig.Load(paths.ConfigFile);
        var pointer = paths.ReadCurrent(config);
        var log = new AppLog(paths.LogsRoot);
        using var supervisor = new RunnerSupervisor(paths, config, log, store, _ => Task.CompletedTask);
        await supervisor.StartAsync(pointer, CancellationToken.None);
        File.WriteAllText(Path.Combine(paths.UserRoot, "owner-ready.txt"), Environment.ProcessId.ToString());
        while (!File.Exists(Path.Combine(paths.UserRoot, "owner-stop.txt")))
        {
            var request = Path.Combine(paths.UserRoot, "owner-command.txt");
            if (File.Exists(request))
            {
                var command = File.ReadAllText(request);
                File.Delete(request);
                var healthy = await RecoveryCheck.CheckOwnedChildAsync(paths, pointer, store, supervisor, log, CancellationToken.None,
                    command == "check-aged" ? DateTimeOffset.UtcNow.AddMinutes(-10) : null);
                File.WriteAllText(Path.Combine(paths.UserRoot, "owner-result.txt"), healthy.ToString());
            }
            await Task.Delay(50);
        }
        await supervisor.StopWhenIdleAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
    }

    private static async Task RunServerAsync(AppPaths paths)
    {
        var port = int.Parse(Environment.GetEnvironmentVariable("FEDDIT_BOT_PORT")!);
        var capability = Environment.GetEnvironmentVariable("FEDDIT_DESKTOP_CONTROL_KEY")!;
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        try
        {
            var done = false;
            while (!done)
            {
                using var client = await listener.AcceptTcpClientAsync();
                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                var request = await reader.ReadLineAsync() ?? "";
                var headers = new List<string>();
                string? line;
                while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync())) headers.Add(line);
                var modePath = Path.Combine(paths.UserRoot, "mode.txt");
                var mode = File.Exists(modePath) ? File.ReadAllText(modePath) : "healthy";
                if (mode == "release")
                {
                    listener.Stop();
                    File.WriteAllText(Path.Combine(paths.UserRoot, "listener-released.txt"), Environment.ProcessId.ToString());
                    await Task.Delay(Timeout.InfiniteTimeSpan);
                }
                if (mode == "silent")
                {
                    // Real accepted TCP requests receive no HTTP acknowledgement.
                    // Longer than the production health probe timeout, not a fake
                    // positive health response or injected HttpClient exception.
                    await Task.Delay(TimeSpan.FromSeconds(5));
                    continue;
                }
                var status = 200;
                var body = "{}";
                if (request.StartsWith("GET /api/runtime-state "))
                {
                    if (mode == "noidle") status = 503;
                    else body = "{\"busy\":" + (mode == "busy" ? "true" : "false") + "}";
                }
                else if (request.StartsWith("GET /api/runtime "))
                    body = "{\"placement\":\"desktop\",\"appVersion\":\"" + (mode is "versionbad" or "noidle" ? "bad" : Version) + "\"}";
                else if (request.StartsWith("POST /api/desktop/shutdown "))
                {
                    var authorized = headers.Any(header => header.Equals("Authorization: Bearer " + capability, StringComparison.Ordinal));
                    if (!authorized) status = 401;
                    else if (mode == "busy") status = 409;
                    else
                    {
                        File.AppendAllText(Path.Combine(paths.DataRoot, "shutdown-authenticated.txt"), Environment.ProcessId + "\n");
                        File.WriteAllText(modePath, "healthy");
                        done = true;
                    }
                }
                else status = 404;
                var bytes = Encoding.UTF8.GetBytes(body);
                var headerBytes = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " Fixture\r\nContent-Type: application/json\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(headerBytes);
                await stream.WriteAsync(bytes);
                await stream.FlushAsync();
            }
        }
        finally { listener.Stop(); }
    }

    private sealed class ForeignListener : IAsyncDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _serving;
        private int _requests;
        private int _authenticatedRequests;
        internal int Requests => Volatile.Read(ref _requests);
        internal int AuthenticatedRequests => Volatile.Read(ref _authenticatedRequests);

        internal ForeignListener(int port)
        {
            _listener = new TcpListener(IPAddress.Loopback, port);
            _listener.Start();
            _serving = ServeAsync();
        }

        private async Task ServeAsync()
        {
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    using var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                    using var stream = client.GetStream();
                    using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                    _ = await reader.ReadLineAsync(_stop.Token);
                    Interlocked.Increment(ref _requests);
                    string? line;
                    while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync(_stop.Token)))
                        if (line.StartsWith("Authorization:", StringComparison.OrdinalIgnoreCase))
                            Interlocked.Increment(ref _authenticatedRequests);
                    var bytes = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"busy\":false}");
                    await stream.WriteAsync(bytes, _stop.Token);
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            catch (SocketException) when (_stop.IsCancellationRequested) { }
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            _listener.Stop();
            await _serving;
            _stop.Dispose();
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string _root;
        private readonly List<ProcessIdentity> _tracked = [];
        internal AppPaths Paths { get; }
        internal DesktopConfig Config { get; }
        internal RecoveryStore Store { get; }
        internal string LauncherPath => Path.Combine(Paths.InstallRoot, "FedditBots.Desktop.exe");
        internal string NodePath => Path.Combine(Paths.InstallRoot, "runtime", "node", "node.exe");

        internal Fixture(bool paused)
        {
            _root = Path.Combine(Path.GetTempPath(), "feddit-recovery-process-" + Guid.NewGuid().ToString("N"));
            Paths = new AppPaths(Path.Combine(_root, "install"), Path.Combine(_root, "user"));
            Paths.EnsureDirectories();
            Directory.CreateDirectory(Path.GetDirectoryName(NodePath)!);
            foreach (var file in Directory.GetFiles(AppContext.BaseDirectory))
            {
                File.Copy(file, Path.Combine(Paths.InstallRoot, Path.GetFileName(file)));
                File.Copy(file, Path.Combine(Path.GetDirectoryName(NodePath)!, Path.GetFileName(file)));
            }
            var apphost = Path.Combine(AppContext.BaseDirectory, "FedditBots.Desktop.Tests.exe");
            File.Copy(apphost, LauncherPath, true);
            File.Copy(apphost, NodePath, true);
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            Config = new DesktopConfig { InitialVersion = Version, Port = port, AutoUpdate = false };
            File.WriteAllText(Paths.ConfigFile, JsonSerializer.Serialize(Config, JsonDefaults.Options));
            var pointer = Paths.ReadCurrent(Config);
            Directory.CreateDirectory(Path.Combine(Paths.ResolvePayload(pointer), "app"));
            File.WriteAllText(Path.Combine(Paths.ResolvePayload(pointer), "app", "server.js"), "fake process only");
            File.WriteAllText(Path.Combine(Paths.DataRoot, "runtime.json"), paused ? "{\"globalPaused\":true}" : "{\"globalPaused\":false}");
            File.WriteAllText(Path.Combine(Paths.DataRoot, "profiles.json"), "{\"profiles\":[{\"id\":\"fixture\",\"enabled\":false}]}");
            File.WriteAllText(Path.Combine(Paths.DataRoot, "importer.json"), "{\"candidates\":[1,2,3],\"stageEvidence\":[\"preserve\"]}");
            File.WriteAllText(Path.Combine(Paths.DataRoot, "theme.json"), "{\"scope\":\"fixture-only\",\"receipts\":[1,2]}");
            Store = new RecoveryStore(Paths.InstallRoot, Paths.UserRoot);
            Store.WriteConfig(new RecoveryConfig { InstallRoot = Paths.InstallRoot, Enabled = true, LauncherSha256 = RecoveryCheck.Hash(LauncherPath) });
            Store.WriteIntent(new RecoveryIntent { DesiredRunning = true, UpdatedAt = DateTimeOffset.UtcNow });
        }

        internal void Mode(string value) => File.WriteAllText(Path.Combine(Paths.UserRoot, "mode.txt"), value);
        internal string[] StateHashes() => Directory.GetFiles(Paths.DataRoot).Where(file => !file.EndsWith("shutdown-authenticated.txt"))
            .OrderBy(file => file, StringComparer.Ordinal).Select(file => Path.GetFileName(file) + ":" + RecoveryCheck.Hash(file)).ToArray();
        internal List<ProcessIdentity> Launchers() => RecoveryCheck.FindProcesses(LauncherPath);
        internal List<ProcessIdentity> Runners() => RecoveryCheck.FindProcesses(NodePath);
        internal void SeedFailure(string scope = "external") => Store.WritePolicyState(new RecoveryPolicyState
        {
            LastProbeAt = DateTimeOffset.UtcNow.AddSeconds(-20), FailureSince = DateTimeOffset.UtcNow.AddMinutes(-4), ConsecutiveFailures = 3,
        }, scope);

        internal Task<int> ExternalCheckAsync() => RecoveryCheck.RunAsync(Paths, Config, new AppLog(Paths.LogsRoot), CancellationToken.None, start =>
        {
            start.Environment["FEDDIT_FIXTURE_INSTALL"] = Paths.InstallRoot;
            start.Environment["FEDDIT_FIXTURE_USER"] = Paths.UserRoot;
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Fake owner did not start.");
            var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
            while (true)
            {
                try { _tracked.Add(RecoveryIdentity.Capture(process.Id)); break; }
                catch (Exception error) when (error is InvalidDataException or System.ComponentModel.Win32Exception)
                {
                    if (process.HasExited || DateTimeOffset.UtcNow >= deadline) throw;
                    Thread.Sleep(50);
                }
            }
        });

        internal async Task WaitHealthyAsync()
        {
            await UntilAsync(async () => await RecoveryCheck.HealthyAsync(Config.Port, Version, CancellationToken.None)
                && Store.ReadSession() is { } session && RecoveryIdentity.ProcessMatches(session.Launcher, LauncherPath)
                && RecoveryIdentity.ValidateSession(session, Paths.InstallRoot,
                    Path.Combine(Paths.ResolvePayload(Paths.ReadCurrent(Config)), "app", "server.js"), Config.Port), "fake owner and child health");
            ReadTracked();
        }

        internal async Task CommandAsync(string command)
        {
            var result = Path.Combine(Paths.UserRoot, "owner-result.txt");
            if (File.Exists(result)) File.Delete(result);
            File.WriteAllText(Path.Combine(Paths.UserRoot, "owner-command.txt"), command);
            await UntilAsync(() =>
            {
                var error = Path.Combine(Paths.UserRoot, "fixture-error.txt");
                if (File.Exists(error)) throw new InvalidOperationException(File.ReadAllText(error));
                return Task.FromResult(File.Exists(result));
            }, "fake owner command " + command);
            ReadTracked();
        }

        internal async Task ReleaseChildListenerAsync()
        {
            Mode("release");
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
            try { await client.GetAsync("http://127.0.0.1:" + Config.Port + "/api/runtime"); }
            catch (TaskCanceledException) { }
            await UntilAsync(() => Task.FromResult(File.Exists(Path.Combine(Paths.UserRoot, "listener-released.txt"))), "fake child listener release");
        }

        private static async Task UntilAsync(Func<Task<bool>> predicate, string phase)
        {
            var deadline = DateTimeOffset.UtcNow.AddSeconds(30);
            while (DateTimeOffset.UtcNow < deadline)
            {
                try { if (await predicate()) return; }
                catch (IOException) { }
                await Task.Delay(100);
            }
            throw new TimeoutException("Timed out during isolated process test: " + phase);
        }

        private void ReadTracked()
        {
            foreach (var file in Directory.GetFiles(Paths.UserRoot, "process-*.json"))
            {
                var identity = JsonSerializer.Deserialize<ProcessIdentity>(File.ReadAllText(file), JsonDefaults.Options)!;
                if (_tracked.All(item => item.Pid != identity.Pid || item.StartedAtUtc != identity.StartedAtUtc)) _tracked.Add(identity);
            }
        }

        internal async Task KillTrackedAsync(ProcessIdentity identity)
        {
            ReadTracked();
            if (!_tracked.Any(item => item == identity)) throw new InvalidOperationException("Only tracked fixture processes may be stopped.");
            if (!RecoveryStore.SamePath(identity.ExecutablePath, LauncherPath) && !RecoveryStore.SamePath(identity.ExecutablePath, NodePath))
                throw new InvalidOperationException("Fixture process leaves its isolated executable roots.");
            if (!RecoveryIdentity.ProcessMatches(identity, identity.ExecutablePath)) return;
            using var process = Process.GetProcessById(identity.Pid);
            process.Kill();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        }

        public async ValueTask DisposeAsync()
        {
            ReadTracked();
            foreach (var identity in _tracked.Where(item => RecoveryStore.SamePath(item.ExecutablePath, LauncherPath)).ToArray())
                await KillTrackedAsync(identity);
            // An owner can start a child just before it exits. Let that exclusively
            // owned fake child record its identity before collecting its cleanup.
            for (var pass = 0; pass < 8; pass++)
            {
                await Task.Delay(250);
                ReadTracked();
                foreach (var identity in _tracked.Where(item => RecoveryStore.SamePath(item.ExecutablePath, LauncherPath)).ToArray())
                    await KillTrackedAsync(identity);
                foreach (var identity in _tracked.Where(item => RecoveryStore.SamePath(item.ExecutablePath, NodePath)).ToArray())
                    await KillTrackedAsync(identity);
                if (Runners().Count == 0) break;
            }
            if (Launchers().Count != 0 || Runners().Count != 0) throw new InvalidOperationException("Fixture cleanup left an owned process alive.");
            var root = Path.GetFullPath(_root);
            var prefix = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!root.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(root).StartsWith("feddit-recovery-process-", StringComparison.Ordinal))
                throw new InvalidOperationException("Refusing cleanup outside the exclusively owned temporary fixture.");
            Directory.Delete(root, true);
        }
    }
}
