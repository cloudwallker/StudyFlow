import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = 'studyflow-delivery.json';
const PRODUCT = 'StudyFlow';
const EXECUTABLE = 'StudyFlow.exe';
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const INSTALLER_FILES = [
  'install-studyflow.cmd',
  'install-studyflow.ps1',
  'rollback-studyflow.cmd',
  'uninstall-studyflow.cmd',
  'uninstall-studyflow.ps1',
];
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const BUILD_ID_PATTERN = /^[^\u0000-\u001F\u007F]{1,128}$/u;
const THUMBPRINT_PATTERN = /^[A-F0-9]{40}$/;

function fail(message) {
  throw new Error(message);
}

function parseOptions(argv) {
  const command = argv.shift();
  if (command !== 'prepare' && command !== 'verify') {
    fail('用法: node scripts/local-delivery.mjs <prepare|verify> --package <目录> [--version <版本>]');
  }
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`参数格式错误: ${key ?? '(missing)'}`);
    }
    if (options.has(key)) fail(`参数重复: ${key}`);
    options.set(key, value);
  }
  const allowed = command === 'prepare'
    ? new Set(['--package', '--version', '--build-id', '--sign-tool', '--certificate-thumbprint'])
    : new Set(['--package', '--sign-tool']);
  for (const key of options.keys()) if (!allowed.has(key)) fail(`未知参数: ${key}`);
  const packagePath = options.get('--package');
  if (!packagePath) fail('缺少 --package');
  return { command, packagePath: resolve(packagePath), options };
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    fail(`清单包含不安全路径: ${String(value)}`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail(`清单包含不安全路径: ${value}`);
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`清单包含不安全路径: ${value}`);
  }
  return value;
}

function packageFile(packagePath, relativePath) {
  const safePath = safeRelativePath(relativePath);
  const fullPath = resolve(packagePath, ...safePath.split('/'));
  const rootPrefix = packagePath.endsWith(sep) ? packagePath : `${packagePath}${sep}`;
  if (!fullPath.startsWith(rootPrefix)) fail(`清单包含不安全路径: ${relativePath}`);
  return fullPath;
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) fail(`交付包不允许符号链接或目录联接: ${fullPath}`);
      if (info.isDirectory()) await visit(fullPath);
      else if (info.isFile()) {
        const name = relative(root, fullPath).split(sep).join('/');
        if (name.toLowerCase() !== MANIFEST_NAME.toLowerCase()) files.push(name);
      } else fail(`交付包包含不支持的文件类型: ${fullPath}`);
    }
  }
  await visit(root);
  return files;
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolveHash);
  });
  return hash.digest('hex');
}

function runSignTool(signTool, args, operation) {
  const result = spawnSync(signTool, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) fail(`${operation}失败: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${operation}失败 (${result.status ?? 'unknown'}): ${(result.stderr || result.stdout).trim()}`);
  }
}

async function signExecutables(packagePath, files, signTool, thumbprint) {
  await access(signTool);
  const executables = files.filter((name) => name.toLowerCase().endsWith('.exe'));
  if (!executables.includes(EXECUTABLE)) fail(`交付包缺少 ${EXECUTABLE}`);
  for (const name of executables) {
    const fullPath = packageFile(packagePath, name);
    runSignTool(signTool, ['sign', '/fd', 'SHA256', '/sha1', thumbprint, fullPath], `签名 ${name}`);
    runSignTool(signTool, ['verify', '/pa', '/all', fullPath], `验证签名 ${name}`);
  }
  return executables;
}

async function verifySignatures(packagePath, manifest, signTool) {
  if (manifest.signature.mode !== 'authenticode') return;
  if (!signTool) return;
  await access(signTool);
  for (const name of manifest.signature.signedFiles) {
    runSignTool(signTool, ['verify', '/pa', '/all', packageFile(packagePath, name)], `验证签名 ${name}`);
  }
}

function validateSignature(signature) {
  if (!signature || typeof signature !== 'object') fail('签名状态缺失');
  if (signature.mode === 'unsigned') {
    if (signature.reason !== 'certificate-not-configured') fail('未签名状态无效');
    return;
  }
  if (signature.mode !== 'authenticode') fail('签名模式无效');
  if (typeof signature.certificateThumbprint !== 'string'
    || !THUMBPRINT_PATTERN.test(signature.certificateThumbprint)) fail('签名证书指纹无效');
  if (!Array.isArray(signature.signedFiles) || signature.signedFiles.length === 0) fail('签名文件列表无效');
  const seen = new Set();
  for (const name of signature.signedFiles) {
    const safeName = safeRelativePath(name);
    const key = safeName.toLowerCase();
    if (seen.has(key) || !safeName.toLowerCase().endsWith('.exe')) fail('签名文件列表无效');
    seen.add(key);
  }
}

