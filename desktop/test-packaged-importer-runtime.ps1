[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageFile,
    [string]$BrowserExe = ""
)

$ErrorActionPreference = "Stop"
$PackageFile = [IO.Path]::GetFullPath($PackageFile)
if (-not (Test-Path -LiteralPath $PackageFile -PathType Leaf)) {
    throw "Packaged desktop update not found: $PackageFile"
}

if (-not $BrowserExe) {
    $candidates = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "BraveSoftware\Brave-Browser\Application\brave.exe")
    )
    $BrowserExe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $BrowserExe -or -not (Test-Path -LiteralPath $BrowserExe -PathType Leaf)) {
    throw "Chrome, Edge or Brave is required for the packaged desktop importer runtime test."
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("feddit-packaged-importer-" + [Guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    Expand-Archive -LiteralPath $PackageFile -DestinationPath $root
    $appRoot = Join-Path $root "app"
    & node (Join-Path $PSScriptRoot "test-packaged-importer-runtime.js") `
        --app-root $appRoot `
        --browser $BrowserExe
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged desktop importer runtime test failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
