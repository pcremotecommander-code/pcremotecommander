@echo off
"%~dp0.venv\Scripts\python.exe" -m jan_mcp_commander.cli %*
if errorlevel 1 pause
