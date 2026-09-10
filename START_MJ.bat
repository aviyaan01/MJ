@echo off
title MJ -- AI Desktop Assistant
color 0B

echo ===================================================
echo    MJ AI Engine -- Launcher
echo ===================================================
echo.

cd /d "%~dp0"

REM ── Check if virtualenv exists ──────────────────────────────────────────
if exist ".venv\Scripts\activate.bat" (
    call .venv\Scripts\activate.bat
)

echo Launching MJ AI Assistant...
python main.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo MJ closed with an error (code %ERRORLEVEL%).
    pause
)
