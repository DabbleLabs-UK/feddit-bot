using System.Diagnostics;
using System.Windows.Forms;

namespace DabbleLabs.FedditBots.Desktop;

internal static class Program
{
    [STAThread]
    private static async Task Main()
    {
        var paths = new AppPaths();
        var config = DesktopConfig.Load(paths.ConfigFile);
        using var instance = new Mutex(true, "Local\\DabbleLabs.FedditBots.Desktop", out var firstInstance);
        if (!firstInstance)
        {
            OpenExisting(config.Port);
            return;
        }

        paths.EnsureDirectories();
        var log = new AppLog(paths.LogsRoot);
        using var cancellation = new CancellationTokenSource();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => cancellation.Cancel();
        var updater = new UpdateService(paths, config, log);
        using var supervisor = new RunnerSupervisor(paths, config, log);

        VersionPointer current;
        try
        {
            using (var preparing = new PreparingForm())
            {
                preparing.Show();
                Application.DoEvents();
                var provisioner = new RuntimeProvisioner(paths, config, log);
                await provisioner.EnsureOllamaAsync(preparing.SetMessage, cancellation.Token);
                preparing.Close();
            }
            current = paths.ReadCurrent(config);
            var pending = updater.ReadPending();
            if (pending is not null && UpdateSecurity.CompareVersions(pending.Version, current.Version) > 0)
            {
                var previous = current;
                updater.Activate(pending);
                try
                {
                    await supervisor.StartAsync(pending, cancellation.Token);
                    current = pending;
                }
                catch (Exception updateError)
                {
                    log.Write("Pending update failed health check: " + updateError.Message);
                    supervisor.StopFailedCandidate();
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
            supervisor.OpenBrowser();
        }
        catch (Exception error)
        {
            log.Write("Startup failed: " + error);
            MessageBox.Show(
                "Feddit Bots could not start.\n\n" + error.Message + "\n\nLog: " + Path.Combine(paths.LogsRoot, "desktop.log"),
                "Feddit Bots",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var nextUpdateCheck = DateTimeOffset.UtcNow + TimeSpan.FromMinutes(1);
        while (!cancellation.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(10), cancellation.Token);
                if (supervisor.RunnerExited)
                {
                    log.Write("Restarting the runner after an unexpected exit.");
                    await Task.Delay(TimeSpan.FromSeconds(5), cancellation.Token);
                    await supervisor.StartAsync(current, cancellation.Token);
                }

                if (DateTimeOffset.UtcNow < nextUpdateCheck) continue;
                nextUpdateCheck = DateTimeOffset.UtcNow + TimeSpan.FromHours(Math.Clamp(config.UpdateCheckHours, 1, 168));
                VersionPointer? pending;
                try
                {
                    pending = updater.ReadPending() ?? await updater.CheckAndStageAsync(current, cancellation.Token);
                }
                catch (Exception updateError)
                {
                    log.Write("Automatic update check failed safely: " + updateError.Message);
                    continue;
                }
                if (pending is null || UpdateSecurity.CompareVersions(pending.Version, current.Version) <= 0) continue;

                // Never cut through a model response or scheduled post. The
                // server rechecks idleness while accepting the shutdown call.
                if (!await supervisor.StopWhenIdleAsync(TimeSpan.FromMinutes(30), cancellation.Token))
                {
                    log.Write("Update remains staged because the runner did not reach a safe idle point.");
                    continue;
                }

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
                    log.Write("Updated runner was unhealthy; rolling back: " + updateError.Message);
                    supervisor.StopFailedCandidate();
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

    private static void OpenExisting(int port)
    {
        var url = "http://127.0.0.1:" + port + "/";
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
