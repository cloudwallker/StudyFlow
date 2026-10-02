import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { Diagnostics, safeError, isExpectedRejection } from '../src/desktop/diagnostics';
import { parseImport } from '../src/import/json-plan';

const roots: string[] = [];
function setup(maxBytes = 4096) {
  const root = mkdtempSync(join(tmpdir(), 'studyflow-diagnostics-')); roots.push(root);
  return { root, log: new Diagnostics(root, { version: '0.3.0-test.1', buildId: 'test-build', maxBytes }) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('local diagnostics', () => {
  it('counts unknown plain errors as faults but recognizes deliberate validation failures', () => {
    expect(isExpectedRejection(new Error('设置数据缺失，请恢复备份'))).toBe(false);
    expect(isExpectedRejection(new Error('unanticipated storage failure'))).toBe(false);
    expect(isExpectedRejection(new Error('请选择未完成的任务'))).toBe(true);
    try { parseImport('{broken json'); } catch (error) { expect(isExpectedRejection(error)).toBe(true); }
  });
  it('removes abandoned atomic-write temporary files from expired runs', () => {
    const { root } = setup();
    const file = '00000000-0000-0000-0000-000000000000.summary.json.tmp';
    writeFileSync(join(root, file), '{}');
    const log = new Diagnostics(root, { version: '0.3.0-test.1', buildId: 'test-build' });
    expect(readdirSync(root)).not.toContain(file); log.finish();
  });
  it('never persists task payloads, raw messages, paths or arbitrary fields', () => {
    const { root, log } = setup();
    const error = new Error('private task C:\\Users\\secret\\file token=SECRET');
    error.stack = 'Error: SECRET\n at save (C:\\private\\main.cjs:42:8)';
    log.record('command_failed', { command: 'confirmImport', ...safeError(error), title: 'SECRET', path: 'SECRET' });
    log.record('SECRET', { command: 'SECRET' });
    const content = readFileSync(join(root, 'events.jsonl'), 'utf8');
    expect(content).toContain('confirmImport'); expect(content).toContain('main.cjs:42:8');
    expect(content).not.toContain('SECRET'); expect(content).not.toContain('private');
    expect(log.status().errors).toBe(1);
  });
  it('rotates bounded logs but preserves total error counts', () => {
    const { root, log } = setup(512);
    for (let i = 0; i < 200; i++) log.record('sample_failed', { reason: 'timeout' });
    expect(readdirSync(root).filter(name => name.startsWith('events.')).length).toBeLessThanOrEqual(5);
    expect(log.status().errors).toBe(200);
    log.finish();
    expect(readFileSync(join(root, `${log.runId}.summary.json`), 'utf8')).toContain('200');
  });
  it('distinguishes diagnostic self tests and expected validation from real errors', () => {
    const { log } = setup(); log.record('self_test', safeError(new Error('fictional')));
    log.record('command_rejected', { command: 'previewImport' });
    log.record('issue_mark', { category: 'timer' });
    expect(log.status()).toMatchObject({ errors: 0, warnings: 0, marks: 1 });
  });
  it('exports only diagnostic allowlisted files and reports previous abnormal termination', () => {
    const { root, log } = setup(); log.heartbeat();
    writeFileSync(join(root, 'studyflow.sqlite'), 'SECRET'); writeFileSync(join(root, 'unrelated.txt'), 'SECRET');
    const next = new Diagnostics(root, { version: '0.3.0-test.1', buildId: 'test-build' });
    expect(readFileSync(join(root, 'events.jsonl'), 'utf8')).toContain('previous_unclean');
    const files = unzipSync(next.exportZip());
    expect(Object.keys(files)).toContain('report.json'); expect(Object.keys(files)).not.toContain('studyflow.sqlite');
    expect(Object.values(files).map(bytes => strFromU8(bytes)).join('')).not.toContain('SECRET');
    expect(JSON.parse(strFromU8(files['report.json']!)).limitations).toBeDefined();
    next.finish();
    expect(readdirSync(root)).toContain(`${next.runId}.done`);
  });
  it('does not treat a clean restart as an abnormal termination', () => {
    const { root, log } = setup(); log.finish();
    const next = new Diagnostics(root, { version: '0.3.0-test.1', buildId: 'test-build' });
    expect(readFileSync(join(root, 'events.jsonl'), 'utf8')).not.toContain('previous_unclean'); next.finish();
  });
  it('contains logger write failure without crashing the business flow', () => {
    const { root, log } = setup(); rmSync(root, { recursive: true });
    expect(() => log.record('sample_failed')).not.toThrow(); expect(log.status().writeFailures).toBeGreaterThan(0);
  });
});
