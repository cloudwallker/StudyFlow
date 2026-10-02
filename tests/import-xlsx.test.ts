// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { MAX_IMPORT_BYTES } from '../src/import/json-plan';
import { parseXlsxImport } from '../src/import/xlsx-plan';

const mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const cell = (address: string, value: string, type = 'inlineStr') => type === 'inlineStr'
  ? `<c r="${address}" t="inlineStr"><is><t>${value}</t></is></c>`
  : `<c r="${address}" t="${type}"><v>${value}</v></c>`;
const row = (number: number, cells: string) => `<row r="${number}">${cells}</row>`;
const sheet = (rows: string) => `<worksheet xmlns="${mainNs}"><sheetData>${rows}</sheetData></worksheet>`;

function workbook(overrides: Record<string, Uint8Array> = {}): Uint8Array {
  const relationships = `<Relationships xmlns="${packageRelNs}">
    <Relationship Id="rMeta" Type="${relNs}/worksheet" Target="worksheets/meta.xml"/>
    <Relationship Id="rTasks" Type="${relNs}/worksheet" Target="worksheets/tasks.xml"/>
    <Relationship Id="rPlans" Type="${relNs}/worksheet" Target="worksheets/plans.xml"/>
  </Relationships>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns="${mainNs}" xmlns:r="${relNs}"><sheets><sheet name="meta" sheetId="1" r:id="rMeta"/><sheet name="tasks" sheetId="2" r:id="rTasks"/><sheet name="plans" sheetId="3" r:id="rPlans"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(relationships),
    'xl/worksheets/meta.xml': strToU8(sheet(row(1, cell('A1', 'schemaVersion')) + row(2, cell('A2', '1', 'n')))),
    'xl/worksheets/tasks.xml': strToU8(sheet(
      row(1, cell('A1', 'taskKey') + cell('B1', 'project') + cell('C1', 'title') + cell('D1', 'estimateMinutes'))
      + row(2, cell('A2', 'read') + cell('B2', '阅读') + cell('C2', '第一章') + cell('D2', '4.5E1', 'n')),
    )),
    'xl/worksheets/plans.xml': strToU8(sheet(
      row(1, cell('A1', 'date') + cell('B1', 'taskKey') + cell('C1', 'minutes'))
      + row(2, cell('A2', '2026-09-11') + cell('B2', 'read') + cell('C2', '+45', 'n')),
    )),
    ...overrides,
  };
  return zipSync(files, { level: 9 });
}

function understateExpandedSize(input: Uint8Array, entryName: string): Uint8Array {
  const bytes = input.slice(); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 30 <= bytes.length;) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true);
      const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
      if (name === entryName) view.setUint32(offset + 22, 1, true);
      offset += 30 + nameLength + extraLength + view.getUint32(offset + 18, true); continue;
    }
    if (signature === 0x02014b50) {
      const nameLength = view.getUint16(offset + 28, true); const extraLength = view.getUint16(offset + 30, true); const commentLength = view.getUint16(offset + 32, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (name === entryName) view.setUint32(offset + 24, 1, true);
      offset += 46 + nameLength + extraLength + commentLength; continue;
    }
    offset++;
  }
  return bytes;
}

it('normalizes meaningful XLSX number and text formats to the same import document as JSON', () => {
  expect(parseXlsxImport(workbook())).toEqual({
    schemaVersion: 1,
    tasks: [{ taskKey: 'read', project: '阅读', title: '第一章', estimateMinutes: 45 }],
    plans: [{ date: '2026-09-11', taskKey: 'read', minutes: 45 }],
  });
});

it('rejects formula cells even when they contain a cached static value', () => {
  const formula = sheet(
    row(1, cell('A1', 'taskKey') + cell('B1', 'project') + cell('C1', 'title') + cell('D1', 'estimateMinutes'))
    + row(2, cell('A2', 'read') + cell('B2', '阅读') + '<c r="C2" t="str"><f>&quot;第一章&quot;</f><v>第一章</v></c>' + cell('D2', '45', 'n')),
  );
  expect(() => parseXlsxImport(workbook({ 'xl/worksheets/tasks.xml': strToU8(formula) }))).toThrow(/tasks!C2.*公式/);
});

it('rejects external package relationships before reading worksheet data', () => {
  const external = `<Relationships xmlns="${packageRelNs}">
    <Relationship Id="rMeta" Type="${relNs}/worksheet" Target="worksheets/meta.xml"/>
    <Relationship Id="rTasks" Type="${relNs}/worksheet" Target="worksheets/tasks.xml"/>
    <Relationship Id="rPlans" Type="${relNs}/worksheet" Target="worksheets/plans.xml"/>
    <Relationship Id="rExternal" Type="${relNs}/hyperlink" Target="https://example.invalid/private" TargetMode="External"/>
  </Relationships>`;
  expect(() => parseXlsxImport(workbook({ 'xl/_rels/workbook.xml.rels': strToU8(external) }))).toThrow(/外部链接/);
});

it('rejects compressed input and actual expanded content beyond their independent limits', () => {
  expect(() => parseXlsxImport(new Uint8Array(MAX_IMPORT_BYTES + 1))).toThrow(/1 MiB/);
  const expanded = understateExpandedSize(workbook({ 'oversized.txt': strToU8('x'.repeat(4 * 1024 * 1024 + 1)) }), 'oversized.txt');
  expect(expanded.length).toBeLessThan(MAX_IMPORT_BYTES);
  expect(() => parseXlsxImport(expanded)).toThrow(/解压内容超过上限.*单文件 4 MiB/);
});
