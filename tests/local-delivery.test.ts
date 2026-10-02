import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

interface DeliveryManifest {
  schemaVersion: number;
  product: string;
  version: string;
  buildId?: string;
  signature: {
    mode: string;
  };
  files: Array<{
    path: string;
    sha256: string;
    size: number;
  }>;
}

const roots: string[] = [];
const deliveryScript = resolve('scripts/local-delivery.mjs');
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'pwsh';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'studyflow-local-delivery-'));
  roots.push(root);
  return root;
}

function createPackage(root: string, name: string, version: string): string {
  const packagePath = join(root, name);
  mkdirSync(join(packagePath, 'resources', 'app'), { recursive: true });
  writeFileSync(join(packagePath, 'StudyFlow.exe'), `MZ StudyFlow ${version}`);
  writeFileSync(join(packagePath, 'resources', 'app', 'version.txt'), version);
  return packagePath;
}

function runDelivery(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [deliveryScript, ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
  });
}

function runPowerShell(
  script: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    ...args,
  ], {
    cwd: tmpdir(),
    env: environment,
    encoding: 'utf8',
  });
}

function expectSuccess(result: SpawnSyncReturns<string>): void {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function prepare(packagePath: string, version: string): DeliveryManifest {
  const result = runDelivery(['prepare', '--package', packagePath, '--version', version]);
  expectSuccess(result);
  return JSON.parse(readFileSync(join(packagePath, 'studyflow-delivery.json'), 'utf8')) as DeliveryManifest;
}

describe('Windows 本地交付', () => {
  it.skipIf(process.platform !== 'win32').each(['current', 'previous'] as const)('卸载拒绝 %s 版本文件占用且两个版本完整保留', (lockedVersion) => {
    const root = temporaryRoot();
    const localAppData = join(root, 'LocalAppData');
    const programs = join(localAppData, 'Programs');
    const installPath = createPackage(programs, 'StudyFlow', '2.0.0');
    const previousPath = createPackage(programs, 'StudyFlow.previous', '1.0.0');
    prepare(installPath, '2.0.0');
    prepare(previousPath, '1.0.0');
    const wrapper = join(root, 'locked-uninstall.ps1');
    writeFileSync(wrapper, `param([string]$Script, [string]$InstallDir, [string]$LockedFile)
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($LockedFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { & $Script -InstallDir $InstallDir -NoShortcuts }
finally { $stream.Dispose() }
`);
    const removal = runPowerShell(wrapper, [
      '-Script', resolve('scripts/uninstall-studyflow.ps1'),
      '-InstallDir', installPath,
      '-LockedFile', join(lockedVersion === 'current' ? installPath : previousPath, 'StudyFlow.exe'),
    ], { ...process.env, LOCALAPPDATA: localAppData, APPDATA: join(root, 'AppData') });

    expect(removal.status).not.toBe(0);
    expectSuccess(runDelivery(['verify', '--package', installPath]));
    expectSuccess(runDelivery(['verify', '--package', previousPath]));
    expect(`${removal.stdout}\n${removal.stderr}`).toMatch(/in use|running/i);
    // Once the fixture releases its handle, the same installation is removable.
    expectSuccess(runPowerShell(resolve('scripts/uninstall-studyflow.ps1'), [
      '-InstallDir', installPath, '-NoShortcuts',
    ], { ...process.env, LOCALAPPDATA: localAppData, APPDATA: join(root, 'AppData') }));
    expect(existsSync(installPath)).toBe(false);
    expect(existsSync(previousPath)).toBe(false);
  }, 30_000);

  it('生成随包 SHA-256 清单并拒绝包内文件被篡改', () => {
    const root = temporaryRoot();
    const packagePath = createPackage(root, 'package', '1.0.0');

    const manifest = prepare(packagePath, '1.0.0');

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      product: 'StudyFlow',
      version: '1.0.0',
      signature: { mode: 'unsigned' },
    });
    expect(manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'StudyFlow.exe',
      'install-studyflow.cmd',
      'install-studyflow.ps1',
      'rollback-studyflow.cmd',
      'uninstall-studyflow.cmd',
      'uninstall-studyflow.ps1',
      'resources/app/version.txt',
    ]));
    expectSuccess(runDelivery(['verify', '--package', packagePath]));

    writeFileSync(join(packagePath, 'StudyFlow.exe'), 'tampered');
    const verification = runDelivery(['verify', '--package', packagePath]);
    expect(verification.status).not.toBe(0);
    expect(`${verification.stdout}\n${verification.stderr}`).toContain('SHA-256');
  });

  it('拒绝清单目录穿越和不完整的签名配置', () => {
    const root = temporaryRoot();
    const packagePath = createPackage(root, 'package', '1.0.0');
    const manifest = prepare(packagePath, '1.0.0');
    manifest.files[0]!.path = '../outside.txt';
    writeFileSync(join(packagePath, 'studyflow-delivery.json'), JSON.stringify(manifest));

    const traversal = runDelivery(['verify', '--package', packagePath]);
    expect(traversal.status).not.toBe(0);
    expect(`${traversal.stdout}\n${traversal.stderr}`).toContain('不安全');

    rmSync(join(packagePath, 'studyflow-delivery.json'));
    const signing = runDelivery([
      'prepare',
      '--package', packagePath,
      '--version', '1.0.0',
      '--certificate-thumbprint', '001122',
    ]);
    expect(signing.status).not.toBe(0);
    expect(`${signing.stdout}\n${signing.stderr}`).toContain('--sign-tool');
  });

  it('接受桌面构建使用的 ISO 时间 build id', () => {
    const root = temporaryRoot();
    const packagePath = createPackage(root, 'package', '0.5.0-local');
    const buildId = '2026-09-10T11:20:00.000Z';

    const result = runDelivery([
      'prepare',
      '--package', packagePath,
      '--version', '0.5.0-local',
      '--build-id', buildId,
    ]);

    expectSuccess(result);
    const manifest = JSON.parse(readFileSync(join(packagePath, 'studyflow-delivery.json'), 'utf8')) as DeliveryManifest;
    expect(manifest.buildId).toBe(buildId);
  });
  it.skipIf(process.platform !== 'win32')('安装、升级、回退和卸载始终保留 APPDATA', () => {
    const root = temporaryRoot();
    const localAppData = join(root, 'LocalAppData');
    const appData = join(root, 'AppData');
    const installPath = join(localAppData, 'Programs', 'StudyFlow');
    const userData = join(appData, 'StudyFlow', 'studyflow.sqlite');
    const environment = { ...process.env, LOCALAPPDATA: localAppData, APPDATA: appData };
    mkdirSync(join(appData, 'StudyFlow'), { recursive: true });
    writeFileSync(userData, 'user-data-must-survive');
    const versionOne = createPackage(root, 'package-v1', '1.0.0');
    const versionTwo = createPackage(root, 'package-v2', '2.0.0');
    prepare(versionOne, '1.0.0');
    prepare(versionTwo, '2.0.0');

    expectSuccess(runPowerShell(join(versionOne, 'install-studyflow.ps1'), [
      '-InstallDir', installPath,
      '-NoShortcuts',
    ], environment));
    expect(readFileSync(join(installPath, 'resources', 'app', 'version.txt'), 'utf8')).toBe('1.0.0');

    expectSuccess(runPowerShell(join(versionTwo, 'install-studyflow.ps1'), [
      '-InstallDir', installPath,
      '-NoShortcuts',
    ], environment));
    expect(readFileSync(join(installPath, 'resources', 'app', 'version.txt'), 'utf8')).toBe('2.0.0');
    expect(readFileSync(join(`${installPath}.previous`, 'resources', 'app', 'version.txt'), 'utf8')).toBe('1.0.0');

    expectSuccess(runPowerShell(join(installPath, 'install-studyflow.ps1'), [
      '-InstallDir', installPath,
      '-Rollback',
      '-NoShortcuts',
    ], environment));
    expect(readFileSync(join(installPath, 'resources', 'app', 'version.txt'), 'utf8')).toBe('1.0.0');
    expect(readFileSync(join(`${installPath}.previous`, 'resources', 'app', 'version.txt'), 'utf8')).toBe('2.0.0');
    expect(readFileSync(userData, 'utf8')).toBe('user-data-must-survive');

    expectSuccess(runPowerShell(join(installPath, 'uninstall-studyflow.ps1'), [
      '-InstallDir', installPath,
      '-NoShortcuts',
    ], environment));
    expect(existsSync(installPath)).toBe(false);
    expect(existsSync(`${installPath}.previous`)).toBe(false);
    expect(readFileSync(userData, 'utf8')).toBe('user-data-must-survive');
  }, 30_000);

  it.skipIf(process.platform !== 'win32')('被篡改的升级包失败后保持已安装版本和用户数据不变', () => {
    const root = temporaryRoot();
    const localAppData = join(root, 'LocalAppData');
    const appData = join(root, 'AppData');
    const installPath = join(localAppData, 'Programs', 'StudyFlow');
    const userData = join(appData, 'StudyFlow', 'studyflow.sqlite');
    const environment = { ...process.env, LOCALAPPDATA: localAppData, APPDATA: appData };
    mkdirSync(join(appData, 'StudyFlow'), { recursive: true });
    writeFileSync(userData, 'existing-user-data');
    const versionOne = createPackage(root, 'package-v1', '1.0.0');
    const versionTwo = createPackage(root, 'package-v2', '2.0.0');
    prepare(versionOne, '1.0.0');
    prepare(versionTwo, '2.0.0');
    expectSuccess(runPowerShell(join(versionOne, 'install-studyflow.ps1'), [
      '-InstallDir', installPath,
      '-NoShortcuts',
    ], environment));
    writeFileSync(join(versionTwo, 'StudyFlow.exe'), 'tampered-after-manifest');

    const upgrade = runPowerShell(join(versionTwo, 'install-studyflow.ps1'), [
      '-InstallDir', installPath,
      '-NoShortcuts',
    ], environment);

    expect(upgrade.status).not.toBe(0);
    expect(readFileSync(join(installPath, 'resources', 'app', 'version.txt'), 'utf8')).toBe('1.0.0');
    expect(existsSync(`${installPath}.previous`)).toBe(false);
    expect(readFileSync(userData, 'utf8')).toBe('existing-user-data');
  }, 30_000);

  it.skipIf(process.platform !== 'win32')('拒绝安装到当前用户 LOCALAPPDATA Programs 之外', () => {
    const root = temporaryRoot();
    const localAppData = join(root, 'LocalAppData');
    const packagePath = createPackage(root, 'package', '1.0.0');
    const outside = join(root, 'outside', 'StudyFlow');
    prepare(packagePath, '1.0.0');

    const installation = runPowerShell(join(packagePath, 'install-studyflow.ps1'), [
      '-InstallDir', outside,
      '-NoShortcuts',
    ], { ...process.env, LOCALAPPDATA: localAppData, APPDATA: join(root, 'AppData') });

    expect(installation.status).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
    expect(`${installation.stdout}\n${installation.stderr}`).toContain('LOCALAPPDATA');
  });

  it.skipIf(process.platform !== 'win32')('拒绝经 LOCALAPPDATA Programs 目录联接写入其他位置', () => {
    const root = temporaryRoot();
    const localAppData = join(root, 'LocalAppData');
    const actualPrograms = join(root, 'redirected-programs');
    const linkedPrograms = join(localAppData, 'Programs');
    const packagePath = createPackage(root, 'package', '1.0.0');
    mkdirSync(localAppData, { recursive: true });
    mkdirSync(actualPrograms, { recursive: true });
    symlinkSync(actualPrograms, linkedPrograms, 'junction');
    prepare(packagePath, '1.0.0');

    const installation = runPowerShell(join(packagePath, 'install-studyflow.ps1'), [
      '-InstallDir', join(linkedPrograms, 'StudyFlow'),
      '-NoShortcuts',
    ], { ...process.env, LOCALAPPDATA: localAppData, APPDATA: join(root, 'AppData') });

    expect(installation.status).not.toBe(0);
    expect(existsSync(join(actualPrograms, 'StudyFlow'))).toBe(false);
    expect(`${installation.stdout}\n${installation.stderr}`).toContain('reparse point');
  }, 15_000);

  it.skipIf(process.platform !== 'win32')('卸载前拒绝被替换成目录联接的回退版本', () => {
    const root = temporaryRoot();
    const localAppData = join(root, 'LocalAppData');
    const installPath = join(localAppData, 'Programs', 'StudyFlow');
    const packagePath = createPackage(root, 'package', '1.0.0');
    const redirectedPackage = createPackage(root, 'redirected-package', '0.9.0');
    const environment = { ...process.env, LOCALAPPDATA: localAppData, APPDATA: join(root, 'AppData') };
    prepare(packagePath, '1.0.0');
    prepare(redirectedPackage, '0.9.0');
    expectSuccess(runPowerShell(join(packagePath, 'install-studyflow.ps1'), [
      '-InstallDir', installPath,
      '-NoShortcuts',
    ], environment));
    symlinkSync(redirectedPackage, `${installPath}.previous`, 'junction');

    const removal = runPowerShell(join(installPath, 'uninstall-studyflow.ps1'), [
      '-InstallDir', installPath,
      '-NoShortcuts',
    ], environment);

    expect(removal.status).not.toBe(0);
    expect(existsSync(join(installPath, 'StudyFlow.exe'))).toBe(true);
    expect(existsSync(join(redirectedPackage, 'StudyFlow.exe'))).toBe(true);
    expect(`${removal.stdout}\n${removal.stderr}`).toContain('reparse point');
  }, 15_000);
});
