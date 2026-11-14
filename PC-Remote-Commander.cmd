@echo off
setlocal
where node.exe >nul 2>&1
if errorlevel 1 (
  echo PC Remote Commander requires Node.js 20 or newer. 1>&2
  exit /b 1
)
node.exe "%~dp0deploy\npm\jan-commander\bin\jan-commander.cjs" connect --project "%~dp0." %*
exit /b %ERRORLEVEL%
