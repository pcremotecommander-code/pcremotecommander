@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Connect-ChatGPT.ps1" %*
pause
