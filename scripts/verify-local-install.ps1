[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PackagePath)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$package = [IO.Path]::GetFullPath($PackagePath)
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$verificationRoot = Join-Path $workspace ('.cache\local-install-smoke\run-' + [Guid]::NewGuid().ToString('N'))
if (-not $verificationRoot.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Verification path escaped workspace.' }
$oldLocalAppData = $env:LOCALAPPDATA
$oldAppData = $env:APPDATA
$oldDataDirectory = $env:STUDYFLOW_DATA_DIR
$oldHidden = $env:STUDYFLOW_HIDDEN
$testProcess = $null
try {
    $env:LOCALAPPDATA = Join-Path $verificationRoot 'LocalAppData'
    $env:APPDATA = Join-Path $verificationRoot 'AppData'
    $env:STUDYFLOW_DATA_DIR = Join-Path $env:APPDATA 'StudyFlow'
    $env:STUDYFLOW_HIDDEN = '1'
    [void](New-Item -ItemType Directory -Path $env:STUDYFLOW_DATA_DIR -Force)
    $sentinel = Join-Path $env:STUDYFLOW_DATA_DIR 'keep-fixture.txt'
    [IO.File]::WriteAllText($sentinel, 'fictional-data-must-survive')
    $target = Join-Path $env:LOCALAPPDATA 'Programs\StudyFlow'
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    function Invoke-Installer([string]$Script, [string[]]$Options) {
        & $shell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Script @Options
        if ($LASTEXITCODE -ne 0) { throw "Delivery script failed: $LASTEXITCODE" }
    }
    Invoke-Installer (Join-Path $package 'install-studyflow.ps1') @('-InstallDir', $target, '-NoShortcuts')
    $testProcess = Start-Process -FilePath (Join-Path $target 'StudyFlow.exe') -WindowStyle Hidden -PassThru
    $database = Join-Path $env:STUDYFLOW_DATA_DIR 'studyflow.sqlite'
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($testProcess.HasExited) { throw 'Installed executable exited before verification.' }
        if (Test-Path -LiteralPath $database -PathType Leaf) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw 'Installed executable did not initialize SQLite.' }
    # This isolated startup probe intentionally terminates its own child. Clean
    # product shutdown is covered separately by the Electron/package verifiers.
    Stop-Process -Id $testProcess.Id -Force
    $testProcess.WaitForExit()
    Start-Sleep -Milliseconds 500
    $testProcess = $null
    $databaseHash = (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash
    Invoke-Installer (Join-Path $package 'install-studyflow.ps1') @('-InstallDir', $target, '-NoShortcuts')
    if (-not (Test-Path -LiteralPath "$target.previous\StudyFlow.exe")) { throw 'Upgrade did not retain previous program files.' }
    Invoke-Installer (Join-Path $target 'install-studyflow.ps1') @('-InstallDir', $target, '-Rollback', '-NoShortcuts')
    Invoke-Installer (Join-Path $target 'uninstall-studyflow.ps1') @('-InstallDir', $target, '-NoShortcuts')
    if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath "$target.previous")) { throw 'Uninstall left managed application directories.' }
    if ([IO.File]::ReadAllText($sentinel) -ne 'fictional-data-must-survive' -or (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash -ne $databaseHash) { throw 'Delivery operation changed application data.' }
    Write-Host 'PASS: final payload isolated installation, executable/SQLite startup, same-version upgrade, rollback and uninstall retain data.'
    Write-Host 'LIMIT: no real desktop shortcuts; cross-version replacement is covered by synthetic delivery tests; startup probe uses forced exit.'
    Write-Host "Evidence retained: $verificationRoot"
} finally {
    if ($null -ne $testProcess -and -not $testProcess.HasExited) { Stop-Process -Id $testProcess.Id -Force }
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:APPDATA = $oldAppData
    $env:STUDYFLOW_DATA_DIR = $oldDataDirectory
    $env:STUDYFLOW_HIDDEN = $oldHidden
}
