namespace DabbleLabs.FedditBots.Desktop;

internal static class LaunchIntent
{
    public static bool ShouldOpenInterface(IEnumerable<string> arguments)
    {
        return arguments.Any(argument =>
            string.Equals(argument, "--open-ui", StringComparison.OrdinalIgnoreCase));
    }
}
