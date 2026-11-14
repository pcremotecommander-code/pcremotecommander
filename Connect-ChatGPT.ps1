param([string]$TunnelId, [switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path '.venv\Scripts\python.exe')) { throw 'Run Setup-Windows.cmd first.' }
$config = Get-Content -LiteralPath 'connection.json' -Raw | ConvertFrom-Json
$env:JAN_MCP_WORKSPACE = $config.workspace
New-Item -ItemType Directory -Force 'tools' | Out-Null
$tunnel = Join-Path $PSScriptRoot 'tools\tunnel-client.exe'
if (-not (Test-Path -LiteralPath $tunnel)) {
    $release = Invoke-RestMethod 'https://api.github.com/repos/openai/tunnel-client/releases/latest'
    $asset = @($release.assets | Where-Object { $_.name -match '^tunnel-client-v[^/]+-windows-amd64\.zip$' })
    $checksums = @($release.assets | Where-Object name -eq 'SHA256SUMS.txt')
    if ($asset.Count -ne 1 -or $checksums.Count -ne 1) { throw 'Could not identify the official Windows x64 release.' }
    $archive = Join-Path $PSScriptRoot 'tools\tunnel-download.zip'
    $response = (Invoke-WebRequest -UseBasicParsing $checksums[0].browser_download_url).Content
    $manifest = if ($response -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response) } else { [string]$response }
    $expected = $null
    foreach ($line in ($manifest -split "`n")) {
        if ($line -match '^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $asset[0].name) { $expected = $Matches[1] }
    }
    if (-not $expected) { throw 'Official checksum manifest did not contain the selected archive.' }
    if (-not (Test-Path -LiteralPath $archive) -or (Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) {
        Invoke-WebRequest -UseBasicParsing $asset[0].browser_download_url -OutFile $archive
    }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Tunnel download checksum verification failed.' }
    Expand-Archive -LiteralPath $archive -DestinationPath 'tools\release' -Force
    $binary = @(Get-ChildItem 'tools\release' -Filter 'tunnel-client.exe' -Recurse)
    if ($binary.Count -ne 1) { throw 'Official archive has an unexpected layout.' }
    Copy-Item -LiteralPath $binary[0].FullName -Destination $tunnel
    Remove-Item -LiteralPath $archive
}
& $tunnel --version
if ($LASTEXITCODE -ne 0) { throw 'Tunnel client failed its startup check.' }
if ($PrepareOnly) { Write-Host 'Official tunnel client installed and verified. Account activation pending.'; return }
if (-not $TunnelId) {
    Start-Process 'https://platform.openai.com/settings/organization/tunnels'
    Write-Host 'Create/reuse a tunnel associated with your ChatGPT workspace, then enter its ID.'
    $TunnelId = Read-Host 'Tunnel ID'
}
if ($TunnelId -notmatch '^tunnel_[a-zA-Z0-9]+$') { throw 'Invalid tunnel ID.' }
$secret = Read-Host 'Enter the tunnel runtime API key (hidden; never saved by JAN)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    $command = '"' + $python + '" -m jan_mcp_commander.server'
    & $tunnel init --sample sample_mcp_stdio_local --profile jan-commander --force --tunnel-id $TunnelId --mcp-command $command
    if ($LASTEXITCODE -ne 0) { throw 'Tunnel initialization failed.' }
    & $tunnel doctor --profile jan-commander --explain
    if ($LASTEXITCODE -ne 0) { throw 'Tunnel diagnostics failed. Resolve the displayed account/connection error.' }
    Write-Host 'In ChatGPT Plugins: + > Add custom MCP server > Tunnel > select this tunnel > Create as a plugin.'
    Write-Host 'Name it PC Remote Commander. Keep this window open. Press Ctrl+C here to disconnect.'
    & $tunnel run --profile jan-commander
} finally {
    Remove-Item Env:\CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secret.Dispose()
}
