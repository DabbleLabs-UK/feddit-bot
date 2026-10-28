[CmdletBinding()]
param(
    [ValidateSet('Install', 'Disable', 'Remove')][string]$Action = 'Install',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Feddit Bots'),
    [string]$UserRoot = (Join-Path $env:LOCALAPPDATA 'DabbleLabs\FedditBots'),
    [string]$LauncherSha256 = '',
    [hashtable]$RuntimeEnvironment = @{},
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$marker = 'Feddit Bots private self-recovery v1'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$allowedEnvironment = @('FEDDIT_QUIET_CONVERSATIONS', 'FEDDIT_THEME_INTEREST_V1',
    'FEDDIT_THEME_INTEREST_COMMUNITIES', 'FEDDIT_QUIET_POPULATION_V2')

function Resolve-LocalPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw 'A fully qualified local drive path is required.' }
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($resolved.Length -le 3) { throw 'A drive root is not an installation directory.' }
    $current = $resolved
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Recovery paths must not contain reparse points.'
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $resolved
}

function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals([IO.Path]::GetFullPath($Left).TrimEnd('\'),
        [IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

function Set-PrivateAcl([string]$Path, [bool]$Directory) {
    if ($Directory) { $acl = New-Object Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($owner in @($sid, $systemSid)) {
        if ($Directory) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl',
                'ContainerInherit,ObjectInherit', 'None', 'Allow')
        } else {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'Allow')
        }
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Read-PrivateJson([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) { return $null }
    $null = Resolve-LocalPath $Path
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -le 0 -or $file.Length -gt 65536) { throw 'Invalid recovery file size.' }
    $value = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    if ($value.schemaVersion -ne 1) { throw 'Unknown recovery file schema.' }
    return $value
}

function Write-PrivateJson([string]$Path, $Value, [switch]$CreateOnly) {
    $null = Resolve-LocalPath $Path
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 8))
    if ($bytes.Length -gt 65536) { throw 'Recovery file exceeds its size bound.' }
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        Set-PrivateAcl $temporary $false
        if ($CreateOnly) {
            try { [IO.File]::Move($temporary, $Path) }
            catch [IO.IOException] {
                if (![IO.File]::Exists($Path)) { throw }
                # A concurrent deliberate Exit owns its intent; never overwrite it.
            }
        }
        elseif ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Assert-Environment($Environment) {
    $keys = @($Environment.Keys)
    if ($keys.Count -ne 4) { throw 'Supply all four explicitly reviewed nonsecret runtime flags.' }
    foreach ($key in $keys) {
        if ($key -cnotin $allowedEnvironment -or $Environment[$key] -isnot [string] -or
            $Environment[$key].Length -gt 512 -or $Environment[$key] -match '[\x00-\x1f\x7f]') {
            throw 'Unapproved recovery environment field.'
        }
    }
}

function Assert-Config($Config) {
    if (!(Same-Path $Config.installRoot $InstallRoot) -or $Config.enabled -isnot [bool] -or
        ($Config.launcherSha256 -cnotmatch '^[a-f0-9]{64}$' -and
            !(!$Config.enabled -and $Config.launcherSha256 -eq ''))) {
        throw 'Recovery configuration differs from this installation.'
    }
    $environment = @{}
    foreach ($field in $Config.runtimeEnvironment.PSObject.Properties) { $environment[$field.Name] = $field.Value }
    if ($environment.Count -gt 4) { throw 'Invalid saved runtime flags.' }
    foreach ($key in $environment.Keys) {
        if ($key -cnotin $allowedEnvironment -or $environment[$key] -isnot [string] -or
            $environment[$key].Length -gt 512 -or $environment[$key] -match '[\x00-\x1f\x7f]') {
            throw 'Unapproved saved runtime flag.'
        }
    }
}

function Get-TaskOrNull([string]$Name) {
    try { return $folder.GetTask($Name) }
    catch {
        $failure = $_.Exception
        while ($failure) {
            if ($failure.HResult -eq -2147024894 -or $failure.HResult -eq -2147024893) { return $null }
            $failure = $failure.InnerException
        }
        throw
    }
}

function Assert-OwnedTask($Task, [bool]$Check) {
    $definition = $Task.Definition
    $principal = $definition.Principal
    $user = $principal.UserId
    if ($user -notlike 'S-1-*') {
        $user = (New-Object Security.Principal.NTAccount($user)).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    $expectedPath = $launcher
    $expectedArguments = '--recovery-start'
    $expectedLimit = 'PT0S'
    if ($Check) {
        $expectedPath = $helper
        $expectedArguments = '--recovery-check --install-root "' + $InstallRoot + '"'
        $expectedLimit = 'PT45S'
    }
    if ($definition.RegistrationInfo.Description -ne $marker -or $definition.Actions.Count -ne 1 -or
        $user -ne $sid.Value -or $principal.LogonType -ne 3 -or $principal.RunLevel -ne 0 -or
        !(Same-Path $definition.Actions.Item(1).Path $expectedPath) -or
        $definition.Actions.Item(1).Arguments -cne $expectedArguments -or
        !(Same-Path $definition.Actions.Item(1).WorkingDirectory $InstallRoot) -or
        $definition.Settings.MultipleInstances -ne 2 -or
        $definition.Settings.ExecutionTimeLimit -cne $expectedLimit -or
        !$definition.Settings.StartWhenAvailable -or $definition.Settings.WakeToRun -or
        $definition.Settings.DisallowStartIfOnBatteries -or $definition.Settings.StopIfGoingOnBatteries -or
        $definition.Settings.RestartCount -ne 0 -or
        $definition.Settings.AllowHardTerminate -ne $Check -or !$definition.Settings.AllowDemandStart -or
        $definition.Settings.RunOnlyIfIdle -or $definition.Settings.RunOnlyIfNetworkAvailable) {
        throw 'An existing task differs from the exact owned recovery contract; it was not overwritten.'
    }
    if (!$Check -and $definition.Triggers.Count -ne 0) { throw 'The application task must be on-demand only.' }
    if ($Check) {
        if ($definition.Triggers.Count -ne 2) { throw 'Unexpected health task triggers.' }
        $time = $definition.Triggers.Item(1)
        $logon = $definition.Triggers.Item(2)
        $logonUser = $logon.UserId
        if ($logonUser -notlike 'S-1-*') {
            $logonUser = (New-Object Security.Principal.NTAccount($logonUser)).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        if ($time.Type -ne 1 -or $time.Repetition.Interval -cne 'PT1M' -or
            [string]$time.Repetition.Duration -ne '' -or $time.Repetition.StopAtDurationEnd -or
            !$time.Enabled -or [string]$time.EndBoundary -ne '' -or !$logon.Enabled -or
            [string]$logon.EndBoundary -ne '' -or $logon.Type -ne 9 -or $logonUser -ne $sid.Value) {
            throw 'Unexpected health task trigger bounds.'
        }
    }
}

function New-RecoveryTask([bool]$Check) {
    $definition = $service.NewTask(0)
    $definition.RegistrationInfo.Description = $marker
    $definition.Principal.UserId = $sid.Value
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $settings = $definition.Settings
    $settings.Enabled = $false
    $settings.MultipleInstances = 2
    $settings.StartWhenAvailable = $true
    $settings.WakeToRun = $false
    $settings.DisallowStartIfOnBatteries = $false
    $settings.StopIfGoingOnBatteries = $false
    $settings.RestartCount = 0
    $settings.RunOnlyIfIdle = $false
    $settings.RunOnlyIfNetworkAvailable = $false
    $settings.ExecutionTimeLimit = 'PT0S'
    $settings.AllowHardTerminate = $false
    $actionDefinition = $definition.Actions.Create(0)
    $actionDefinition.Path = $launcher
    $actionDefinition.Arguments = '--recovery-start'
    $actionDefinition.WorkingDirectory = $InstallRoot
    if ($Check) {
        $settings.ExecutionTimeLimit = 'PT45S'
        $settings.AllowHardTerminate = $true
        $actionDefinition.Path = $helper
        $actionDefinition.Arguments = '--recovery-check --install-root "' + $InstallRoot + '"'
        $time = $definition.Triggers.Create(1)
        $time.StartBoundary = [DateTime]::Now.AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
        $time.Repetition.Interval = 'PT1M'
        $time.Repetition.StopAtDurationEnd = $false
        $logon = $definition.Triggers.Create(9)
        $logon.UserId = $sid.Value
    }
    return $definition
}

$InstallRoot = Resolve-LocalPath $InstallRoot
$UserRoot = Resolve-LocalPath $UserRoot
if (!(Same-Path $UserRoot (Join-Path $env:LOCALAPPDATA 'DabbleLabs\FedditBots'))) {
    throw 'The launcher uses the current user LocalAppData data root; a different UserRoot is unsupported.'
}
$launcher = Join-Path $InstallRoot 'FedditBots.Desktop.exe'
$helper = Join-Path $InstallRoot 'tools\self-recovery\0.15.3\FedditBots.Recovery.exe'
$privateDirectory = Join-Path $UserRoot 'supervision'
$configPath = Join-Path $privateDirectory 'config.json'
$intentPath = Join-Path $privateDirectory 'intent.json'
$applicationName = 'Feddit Bots application - ' + $sid.Value
$checkName = 'Feddit Bots self-recovery - ' + $sid.Value
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$applicationTask = Get-TaskOrNull $applicationName
$checkTask = Get-TaskOrNull $checkName
if ($applicationTask) { Assert-OwnedTask $applicationTask $false }
if ($checkTask) { Assert-OwnedTask $checkTask $true }
$config = Read-PrivateJson $configPath
if ($config) { Assert-Config $config }
$intent = Read-PrivateJson $intentPath
if ($intent -and ($intent.desiredRunning -isnot [bool] -or !$intent.updatedAt)) { throw 'Invalid saved recovery intent.' }

if ($Action -eq 'Install') {
    Assert-Environment $RuntimeEnvironment
    if ($LauncherSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Supply the approved lowercase launcher SHA-256.' }
    foreach ($path in @($launcher, $helper)) {
        $null = Resolve-LocalPath $path
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $LauncherSha256) {
            throw 'Installed launcher/helper does not match the approved hash.'
        }
        if ([Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion -ne '0.15.3.0') {
            throw 'The reviewed 0.15.3 launcher is required.'
        }
    }
}
if ($ValidateOnly) {
    Write-Output ('Validated ' + $Action + ' inputs and existing owned task contracts; no changes made.')
    return
}

$null = [IO.Directory]::CreateDirectory($privateDirectory)
$null = Resolve-LocalPath $privateDirectory
Set-PrivateAcl $privateDirectory $true
$lockPath = Join-Path $privateDirectory 'check.lock'
$null = Resolve-LocalPath $lockPath
$checkLock = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    $config = Read-PrivateJson $configPath
    if ($config) { Assert-Config $config }
    $intent = Read-PrivateJson $intentPath
    if ($intent -and ($intent.desiredRunning -isnot [bool] -or !$intent.updatedAt)) { throw 'Invalid saved recovery intent.' }
    # Disable first. Failed registration must never leave a partially enabled recovery path.
    if (!$config) {
        $config = [pscustomobject]@{ schemaVersion = 1; enabled = $false; installRoot = $InstallRoot;
            launcherSha256 = ''; runtimeEnvironment = @{} }
    }
    $config.enabled = $false
    Write-PrivateJson $configPath $config
    if ($Action -eq 'Install') {
        $config.launcherSha256 = $LauncherSha256
        $config.runtimeEnvironment = $RuntimeEnvironment
        Write-PrivateJson $configPath $config
        if (!$intent) {
            Write-PrivateJson $intentPath ([ordered]@{ schemaVersion = 1; desiredRunning = $true;
                updatedAt = [DateTimeOffset]::UtcNow.ToString('O') }) -CreateOnly
        }
        $created = New-Object 'Collections.Generic.List[string]'
        try {
            if (!$applicationTask) {
                $applicationTask = $folder.RegisterTaskDefinition($applicationName, (New-RecoveryTask $false), 2, $sid.Value, $null, 3)
                $created.Add($applicationName)
            }
            Assert-OwnedTask $applicationTask $false
            if (!$checkTask) {
                $checkTask = $folder.RegisterTaskDefinition($checkName, (New-RecoveryTask $true), 2, $sid.Value, $null, 3)
                $created.Add($checkName)
            }
            Assert-OwnedTask $checkTask $true
            $applicationTask.Enabled = $true
            $checkTask.Enabled = $true
            $config.enabled = $true
            Write-PrivateJson $configPath $config
        } catch {
            foreach ($name in $created) { $folder.DeleteTask($name, 0) }
            throw
        }
        Write-Output 'Installed same-user recovery tasks and enabled pinned configuration. No application was started or stopped.'
    } else {
        if ($checkTask) { $checkTask.Enabled = $false }
        if ($applicationTask) { $applicationTask.Enabled = $false }
        if ($Action -eq 'Remove') {
            if ($checkTask) { $folder.DeleteTask($checkName, 0) }
            if ($applicationTask) { $folder.DeleteTask($applicationName, 0) }
        }
        Write-Output ($Action + ' completed. Running application, manual intent, HKCU Run and all app data were left unchanged.')
    }
} finally { $checkLock.Dispose() }
