[CmdletBinding()]
param(
    [string]$SourcePath,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\StudyFlow'),
    [switch]$Rollback,
    [switch]$NoShortcuts
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ManifestName = 'studyflow-delivery.json'
$ExpectedProduct = 'StudyFlow'
$ExpectedExecutable = 'StudyFlow.exe'

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
    if (-not ($Value -is [string]) -or [string]::IsNullOrWhiteSpace($Value)) {
        throw 'Manifest contains an invalid path.'
    }
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
    $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
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
        $directory = $queue.Dequeue()
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Package contains a reparse point: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) {
                $queue.Enqueue($entry.FullName)
            } elseif ($entry.Name -ne $ManifestName) {
                $name = $entry.FullName.Substring($rootPath.Length + 1).Replace('\', '/')
                [void]$result.Add($name)
            }
        }
    }
    return $result.ToArray()
}

function Assert-DeliveryPackage([string]$Root) {
    $rootPath = Resolve-FullPath $Root
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { throw "Package directory is missing: $rootPath" }
    $rootItem = Get-Item -LiteralPath $rootPath -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Package root cannot be a reparse point.' }
    $manifestPath = Join-Path $rootPath $ManifestName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Package manifest is missing: $ManifestName" }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Package manifest cannot be parsed: $($_.Exception.Message)"
    }
    if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne $ExpectedProduct -or
        $manifest.executable -ne $ExpectedExecutable -or [string]::IsNullOrWhiteSpace([string]$manifest.version)) {
        throw 'Package manifest identity is invalid.'
    }
    $expected = @{}
    foreach ($record in @($manifest.files)) {
        $name = Assert-RelativeManifestPath $record.path
        if ($expected.ContainsKey($name)) { throw "Package manifest has a duplicate path: $name" }
        if (-not ([string]$record.sha256 -match '^[a-f0-9]{64}$') -or [int64]$record.size -lt 0) {
            throw "Package manifest has an invalid file record: $name"
        }
        $expected[$name] = $record
    }
    $actual = @(Get-SafePackageFiles $rootPath)
    if ($actual.Count -ne $expected.Count) { throw 'Package file count does not match the SHA-256 manifest.' }
    foreach ($name in $actual) {
        if (-not $expected.ContainsKey($name)) { throw "Package has an unlisted file: $name" }
        $fullPath = Resolve-PackageFile $rootPath $name
        $file = Get-Item -LiteralPath $fullPath -Force
        if ($file.Length -ne [int64]$expected[$name].size) { throw "Package file size check failed: $name" }
        $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne [string]$expected[$name].sha256) { throw "Package SHA-256 check failed: $name" }
    }
    if (-not $expected.ContainsKey($ExpectedExecutable)) { throw "Package is missing $ExpectedExecutable" }

    if ($manifest.signature.mode -eq 'authenticode') {
        $thumbprint = ([string]$manifest.signature.certificateThumbprint).Replace(' ', '').ToUpperInvariant()
        if ($thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'Package certificate thumbprint is invalid.' }
        foreach ($nameObject in @($manifest.signature.signedFiles)) {
            $name = Assert-RelativeManifestPath $nameObject
            if (-not $expected.ContainsKey($name)) { throw "Signed file is not listed in the manifest: $name" }
            $signature = Get-AuthenticodeSignature -LiteralPath (Resolve-PackageFile $rootPath $name)
            if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
                $null -eq $signature.SignerCertificate -or
                $signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $thumbprint) {
                throw "Authenticode verification failed: $name ($($signature.Status))"
            }
        }
    } elseif ($manifest.signature.mode -eq 'unsigned' -and $manifest.signature.reason -eq 'certificate-not-configured') {
        Write-Warning 'This StudyFlow package is unsigned. SHA-256 checks protect local package integrity but do not prove publisher identity.'
    } else {
        throw 'Package signature state is invalid.'
    }
    return $manifest
}

function Copy-DeliveryPackage([string]$Source, [string]$Destination, [object]$Manifest) {
    [void](New-Item -ItemType Directory -Path $Destination -Force)
    foreach ($record in @($Manifest.files)) {
        $sourceFile = Resolve-PackageFile $Source ([string]$record.path)
        $destinationFile = Resolve-PackageFile $Destination ([string]$record.path)
        $parent = Split-Path -Parent $destinationFile
        [void](New-Item -ItemType Directory -Path $parent -Force)
        Copy-Item -LiteralPath $sourceFile -Destination $destinationFile
    }
    Copy-Item -LiteralPath (Join-Path $Source $ManifestName) -Destination (Join-Path $Destination $ManifestName)
}

