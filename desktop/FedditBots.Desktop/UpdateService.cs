using System.IO.Compression;
using System.Net.Http.Json;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed class UpdateService
{
    private readonly AppPaths _paths;
    private readonly DesktopConfig _config;
    private readonly AppLog _log;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMinutes(45) };

    public UpdateService(AppPaths paths, DesktopConfig config, AppLog log)
    {
        _paths = paths;
        _config = config;
        _log = log;
    }

    public async Task<VersionPointer?> CheckAndStageAsync(VersionPointer current, CancellationToken cancellationToken)
    {
        if (!_config.AutoUpdate || string.IsNullOrWhiteSpace(_config.UpdateManifestUrl)) return null;
        if (!Uri.TryCreate(_config.UpdateManifestUrl, UriKind.Absolute, out var manifestUri) || manifestUri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidDataException("The update manifest URL must use HTTPS.");

        var manifest = await _http.GetFromJsonAsync<UpdateManifest>(manifestUri, JsonDefaults.Options, cancellationToken)
            ?? throw new InvalidDataException("The update manifest was empty.");
        UpdateSecurity.ValidateManifest(manifest, _config.UpdatePublicKeyPem, LauncherVersion());
        if (UpdateSecurity.CompareVersions(manifest.Version, current.Version) <= 0) return null;

        var finalDirectory = SafeVersionDirectory(manifest.Version);
        if (!PayloadIsComplete(finalDirectory))
            await DownloadAndExtractAsync(manifestUri, manifest, finalDirectory, cancellationToken);

        var pointer = new VersionPointer
        {
            Version = manifest.Version,
            RelativePath = Path.GetRelativePath(_paths.InstallRoot, finalDirectory),
        };
        WritePointer(_paths.PendingFile, pointer);
        _log.Write("Staged signed update " + manifest.Version + ".");
        return pointer;
    }

    public VersionPointer? ReadPending()
    {
        if (!File.Exists(_paths.PendingFile)) return null;
        try
        {
            var pending = _paths.ReadPointer(_paths.PendingFile);
            return PayloadIsComplete(_paths.ResolvePayload(pending)) ? pending : null;
        }
        catch (Exception error)
        {
            _log.Write("Ignoring invalid pending update: " + error.Message);
            return null;
        }
    }

    public void Activate(VersionPointer pending)
    {
        _paths.WriteCurrent(pending);
        File.Delete(_paths.PendingFile);
        _log.Write("Activated update " + pending.Version + ".");
    }

    public void DiscardPending()
    {
        if (File.Exists(_paths.PendingFile)) File.Delete(_paths.PendingFile);
    }

    private async Task DownloadAndExtractAsync(
        Uri manifestUri,
        UpdateManifest manifest,
        string finalDirectory,
        CancellationToken cancellationToken)
    {
        var packageUri = new Uri(manifestUri, manifest.PackageUrl);
        if (packageUri.Scheme != Uri.UriSchemeHttps) throw new InvalidDataException("The update package URL must use HTTPS.");

        var packageFile = Path.Combine(_paths.UpdatesRoot, "feddit-bots-" + manifest.Version + ".zip");
        var downloadFile = packageFile + ".download";
        using (var response = await _http.GetAsync(packageUri, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
        {
            response.EnsureSuccessStatusCode();
            await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using var output = new FileStream(downloadFile, FileMode.Create, FileAccess.Write, FileShare.None);
            await input.CopyToAsync(output, cancellationToken);
        }
        File.Move(downloadFile, packageFile, true);

        await using (var stream = File.OpenRead(packageFile))
        {
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken));
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(actual),
                    Encoding.ASCII.GetBytes(manifest.Sha256.ToUpperInvariant())))
                throw new InvalidDataException("The downloaded update did not match its signed SHA-256 digest.");
        }

        var staging = finalDirectory + ".staging";
        SafeDeleteDirectory(staging);
        Directory.CreateDirectory(staging);
        try
        {
            ExtractSafely(packageFile, staging);
            if (!PayloadIsComplete(staging)) throw new InvalidDataException("The update package has no app/server.js.");
            if (Directory.Exists(finalDirectory)) SafeDeleteDirectory(finalDirectory);
            Directory.Move(staging, finalDirectory);
        }
        catch
        {
            SafeDeleteDirectory(staging);
            throw;
        }
    }

    private string SafeVersionDirectory(string version)
    {
        if (!Version.TryParse(version, out _)) throw new InvalidDataException("Update versions must be numeric dotted versions.");
        var directory = Path.GetFullPath(Path.Combine(_paths.VersionsRoot, version));
        var prefix = Path.GetFullPath(_paths.VersionsRoot) + Path.DirectorySeparatorChar;
        if (!directory.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The update version leaves the versions directory.");
        return directory;
    }

    private void SafeDeleteDirectory(string directory)
    {
        var full = Path.GetFullPath(directory);
        var prefix = Path.GetFullPath(_paths.VersionsRoot) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Refusing to delete outside the versions directory.");
        if (Directory.Exists(full)) Directory.Delete(full, true);
    }

    internal static void ExtractSafely(string zipFile, string destination)
    {
        var root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
        using var archive = ZipFile.OpenRead(zipFile);
        foreach (var entry in archive.Entries)
        {
            var unixType = (entry.ExternalAttributes >> 16) & 0xF000;
            if (unixType == 0xA000) throw new InvalidDataException("Update packages may not contain symbolic links.");
            var output = Path.GetFullPath(Path.Combine(destination, entry.FullName));
            if (!output.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The update package contains an unsafe path.");
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(output);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            entry.ExtractToFile(output, true);
        }
    }

    internal static bool PayloadIsComplete(string directory) =>
        File.Exists(Path.Combine(directory, "app", "server.js"));

    private static string LauncherVersion() =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    private static void WritePointer(string file, VersionPointer pointer)
    {
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(pointer, JsonDefaults.Options));
        File.Move(temp, file, true);
    }
}

internal static class UpdateSecurity
{
    public static void ValidateManifest(UpdateManifest manifest, string publicKeyPem, string launcherVersion)
    {
        if (!Version.TryParse(manifest.Version, out _)) throw new InvalidDataException("Invalid update version.");
        if (!Version.TryParse(manifest.MinLauncherVersion, out _)) throw new InvalidDataException("Invalid minimum launcher version.");
        if (CompareVersions(launcherVersion, manifest.MinLauncherVersion) < 0)
            throw new InvalidDataException("This update needs a newer Feddit Bots launcher.");
        if (manifest.Sha256.Length != 64 || !manifest.Sha256.All(Uri.IsHexDigit))
            throw new InvalidDataException("Invalid update SHA-256 digest.");
        if (string.IsNullOrWhiteSpace(publicKeyPem)) throw new InvalidDataException("No update signing public key is configured.");

        byte[] signature;
        try { signature = Convert.FromBase64String(manifest.Signature); }
        catch (FormatException) { throw new InvalidDataException("Invalid update signature encoding."); }
        using var key = ECDsa.Create();
        key.ImportFromPem(publicKeyPem);
        var valid = key.VerifyData(
            Encoding.UTF8.GetBytes(manifest.CanonicalText),
            signature,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);
        if (!valid) throw new InvalidDataException("The update signature is not valid.");
    }

    public static int CompareVersions(string left, string right)
    {
        if (!Version.TryParse(left, out var a) || !Version.TryParse(right, out var b))
            throw new InvalidDataException("Versions must use numeric dotted notation.");
        return a.CompareTo(b);
    }
}
