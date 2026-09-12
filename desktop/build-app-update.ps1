[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$PrivateKeyFile = "",
    [string]$OutputDirectory = "",
    [string]$PackageUrl = "",
    [string]$MinLauncherVersion = "0.2.2"
)

$ErrorActionPreference = "Stop"
if ([Environment]::Version.Major -lt 8) {
    throw "Signed update builds require PowerShell 7 with modern .NET. Run this script with pwsh, not Windows PowerShell."
}
$repo = Split-Path -Parent $PSScriptRoot
if (-not $PrivateKeyFile) { $PrivateKeyFile = Join-Path $PSScriptRoot "update-signing.private.pem" }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo "artifacts\app-update-$Version" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) {
    throw "Output directory already exists: $OutputDirectory"
}
if (-not (Test-Path -LiteralPath $PrivateKeyFile -PathType Leaf)) {
    throw "Private update-signing key not found: $PrivateKeyFile"
}
$parsedVersion = $null
if (-not [Version]::TryParse($Version, [ref]$parsedVersion)) {
    throw "Version must use numeric dotted notation, for example 0.2.4."
}

$packageName = "FedditBots-$Version-update.zip"
if (-not $PackageUrl) { $PackageUrl = $packageName }
$staging = Join-Path $OutputDirectory "staging\app"
New-Item -ItemType Directory -Path $staging -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo "server.js") -Destination $staging
Copy-Item -LiteralPath (Join-Path $repo "lib") -Destination $staging -Recurse
Copy-Item -LiteralPath (Join-Path $repo "public") -Destination $staging -Recurse

$package = Join-Path $OutputDirectory $packageName
Compress-Archive -Path (Join-Path (Split-Path -Parent $staging) "*") -DestinationPath $package -CompressionLevel Optimal
$manifest = Join-Path $OutputDirectory "update.json"
& (Join-Path $PSScriptRoot "sign-update.ps1") `
    -Version $Version `
    -PackageFile $package `
    -PackageUrl $PackageUrl `
    -PrivateKeyFile $PrivateKeyFile `
    -MinLauncherVersion $MinLauncherVersion `
    -OutputFile $manifest
Remove-Item -LiteralPath (Join-Path $OutputDirectory "staging") -Recurse -Force

Write-Host "Signed app update: $package"
Write-Host "Signed update manifest: $manifest"
Write-Host "Publishing these files is a separate release action."
