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
        foreach ($required in @("public-writing.js", "reply-branch.js", "continuation-guard.js", "discovery-receipt.js", "hosted-tokenizer.js", "hosted-tokenizer-data.json.gz", "hosted-tokenizer-unicode.json", "third-party/llama31/LICENSE.txt", "third-party/llama31/Notice.txt", "third-party/llama31/README.md", "third-party/llama31/llama.cpp-LICENSE.txt")) {
            Assert-True ($names -contains ("app/lib/" + $required)) "package includes required dependency/notice $required"
        }
        Assert-True (-not ($names | Where-Object { $_ -match '^runtime/' })) "package excludes the shared runtime"
        Assert-True (-not ($names | Where-Object { $_ -match '(^|/)data/' })) "package excludes runtime data"
        Assert-True (-not ($names | Where-Object { $_ -match '(^|/)secrets\.json$' })) "package excludes secret stores"
        Assert-True (-not ($names | Where-Object { $_ -match 'culture-import-cache' })) "package excludes private culture caches"
    } finally {
        $archive.Dispose()
    }

    $tokenizerExtract = Join-Path $root "tokenizer-package"
    [IO.Compression.ZipFile]::ExtractToDirectory($package, $tokenizerExtract)
    & node -e 'const t=require(process.argv[1]);if(t.countText("Hello world!")!==4||!Number.isInteger(t.countRequest("Complete persona", "Complete task")))process.exit(1);' (Join-Path $tokenizerExtract "app/lib/hosted-tokenizer.js")
    Assert-True ($LASTEXITCODE -eq 0) "tokenizer loads and counts using only packaged dependencies"
    & node -e 'const p=require(process.argv[1]);const b=require(process.argv[2]);const s=p.comment({version:2,target:{replyBranch:b.forPost({title:"Frozen title",body:"Frozen body"})}});if(!s.includes("40-70 words")||!s.includes("Frozen body"))process.exit(1);' (Join-Path $tokenizerExtract "app/lib/public-writing.js") (Join-Path $tokenizerExtract "app/lib/reply-branch.js")
    Assert-True ($LASTEXITCODE -eq 0) "shared public writing and branch rendering load from packaged dependencies"

    & node -e 'const a=require("node:assert/strict"),p=require("node:path"),g=require(p.join(process.argv[1],"lib/continuation-guard.js")),r=require(p.join(process.argv[1],"lib/discovery-receipt.js"));a.equal(g.VERSION,2);a.equal(g.WINDOW_MS,3600000);a.equal(g.count(g.record(null,1,{targetKey:"t1_2",nowMs:100}).state,1,100),1);const scan={cursor:{comments:2,posts:0},startCursor:{comments:0,posts:0},seenEventIds:["t1_2"],pendingEventIds:["t1_2"]};a.equal(r.plan({attentionScan:scan},{valid:false}).attentionScan.cursor.comments,1);a.deepEqual(r.plan({attentionScan:scan},{valid:true,candidates:[{target:{key:"t1_2"}}]}).attentionScan.seenEventIds,["t1_2"]);' (Join-Path $tokenizerExtract "app")
    Assert-True ($LASTEXITCODE -eq 0) "packaged continuation guard and selective discovery receipts load and execute"

    $firstLookCheck = @'
const a = require('node:assert/strict'), path = require('node:path');
const app = process.argv[1], f = require(path.join(app, 'lib/first-contact.js'));
const b = require(path.join(app, 'lib/hosted-decision-budget.js'));
const t = require(path.join(app, 'lib/hosted-tokenizer.js'));
const roots = [1, 2].map(id => ({ kind: 'post', candidateType: 'ordinary_post',
  key: 't3_' + id, independentlyAssessed: true }));
a.equal(f.VERSION, 2);
a.equal(f.select(roots, null, null, 1), null);
a.equal(f.select(roots, null, null, 2).key, 't3_1');
const candidate = { id: 'C7', candidateType: 'ordinary_post', target: roots[0],
  context: 'A complete public root question about a moon permit.' };
const votes = [1, 2].map((id, index) => ({ id: index ? 'V5' : 'V2', targetType: 'post',
  targetId: id, author: 'other_bot', label: 'Public root ' + id, content: 'Does a moon need a permit?' }));
const packed = b.construct({ model: t.MODEL, constructionVersion: b.VERSION,
  system: 'A dry bureaucratic fixture persona.', candidates: [candidate], voteCandidates: votes,
  voteAllowance: { remaining: 8 }, decisionAt: 100, decisionContractVersion: 2,
  firstContactVersion: 2, firstContactKey: 't3_1', firstContactVoteKey: 't3_2' });
a.ok(!packed.failure && b.fits(packed.budget) && b.fits(packed.repairBudget));
a.deepEqual(packed.candidateIds, ['C7']); a.deepEqual(packed.voteIds, ['V2', 'V5']);
const handled = f.plan({ valid: true, candidates: [candidate], votes: [] }, 100, 2);
a.deepEqual(handled.keys, ['t3_1']);
a.equal(f.select(roots, f.record(null, handled), null, 2).key, 't3_2');
'@
    & node -e $firstLookCheck (Join-Path $tokenizerExtract "app")
    Assert-True ($LASTEXITCODE -eq 0) "packaged first-look v2 and two-root packing execute with legacy v1 preserved"

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

    & (Join-Path $PSScriptRoot "test-packaged-importer-runtime.ps1") -PackageFile $package
    Assert-True ($LASTEXITCODE -eq 0) "extracted package exposes the desktop importer in a real browser runtime"

    Write-Host "signed app update: $checks checks passed"
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
