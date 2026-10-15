$ErrorActionPreference = 'Stop'

# Fixed read-only native process inventory for the lower-integrity WSL service.
# Install as a highest-privilege interactive task for the same Windows user.
# This task never starts, stops, signals or changes any application process.
$directory = 'C:\dev\feddit-worker-ops'
$snapshotPath = Join-Path $directory 'identity.json'
$mutex = New-Object System.Threading.Mutex($false, 'Local\FedditWorkerIdentityProbe-v1')
try {
    $owned = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $owned = $true
}
if (-not $owned) { exit 78 }

try {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($sid in @($owner, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    $probeStartedAt = [datetime]::UtcNow.ToString('o')
    $sequence = 0
    $temporaryPath = Join-Path $directory ('identity.' + $PID + '.tmp')
    while ($true) {
        $observedAt = [datetime]::UtcNow.ToString('o')
        $records = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
            $command = $_.CommandLine
            if ([string]::IsNullOrWhiteSpace($command)) {
                $command = $null
            } elseif ($command -match '(?i)(^|[\\/\s"])worker\.js(?=["\s]|$)') {
                # Persist only the exact executable + single worker path. Never
                # copy arbitrary Node arguments into this operational snapshot.
                if ($command -notmatch '^\s*(?:"[^"]+"|\S+)\s+(?:"([^"]+)"|(\S+))\s*$') {
                    $command = $null
                }
            } else {
                $command = '[verified-other-node]'
            }
            @{ pid = [int]$_.ProcessId; startedAt = $_.CreationDate.ToUniversalTime().ToString('o');
               commandLine = $command; executable = $_.ExecutablePath }
        })
        $sequence++
        $snapshot = @{ version = 1; probePid = $PID; probeStartedAt = $probeStartedAt; sequence = $sequence;
                       observedAt = $observedAt; completedAt = [datetime]::UtcNow.ToString('o'); processes = $records }
        [System.IO.File]::WriteAllText($temporaryPath, ($snapshot | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $snapshotPath) {
            # Windows PowerShell 5 coerces $null to an empty string for this
            # overload. NullString preserves the intended no-backup argument.
            [System.IO.File]::Replace($temporaryPath, $snapshotPath, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [System.IO.File]::Move($temporaryPath, $snapshotPath)
        }
        Start-Sleep -Seconds 2
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
