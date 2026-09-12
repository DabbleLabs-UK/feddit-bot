using System.Security.Cryptography;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed class RuntimeProvisioner
{
    private readonly AppPaths _paths;
    private readonly DesktopConfig _config;
    private readonly AppLog _log;

    public RuntimeProvisioner(AppPaths paths, DesktopConfig config, AppLog log)
    {
        _paths = paths;
        _config = config;
        _log = log;
    }

    public async Task EnsureOllamaAsync(Action<string>? progress, CancellationToken cancellationToken)
    {
        var runtimeRoot = Path.Combine(_paths.InstallRoot, "runtime");
        var ollamaRoot = Path.Combine(runtimeRoot, "ollama");
        if (File.Exists(Path.Combine(ollamaRoot, "ollama.exe"))) return;

        var package = Path.Combine(runtimeRoot, "ollama-package.zip");
        if (!File.Exists(package))
            throw new FileNotFoundException("The Ollama runtime and its installer package are both missing.", package);
        if (_config.OllamaPackageSha256.Length != 64 || !_config.OllamaPackageSha256.All(Uri.IsHexDigit))
            throw new InvalidDataException("The Ollama package has no valid pinned SHA-256 digest.");

        progress?.Invoke("Checking the bundled local model service...");
        await using (var stream = File.OpenRead(package))
        {
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken));
            if (!CryptographicOperations.FixedTimeEquals(
                    System.Text.Encoding.ASCII.GetBytes(actual),
                    System.Text.Encoding.ASCII.GetBytes(_config.OllamaPackageSha256.ToUpperInvariant())))
                throw new InvalidDataException("The bundled Ollama package did not match its pinned SHA-256 digest.");
        }

        progress?.Invoke("Unpacking the local model service for first use...");
        var staging = Path.Combine(runtimeRoot, "ollama.staging");
        SafeDeleteRuntimeDirectory(staging, runtimeRoot);
        Directory.CreateDirectory(staging);
        try
        {
            UpdateService.ExtractSafely(package, staging);
            if (!File.Exists(Path.Combine(staging, "ollama.exe")))
                throw new InvalidDataException("The Ollama package does not contain ollama.exe.");
            if (Directory.Exists(ollamaRoot)) SafeDeleteRuntimeDirectory(ollamaRoot, runtimeRoot);
            Directory.Move(staging, ollamaRoot);
            File.Delete(package);
            _log.Write("Verified and unpacked the bundled Ollama runtime.");
        }
        catch
        {
            SafeDeleteRuntimeDirectory(staging, runtimeRoot);
            throw;
        }
    }

    private static void SafeDeleteRuntimeDirectory(string directory, string runtimeRoot)
    {
        var full = Path.GetFullPath(directory);
        var prefix = Path.GetFullPath(runtimeRoot) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Refusing to delete outside the app runtime directory.");
        if (Directory.Exists(full)) Directory.Delete(full, true);
    }
}