async function verifyPackage(packagePath, signTool) {
  const rootInfo = await stat(packagePath);
  if (!rootInfo.isDirectory()) fail('交付包路径不是目录');
  const manifestPath = join(packagePath, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    fail(`无法读取交付清单: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.schemaVersion !== 1 || manifest.product !== PRODUCT) fail('交付清单产品或版本无效');
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) fail('交付版本无效');
  if (manifest.executable !== EXECUTABLE || !Array.isArray(manifest.files)) fail('交付清单结构无效');
  validateSignature(manifest.signature);

  const expected = new Map();
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object') fail('交付清单文件项无效');
    const name = safeRelativePath(item.path);
    const key = name.toLowerCase();
    if (expected.has(key)) fail(`交付清单路径重复: ${name}`);
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.size) || item.size < 0) fail(`交付清单文件项无效: ${name}`);
    expected.set(key, { ...item, path: name });
  }

  const actualFiles = await walkFiles(packagePath);
  if (actualFiles.length !== expected.size) fail('交付包文件数量与 SHA-256 清单不一致');
  for (const name of actualFiles) {
    const item = expected.get(name.toLowerCase());
    if (!item) fail(`交付包含有未列入 SHA-256 清单的文件: ${name}`);
    const fullPath = packageFile(packagePath, name);
    const fileInfo = await stat(fullPath);
    if (fileInfo.size !== item.size) fail(`SHA-256 清单中的文件大小校验失败: ${name}`);
    if (await sha256(fullPath) !== item.sha256) fail(`SHA-256 校验失败: ${name}`);
  }
  if (!expected.has(EXECUTABLE.toLowerCase())) fail(`交付包缺少 ${EXECUTABLE}`);
  await verifySignatures(packagePath, manifest, signTool);
  return manifest;
}

async function preparePackage(packagePath, options) {
  const version = options.get('--version');
  const buildId = options.get('--build-id');
  if (!version || !VERSION_PATTERN.test(version)) fail('缺少或无效的 --version');
  if (buildId !== undefined && !BUILD_ID_PATTERN.test(buildId)) fail('--build-id 无效');
  const signToolOption = options.get('--sign-tool');
  const thumbprintOption = options.get('--certificate-thumbprint');
  if ((signToolOption === undefined) !== (thumbprintOption === undefined)) {
    fail('--sign-tool 与 --certificate-thumbprint 必须同时提供');
  }
  const thumbprint = thumbprintOption?.replace(/\s/g, '').toUpperCase();
  if (thumbprint !== undefined && !THUMBPRINT_PATTERN.test(thumbprint)) fail('证书指纹必须是 40 位十六进制 SHA-1');

  const rootInfo = await stat(packagePath);
  if (!rootInfo.isDirectory()) fail('交付包路径不是目录');
  await access(join(packagePath, EXECUTABLE));
  for (const name of INSTALLER_FILES) await copyFile(join(SCRIPT_DIRECTORY, name), join(packagePath, name));

  let files = await walkFiles(packagePath);
  let signature = { mode: 'unsigned', reason: 'certificate-not-configured' };
  if (signToolOption && thumbprint) {
    const signTool = resolve(signToolOption);
    const signedFiles = await signExecutables(packagePath, files, signTool, thumbprint);
    signature = {
      mode: 'authenticode',
      certificateThumbprint: thumbprint,
      timestamp: 'none-offline',
      signedFiles,
    };
    files = await walkFiles(packagePath);
  }

  const records = [];
  for (const name of files) {
    const fullPath = packageFile(packagePath, name);
    const fileInfo = await stat(fullPath);
    records.push({ path: name, sha256: await sha256(fullPath), size: fileInfo.size });
  }
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const manifest = {
    schemaVersion: 1,
    product: PRODUCT,
    version,
    ...(buildId === undefined ? {} : { buildId }),
    executable: EXECUTABLE,
    signature,
    files: records,
  };
  const manifestPath = join(packagePath, MANIFEST_NAME);
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rm(manifestPath, { force: true });
  await rename(temporaryPath, manifestPath);
  await verifyPackage(packagePath, signToolOption ? resolve(signToolOption) : undefined);
  return manifest;
}

async function main() {
  const { command, packagePath, options } = parseOptions(process.argv.slice(2));
  if (command === 'prepare') {
    const manifest = await preparePackage(packagePath, options);
    console.log(`本地交付入口已生成: ${packagePath}`);
    console.log(`版本: ${manifest.version}`);
    console.log(manifest.signature.mode === 'unsigned'
      ? '签名: 未配置用户代码签名证书（包内 SHA-256 校验仍启用）'
      : `签名: Authenticode ${manifest.signature.certificateThumbprint}（离线，无时间戳）`);
  } else {
    const signTool = options.get('--sign-tool');
    const manifest = await verifyPackage(packagePath, signTool ? resolve(signTool) : undefined);
    console.log(`SHA-256 清单校验通过: ${manifest.files.length} 个文件，版本 ${manifest.version}`);
    console.log(manifest.signature.mode === 'unsigned'
      ? '签名: 未配置；无法证明发布者身份'
      : `签名配置: ${manifest.signature.certificateThumbprint}`);
  }
}

main().catch((error) => {
  console.error(`本地交付失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
