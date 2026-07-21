@echo off
cd /d "%~dp0"
start "Grimoire" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
