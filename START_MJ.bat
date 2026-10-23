@echo off
title MJ -- AI Desktop Assistant
color 0B

echo ===================================================
echo    MJ AI Engine -- Launcher
echo ===================================================
echo.

cd /d "%~dp0"

REM ── Check for Administrator privileges ────────────────────────────────────
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [MJ] Tip: Running as Administrator allows complete hardware and window controls.
)

REM ── Check if virtualenv exists ──────────────────────────────────────────
if exist .venv\Scripts\activate.bat (
    call .venv\Scripts\activate.bat
)

echo Launching MJ AI Assistant...
set "PY_CMD=python"
if exist .venv\Scripts\python.exe (
    set "PY_CMD=.venv\Scripts\python.exe"
)

%PY_CMD% main.py

if %ERRORLEVEL% NEQ 0 (
    echo [MJ] Process exited with code %ERRORLEVEL%.
    pause
)
