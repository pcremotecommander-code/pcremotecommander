@echo off
setlocal
title PC Remote Commander
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; try { Invoke-RestMethod -Uri 'https://pc-remote-commander.pcremotecommander.workers.dev/install.ps1' | Invoke-Expression; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } catch { Write-Error $_; exit 1 }"
set "PCRC_EXIT=%ERRORLEVEL%"
if not "%PCRC_EXIT%"=="0" (
  echo.
  echo PCRC could not finish. Check the error above and your internet connection.
  echo Help: https://pc-remote-commander.pcremotecommander.workers.dev/setup/
  pause
)
exit /b %PCRC_EXIT%
