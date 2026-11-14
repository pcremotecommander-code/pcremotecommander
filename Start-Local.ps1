$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$config = Get-Content -LiteralPath 'connection.json' -Raw | ConvertFrom-Json
$env:JAN_MCP_WORKSPACE = $config.workspace
& .\.venv\Scripts\python.exe -m jan_mcp_commander.server
exit $LASTEXITCODE
