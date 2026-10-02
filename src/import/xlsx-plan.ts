import { Unzip, UnzipInflate } from 'fflate';
import { ImportValidationError, MAX_IMPORT_BYTES, parseImport, type ImportDocument } from './json-plan';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const headers = {
  meta: ['schemaVersion'],
  tasks: ['taskKey', 'project', 'title', 'estimateMinutes'],
  plans: ['date', 'taskKey', 'minutes'],
} as const;
type Sheet = keyof typeof headers;
function fail(where: string, message: string): never { throw new ImportValidationError(`${where}: ${message}`); }
const elements = (root: Document | Element, name: string, namespace = NS): Element[] => Array.from(root.getElementsByTagNameNS(namespace, name));
const children = (root: Element, name: string): Element[] => Array.from(root.children).filter(e => e.namespaceURI === NS && e.localName === name);
// Decode once so escaped literal tokens such as _x005F_x0041_ stay literal.
const spreadsheetText = (value: string): string => value.replace(/_x([0-9a-fA-F]{4})_/g, (_token, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const richText = (root: Element): string => spreadsheetText(elements(root, 't').filter(t => t.parentElement?.localName !== 'rPh').map(t => t.textContent ?? '').join(''));

// Feed bounded compressed chunks: do not trust the ZIP's declared expanded sizes.
function unpack(bytes: Uint8Array): Map<string, Uint8Array> {
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES) fail('XLSX', '文件须为 1 MiB 以内的非空文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) fail('XLSX', 'ZIP 不完整或使用了不支持的分卷格式');
  const entries = view.getUint16(end + 10, true);
  if (entries > 128 || view.getUint16(end + 8, true) !== entries || view.getUint32(end + 12, true) + view.getUint32(end + 16, true) !== end) fail('XLSX', 'ZIP 目录无效或内部文件超过 128 个');
  const files = new Map<string, Uint8Array>(); const seen = new Set<string>();
  let total = 0; let pending = 0;
  try {
    const unzip = new Unzip(file => {
      const name = file.name;
      if (seen.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) fail('XLSX', 'ZIP 文件路径无效或重复');
      seen.add(name);
      if (seen.size > 128) fail('XLSX', '内部文件不能超过 128 个');
      if ((file.originalSize ?? 0) > 4 * 1024 * 1024) fail('XLSX', '单个内部文件不能超过 4 MiB');
      if (/vba|externalLinks|embeddings|activeX|connections\.xml/i.test(name)) fail('XLSX', '不支持宏、外部链接或嵌入对象');
      let size = 0; const chunks: Uint8Array[] = []; pending++;
      file.ondata = (error, data, final) => {
        if (error instanceof ImportValidationError) throw error;
        if (error) fail('XLSX', '压缩内容损坏或不支持');
        size += data.length; total += data.length;
        if (size > 4 * 1024 * 1024 || total > 8 * 1024 * 1024) fail('XLSX', '解压内容超过上限（单文件 4 MiB，合计 8 MiB）');
        chunks.push(data);
        if (final) {
          const result = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
          files.set(name, result); pending--;
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let offset = 0; offset < bytes.length; offset += 1024) unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
    if (pending || !files.size || files.size !== entries) fail('XLSX', '压缩文件不完整');
  } catch (error) {
    if (error instanceof ImportValidationError) throw error;
    fail('XLSX', '无法读取，请选择未加密的 .xlsx 文件');
  }
  return files;
}

function xml(bytes: Uint8Array | undefined, path: string): Document {
  if (!bytes) fail('XLSX', `缺少 ${path}`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('XLSX', '内部 XML 须为 UTF-8 编码'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('XLSX', '不支持 XML 实体或 DTD');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) fail('XLSX', '内部 XML 格式错误');
  return doc;
}

function cellValue(cell: Element, strings: string[], where: string): unknown {
  if (elements(cell, 'f').length) fail(where, '不支持公式，请粘贴为静态值');
  const type = cell.getAttribute('t'); const values = children(cell, 'v');
  if (values.length > 1) fail(where, '单元格值重复');
  const value = values[0]?.textContent ?? '';
  if (type === 'inlineStr') {
    const inline = children(cell, 'is');
    if (inline.length !== 1 || values.length) fail(where, '文本单元格格式错误');
    return richText(inline[0]!);
  }
  if (type === 's') {
    if (!/^\d+$/.test(value) || Number(value) >= strings.length) fail(where, '共享文本引用无效');
    return strings[Number(value)]!;
  }
  if (type === 'str') return spreadsheetText(value);
  if (type && type !== 'n') fail(where, '只支持文本和整数，不支持日期单元格、布尔值或错误值');
  if (!value) return '';
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) fail(where, '数字格式错误');
  return Number(value);
}

function table(doc: Document, name: Sheet, strings: string[]): { values: Record<string, unknown>[]; rows: number[] } {
  if (doc.documentElement.localName !== 'worksheet' || doc.documentElement.namespaceURI !== NS) fail(name, '不是受支持的工作表');
  if (elements(doc, 'mergeCell').length || elements(doc, 'hyperlink').length) fail(name, '不支持合并单元格或超链接');
  const data = elements(doc, 'sheetData');
  if (data.length !== 1) fail(name, '工作表数据缺失或重复');
  const cols = headers[name]; const values: Record<string, unknown>[] = []; const rows: number[] = [];
  let previous = 0; let hasHeader = false;
  for (const row of children(data[0]!, 'row')) {
    const raw = row.getAttribute('r') ?? ''; const index = Number(raw);
    if (!/^\d+$/.test(raw) || index <= previous || index > 10000) fail(name, '行号须递增且不超过 10000');
    previous = index;
    const cells = new Map<number, unknown>();
    for (const cell of children(row, 'c')) {
      const address = cell.getAttribute('r') ?? ''; const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
      if (!match || Number(match[2]) !== index) fail(`${name} 第 ${index} 行`, '单元格地址无效');
      const column = [...match[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
      if (cells.has(column)) fail(`${name}!${address}`, '单元格重复');
      const value = cellValue(cell, strings, `${name}!${address}`); cells.set(column, value);
      if (column >= cols.length && value !== '') fail(`${name}!${address}`, '含模板以外的列');
    }
    if (index === 1) {
      cols.forEach((header, column) => { if (cells.get(column) !== header) fail(`${name}!${String.fromCharCode(65 + column)}1`, `表头须为 ${header}`); });
      hasHeader = true; continue;
    }
    if ([...cells.values()].every(value => value === '')) continue;
    values.push(Object.fromEntries(cols.map((header, column) => [header, cells.get(column) ?? '']))); rows.push(index);
    if (values.length > (name === 'tasks' ? 1000 : name === 'plans' ? 5000 : 1)) fail(name, '数据行数超过上限');
  }
  if (!hasHeader) fail(name, '第 1 行缺少表头');
  return { values, rows };
}

/** Browser-only adapter. Main process revalidates the normalized JSON before preview/write. */
export function parseXlsxImport(bytes: Uint8Array): ImportDocument {
  const files = unpack(bytes);
  for (const [name, bytes] of files) {
    if (name.endsWith('.rels')) {
      const doc = xml(bytes, name);
      for (const rel of elements(doc, 'Relationship', PACKAGE_REL)) {
        if (rel.getAttribute('TargetMode') === 'External' || /vbaProject|externalLink|oleObject|hyperlink/i.test(rel.getAttribute('Type') ?? '')) fail('XLSX', '不支持宏或外部链接');
      }
    }
  }
  const types = xml(files.get('[Content_Types].xml'), '[Content_Types].xml');
  if (/macroEnabled|vbaProject/i.test(types.documentElement.textContent + new XMLSerializer().serializeToString(types))) fail('XLSX', '不支持宏工作簿');
  const workbook = xml(files.get('xl/workbook.xml'), 'xl/workbook.xml');
  const rels = xml(files.get('xl/_rels/workbook.xml.rels'), 'xl/_rels/workbook.xml.rels');
  const relationships = new Map<string, Element>();
  for (const rel of elements(rels, 'Relationship', PACKAGE_REL)) {
    const id = rel.getAttribute('Id');
    if (!id || relationships.has(id)) fail('XLSX', '工作簿关系重复或缺少标识');
    relationships.set(id, rel);
  }
  let strings: string[] = [];
  const shared = [...relationships.values()].filter(r => r.getAttribute('Type') === `${REL}/sharedStrings`);
  const partPath = (target: string): string => {
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    if (path.includes('\\') || path.split('/').some(p => p === '..' || p === '.')) fail('XLSX', '内部引用路径无效');
    return path;
  };
  if (shared.length > 1) fail('XLSX', '共享文本关系重复');
  if (shared.length) {
    const path = partPath(shared[0]!.getAttribute('Target') ?? '');
    strings = elements(xml(files.get(path), path), 'si').map(richText);
  }
  const sheets = elements(workbook, 'sheet'); const tables = new Map<Sheet, ReturnType<typeof table>>(); const paths = new Set<string>();
  if (sheets.length !== 3) fail('XLSX', '须且只能包含 meta、tasks、plans 三个工作表');
  for (const sheet of sheets) {
    const name = sheet.getAttribute('name');
    if (name !== 'meta' && name !== 'tasks' && name !== 'plans') fail('XLSX', '工作表名称须为 meta、tasks、plans');
    if (tables.has(name)) fail(name, '工作表重复');
    const rel = relationships.get(sheet.getAttributeNS(REL, 'id') ?? '');
    if (!rel || rel.getAttribute('Type') !== `${REL}/worksheet`) fail(name, '工作表引用无效');
    const path = partPath(rel.getAttribute('Target') ?? '');
    if (paths.has(path)) fail(name, '多个工作表引用同一数据'); paths.add(path);
    tables.set(name, table(xml(files.get(path), path), name, strings));
  }
  const meta = tables.get('meta')!;
  if (meta.values.length !== 1 || meta.rows[0] !== 2) fail('meta!A2', '须填写版本 1');
  try {
    return parseImport(JSON.stringify({ schemaVersion: meta.values[0]!.schemaVersion, tasks: tables.get('tasks')!.values, plans: tables.get('plans')!.values }));
  } catch (error) {
    if (!(error instanceof ImportValidationError)) throw error;
    const message = error.message.replace(/(tasks|plans)\[(\d+)\](?:\.(\w+))?/g, (_all, name: 'tasks' | 'plans', index: string, field: string | undefined) => {
      const column = field ? (headers[name] as readonly string[]).indexOf(field) : -1;
      return `${name}!${column < 0 ? '行 ' : String.fromCharCode(65 + column)}${tables.get(name)!.rows[Number(index)]}`;
    }).replace(/^schemaVersion:/, 'meta!A2:');
    throw new ImportValidationError(message);
  }
}
