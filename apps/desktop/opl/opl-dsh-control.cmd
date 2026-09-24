@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0OPL DSH.exe" --expose-internals "%~dp0resources\control\opl-dsh-control.mjs" %*
