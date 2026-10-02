@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-studyflow.ps1" -Rollback
set "studyflowExit=%ERRORLEVEL%"
echo.
if not "%studyflowExit%"=="0" echo StudyFlow rollback failed. Review the message above.
if "%studyflowExit%"=="0" echo StudyFlow program-file rollback completed. The APPDATA database was not changed.
pause
exit /b %studyflowExit%
