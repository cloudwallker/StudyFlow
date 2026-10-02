import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const child = spawn(process.execPath, [resolve('node_modules/electron/install.js')], {
  env: { ...process.env, electron_config_cache: resolve('.cache/electron') }, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
