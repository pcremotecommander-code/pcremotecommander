@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto use_python
py -3 "%~dp0scripts\setup_windows.py" %*
goto done
:use_python
python "%~dp0scripts\setup_windows.py" %*
:done
if errorlevel 1 pause
