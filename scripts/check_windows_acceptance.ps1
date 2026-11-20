$ErrorActionPreference = 'Stop'
$env:PCRC_SOURCE_ONLY_TESTS = '1'
$env:JAN_MCP_BROWSER_CHANNEL = 'chromium'
$env:JAN_TEST_PYTHON = (Get-Command python -CommandType Application | Select-Object -First 1).Source

$defender = Get-MpComputerStatus
if (-not ($defender.AMServiceEnabled -and $defender.AntivirusEnabled -and $defender.RealTimeProtectionEnabled)) {
    throw 'Windows acceptance requires Microsoft Defender real-time protection.'
}

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & $env:JAN_TEST_PYTHON -c "from jan_mcp_commander.security_scan import scan_bytes; print(scan_bytes(b'PCRC synthetic fixture')['result'])"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $env:JAN_TEST_PYTHON -m pytest -q -ra
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm.cmd run build --prefix deploy/mcp-task-server
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    node --test --test-concurrency=1 'deploy/mcp-task-server/dist/**/*.test.js'
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
