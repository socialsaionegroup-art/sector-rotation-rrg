@echo off
cd /d "%~dp0"
where py >nul 2>&1 && (py serve.py %*) || (python serve.py %*)
if errorlevel 1 (
  echo.
  echo Something went wrong. Make sure Python 3 is installed and on PATH.
  pause
)
