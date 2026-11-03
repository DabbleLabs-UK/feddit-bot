using System.Drawing;

namespace DabbleLabs.FedditBots.Desktop;

internal static class AppBranding
{
    internal const string IconResource = "DabbleLabs.FedditBots.Desktop.app.ico";

    internal static Icon CreateIcon()
    {
        using var stream = typeof(AppBranding).Assembly.GetManifestResourceStream(IconResource)
            ?? throw new InvalidDataException("The bundled Feddit Bots icon is missing.");
        using var icon = new Icon(stream, new Size(32, 32));
        return (Icon)icon.Clone();
    }
}
