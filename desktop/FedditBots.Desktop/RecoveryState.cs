using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed record RecoveryConfig
{
    public int SchemaVersion { get; init; } = 1;
    public bool Enabled { get; init; }
    public required string InstallRoot { get; init; }
    public string LauncherSha256 { get; init; } = "";
    public Dictionary<string, string> RuntimeEnvironment { get; init; } = new(StringComparer.Ordinal);
}

internal sealed record RecoveryIntent
{
    public int SchemaVersion { get; init; } = 1;
    public bool DesiredRunning { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }

}

internal sealed record RecoverySession
{
    public int SchemaVersion { get; init; } = 1;
    public required string InstallRoot { get; init; }
    public required ProcessIdentity Launcher { get; init; }
    public ProcessIdentity? Runner { get; init; }
    public string ServerPath { get; init; } = "";
    public string Capability { get; init; } = "";
    public DateTimeOffset UpdatedAt { get; init; }

    public override string ToString() => "RecoverySession(private)";
}

internal sealed class RecoveryStore
{
    private const int MaximumBytes = 64 * 1024;
    private static readonly HashSet<string> EnvironmentKeys = new(StringComparer.Ordinal)
    {
        "FEDDIT_QUIET_CONVERSATIONS", "FEDDIT_THEME_INTEREST_V1",
        "FEDDIT_THEME_INTEREST_COMMUNITIES", "FEDDIT_QUIET_POPULATION_V2",
    };
    public string InstallRoot { get; }
    public string DirectoryPath { get; }

    public RecoveryStore(string installRoot, string userRoot)
    {
        InstallRoot = Path.GetFullPath(installRoot).TrimEnd(Path.DirectorySeparatorChar);
        DirectoryPath = Path.Combine(Path.GetFullPath(userRoot), "supervision");
    }

    public void InitializePrivateDirectory()
    {
        Directory.CreateDirectory(DirectoryPath);
        if ((File.GetAttributes(DirectoryPath) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Recovery directory must not be a reparse point.");
        var owner = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Missing Windows user identity.");
        var security = new DirectorySecurity();
        security.SetOwner(owner);
        security.SetAccessRuleProtection(true, false);
        var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(DirectoryPath).SetAccessControl(security);
    }

    public RecoveryConfig? ReadConfig() => Read<RecoveryConfig>("config.json", ValidateConfig);
    public RecoveryIntent? ReadIntent() => Read<RecoveryIntent>("intent.json", value =>
    {
        Require(value.SchemaVersion == 1 && IsTimestamp(value.UpdatedAt), "Invalid recovery intent.");
    });
    public RecoverySession? ReadSession() => Read<RecoverySession>("session.json", ValidateSession);
    public RecoveryPolicyState? ReadPolicyState(string scope = "external") => Read<RecoveryPolicyState>(PolicyFile(scope), RecoveryPolicy.Validate);
    public void WriteConfig(RecoveryConfig value) { ValidateConfig(value); Write("config.json", value); }
    public void WriteIntent(RecoveryIntent value)
    {
        Require(value.SchemaVersion == 1 && IsTimestamp(value.UpdatedAt), "Invalid recovery intent.");
        Write("intent.json", value);
    }
    public void WriteSession(RecoverySession value) { ValidateSession(value); Write("session.json", value); }
    public void WritePolicyState(RecoveryPolicyState value, string scope = "external") { RecoveryPolicy.Validate(value); Write(PolicyFile(scope), value); }
    public FileStream? TryAcquireLauncherLock() => TryAcquireLock("launcher.lock");
    public FileStream? TryAcquireCheckLock() => TryAcquireLock("check.lock");

    private FileStream? TryAcquireLock(string name)
    {
        InitializePrivateDirectory();
        try { return new FileStream(Path.Combine(DirectoryPath, name), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33) { return null; }
    }

    private static string PolicyFile(string scope) => scope switch
    {
        "external" => "external-policy.json",
        "child" => "child-policy.json",
        _ => throw new ArgumentException("Unknown recovery policy scope.", nameof(scope)),
    };

    private T? Read<T>(string name, Action<T> validate) where T : class
    {
        var path = Path.Combine(DirectoryPath, name);
        if (!File.Exists(path)) return null;
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Recovery file must not be a reparse point.");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        Require(stream.Length is > 0 and <= MaximumBytes, "Recovery file exceeds its size bound.");
        using var document = JsonDocument.Parse(stream);
        Require(document.RootElement.ValueKind == JsonValueKind.Object
            && document.RootElement.TryGetProperty("schemaVersion", out var schema)
            && schema.TryGetInt32(out var version) && version == 1, "Unknown recovery file schema.");
        Require(document.RootElement.EnumerateObject().Select(item => item.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count()
            == document.RootElement.EnumerateObject().Count(), "Ambiguous recovery file fields.");
        var value = document.Deserialize<T>(JsonDefaults.Options)
            ?? throw new InvalidDataException("Recovery file is empty.");
        validate(value);
        return value;
    }

    private void Write<T>(string name, T value)
    {
        InitializePrivateDirectory();
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, JsonDefaults.Options);
        Require(bytes.Length <= MaximumBytes, "Recovery file exceeds its size bound.");
        var path = Path.Combine(DirectoryPath, name);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(true);
            }
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
            var owner = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Missing Windows user identity.");
            var security = new FileSecurity();
            security.SetOwner(owner);
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(security);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private void ValidateConfig(RecoveryConfig value)
    {
        Require(value.SchemaVersion == 1 && SamePath(value.InstallRoot, InstallRoot), "Recovery configuration does not match this installation.");
        Require(value.LauncherSha256 is not null && ((!value.Enabled && value.LauncherSha256.Length == 0)
            || (value.LauncherSha256.Length == 64 && value.LauncherSha256.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'))), "Invalid recovery launcher hash.");
        if (value.RuntimeEnvironment is null || value.RuntimeEnvironment.Count > EnvironmentKeys.Count)
            throw new InvalidDataException("Invalid recovery environment.");
        foreach (var item in value.RuntimeEnvironment)
            Require(EnvironmentKeys.Contains(item.Key) && item.Value is not null && item.Value.Length <= 512 && !item.Value.Any(char.IsControl), "Unapproved recovery environment field.");
    }

    private void ValidateSession(RecoverySession value)
    {
        Require(value.SchemaVersion == 1 && SamePath(value.InstallRoot, InstallRoot) && IsTimestamp(value.UpdatedAt), "Invalid recovery session.");
        Require(RecoveryIdentity.IsValid(value.Launcher) && (value.Runner is null || RecoveryIdentity.IsValid(value.Runner)), "Invalid recovery process identity.");
        Require(value.ServerPath is not null && value.ServerPath.Length <= 4096 && value.Capability is not null && value.Capability.Length <= 512 && !value.Capability.Any(char.IsControl), "Invalid recovery session fields.");
    }

    internal static bool SamePath(string left, string right) => !string.IsNullOrWhiteSpace(left) && !string.IsNullOrWhiteSpace(right)
        && string.Equals(Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
    internal static bool IsTimestamp(DateTimeOffset value) => value != default && value.Offset == TimeSpan.Zero;
    internal static void Require(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
}
