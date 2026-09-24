@echo off
setlocal
"%~dp0resources\runtime\node\node.exe" "%~dp0resources\control\opl-dsh-control.mjs" %*
exit /b %ERRORLEVEL%
