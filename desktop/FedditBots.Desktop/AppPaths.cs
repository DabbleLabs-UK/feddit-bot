using System.Text.Json;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed class AppPaths
{
    public string InstallRoot { get; } = Path.GetFullPath(AppContext.BaseDirectory);
    public string VersionsRoot { get; }
    public string CurrentFile { get; }
    public string PendingFile { get; }
    public string ConfigFile { get; }
    public string UserRoot { get; }
    public string DataRoot { get; }
    public string ModelsRoot { get; }
    public string LogsRoot { get; }
    public string UpdatesRoot { get; }

    public AppPaths()
    {
        VersionsRoot = Path.Combine(InstallRoot, "versions");
        CurrentFile = Path.Combine(InstallRoot, "current.json");
        PendingFile = Path.Combine(InstallRoot, "pending.json");
        ConfigFile = Path.Combine(InstallRoot, "desktop-config.json");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        UserRoot = Path.Combine(local, "DabbleLabs", "FedditBots");
        DataRoot = Path.Combine(UserRoot, "data");
        ModelsRoot = Path.Combine(UserRoot, "models");
        LogsRoot = Path.Combine(UserRoot, "logs");
        UpdatesRoot = Path.Combine(UserRoot, "updates");
    }

    public void EnsureDirectories()
    {
        Directory.CreateDirectory(VersionsRoot);
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(ModelsRoot);
        Directory.CreateDirectory(LogsRoot);
        Directory.CreateDirectory(UpdatesRoot);
    }

    public VersionPointer ReadCurrent(DesktopConfig config)
    {
        if (File.Exists(CurrentFile)) return ReadPointer(CurrentFile);
        var initial = new VersionPointer
        {
            Version = config.InitialVersion,
            RelativePath = Path.Combine("versions", config.InitialVersion),
        };
        WriteCurrent(initial);
        return initial;
    }

    public VersionPointer ReadPointer(string file)
    {
        var pointer = JsonSerializer.Deserialize<VersionPointer>(File.ReadAllText(file), JsonDefaults.Options)
            ?? throw new InvalidDataException("Invalid version pointer: " + file);
        _ = ResolvePayload(pointer);
        return pointer;
    }

    public void WriteCurrent(VersionPointer pointer)
    {
        var temp = CurrentFile + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(pointer, JsonDefaults.Options));
        File.Move(temp, CurrentFile, true);
    }

    public string ResolvePayload(VersionPointer pointer)
    {
        var full = Path.GetFullPath(Path.Combine(InstallRoot, pointer.RelativePath));
        var versionsPrefix = Path.GetFullPath(VersionsRoot) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(versionsPrefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The version pointer leaves the versions directory.");
        return full;
    }
}
