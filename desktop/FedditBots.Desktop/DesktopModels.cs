using System.Text.Json;
using System.Text.Json.Serialization;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed record DesktopConfig
{
    public string InitialVersion { get; init; } = "0.1.0";
    public string DefaultModel { get; init; } = "qwen3:4b";
    public int Port { get; init; } = 8770;
    public bool AutoUpdate { get; init; }
    public int UpdateCheckHours { get; init; } = 6;
    public string UpdateManifestUrl { get; init; } = "";
    public string UpdatePublicKeyPem { get; init; } = "";
    public string OllamaPackageSha256 { get; init; } = "";

    public static DesktopConfig Load(string file)
    {
        if (!File.Exists(file)) return new DesktopConfig();
        var parsed = JsonSerializer.Deserialize<DesktopConfig>(File.ReadAllText(file), JsonDefaults.Options);
        return parsed ?? new DesktopConfig();
    }
}

internal sealed record VersionPointer
{
    public required string Version { get; init; }
    public required string RelativePath { get; init; }
}

internal sealed record UpdateManifest
{
    public required string Version { get; init; }
    public required string PackageUrl { get; init; }
    public required string Sha256 { get; init; }
    public required string Signature { get; init; }
    public required string MinLauncherVersion { get; init; }
    public required string PublishedAt { get; init; }

    [JsonIgnore]
    public string CanonicalText => string.Join("\n", Version, PackageUrl, Sha256, MinLauncherVersion, PublishedAt);
}

internal static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };
}
