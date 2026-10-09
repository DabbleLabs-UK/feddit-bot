[CmdletBinding()]
param(
    [int]$TargetPid,
    [string]$ExpectedCommandLine,
    [datetime]$ExpectedCreatedAtUtc,
    [switch]$Send,
    [ValidateRange(1, 2400)][int]$WaitExitSeconds = 2100,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

function Test-OwnedConsole {
    param([uint32[]]$Members, [uint32]$Target, [uint32]$Helper)
    return $Target -ne $Helper -and $Members.Count -eq 2 `
        -and $Members -contains $Target -and $Members -contains $Helper `
        -and @($Members | Where-Object { $_ -ne $Target -and $_ -ne $Helper }).Count -eq 0
}

if ($SelfTest) {
    $cases = @(
        @{ members = @(12, 34); expected = $true },
        @{ members = @(34, 12); expected = $true },
        @{ members = @(12); expected = $false },
        @{ members = @(); expected = $false },
        @{ members = @(12, 34, 56); expected = $false },
        @{ members = @(12, 12); expected = $false },
        @{ members = @(34, 56); expected = $false }
    )
    foreach ($case in $cases) {
        if ((Test-OwnedConsole -Members $case.members -Target 12 -Helper 34) -ne $case.expected) {
            throw 'Console ownership fixture failed.'
        }
    }
    if (Test-OwnedConsole -Members @(12, 12) -Target 12 -Helper 12) { throw 'Self-target fixture failed.' }
    Write-Output 'worker-maintenance-bootstrap: 8 ownership fixtures passed; no signal sent.'
    exit 0
}

if ($TargetPid -le 0 -or $TargetPid -eq $PID -or [string]::IsNullOrWhiteSpace($ExpectedCommandLine) `
    -or $ExpectedCreatedAtUtc -eq [datetime]::MinValue) {
    throw 'Exact target PID, command line and UTC creation time are required. No signal sent.'
}

function Assert-TargetIdentity {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
    if (-not $process -or $process.Name -ine 'node.exe' `
        -or $process.CommandLine -cne $ExpectedCommandLine `
        -or $process.CreationDate.ToUniversalTime() -ne $ExpectedCreatedAtUtc.ToUniversalTime()) {
        throw 'Target identity changed or is not the expected Windows Node process. No signal sent.'
    }
    return $process
}

Assert-TargetIdentity | Out-Null
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WorkerMaintenanceConsole {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint count);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint code, uint group);
}
'@

# Run in a dedicated, disposable PowerShell process. Never signal a console
# shared with a supervisor, Cy, another worker, or an interactive user shell.
[WorkerMaintenanceConsole]::FreeConsole() | Out-Null
if (-not [WorkerMaintenanceConsole]::AttachConsole([uint32]$TargetPid)) {
    throw 'The target console cannot be attached. No signal sent; do not substitute a force stop.'
}
try {
    Assert-TargetIdentity | Out-Null
    $members = New-Object uint32[] 32
    $count = [WorkerMaintenanceConsole]::GetConsoleProcessList($members, 32)
    if ($count -eq 0 -or $count -gt 32 `
        -or -not (Test-OwnedConsole -Members $members[0..($count - 1)] -Target $TargetPid -Helper $PID)) {
        throw 'Console is not exclusive to the exact worker and this helper. No signal sent.'
    }
    if (-not $Send) {
        Write-Output ('Verified exclusive console for worker PID {0}; validation only, no signal sent.' -f $TargetPid)
        return
    }
    if (-not [WorkerMaintenanceConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) {
        throw 'Cannot protect the helper from its own signal. No signal sent.'
    }
    if (-not [WorkerMaintenanceConsole]::GenerateConsoleCtrlEvent(0, 0)) {
        throw 'CTRL_C delivery failed. Do not substitute a force stop.'
    }
    Write-Output ('CTRL_C sent to verified worker PID {0} at {1}; waiting for natural exit.' -f $TargetPid, [datetime]::UtcNow.ToString('o'))
    Start-Sleep -Milliseconds 500
} finally {
    [WorkerMaintenanceConsole]::FreeConsole() | Out-Null
}

$deadline = [datetime]::UtcNow.AddSeconds($WaitExitSeconds)
while ([datetime]::UtcNow -lt $deadline) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
    if (-not $current -or $current.CreationDate.ToUniversalTime() -ne $ExpectedCreatedAtUtc.ToUniversalTime()) {
        Write-Output ('Original worker PID {0} exited at {1}. Verify the user unit is inactive and no replacement started.' -f $TargetPid, [datetime]::UtcNow.ToString('o'))
        return
    }
    Start-Sleep -Milliseconds 500
}
throw 'Natural worker exit not confirmed within the bound. Do not force stop or replace it. Inspect status and preserve the current restart-disabled barrier.'
