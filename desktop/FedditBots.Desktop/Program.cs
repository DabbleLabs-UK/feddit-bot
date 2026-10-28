using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Windows.Forms;

namespace DabbleLabs.FedditBots.Desktop;

internal static class Program
{
    [STAThread]
    private static async Task Main(string[] args)
    {
        var shouldOpenInterface = LaunchIntent.ShouldOpenInterface(args);
        var recoveryCheck = args.Contains("--recovery-check", StringComparer.OrdinalIgnoreCase);
        var rootArgument = Array.FindIndex(args, value => value == "--install-root");
        var paths = new AppPaths(recoveryCheck && rootArgument >= 0 && rootArgument + 1 < args.Length
            ? args[rootArgument + 1] : null);
        var config = DesktopConfig.Load(paths.ConfigFile);
        if (recoveryCheck)
        {
            try
            {
                var checkLog = new AppLog(Path.Combine(paths.UserRoot, "supervision", "logs"));
                var pinned = new RecoveryStore(paths.InstallRoot, paths.UserRoot).ReadConfig();
                if (pinned?.Enabled == true && RecoveryCheck.Hash(Environment.ProcessPath!) != pinned.LauncherSha256)
                    throw new InvalidDataException("Recovery helper hash mismatch.");
                Environment.ExitCode = await RecoveryCheck.RunAsync(paths, config, checkLog, CancellationToken.None);
            }
            catch (Exception error)
            {
                new AppLog(Path.Combine(paths.UserRoot, "supervision", "logs"))
                    .Write("Recovery check failed closed: " + error.GetType().Name + ".");
                Environment.ExitCode = 2;
            }
            return;
        }
        var recovery = new RecoveryStore(paths.InstallRoot, paths.UserRoot);
        recovery.InitializePrivateDirectory();
        var automaticStart = args.Any(value => value is "--background" or "--recovery-start");
        var intent = recovery.ReadIntent();
        if (automaticStart && intent?.DesiredRunning == false) return;
        if (!automaticStart || intent is null)
            recovery.WriteIntent(new RecoveryIntent { DesiredRunning = true, UpdatedAt = DateTimeOffset.UtcNow });
        RecoveryCheck.ApplyRuntimeEnvironment(recovery.ReadConfig());
        using var instance = recovery.TryAcquireLauncherLock();
        if (instance is null)
        {
            if (shouldOpenInterface) OpenExisting(config.Port);
            return;
        }

        paths.EnsureDirectories();
        var log = new AppLog(paths.LogsRoot);
        if (RecoveryCheck.FindProcesses(Path.Combine(paths.InstallRoot, "FedditBots.Desktop.exe"), Environment.ProcessId).Count != 0)
        {
            log.Write("Launcher start held: another existing launcher has not adopted the exclusive identity boundary.");
            return;
        }
        using var cancellation = new CancellationTokenSource();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => cancellation.Cancel();
        var updater = new UpdateService(paths, config, log);
        using var supervisor = new RunnerSupervisor(paths, config, log, recovery);
        TrayIconController? trayIcon = null;
        var lastHealthy = false;

        VersionPointer current = paths.ReadCurrent(config);
        try
        {
            ProvisionRuntime(paths, config, log, cancellation.Token);
            current = paths.ReadCurrent(config);
            var pending = updater.ReadPending();
            if (pending is not null && UpdateSecurity.CompareVersions(pending.Version, current.Version) > 0)
            {
                if (recovery.ReadIntent()?.DesiredRunning != true) return;
                var previous = current;
                updater.Activate(pending);
                try
                {
                    await supervisor.StartAsync(pending, cancellation.Token);
                    current = pending;
                }
                catch (Exception updateError)
                {
                    if (recovery.ReadIntent()?.DesiredRunning != true)
                    {
                        // A deliberate stop is not a failed update. Keep the
                        // activated pointer and never launch a rollback child.
                        current = pending;
                        throw;
                    }
                    log.Write("Pending update failed health check: " + updateError.Message);
                    if (!await supervisor.StopFailedCandidateAsync(cancellation.Token))
                    {
                        current = pending;
                        throw new InvalidOperationException("Unhealthy candidate is still alive; rollback waits for verified safe shutdown.");
                    }
                    paths.WriteCurrent(previous);
                    updater.DiscardPending();
                    await supervisor.StartAsync(previous, cancellation.Token);
                    current = previous;
                }
            }
            else
            {
                await supervisor.StartAsync(current, cancellation.Token);
            }
            lastHealthy = true;
            if (shouldOpenInterface)
            {
                supervisor.OpenBrowser();
            }
            else
            {
                log.Write("Feddit Bots started in the background; the browser was not opened.");
            }
        }
        catch (Exception error)
        {
            log.Write("Startup failed: " + error);
            if (shouldOpenInterface) MessageBox.Show(
                "Feddit Bots could not start.\n\n" + error.Message + "\n\nLog: " + Path.Combine(paths.LogsRoot, "desktop.log"),
                "Feddit Bots",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            if (supervisor.RunnerExited) return;
            current = paths.ReadCurrent(config);
            log.Write("Live unverified runner retained for safe recovery; no process was killed.");
        }

        trayIcon = new TrayIconController(supervisor.OpenBrowser, () =>
            recovery.WriteIntent(new RecoveryIntent { DesiredRunning = false, UpdatedAt = DateTimeOffset.UtcNow }));
        using var trayIconLifetime = trayIcon;
        var nextUpdateCheck = DateTimeOffset.UtcNow + TimeSpan.FromMinutes(1);
        var nextHealthCheck = DateTimeOffset.UtcNow;
        var nextStopLog = DateTimeOffset.MinValue;
        while (!cancellation.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(10), cancellation.Token);
                if (recovery.ReadIntent()?.DesiredRunning != true)
                {
                    // Deliberate Exit survives recovery/login. Never rewrite
                    // the saved pause, and never kill active bot work.
                    if (await supervisor.StopWhenIdleAsync(TimeSpan.FromSeconds(5), cancellation.Token)) break;
                    if (DateTimeOffset.UtcNow >= nextStopLog)
                    {
                        log.Write("Manual exit is waiting for the runner's authenticated safe idle boundary.");
                        nextStopLog = DateTimeOffset.UtcNow.AddMinutes(2);
                    }
                    continue;
                }
                trayIcon.SetStopping(false);
                if (DateTimeOffset.UtcNow >= nextHealthCheck)
                {
                    nextHealthCheck = DateTimeOffset.UtcNow.AddMinutes(1);
                    lastHealthy = await RecoveryCheck.CheckOwnedChildAsync(paths, current, recovery, supervisor, log, cancellation.Token);
                }
                if (!lastHealthy || supervisor.RunnerExited) continue;

                // A developer-staged update may appear at any time, so inspect
                // the local pending pointer on every supervisor pass. Only the
                // HTTPS manifest fetch follows the slower configured interval.
                VersionPointer? pending = updater.ReadPending();
                if (pending is null && DateTimeOffset.UtcNow >= nextUpdateCheck)
                {
                    nextUpdateCheck = DateTimeOffset.UtcNow + TimeSpan.FromHours(Math.Clamp(config.UpdateCheckHours, 1, 168));
                    try
                    {
                        pending = await updater.CheckAndStageAsync(current, cancellation.Token);
                    }
                    catch (Exception updateError)
                    {
                        log.Write("Automatic update check failed safely: " + updateError.Message);
                        continue;
                    }
                }
                if (pending is null || UpdateSecurity.CompareVersions(pending.Version, current.Version) <= 0) continue;

                // Never cut through a model response or scheduled post. The
                // server rechecks idleness while accepting the shutdown call.
                if (!await supervisor.StopWhenIdleAsync(TimeSpan.FromMinutes(30), cancellation.Token))
                {
                    log.Write("Update remains staged because the runner did not reach a safe idle point.");
                    continue;
                }
                if (recovery.ReadIntent()?.DesiredRunning != true) break;

                var previous = current;
                updater.Activate(pending);
                try
                {
                    await supervisor.StartAsync(pending, cancellation.Token);
                    current = pending;
                    log.Write("Automatic update to " + current.Version + " completed.");
                }
                catch (Exception updateError)
                {
                    if (recovery.ReadIntent()?.DesiredRunning != true)
                    {
                        current = pending;
                        continue;
                    }
                    log.Write("Updated runner was unhealthy; rolling back: " + updateError.Message);
                    if (!await supervisor.StopFailedCandidateAsync(cancellation.Token))
                    {
                        current = pending;
                        lastHealthy = false;
                        throw new InvalidOperationException("Updated runner remains alive; unsafe rollback was suppressed.");
                    }
                    paths.WriteCurrent(previous);
                    updater.DiscardPending();
                    await supervisor.StartAsync(previous, cancellation.Token);
                    current = previous;
                }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                log.Write("Desktop supervisor recovered from an error: " + error);
                await Task.Delay(TimeSpan.FromSeconds(30));
            }
        }
    }

    private static void ProvisionRuntime(AppPaths paths, DesktopConfig config, AppLog log, CancellationToken cancellationToken)
    {
        Exception? failure = null;
        using var preparing = new PreparingForm();
        var provisioner = new RuntimeProvisioner(paths, config, log);

        preparing.Shown += (_, _) =>
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    await provisioner.EnsureOllamaAsync(preparing.SetMessage, cancellationToken);
                }
                catch (Exception error)
                {
                    failure = error;
                }
                finally
                {
                    preparing.Complete();
                }
            });
        };

        Application.Run(preparing);
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private static void OpenExisting(int port)
    {
        var url = "http://127.0.0.1:" + port + "/";
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
