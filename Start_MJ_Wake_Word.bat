@echo off
title MJ -- Wake Word Service
color 0B

echo ==============================================
echo   MJ -- Starting Wake Word Listener...
echo ==============================================

cd /d "%~dp0"

if exist ".venv\Scripts\activate.bat" (
    call .venv\Scripts\activate.bat
)

echo.
echo Launching Wake Word Listener ("wake up mj")...
python wake_service.py

echo.
pause
