@echo off
setlocal
set "JAN_REMOTE_EXE=%~dp0.venv\Scripts\jan-mcp.exe"
if not exist "%JAN_REMOTE_EXE%" (
  echo JAN is not installed in this folder. Run Setup-Windows.cmd from the extracted JAN release. 1>&2
  exit /b 1
)
"%JAN_REMOTE_EXE%" remote %*
exit /b %ERRORLEVEL%
