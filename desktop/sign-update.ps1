param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$PackageFile,
    [Parameter(Mandatory = $true)][string]$PackageUrl,
    [Parameter(Mandatory = $true)][string]$PrivateKeyFile,
    [string]$MinLauncherVersion = "0.1.0",
    [string]$OutputFile = "update.json"
)

$ErrorActionPreference = "Stop"
$sha256 = (Get-FileHash -LiteralPath $PackageFile -Algorithm SHA256).Hash.ToLowerInvariant()
$publishedAt = [DateTimeOffset]::UtcNow.ToString("O")
$canonical = $Version + "`n" + $PackageUrl + "`n" + $sha256 + "`n" + $MinLauncherVersion + "`n" + $publishedAt
$key = [Security.Cryptography.ECDsa]::Create()
try {
    $key.ImportFromPem((Get-Content -LiteralPath $PrivateKeyFile -Raw))
    $signature = $key.SignData(
        [Text.Encoding]::UTF8.GetBytes($canonical),
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
} finally {
    $key.Dispose()
}
[ordered]@{
    version = $Version
    packageUrl = $PackageUrl
    sha256 = $sha256
    signature = [Convert]::ToBase64String($signature)
    minLauncherVersion = $MinLauncherVersion
    publishedAt = $publishedAt
} | ConvertTo-Json | Set-Content -LiteralPath $OutputFile -Encoding utf8
Write-Host "Signed manifest: $OutputFile"
