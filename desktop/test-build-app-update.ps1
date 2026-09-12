$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Join-Path ([IO.Path]::GetTempPath()) ("feddit-signed-update-test-" + [Guid]::NewGuid().ToString("N"))
$privateKey = Join-Path $root "update.private.pem"
$publicKey = Join-Path $root "update.public.pem"
$output = Join-Path $root "output"
$checks = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:checks++
}

try {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    & (Join-Path $PSScriptRoot "new-update-signing-key.ps1") -PrivateKeyFile $privateKey -PublicKeyFile $publicKey
    Assert-True (Test-Path -LiteralPath $privateKey -PathType Leaf) "private key was created"
    Assert-True (Test-Path -LiteralPath $publicKey -PathType Leaf) "public key was created"

    & (Join-Path $PSScriptRoot "build-app-update.ps1") -Version "9.8.7" -PrivateKeyFile $privateKey -OutputDirectory $output
    $package = Join-Path $output "FedditBots-9.8.7-update.zip"
    $manifestFile = Join-Path $output "update.json"
    Assert-True (Test-Path -LiteralPath $package -PathType Leaf) "app package was created"
    Assert-True (Test-Path -LiteralPath $manifestFile -PathType Leaf) "signed manifest was created"

    $archive = [IO.Compression.ZipFile]::OpenRead($package)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        Assert-True ($names -contains "app/server.js") "package contains app/server.js"
        Assert-True ($names -contains "app/public/index.html") "package contains app/public/index.html"
        Assert-True (-not ($names | Where-Object { $_ -match '^runtime/' })) "package excludes the shared runtime"
    } finally {
        $archive.Dispose()
    }

    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json -DateKind String
    $sha = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-True ($manifest.sha256 -eq $sha) "manifest pins the package SHA-256"
    $canonical = [string]::Join("`n", @($manifest.version, $manifest.packageUrl, $manifest.sha256, $manifest.minLauncherVersion, $manifest.publishedAt))
    $key = [Security.Cryptography.ECDsa]::Create()
    try {
        $key.ImportFromPem((Get-Content -LiteralPath $publicKey -Raw))
        $valid = $key.VerifyData(
            [Text.Encoding]::UTF8.GetBytes($canonical),
            [Convert]::FromBase64String($manifest.signature),
            [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
        Assert-True $valid "manifest signature verifies with the public key"
    } finally {
        $key.Dispose()
    }

    Write-Host "signed app update: $checks checks passed"
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
