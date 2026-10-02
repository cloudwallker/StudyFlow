import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { strToU8, zipSync } from 'fflate';

const result = await build({ entryPoints: ['src/entry.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
const code = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = await readFile('plugin/index.html', 'utf8');
if (template.split('/* STUDYFLOW_SCRIPT */').length !== 2) throw Error('Expected one script placeholder');
const html = template.replace('/* STUDYFLOW_SCRIPT */', () => code);
const manifest = await readFile('plugin/manifest.json', 'utf8');
// A host-side file also supports installers that require plugin.js.
// Runtime/UI lives entirely in the official iframe; no host internals are accessed.
const bootstrap = '// StudyFlow Phase 0: runtime is in index.html.\n';
const files = { 'manifest.json': strToU8(manifest), 'index.html': strToU8(html), 'plugin.js': strToU8(bootstrap) };
if (files['index.html'].length > 100000) throw Error('Plugin index.html exceeds upstream size limit');
await mkdir('dist', { recursive: true });
for (const [name, data] of Object.entries(files)) await writeFile(`dist/${name}`, data);
// ZIP DOS timestamps encode local calendar fields, so fix those fields in every timezone.
await writeFile('dist/studyflow-phase0.zip', zipSync(files, { level: 9, mtime: new Date(2020, 0, 1, 0, 0, 0) }));
console.log('Built dist/studyflow-phase0.zip (manifest.json at ZIP root)');