function Set-StudyFlowShortcuts([string]$TargetDirectory) {
    $target = Join-Path $TargetDirectory $ExpectedExecutable
    $shell = New-Object -ComObject WScript.Shell
    $startMenuDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\StudyFlow'
    [void](New-Item -ItemType Directory -Path $startMenuDirectory -Force)
    $desktopDirectory = [Environment]::GetFolderPath('Desktop')
    foreach ($shortcutPath in @((Join-Path $startMenuDirectory 'StudyFlow.lnk'), (Join-Path $desktopDirectory 'StudyFlow.lnk'))) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $target
        $shortcut.WorkingDirectory = $TargetDirectory
        $shortcut.IconLocation = "$target,0"
        $shortcut.Save()
    }
}

function Invoke-Rollback([string]$CurrentPath, [switch]$SkipShortcuts) {
    $previousPath = "$CurrentPath.previous"
    if (-not (Test-Path -LiteralPath $CurrentPath -PathType Container) -or
        -not (Test-Path -LiteralPath $previousPath -PathType Container)) {
        throw 'Rollback requires both the current and previous StudyFlow versions.'
    }
    [void](Assert-DeliveryPackage $CurrentPath)
    [void](Assert-DeliveryPackage $previousPath)
    $swapPath = Join-Path (Split-Path -Parent $CurrentPath) ('.StudyFlow.swap-' + [Guid]::NewGuid().ToString('N'))
    try {
        Move-Item -LiteralPath $CurrentPath -Destination $swapPath
        Move-Item -LiteralPath $previousPath -Destination $CurrentPath
        Move-Item -LiteralPath $swapPath -Destination $previousPath
        [void](Assert-DeliveryPackage $CurrentPath)
        if (-not $SkipShortcuts) {
            try { Set-StudyFlowShortcuts $CurrentPath }
            catch { Write-Warning "Program rollback completed, but shortcuts could not be updated: $($_.Exception.Message)" }
        }
    } catch {
        if (Test-Path -LiteralPath $swapPath -PathType Container) {
            if (Test-Path -LiteralPath $CurrentPath -PathType Container) {
                Move-Item -LiteralPath $CurrentPath -Destination $previousPath -Force
            }
            Move-Item -LiteralPath $swapPath -Destination $CurrentPath
        }
        throw
    }
}

if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $SourcePath = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$InstallDir = Assert-ManagedInstallPath $InstallDir
if ($Rollback) {
    Invoke-Rollback $InstallDir -SkipShortcuts:$NoShortcuts
    Write-Host "StudyFlow rollback completed: $InstallDir"
    Write-Warning 'Rollback changes program files only. The APPDATA database is unchanged and may require an explicit compatible backup restore.'
    exit 0
}

$SourcePath = Resolve-FullPath $SourcePath
$sourceManifest = Assert-DeliveryPackage $SourcePath
$parent = Split-Path -Parent $InstallDir
[void](New-Item -ItemType Directory -Path $parent -Force)
$stagePath = Join-Path $parent ('.StudyFlow.stage-' + [Guid]::NewGuid().ToString('N'))
$previousPath = "$InstallDir.previous"
$oldMoved = $false
$activated = $false

try {
    Copy-DeliveryPackage $SourcePath $stagePath $sourceManifest
    [void](Assert-DeliveryPackage $stagePath)
    if (Test-Path -LiteralPath $InstallDir) { [void](Assert-DeliveryPackage $InstallDir) }
    if (Test-Path -LiteralPath $previousPath) {
        [void](Assert-DeliveryPackage $previousPath)
        Remove-Item -LiteralPath $previousPath -Recurse -Force
    }
    if (Test-Path -LiteralPath $InstallDir) {
        Move-Item -LiteralPath $InstallDir -Destination $previousPath
        $oldMoved = $true
    }
    Move-Item -LiteralPath $stagePath -Destination $InstallDir
    $activated = $true
    [void](Assert-DeliveryPackage $InstallDir)
} catch {
    $failure = $_
    if ($activated -and (Test-Path -LiteralPath $InstallDir -PathType Container)) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
    }
    if ($oldMoved -and (Test-Path -LiteralPath $previousPath -PathType Container)) {
        Move-Item -LiteralPath $previousPath -Destination $InstallDir
    }
    if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
    throw $failure
}

if (-not $NoShortcuts) {
    try { Set-StudyFlowShortcuts $InstallDir }
    catch { Write-Warning "StudyFlow was installed, but shortcuts could not be created: $($_.Exception.Message)" }
}

Write-Host "StudyFlow $($sourceManifest.version) installed for the current user: $InstallDir"
Write-Host 'Application data in APPDATA\StudyFlow was not modified.'
if ($oldMoved) { Write-Host "Previous version retained for rollback: $previousPath" }
