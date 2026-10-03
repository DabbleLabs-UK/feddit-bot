$ErrorActionPreference = "Stop"
$root = Join-Path ([IO.Path]::GetTempPath()) ("feddit-local-update-test-" + [Guid]::NewGuid().ToString("N"))
$source = Join-Path $root "source"
$install = Join-Path $root "install"
$dataRoot = Join-Path $root "private-data"
$previousDataRoot = $env:FEDDIT_BOT_DATA_DIR

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

try {
    New-Item -ItemType Directory -Path (Join-Path $source "lib"),(Join-Path $source "public"),(Join-Path $install "versions\0.2.2\app"),$dataRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $source "server.js") -Value "'use strict';" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $source "lib\core.js") -Value "module.exports = {};" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $source "public\index.html") -Value "<!doctype html>" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $install "FedditBots.Desktop.exe") -Value "test launcher" -Encoding utf8
    [ordered]@{ version = "0.2.2"; relativePath = "versions\0.2.2" } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install "current.json") -Encoding utf8
    $workspaceFile = Join-Path $dataRoot "culture-import-workspaces.json"
    $candidateDrafts = 1..24 | ForEach-Object {
        [ordered]@{
            id = "culture_candidate_$($_.ToString('x').PadLeft(20, '0'))"
            selected = ($_ % 3 -ne 0)
            seed = [ordered]@{ username = "update_fixture_$_"; biography = "Preserved edit $_" }
        }
    }
    [ordered]@{
        version = 1
        sessions = @([ordered]@{
            id = "completed-update-workspace"
            analysed = [ordered]@{ analysis = [ordered]@{ id = "saved-analysis" } }
            importResult = [ordered]@{ candidates = $candidateDrafts }
            candidateReview = [ordered]@{ drafts = $candidateDrafts }
            staging = [ordered]@{ results = @([ordered]@{ importerCandidateId = $candidateDrafts[0].id; ok = $true }) }
        })
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $workspaceFile -Encoding utf8
    $workspaceHash = (Get-FileHash -LiteralPath $workspaceFile -Algorithm SHA256).Hash
    $env:FEDDIT_BOT_DATA_DIR = $dataRoot

    & (Join-Path $PSScriptRoot "stage-local-update.ps1") -Version "0.2.3" -SourceDirectory $source -InstallRoot $install

    $pending = Get-Content -LiteralPath (Join-Path $install "pending.json") -Raw | ConvertFrom-Json
    Assert-True ($pending.version -eq "0.2.3") "pending pointer records the new version"
    Assert-True ($pending.relativePath -eq "versions\0.2.3") "pending pointer stays below versions"
    Assert-True (Test-Path -LiteralPath (Join-Path $install "versions\0.2.3\app\server.js")) "server is staged"
    Assert-True (Test-Path -LiteralPath (Join-Path $install "versions\0.2.3\app\lib\core.js")) "library is staged"
    Assert-True (Test-Path -LiteralPath (Join-Path $install "versions\0.2.3\app\public\index.html")) "browser app is staged"
    $current = Get-Content -LiteralPath (Join-Path $install "current.json") -Raw | ConvertFrom-Json
    Assert-True ($current.version -eq "0.2.2") "staging does not switch the active version itself"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $install "runtime"))) "runtime is not copied"
    Assert-True (Test-Path -LiteralPath $workspaceFile) "completed importer workspace remains in the private data root"
    Assert-True ((Get-FileHash -LiteralPath $workspaceFile -Algorithm SHA256).Hash -eq $workspaceHash) "desktop update leaves analysis, 24 candidates, edits, selections and staging evidence byte-for-byte unchanged"

    Write-Host "desktop local update: 9 checks passed"
} finally {
    if ($null -eq $previousDataRoot) { Remove-Item Env:FEDDIT_BOT_DATA_DIR -ErrorAction SilentlyContinue }
    else { $env:FEDDIT_BOT_DATA_DIR = $previousDataRoot }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
