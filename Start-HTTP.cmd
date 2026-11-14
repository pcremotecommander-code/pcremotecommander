@echo off
cd /d "%~dp0"
"%~dp0.venv\Scripts\python.exe" -I -m jan_mcp_commander.http_server %*
if errorlevel 1 pause
