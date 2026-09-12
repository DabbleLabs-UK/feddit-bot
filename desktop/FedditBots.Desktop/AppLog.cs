namespace DabbleLabs.FedditBots.Desktop;

internal sealed class AppLog
{
    private readonly string _file;
    private readonly object _gate = new();

    public AppLog(string logsRoot)
    {
        Directory.CreateDirectory(logsRoot);
        _file = Path.Combine(logsRoot, "desktop.log");
    }

    public void Write(string message)
    {
        try
        {
            lock (_gate)
            {
                if (File.Exists(_file) && new FileInfo(_file).Length > 5 * 1024 * 1024)
                {
                    var old = _file + ".old";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(_file, old);
                }
                File.AppendAllText(_file, DateTimeOffset.Now.ToString("O") + " " + message + Environment.NewLine);
            }
        }
        catch
        {
            // Logging must never take down a continuously running bot.
        }
    }
}
