Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'tools/Install-LenoSelfRecovery.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Load only reviewed function definitions. Never execute the installer entrypoint.
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
$checks = 0
function Check($Condition, [string]$Message) {
    if (!$Condition) { throw ('FAIL: ' + $Message) }; $script:checks++
}
function Reject([scriptblock]$Operation, [string]$Message) {
    $rejected = $false
    try { & $Operation } catch { $rejected = $true }
    Check $rejected $Message
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$marker = 'Feddit Bots private self-recovery v1'
$allowedEnvironment = @('FEDDIT_QUIET_CONVERSATIONS', 'FEDDIT_THEME_INTEREST_V1', 'FEDDIT_THEME_INTEREST_COMMUNITIES', 'FEDDIT_QUIET_POPULATION_V2')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('feddit-recovery-installer-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($fixture)
$InstallRoot = $fixture
$launcher = Join-Path $fixture 'FedditBots.Desktop.exe'
$helper = Join-Path $fixture 'tools/self-recovery/0.15.3/FedditBots.Recovery.exe'
try {
    Check ((Resolve-LocalPath $fixture) -eq $fixture.TrimEnd('\')) 'canonical exact fixture path'
    Reject { Resolve-LocalPath 'C:\' } 'drive root rejected'
    Reject { Resolve-LocalPath '\\server\share' } 'network path rejected'
    Set-PrivateAcl $fixture $true
    $acl = Get-Acl -LiteralPath $fixture
    Check $acl.AreAccessRulesProtected 'private directory does not inherit broader access'
    Check (@($acl.Access).Count -eq 2) 'only current user and SYSTEM granted access'
    $file = Join-Path $fixture 'intent.json'
    Write-PrivateJson $file ([ordered]@{schemaVersion=1; desiredRunning=$false; updatedAt=[DateTimeOffset]::UtcNow.ToString('O')})
    Write-PrivateJson $file ([ordered]@{schemaVersion=1; desiredRunning=$true; updatedAt=[DateTimeOffset]::UtcNow.ToString('O')}) -CreateOnly
    Check ((Read-PrivateJson $file).desiredRunning -eq $false) 'install cannot overwrite explicit manual stop'
    Check ((Get-Acl -LiteralPath $file).AreAccessRulesProtected) 'private intent ACL is protected'
    Write-PrivateJson $file ([ordered]@{schemaVersion=2})
    Reject { Read-PrivateJson $file } 'unknown state schema rejected'
    $flags = @{ FEDDIT_QUIET_CONVERSATIONS='1'; FEDDIT_THEME_INTEREST_V1='1'; FEDDIT_THEME_INTEREST_COMMUNITIES='shittyaskfeddit'; FEDDIT_QUIET_POPULATION_V2='' }
    Assert-Environment $flags
    Check $true 'exact approved four flag set accepted'
    Reject { Assert-Environment @{ API_KEY='not-a-real-key' } } 'credential or arbitrary environment field rejected'
    $flags.FEDDIT_THEME_INTEREST_COMMUNITIES = "bad`nvalue"
    Reject { Assert-Environment $flags } 'control characters rejected'
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $app = New-RecoveryTask $false
    Assert-OwnedTask ([pscustomobject]@{Definition=$app}) $false
    Check ($app.Triggers.Count -eq 0 -and $app.Settings.ExecutionTimeLimit -eq 'PT0S' -and !$app.Settings.AllowHardTerminate) 'app task has no short-probe kill boundary'
    $probe = New-RecoveryTask $true
    try { Assert-OwnedTask ([pscustomobject]@{Definition=$probe}) $true }
    catch {
        $a=$probe.Triggers.Item(1); $b=$probe.Triggers.Item(2)
        Write-Output ([pscustomobject]@{timeType=$a.Type; interval=$a.Repetition.Interval; duration=$a.Repetition.Duration;
            stop=$a.Repetition.StopAtDurationEnd; timeEnabled=$a.Enabled; end=$a.EndBoundary;
            logonEnabled=$b.Enabled; logonEnd=$b.EndBoundary; logonType=$b.Type; logonUser=$b.UserId; expected=$sid.Value} | ConvertTo-Json)
        throw
    }
    Check ($probe.Triggers.Count -eq 2 -and $probe.Settings.ExecutionTimeLimit -eq 'PT45S') 'short probe uses bounded minute and logon triggers'
    Check (!$probe.Settings.WakeToRun -and $probe.Settings.RestartCount -eq 0 -and $probe.Settings.MultipleInstances -eq 2) 'no wake, scheduler retry storm or overlapping instance'
    $probe.Actions.Item(1).Path = 'C:\unrelated.exe'
    Reject { Assert-OwnedTask ([pscustomobject]@{Definition=$probe}) $true } 'unknown task action cannot be overwritten'
    $app.Settings.ExecutionTimeLimit = 'PT45S'
    Reject { Assert-OwnedTask ([pscustomobject]@{Definition=$app}) $false } 'short-lived application task rejected'
    Check (@(Get-ChildItem -LiteralPath $fixture -Filter '*.tmp').Count -eq 0) 'atomic writes leave no successful temporary files'
    Write-Output ('self-recovery installer: ' + $checks + ' checks passed; no task registered or started')
} finally {
    # Only the exclusively created, verified temporary fixture is removed.
    if (([IO.Path]::GetFullPath($fixture)).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and
        ([IO.Path]::GetFileName($fixture)).StartsWith('feddit-recovery-installer-')) {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
