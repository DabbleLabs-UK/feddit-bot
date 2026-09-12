[CmdletBinding()]
param(
    [string]$PrivateKeyFile = "",
    [string]$PublicKeyFile = ""
)

$ErrorActionPreference = "Stop"
if ([Environment]::Version.Major -lt 8) {
    throw "Update signing requires PowerShell 7 with modern .NET. Run: pwsh -File desktop/new-update-signing-key.ps1"
}
if (-not $PrivateKeyFile) { $PrivateKeyFile = Join-Path $PSScriptRoot "update-signing.private.pem" }
if (-not $PublicKeyFile) { $PublicKeyFile = Join-Path $PSScriptRoot "update-signing.public.pem" }
$PrivateKeyFile = [IO.Path]::GetFullPath($PrivateKeyFile)
$PublicKeyFile = [IO.Path]::GetFullPath($PublicKeyFile)

if (Test-Path -LiteralPath $PrivateKeyFile) {
    throw "Refusing to replace the existing private update-signing key: $PrivateKeyFile"
}
if (Test-Path -LiteralPath $PublicKeyFile) {
    throw "Refusing to replace the existing public update-signing key: $PublicKeyFile"
}

$privateDirectory = Split-Path -Parent $PrivateKeyFile
$publicDirectory = Split-Path -Parent $PublicKeyFile
New-Item -ItemType Directory -Path $privateDirectory,$publicDirectory -Force | Out-Null
$key = [Security.Cryptography.ECDsa]::Create()
try {
    $key.GenerateKey([Security.Cryptography.ECCurve]::CreateFromFriendlyName("nistP256"))
    Set-Content -LiteralPath $PrivateKeyFile -Value $key.ExportECPrivateKeyPem() -Encoding ascii
    Set-Content -LiteralPath $PublicKeyFile -Value $key.ExportSubjectPublicKeyInfoPem() -Encoding ascii
} finally {
    $key.Dispose()
}

Write-Host "Private signing key: $PrivateKeyFile"
Write-Host "Public verification key: $PublicKeyFile"
Write-Host "Keep the private file secret and backed up. Never commit it."
