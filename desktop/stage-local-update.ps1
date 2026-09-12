[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$SourceDirectory = "",
    [string]$InstallRoot = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $SourceDirectory) { $SourceDirectory = $repo }
if (-not $InstallRoot) {
    $InstallRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Programs\Feddit Bots"
}
$SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$versionsRoot = [IO.Path]::GetFullPath((Join-Path $InstallRoot "versions"))

$requestedVersion = $null
if (-not [Version]::TryParse($Version, [ref]$requestedVersion)) {
    throw "Version must use numeric dotted notation, for example 0.2.3."
}
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "FedditBots.Desktop.exe") -PathType Leaf)) {
    throw "Feddit Bots is not installed at $InstallRoot"
}

$currentFile = Join-Path $InstallRoot "current.json"
if (-not (Test-Path -LiteralPath $currentFile -PathType Leaf)) {
    throw "The installed current.json is missing."
}
$current = Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json
$currentVersion = $null
if (-not [Version]::TryParse([string]$current.version, [ref]$currentVersion)) {
    throw "The installed current version is invalid."
}
if ($requestedVersion -le $currentVersion) {
    throw "Local update $Version must be newer than installed app $currentVersion."
}

$sourceServer = Join-Path $SourceDirectory "server.js"
$sourceLib = Join-Path $SourceDirectory "lib"
$sourcePublic = Join-Path $SourceDirectory "public"
if (-not (Test-Path -LiteralPath $sourceServer -PathType Leaf) -or
    -not (Test-Path -LiteralPath $sourceLib -PathType Container) -or
    -not (Test-Path -LiteralPath (Join-Path $sourcePublic "index.html") -PathType Leaf)) {
    throw "Source must contain server.js, lib, and public/index.html."
}

$target = [IO.Path]::GetFullPath((Join-Path $versionsRoot $Version))
$versionsPrefix = $versionsRoot + [IO.Path]::DirectorySeparatorChar
if (-not $target.StartsWith($versionsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stage outside the installed versions directory."
}
if (Test-Path -LiteralPath $target) {
    throw "Installed app version already exists: $target"
}
$staging = $target + ".staging"
if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
}

$app = Join-Path $staging "app"
New-Item -ItemType Directory -Path $app -Force | Out-Null
try {
    Copy-Item -LiteralPath $sourceServer -Destination $app
    Copy-Item -LiteralPath $sourceLib -Destination $app -Recurse
    Copy-Item -LiteralPath $sourcePublic -Destination $app -Recurse
    if (-not (Test-Path -LiteralPath (Join-Path $app "server.js") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $app "public\index.html") -PathType Leaf)) {
        throw "The staged app payload is incomplete."
    }
    Move-Item -LiteralPath $staging -Destination $target
} catch {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
    throw
}

$pendingFile = Join-Path $InstallRoot "pending.json"
$pendingTemp = $pendingFile + ".tmp"
[ordered]@{
    version = $Version
    relativePath = "versions\$Version"
} | ConvertTo-Json | Set-Content -LiteralPath $pendingTemp -Encoding utf8
Move-Item -LiteralPath $pendingTemp -Destination $pendingFile -Force

Write-Host "Staged local app update $Version."
Write-Host "No runtime, model, profile, or credential files were copied or changed."
Write-Host "The launcher will health-check the update and roll back if it cannot start."
