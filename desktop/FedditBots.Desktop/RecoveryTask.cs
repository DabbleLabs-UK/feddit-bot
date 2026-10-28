using System.Runtime.InteropServices;
using System.Security.Principal;

namespace DabbleLabs.FedditBots.Desktop;

internal static class RecoveryTask
{
    internal static string ApplicationName => "Feddit Bots application - " + WindowsIdentity.GetCurrent().User!.Value;
    internal static string CheckName => "Feddit Bots self-recovery - " + WindowsIdentity.GetCurrent().User!.Value;

    internal static void StartApplication(AppPaths paths)
    {
        // A separate on-demand task is deliberately outside the short probe's
        // job. Its 45-second execution limit must never kill the application.
        var objects = new List<object>();
        try
        {
            dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")!)!;
            objects.Add(service);
            service.Connect();
            dynamic folder = service.GetFolder("\\"); objects.Add(folder);
            dynamic task = folder.GetTask(ApplicationName); objects.Add(task);
            dynamic definition = task.Definition; objects.Add(definition);
            dynamic actions = definition.Actions; objects.Add(actions);
            if (actions.Count != 1) throw new InvalidDataException("Recovery application task action is ambiguous.");
            dynamic action = actions[1]; objects.Add(action);
            dynamic principal = definition.Principal; objects.Add(principal);
            dynamic settings = definition.Settings; objects.Add(settings);
            var sid = new SecurityIdentifier(WindowsIdentity.GetCurrent().User!.Value);
            var configuredUser = (string)principal.UserId;
            var actualSid = configuredUser.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase)
                ? new SecurityIdentifier(configuredUser) : (SecurityIdentifier)new NTAccount(configuredUser).Translate(typeof(SecurityIdentifier));
            if (!RecoveryStore.SamePath((string)action.Path, Path.Combine(paths.InstallRoot, "FedditBots.Desktop.exe")) ||
                (string)action.Arguments != "--recovery-start" || !RecoveryStore.SamePath((string)action.WorkingDirectory, paths.InstallRoot) ||
                !sid.Equals(actualSid) || (int)principal.LogonType != 3 || (int)principal.RunLevel != 0 ||
                (int)settings.MultipleInstances != 2 || (string)settings.ExecutionTimeLimit != "PT0S")
                throw new InvalidDataException("Recovery application task differs from its bounded same-user contract.");
            dynamic running = task.Run(null); objects.Add(running);
        }
        finally
        {
            foreach (var value in Enumerable.Reverse(objects))
                if (Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }
    }
}
