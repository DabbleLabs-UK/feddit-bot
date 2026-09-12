using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed class RunnerSupervisor : IDisposable
{
    private readonly AppPaths _paths;
    private readonly DesktopConfig _config;
    private readonly AppLog _log;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(4) };
    private readonly string _controlKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private Process? _runner;
    private Process? _ollama;

    public RunnerSupervisor(AppPaths paths, DesktopConfig config, AppLog log)
    {
        _paths = paths;
        _config = config;
        _log = log;
    }

    public bool RunnerExited => _runner is null || _runner.HasExited;
    public string BrowserUrl => "http://127.0.0.1:" + _config.Port + "/";

    public async Task StartAsync(VersionPointer pointer, CancellationToken cancellationToken)
    {
        var payload = _paths.ResolvePayload(pointer);
        ValidatePayload(payload);
        await EnsureOllamaAsync(payload, cancellationToken);

        var node = Path.Combine(_paths.InstallRoot, "runtime", "node", "node.exe");
        var server = Path.Combine(payload, "app", "server.js");
        var start = new ProcessStartInfo(node)
        {
            WorkingDirectory = Path.GetDirectoryName(server)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(server);
        start.Environment["FEDDIT_BOT_DATA_DIR"] = _paths.DataRoot;
        start.Environment["FEDDIT_BOT_HOST"] = "127.0.0.1";
        start.Environment["FEDDIT_BOT_PORT"] = _config.Port.ToString();
        start.Environment["FEDDIT_BOT_PLACEMENT"] = "desktop";
        start.Environment["FEDDIT_DEFAULT_MODEL"] = _config.DefaultModel;
        start.Environment["FEDDIT_DESKTOP_CONTROL_KEY"] = _controlKey;
        start.Environment["FEDDIT_APP_VERSION"] = pointer.Version;
        start.Environment["OLLAMA_BASE"] = "http://127.0.0.1:11434";

        _runner = StartLoggedProcess(start, "runner");
        if (!await WaitForHealthAsync(pointer.Version, TimeSpan.FromSeconds(45), cancellationToken))
            throw new InvalidOperationException("The bot runner did not become healthy after starting version " + pointer.Version + ".");
        _log.Write("Runner version " + pointer.Version + " is healthy.");
    }

    public void OpenBrowser()
    {
        Process.Start(new ProcessStartInfo(BrowserUrl) { UseShellExecute = true });
    }

    public async Task<bool> StopWhenIdleAsync(TimeSpan maximumWait, CancellationToken cancellationToken)
    {
        if (_runner is null || _runner.HasExited) return true;
        var deadline = DateTimeOffset.UtcNow + maximumWait;
        while (DateTimeOffset.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
        {
            try
            {
                var json = await _http.GetStringAsync(BrowserUrl + "api/runtime-state", cancellationToken);
                using var document = JsonDocument.Parse(json);
                var busy = document.RootElement.TryGetProperty("busy", out var value) && value.GetBoolean();
                if (!busy)
                {
                    using var request = new HttpRequestMessage(HttpMethod.Post, BrowserUrl + "api/desktop/shutdown");
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _controlKey);
                    using var response = await _http.SendAsync(request, cancellationToken);
                    if (response.IsSuccessStatusCode)
                    {
                        await _runner.WaitForExitAsync(cancellationToken).WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);
                        _log.Write("Runner stopped at a safe idle point for an update.");
                        return true;
                    }
                }
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                _log.Write("Waiting for runner idle state: " + error.Message);
            }
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
        }
        return false;
    }

    public void StopFailedCandidate()
    {
        if (_runner is null || _runner.HasExited) return;
        _log.Write("Stopping an unhealthy update candidate before rollback.");
        _runner.Kill(true);
        _runner.WaitForExit(10000);
    }

    private async Task EnsureOllamaAsync(string payload, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _http.GetAsync("http://127.0.0.1:11434/api/tags", cancellationToken);
            if (response.IsSuccessStatusCode)
            {
                _log.Write("Using the Ollama service already running on this computer.");
                return;
            }
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            _log.Write("No existing Ollama service responded: " + error.Message);
        }

        var executable = Path.Combine(_paths.InstallRoot, "runtime", "ollama", "ollama.exe");
        var start = new ProcessStartInfo(executable)
        {
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("serve");
        start.Environment["OLLAMA_HOST"] = "127.0.0.1:11434";
        start.Environment["OLLAMA_MODELS"] = _paths.ModelsRoot;
        _ollama = StartLoggedProcess(start, "ollama");

        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(45);
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_ollama.HasExited) throw new InvalidOperationException("The bundled Ollama service exited while starting.");
            try
            {
                using var response = await _http.GetAsync("http://127.0.0.1:11434/api/tags", cancellationToken);
                if (response.IsSuccessStatusCode) return;
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                _log.Write("Waiting for Ollama: " + error.Message);
            }
            await Task.Delay(1000, cancellationToken);
        }
        throw new InvalidOperationException("The bundled Ollama service did not start within 45 seconds.");
    }

    private async Task<bool> WaitForHealthAsync(string expectedVersion, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_runner is null || _runner.HasExited) return false;
            try
            {
                var json = await _http.GetStringAsync(BrowserUrl + "api/runtime", cancellationToken);
                using var document = JsonDocument.Parse(json);
                var version = document.RootElement.GetProperty("appVersion").GetString();
                if (version == expectedVersion) return true;
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                _log.Write("Waiting for runner health: " + error.Message);
            }
            await Task.Delay(750, cancellationToken);
        }
        return false;
    }

    private Process StartLoggedProcess(ProcessStartInfo start, string name)
    {
        var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, args) => { if (args.Data is not null) _log.Write(name + ": " + args.Data); };
        process.ErrorDataReceived += (_, args) => { if (args.Data is not null) _log.Write(name + " error: " + args.Data); };
        process.Exited += (_, _) => _log.Write(name + " exited with code " + process.ExitCode + ".");
        if (!process.Start()) throw new InvalidOperationException("Could not start " + name + ".");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static void ValidatePayload(string payload)
    {
        var required = new[]
        {
            Path.Combine(payload, "app", "server.js"),
        };
        var missing = required.FirstOrDefault(file => !File.Exists(file));
        if (missing is not null) throw new FileNotFoundException("The desktop payload is incomplete.", missing);
    }

    public void Dispose()
    {
        _http.Dispose();
        _runner?.Dispose();
        _ollama?.Dispose();
    }
}
