[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\StudyFlow'),
    [switch]$NoShortcuts
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ManifestName = 'studyflow-delivery.json'

function Resolve-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-NoReparseAncestors([string]$Path) {
    $cursor = Resolve-FullPath $Path
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Managed path contains a reparse point: $cursor"
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent -or $parent.FullName -eq $cursor) { break }
        $cursor = $parent.FullName
    }
}

function Assert-ManagedInstallPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is not available.' }
    $programsRoot = Resolve-FullPath (Join-Path $env:LOCALAPPDATA 'Programs')
    $target = Resolve-FullPath $Path
    $prefix = $programsRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'InstallDir must be inside the current user LOCALAPPDATA\Programs directory.'
    }
    $relative = $target.Substring($prefix.Length)
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains([IO.Path]::DirectorySeparatorChar)) {
        throw 'InstallDir must be one direct child of LOCALAPPDATA\Programs.'
    }
    Assert-NoReparseAncestors $programsRoot
    Assert-NoReparseAncestors $target
    return $target
}

function Assert-RelativeManifestPath([object]$Value) {
    if (-not ($Value -is [string]) -or [string]::IsNullOrWhiteSpace($Value)) { throw 'Manifest path is invalid.' }
    $path = [string]$Value
    if ($path.Contains('\') -or [IO.Path]::IsPathRooted($path) -or $path -match '^[A-Za-z]:') {
        throw "Manifest contains an unsafe path: $path"
    }
    foreach ($segment in $path.Split('/')) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..') {
            throw "Manifest contains an unsafe path: $path"
        }
    }
    return $path
}

function Resolve-PackageFile([string]$Root, [string]$RelativePath) {
    $safePath = Assert-RelativeManifestPath $RelativePath
    $rootPath = Resolve-FullPath $Root
    $fullPath = Resolve-FullPath (Join-Path $rootPath ($safePath.Replace('/', [IO.Path]::DirectorySeparatorChar)))
    if (-not $fullPath.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest contains an unsafe path: $RelativePath"
    }
    return $fullPath
}

function Get-SafePackageFiles([string]$Root) {
    $rootPath = Resolve-FullPath $Root
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $result = New-Object 'System.Collections.Generic.List[string]'
    $queue.Enqueue($rootPath)
    while ($queue.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Installed package contains a reparse point: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) { $queue.Enqueue($entry.FullName) }
            elseif ($entry.Name -ne $ManifestName) {
                [void]$result.Add($entry.FullName.Substring($rootPath.Length + 1).Replace('\', '/'))
            }
        }
    }
    return $result.ToArray()
}

function Assert-InstalledPackage([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "StudyFlow is not installed at: $Root" }
    $manifestPath = Join-Path $Root $ManifestName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Refusing to remove a directory without a StudyFlow delivery manifest.' }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Installed package manifest cannot be parsed: $($_.Exception.Message)"
    }
    if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'StudyFlow' -or $manifest.executable -ne 'StudyFlow.exe') {
        throw 'Refusing to remove a directory with an invalid StudyFlow identity.'
    }
    $expected = @{}
    foreach ($record in @($manifest.files)) {
        $name = Assert-RelativeManifestPath $record.path
        if ($expected.ContainsKey($name)) { throw "Installed package manifest has a duplicate path: $name" }
        $expected[$name] = $record
    }
    $actual = @(Get-SafePackageFiles $Root)
    if ($actual.Count -ne $expected.Count) { throw 'Installed files do not match the StudyFlow SHA-256 manifest.' }
    foreach ($name in $actual) {
        if (-not $expected.ContainsKey($name)) { throw "Installed package has an unlisted file: $name" }
        $fullPath = Resolve-PackageFile $Root $name
        $file = Get-Item -LiteralPath $fullPath -Force
        $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($file.Length -ne [int64]$expected[$name].size -or $hash -ne [string]$expected[$name].sha256) {
            throw "Installed package integrity check failed: $name"
        }
    }
}

function Assert-PackageNotInUse([string]$Root) {
    # Check every file, not just the main executable: a player, helper or another
    # reader can keep a resource open. ReadWrite also rejects a mapped EXE/DLL.
    # Finish checks for both versions before removing any shortcut or file.
    $names = @(Get-SafePackageFiles $Root) + @($ManifestName)
    foreach ($name in $names) {
        $fullPath = Resolve-PackageFile $Root $name
        $stream = $null
        try {
            $stream = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch {
            throw "StudyFlow package is in use or not writable. Close the running application and retry uninstall: $Root"
        } finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
}

function Remove-StudyFlowShortcuts([string[]]$TargetDirectories) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcutPaths = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\StudyFlow\StudyFlow.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'StudyFlow.lnk')
    )
    foreach ($shortcutPath in $shortcutPaths) {
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { continue }
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $target = Resolve-FullPath $shortcut.TargetPath
        $owned = $false
        foreach ($directory in $TargetDirectories) {
            $expectedTarget = Resolve-FullPath (Join-Path $directory 'StudyFlow.exe')
            if ($target.Equals($expectedTarget, [StringComparison]::OrdinalIgnoreCase)) { $owned = $true }
        }
        if ($owned) { Remove-Item -LiteralPath $shortcutPath -Force }
    }
    $startMenuDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\StudyFlow'
    if ((Test-Path -LiteralPath $startMenuDirectory -PathType Container) -and
        @(Get-ChildItem -LiteralPath $startMenuDirectory -Force).Count -eq 0) {
        Remove-Item -LiteralPath $startMenuDirectory -Force
    }
}

$InstallDir = Assert-ManagedInstallPath $InstallDir
$previousPath = "$InstallDir.previous"
Assert-InstalledPackage $InstallDir
if (Test-Path -LiteralPath $previousPath) {
    Assert-NoReparseAncestors $previousPath
    Assert-InstalledPackage $previousPath
}
Assert-PackageNotInUse $InstallDir
if (Test-Path -LiteralPath $previousPath) { Assert-PackageNotInUse $previousPath }
if (-not $NoShortcuts) { Remove-StudyFlowShortcuts @($InstallDir, $previousPath) }

$currentLocation = Resolve-FullPath (Get-Location).Path
if ($currentLocation.Equals($InstallDir, [StringComparison]::OrdinalIgnoreCase) -or
    $currentLocation.StartsWith($InstallDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    Set-Location $env:TEMP
}
if (Test-Path -LiteralPath $previousPath) { Remove-Item -LiteralPath $previousPath -Recurse -Force }
Remove-Item -LiteralPath $InstallDir -Recurse -Force

Write-Host 'StudyFlow program files and shortcuts were removed.'
Write-Host 'Application data in APPDATA\StudyFlow was retained.'
