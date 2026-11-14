$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../deploy/cloudflare/worker/public/install.ps1"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('pcrc-bootstrap-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$destination = Join-Path $temporary 'verified.txt'
$script:downloads = 0
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
    $script:downloads++
    [IO.File]::WriteAllText($OutFile, 'verified')
}
# Use the same hash implementation as Windows, with fixed synthetic bytes.
$sample = Join-Path $temporary 'sample.txt'
[IO.File]::WriteAllText($sample, 'verified')
$expected = (Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash
Get-PcrcVerifiedFile 'https://synthetic.invalid/file' $destination $expected
Get-PcrcVerifiedFile 'https://synthetic.invalid/file' $destination $expected
if ($script:downloads -ne 1) { throw 'Verified cache was downloaded again.' }
$denied = $false
try { Get-PcrcVerifiedFile 'https://synthetic.invalid/file' $destination ('0' * 64) } catch { $denied = $true }
if (-not $denied) { throw 'A checksum mismatch was accepted.' }
if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) { throw 'Failed download replaced the existing file.' }
if (@(Get-ChildItem -LiteralPath $temporary -Filter '*.download').Count -ne 0) { throw 'Partial download remained.' }
$launcher = "$PSScriptRoot/../deploy/cloudflare/worker/public/install/pcremotecommander.cjs"
$launcherHash = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant()
$bootstrapSource = Get-Content -LiteralPath "$PSScriptRoot/../deploy/cloudflare/worker/public/install.ps1" -Raw
if ($bootstrapSource -notmatch [regex]::Escape("'" + $launcherHash + "'")) { throw 'Bootstrap does not pin the current launcher checksum.' }
$sourceLauncher = "$PSScriptRoot/../deploy/npm/launcher/bin/pcremotecommander.cjs"
if ((Get-FileHash -LiteralPath $sourceLauncher -Algorithm SHA256).Hash.ToLowerInvariant() -ne $launcherHash) { throw 'Website and npm launchers differ.' }
$errors = $null
$tokens = $null
[Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot/../deploy/cloudflare/worker/public/install.ps1", [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw 'Bootstrap failed PowerShell parsing.' }
$originalPath = $env:Path
$runtime = Join-Path $temporary 'runtime & tools'
$npmBin = Join-Path $runtime 'node_modules\npm\bin'
New-Item -ItemType Directory -Path $npmBin -Force | Out-Null
Copy-Item -LiteralPath (Get-Command node.exe -CommandType Application).Source -Destination (Join-Path $runtime 'node.exe')
foreach ($name in @('npm', 'npx')) {
    [IO.File]::WriteAllText((Join-Path $npmBin ($name + '-cli.js')), 'console.log(JSON.stringify(process.argv.slice(2)))')
}
$script:savedUserPath = '%SystemRoot%\synthetic-existing;C:\unrelated tools'
$script:pathWrites = 0
# Mock only the persistent environment boundary: this test never changes the real user PATH.
function Get-PcrcUserPath { return $script:savedUserPath }
function Set-PcrcUserPath { param([string]$Value) $script:savedUserPath = $Value; $script:pathWrites++ }
try {
    $env:Path = $runtime + ';' + (Join-Path $env:SystemRoot 'System32')
    $previousDownloads = $script:downloads
    $selectedNode = Get-PcrcNode (Join-Path $temporary 'unused-cache')
    if ($selectedNode -ne (Join-Path $runtime 'node.exe') -or $script:downloads -ne $previousDownloads) { throw 'Compatible Node was not reused after its Windows PowerShell version probe.' }
    $commandRoot = Join-Path $temporary 'bootstrap 100% & commands'
    Enable-PcrcCommands $commandRoot (Join-Path $runtime 'node.exe')
    Enable-PcrcCommands $commandRoot (Join-Path $runtime 'node.exe')
    if ($script:pathWrites -ne 1) { throw 'Repeated setup duplicated or rewrote the user PATH.' }
    if (-not $script:savedUserPath.EndsWith('%SystemRoot%\synthetic-existing;C:\unrelated tools')) { throw 'Existing user PATH entries were lost or expanded.' }
    $bin = Join-Path $commandRoot 'bin'
    if (Test-Path -LiteralPath (Join-Path $bin 'npx.ps1')) { throw 'Setup added an execution-policy-dependent PowerShell shim.' }
    # Simulate future terminals without the development machine's Node/npm PATH entries.
    $env:Path = $bin + ';' + (Join-Path $env:SystemRoot 'System32')
    $cmdResult = & "$env:SystemRoot\System32\cmd.exe" /d /c 'npx --yes pcremotecommander@beta setup'
    if ($LASTEXITCODE -ne 0 -or ($cmdResult | ConvertFrom-Json)[2] -ne 'setup') { throw 'Fresh CMD cannot resolve npx or forward setup arguments.' }
    $psResult = & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command 'npx --yes pcremotecommander@beta setup'
    if ($LASTEXITCODE -ne 0 -or ($psResult | ConvertFrom-Json)[1] -ne 'pcremotecommander@beta') { throw 'Fresh Windows PowerShell cannot use npx.' }
    $nodeResult = & "$env:SystemRoot\System32\cmd.exe" /d /c 'node -p 2+2'
    if ($LASTEXITCODE -ne 0 -or "$nodeResult" -ne '4') { throw 'Fresh CMD cannot resolve Node.js.' }
    $npmResult = & "$env:SystemRoot\System32\cmd.exe" /d /c 'npm --version'
    if ($LASTEXITCODE -ne 0 -or ($npmResult | ConvertFrom-Json)[0] -ne '--version') { throw 'Fresh CMD cannot resolve npm.' }
} finally { $env:Path = $originalPath }
$originalAppData = $env:LOCALAPPDATA
$originalCounter = $env:PCRC_BOOTSTRAP_TEST_COUNTER
$env:PCRC_BOOTSTRAP_TEST_COUNTER = Join-Path $temporary 'launch-count.txt'
function Get-PcrcNode { param([string]$Root) return (Join-Path $runtime 'node.exe') }
function Get-PcrcVerifiedFile {
    param([string]$Url, [string]$Destination, [string]$Sha256)
    [IO.File]::WriteAllText($Destination, 'require("node:fs").appendFileSync(process.env.PCRC_BOOTSTRAP_TEST_COUNTER,"started\n");')
}
try {
    $env:LOCALAPPDATA = $temporary
    Start-Pcrc
    if (@(Get-Content -LiteralPath $env:PCRC_BOOTSTRAP_TEST_COUNTER).Count -ne 1) { throw 'One installer invocation started its runtime more than once.' }
} finally {
    $env:LOCALAPPDATA = $originalAppData
    $env:PCRC_BOOTSTRAP_TEST_COUNTER = $originalCounter
    $env:Path = $originalPath
}
Write-Output 'PASS: compatible Node version probe/reuse, verified downloads/cache, mismatch denial, pinned launcher, parsing, PATH preservation/idempotence, fresh CMD/Windows PowerShell npx, Node/npm shims, argument forwarding and one runtime launch per installer invocation. Persistent user PATH was mocked.'
