using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace DabbleLabs.FedditBots.Desktop;

internal sealed record ProcessIdentity
{
    public int Pid { get; init; }
    public DateTimeOffset StartedAtUtc { get; init; }
    public required string ExecutablePath { get; init; }
    public int SessionId { get; init; }
    public required string UserSid { get; init; }
}

internal sealed record ListenerIdentity(bool Known, int? Pid, bool LoopbackOnly, string Reason);

internal static class RecoveryIdentity
{
    private const uint QueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;

    public static ProcessIdentity Capture(int pid)
    {
        using var process = Process.GetProcessById(pid);
        var started = new DateTimeOffset(process.StartTime.ToUniversalTime());
        var executable = process.MainModule?.FileName ?? throw new InvalidDataException("Process executable unavailable.");
        var handle = OpenProcess(QueryLimitedInformation, false, pid);
        if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        string sid;
        try
        {
            if (!OpenProcessToken(handle, TokenQuery, out var token))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                using var identity = new WindowsIdentity(token);
                sid = identity.User?.Value ?? throw new InvalidDataException("Process owner unavailable.");
            }
            finally { CloseHandle(token); }
        }
        finally { CloseHandle(handle); }
        if (process.HasExited || new DateTimeOffset(process.StartTime.ToUniversalTime()) != started)
            throw new InvalidDataException("Process changed during inspection.");
        return new ProcessIdentity { Pid = pid, StartedAtUtc = started, ExecutablePath = Path.GetFullPath(executable), SessionId = process.SessionId, UserSid = sid };
    }

    public static bool ProcessMatches(ProcessIdentity expected, string expectedExecutable)
    {
        if (!IsValid(expected)) return false;
        try
        {
            var actual = Capture(expected.Pid);
            return actual.StartedAtUtc == expected.StartedAtUtc && actual.SessionId == expected.SessionId
                && actual.UserSid == expected.UserSid && actual.UserSid == WindowsIdentity.GetCurrent().User?.Value
                && RecoveryStore.SamePath(actual.ExecutablePath, expectedExecutable)
                && RecoveryStore.SamePath(actual.ExecutablePath, expected.ExecutablePath);
        }
        catch { return false; }
    }

    public static ListenerIdentity InspectLoopbackListener(int port)
    {
        if (port is < 1 or > 65535) return new(false, null, false, "invalid-port");
        try
        {
            var endpoints = new List<(int Pid, bool Loopback)>();
            ReadListeners(2, port, endpoints);
            ReadListeners(23, port, endpoints);
            if (endpoints.Count == 0) return new(true, null, true, "listener-absent");
            var owners = endpoints.Select(item => item.Pid).Distinct().ToArray();
            if (owners.Length != 1 || endpoints.Any(item => !item.Loopback))
                return new(false, null, false, "listener-conflict");
            return new(true, owners[0], true, "listener-owned");
        }
        catch { return new(false, null, false, "listener-unavailable"); }
    }

    public static bool ValidateSession(RecoverySession session, string installRoot, string serverPath, int port)
    {
        if (!RecoveryStore.SamePath(session.InstallRoot, installRoot) || session.Runner is null
            || !RecoveryStore.SamePath(session.ServerPath, serverPath)) return false;
        var node = Path.Combine(installRoot, "runtime", "node", "node.exe");
        if (!ProcessMatches(session.Runner, node)) return false;
        var listener = InspectLoopbackListener(port);
        return listener.Known && listener.LoopbackOnly && listener.Pid == session.Runner.Pid
            && ProcessMatches(session.Runner, node);
    }

    internal static bool IsValid(ProcessIdentity? value) => value is not null && value.Pid > 0 && value.SessionId >= 0
        && RecoveryStore.IsTimestamp(value.StartedAtUtc) && !string.IsNullOrWhiteSpace(value.ExecutablePath)
        && Path.IsPathFullyQualified(value.ExecutablePath) && value.ExecutablePath.Length <= 4096
        && !string.IsNullOrWhiteSpace(value.UserSid) && value.UserSid.Length <= 256;

    private static void ReadListeners(int family, int port, List<(int Pid, bool Loopback)> results)
    {
        var size = 0;
        var error = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 3, 0);
        if (error != 122 && error != 0) throw new InvalidDataException("TCP table unavailable.");
        if (size is < 4 or > 16 * 1024 * 1024) throw new InvalidDataException("TCP table size invalid.");
        var memory = Marshal.AllocHGlobal(size);
        try
        {
            error = GetExtendedTcpTable(memory, ref size, false, family, 3, 0);
            if (error != 0) throw new InvalidDataException("TCP table changed or unavailable.");
            var bytes = new byte[size];
            Marshal.Copy(memory, bytes, 0, size);
            var count = BitConverter.ToUInt32(bytes, 0);
            var rowSize = family == 2 ? 24 : 56;
            if (count > (size - 4) / rowSize) throw new InvalidDataException("TCP table row count invalid.");
            for (var index = 0; index < count; index++)
            {
                var offset = 4 + index * rowSize;
                var portOffset = offset + (family == 2 ? 8 : 20);
                var localPort = bytes[portOffset] * 256 + bytes[portOffset + 1];
                if (localPort != port) continue;
                var address = family == 2 ? new IPAddress(bytes.AsSpan(offset + 4, 4)) : new IPAddress(bytes.AsSpan(offset, 16));
                var pid = BitConverter.ToInt32(bytes, offset + (family == 2 ? 20 : 52));
                results.Add((pid, IPAddress.IsLoopback(address)));
            }
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
