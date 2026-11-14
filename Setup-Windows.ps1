param([string]$Workspace)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3 (Join-Path $PSScriptRoot 'scripts/setup_windows.py') $Workspace
} else {
  & python (Join-Path $PSScriptRoot 'scripts/setup_windows.py') $Workspace
}
exit $LASTEXITCODE
