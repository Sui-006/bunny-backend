import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import {
  extractPdfText, extractDocxText, extractXlsxText, extractPptxText,
  extractTextFromAttachment, MAX_EXTRACTED_TEXT_CHARS,
} from '../lib/parsers.js';
import { sanitizeFileName, buildStoragePath, attachmentRow, validateAttachment } from '../lib/attachments.js';

// ---- 确定性测试文档生成器（无网络、无外部文件） ----

async function makePdf(text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText(text, { x: 50, y: 750, size: 24, font });
  return Buffer.from(await doc.save());
}

function makeDocx() {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>Hello from DOCX</w:t></w:r></w:p>
<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
</w:body>
</w:document>`));
  return zip.toBuffer();
}

async function makeXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Expenses');
  ws.addRow(['Date', 'Item', 'Amount']);
  ws.addRow(['2026-09-01', 'Coffee', 5]);
  ws.addRow(['2026-09-02', 'Food', 20]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function makePptx() {
  const zip = new AdmZip();
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld><a:t>Project Overview</a:t><a:t>Revenue &amp; Growth</a:t></p:sld>'));
  zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sld><a:t>Summary</a:t></p:sld>'));
  return zip.toBuffer();
}

// ---- PDF ----
test('PDF：提取正文 + 页码', async () => {
  const r = await extractPdfText(await makePdf('Hello PDF'));
  assert.equal(r.supported, true);
  assert.equal(r.pages, 1);
  assert.ok(r.text.includes('Hello PDF'));
  assert.ok(r.text.includes('[Page 1]'));
});

// ---- DOCX ----
test('DOCX：提取段落文本', async () => {
  const r = await extractDocxText(makeDocx());
  assert.equal(r.supported, true);
  assert.ok(r.text.includes('Hello from DOCX'));
  assert.ok(r.text.includes('Second paragraph'));
});

// ---- XLSX ----
test('XLSX：提取 sheet 名 + 表格行', async () => {
  const r = await extractXlsxText(await makeXlsx());
  assert.equal(r.supported, true);
  assert.ok(r.text.includes('[Sheet: Expenses]'));
  assert.ok(r.text.includes('Date | Item | Amount'));
  assert.ok(r.text.includes('2026-09-01 | Coffee | 5'));
});

// ---- PPTX ----
test('PPTX：提取 slide 编号 + 文本（含 XML 实体还原）', async () => {
  const r = await extractPptxText(makePptx());
  assert.equal(r.supported, true);
  assert.ok(r.text.includes('[Slide 1]'));
  assert.ok(r.text.includes('Project Overview'));
  assert.ok(r.text.includes('Revenue & Growth')); // &amp; → &
  assert.ok(r.text.includes('[Slide 2]'));
});

// ---- 统一入口 ----
test('统一入口：TXT / JSON / 未知类型', async () => {
  const txt = await extractTextFromAttachment({ buffer: Buffer.from('hello'), mimeType: 'text/plain', fileName: 'a.txt' });
  assert.equal(txt.supported, true);
  assert.equal(txt.text, 'hello');

  const json = await extractTextFromAttachment({ buffer: Buffer.from('{"a":1}'), mimeType: 'application/json', fileName: 'a.json' });
  assert.equal(json.supported, true);
  assert.ok(json.text.includes('"a"'));

  const zip = await extractTextFromAttachment({ buffer: Buffer.from('PK\x03\x04'), mimeType: 'application/zip', fileName: 'a.zip' });
  assert.equal(zip.supported, false);
  assert.equal(zip.reason, 'zip_not_analyzed');
});

// ---- 损坏 / 空输入不崩溃 ----
test('损坏文件：PDF/DOCX/XLSX/PPTX 均优雅降级为 supported=false', async () => {
  const garbage = Buffer.from('this is not a valid document');
  assert.equal((await extractPdfText(garbage)).supported, false);
  assert.equal((await extractDocxText(garbage)).supported, false);
  assert.equal((await extractXlsxText(garbage)).supported, false);
  assert.equal((await extractPptxText(garbage)).supported, false);
});

// ---- 超大文本截断 + 显式提示 ----
test('超大文本：超过上限截断并明确提示，不静默丢弃', async () => {
  const big = Buffer.from('x'.repeat(MAX_EXTRACTED_TEXT_CHARS + 500));
  const r = await extractTextFromAttachment({ buffer: big, mimeType: 'text/plain', fileName: 'big.txt' });
  assert.equal(r.supported, true);
  assert.ok(r.text.length < MAX_EXTRACTED_TEXT_CHARS + 100);
  assert.ok(r.text.includes('正文过长'));
});

// ---- 文件名清洗 / 路径穿越 ----
test('文件名清洗：阻断 ../ 与路径穿越', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('..\\..\\windows\\system32'), 'system32');
  const clean = sanitizeFileName('报告 (final).pdf');
  assert.ok(!clean.includes('/') && !clean.includes('\\') && !clean.includes('..'));
});

// ---- 危险扩展名 / 大小校验 ----
test('validateAttachment：拒绝可执行/脚本，通过正常文档', () => {
  assert.throws(() => validateAttachment({ fileName: 'evil.exe', mimeType: 'application/octet-stream', size: 10 }), /UNSAFE_TYPE|不支持/);
  assert.throws(() => validateAttachment({ fileName: 'a.svg', mimeType: 'image/svg+xml', size: 10 }), /UNSUPPORTED_TYPE|不支持/);
  const ok = validateAttachment({ fileName: 'report.pdf', mimeType: 'application/pdf', size: 1000 });
  assert.equal(ok.kind, 'file');
  assert.equal(ok.name, 'report.pdf');
});

// ---- Storage 路径 & 附件行（Supabase 迁移相关） ----
test('buildStoragePath：users/{uid}/chat-attachments/{uuid}-{safeName}', () => {
  const p = buildStoragePath('user-1', 'report.pdf');
  assert.match(p, /^users\/user-1\/chat-attachments\/[0-9a-f-]{36}-report\.pdf$/);
});

test('attachmentRow：Supabase 附件走鉴权代理，旧本地附件走 /uploads', () => {
  const sup = attachmentRow({ id: 'abc', file_name: 'r.pdf', file_url: '', mime_type: 'application/pdf', size: 10, storage_provider: 'supabase', storage_path: 'users/1/chat-attachments/x.pdf' });
  assert.equal(sup.fileUrl, '/api/files/abc/content');
  assert.equal(sup.storageProvider, 'supabase');

  const local = attachmentRow({ id: 'def', file_name: 'r.pdf', file_url: '/uploads/xyz.pdf', mime_type: 'application/pdf', size: 10 });
  assert.equal(local.fileUrl, '/uploads/xyz.pdf');
  assert.equal(local.storageProvider, null);
});
