@echo off
setlocal
set "studyflowScript=%~dp0uninstall-studyflow.ps1"
cd /d "%TEMP%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%studyflowScript%"
set "studyflowExit=%ERRORLEVEL%"
echo.
if not "%studyflowExit%"=="0" echo StudyFlow removal failed. Review the message above.
if "%studyflowExit%"=="0" echo StudyFlow was removed. APPDATA data was retained.
pause
exit /b %studyflowExit%
