param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$NodeExe = "C:\Program Files\nodejs\node.exe",
    [Parameter(Mandatory = $true)][string]$OllamaDirectory,
    [Parameter(Mandatory = $true)][string]$OllamaArchive,
    [Parameter(Mandatory = $true)][string]$OllamaPackageSha256,
    [string]$MakeNsisExe = "",
    [string]$OutputDirectory = "",
    [string]$UpdateManifestUrl = "",
    [string]$UpdatePublicKeyFile = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repo "artifacts\desktop-$Version"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) {
    throw "Output directory already exists: $OutputDirectory"
}
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw "Node executable not found: $NodeExe"
}
$ollamaExe = Join-Path $OllamaDirectory "ollama.exe"
if (-not (Test-Path -LiteralPath $ollamaExe -PathType Leaf)) {
    throw "Ollama directory does not contain ollama.exe: $OllamaDirectory"
}
if (-not (Test-Path -LiteralPath $OllamaArchive -PathType Leaf)) {
    throw "Ollama archive not found: $OllamaArchive"
}
$actualOllamaSha = (Get-FileHash -LiteralPath $OllamaArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualOllamaSha -ne $OllamaPackageSha256.ToLowerInvariant()) {
    throw "Ollama archive SHA-256 mismatch. Expected $OllamaPackageSha256, got $actualOllamaSha"
}
$parsedVersion = $null
if (-not [Version]::TryParse($Version, [ref]$parsedVersion)) {
    throw "Version must use numeric dotted notation, for example 0.1.0"
}

$install = Join-Path $OutputDirectory "install"
$publish = Join-Path $OutputDirectory "launcher-publish"
$payload = Join-Path $install "versions\$Version\app"
New-Item -ItemType Directory -Path $install, $publish, $payload -Force | Out-Null

dotnet publish (Join-Path $PSScriptRoot "FedditBots.Desktop\FedditBots.Desktop.csproj") `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:DebugType=None -p:Version=$Version `
    --configfile (Join-Path $PSScriptRoot "NuGet.Config") `
    -o $publish
if ($LASTEXITCODE -ne 0) { throw "Desktop launcher publish failed." }
Copy-Item -LiteralPath (Join-Path $publish "FedditBots.Desktop.exe") -Destination $install

$nodeTarget = Join-Path $install "runtime\node"
$ollamaTarget = Join-Path $install "runtime\ollama"
New-Item -ItemType Directory -Path $nodeTarget, $ollamaTarget -Force | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $nodeTarget "node.exe")
Copy-Item -Path (Join-Path $OllamaDirectory "*") -Destination $ollamaTarget -Recurse -Force

Copy-Item -LiteralPath (Join-Path $repo "server.js") -Destination $payload
Copy-Item -LiteralPath (Join-Path $repo "lib") -Destination $payload -Recurse
Copy-Item -LiteralPath (Join-Path $repo "public") -Destination $payload -Recurse

$config = [ordered]@{
    initialVersion = $Version
    defaultModel = "qwen3:4b"
    port = 8770
    autoUpdate = [bool]($UpdateManifestUrl -and $UpdatePublicKeyFile)
    updateCheckHours = 6
    updateManifestUrl = $UpdateManifestUrl
    updatePublicKeyPem = if ($UpdatePublicKeyFile) { Get-Content -LiteralPath $UpdatePublicKeyFile -Raw } else { "" }
    ollamaPackageSha256 = $actualOllamaSha
}
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install "desktop-config.json") -Encoding utf8
[ordered]@{
    version = $Version
    relativePath = "versions\$Version"
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install "current.json") -Encoding utf8

$portable = Join-Path $OutputDirectory "FedditBots-$Version-portable.zip"
Compress-Archive -Path (Join-Path $install "*") -DestinationPath $portable -CompressionLevel Optimal

$updatePayload = Join-Path $OutputDirectory "FedditBots-$Version-update.zip"
Compress-Archive -Path (Join-Path (Split-Path -Parent $payload) "*") -DestinationPath $updatePayload -CompressionLevel Optimal

$makensisPath = $MakeNsisExe
if (-not $makensisPath) {
    $makensisCommand = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($makensisCommand) { $makensisPath = $makensisCommand.Source }
}
if ($makensisPath) {
    if (-not (Test-Path -LiteralPath $makensisPath -PathType Leaf)) { throw "makensis.exe not found: $makensisPath" }
    $installerStage = Join-Path $OutputDirectory "installer-stage"
    New-Item -ItemType Directory -Path $installerStage -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $install "FedditBots.Desktop.exe") -Destination $installerStage
    Copy-Item -LiteralPath (Join-Path $install "desktop-config.json") -Destination $installerStage
    Copy-Item -LiteralPath (Join-Path $install "current.json") -Destination $installerStage
    Copy-Item -LiteralPath (Join-Path $install "versions") -Destination $installerStage -Recurse
    New-Item -ItemType Directory -Path (Join-Path $installerStage "runtime\node") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $install "runtime\node\node.exe") -Destination (Join-Path $installerStage "runtime\node\node.exe")
    Copy-Item -LiteralPath $OllamaArchive -Destination (Join-Path $installerStage "runtime\ollama-package.zip")
    $installer = Join-Path $OutputDirectory "FedditBots-$Version-Setup.exe"
    & $makensisPath "/DSTAGE_DIR=$installerStage" "/DAPP_VERSION=$Version" "/DOUT_FILE=$installer" (Join-Path $PSScriptRoot "installer\FedditBots.nsi")
    if ($LASTEXITCODE -ne 0) { throw "NSIS installer build failed." }
    Write-Host "Installer: $installer"
} else {
    Write-Warning "NSIS is not installed; the portable package was built, but not Setup.exe."
}

Write-Host "Portable package: $portable"
Write-Host "Unsigned update payload: $updatePayload"
