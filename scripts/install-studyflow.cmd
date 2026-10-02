@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-studyflow.ps1"
set "studyflowExit=%ERRORLEVEL%"
echo.
if not "%studyflowExit%"=="0" echo StudyFlow installation failed. Review the message above.
if "%studyflowExit%"=="0" echo StudyFlow installation completed.
pause
exit /b %studyflowExit%
