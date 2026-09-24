@echo off
setlocal
rem Windows-friendly wrapper for the built OPL DSH headless profile.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0opl-dsh.ps1" %*
exit /b %ERRORLEVEL%
