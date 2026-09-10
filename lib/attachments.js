// 聊天附件服务（AttachmentService）：上传校验 / 文本提取 / 组装给 AI 的多模态内容。
// 存储：新附件写入 Supabase Storage 私有 bucket（storage_provider='supabase'）；
//       旧附件仍从 public/uploads 本地磁盘兼容读取（storage_provider 为空）。
// 安全：MIME/扩展名/大小服务端校验；文件名清洗（防 ../ 与 HTML/SVG/JS）；所有权校验（用户 A 不能读 B）。
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError } from './rest.js';
import { downloadObject } from './storage.js';
import { attachments as attachmentsTable } from './store.js';
import { extractTextFromAttachment } from './parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

// 允许的图片（HEIC 仅当能安全识别时才放行；此处保守列为图片但不保证可预览）
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
// 允许的文件（PDF + 文本 + 常见办公文档 + 数据）
export const FILE_MIME = [
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv', 'text/x-csv',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
];

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024; // 图片 ≤ 20MB
export const FILE_MAX_BYTES = 50 * 1024 * 1024; // 文件 ≤ 50MB
export const MAX_PER_MESSAGE = 10;

// 危险扩展名黑名单（即使 MIME 伪装也拒绝）；不含 .jpg/.png 等正常图片
const DANGEROUS_EXT = /\.(exe|dll|bat|cmd|com|scr|msi|sh|js|mjs|cjs|html|htm|svg|php|py|rb|jar|apk|app|deb|rpm)$/i;

// 文件名清洗：去路径分隔符与目录穿越，只保留安全字符，限长 120
export function sanitizeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^\w.\-一-龥]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}

// 大小写兼容地取扩展名（含 jpeg/heic 等变体）
export function extOf(name, mimeType) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  if (m) return m[1];
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/heic': 'heic', 'image/heif': 'heif',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
    'text/csv': 'csv', 'text/x-csv': 'csv', 'application/json': 'json',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/zip': 'zip',
  };
  return map[mimeType] || 'bin';
}

// 判定附件种类：image / text / file（决定 AI 侧如何处理）
export function kindOf(mimeType, fileName) {
  const t = String(mimeType || '').toLowerCase();
  if (IMAGE_MIME.includes(t)) return 'image';
  if (/^text\//.test(t) || t === 'application/json') return 'text';
  if (FILE_MIME.includes(t)) return 'file';
  // MIME 缺失时按扩展名兜底
  const ext = extOf(fileName, t);
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif'].includes(ext)) return 'image';
  if (['txt', 'md', 'csv', 'json'].includes(ext)) return 'text';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'pptx', 'zip'].includes(ext)) return 'file';
  return null; // 不支持的类型
}

// 服务端校验：MIME 白名单 + 大小上限 + 危险扩展名。非法时抛 HttpError。
export function validateAttachment({ fileName, mimeType, size }) {
  const name = sanitizeFileName(fileName);
  if (DANGEROUS_EXT.test(name)) throw new HttpError(400, 'UNSAFE_TYPE', '不支持的文件类型（可能为可执行/脚本）');
  const kind = kindOf(mimeType, name);
  if (!kind) throw new HttpError(415, 'UNSUPPORTED_TYPE', '仅支持图片（JPG/PNG/WEBP/GIF/HEIC）与文档（PDF/TXT/MD/CSV/DOCX/XLSX/PPTX/JSON/ZIP）');
  const max = kind === 'image' ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
  if (Number(size) > max) throw new HttpError(413, 'TOO_LARGE', `${kind === 'image' ? '图片' : '文件'}超过 ${Math.round(max / 1024 / 1024)}MB 上限`);
  return { name, kind };
}

// 生成 Supabase Storage 对象路径：users/{userId}/chat-attachments/{uuid}-{safeFileName}。
// 上传时后端还不知道 conversationId，故用 uuid + 清洗后的文件名，后续 metadata 再关联 conversation。
export function buildStoragePath(userId, safeName) {
  return `users/${userId}/chat-attachments/${randomUUID()}-${safeName}`;
}

// 从 file_url（/uploads/xxx）解析磁盘路径；非法/越界返回 null（仅用于旧本地附件兼容）。
export function diskPath(fileUrl) {
  const name = String(fileUrl || '').replace(/^\/uploads\//, '');
  if (!name || name.includes('..') || /[\\/]/.test(name)) return null;
  return path.join(UPLOAD_DIR, name);
}

// 读取附件字节：storage_provider='supabase' 走 Storage；否则回退本地磁盘（旧数据）。
// 返回 Buffer 或 null（文件不可用）。
export async function readBuffer(rec) {
  if (rec?.storage_provider === 'supabase' && rec.storage_path) {
    try { return await downloadObject(rec.storage_path); } catch { return null; }
  }
  const p = diskPath(rec?.file_url);
  if (!p || !fs.existsSync(p)) return null;
  try { return fs.readFileSync(p); } catch { return null; }
}

// 组装给 AI 的多模态内容。
// 返回 { textBlocks: string[], imageDataUrls: string[], notes: string[] }
//   textBlocks  —— 文本/文档正文（会拼进用户消息 content）
//   imageDataUrls —— 图片 base64 data URL（给支持视觉的模型）
//   notes       —— 解析失败 / 不支持类型的说明（不伪造内容）
// 解析结果写入 attachments.extracted_text 缓存，同一附件在同会话重复引用时不重复解析。
export async function prepareAttachmentsForAI(rows) {
  const textBlocks = [];
  const imageDataUrls = [];
  const notes = [];
  for (const r of rows) {
    const buf = await readBuffer(r);
    if (!buf) { notes.push(`[附件不可用] ${r.file_name}`); continue; }
    const kind = kindOf(r.mime_type, r.file_name);
    try {
      if (kind === 'image') {
        // 图片转 data URL（供视觉模型）；HEIC 浏览器/模型可能不支持，注明
        const b64 = buf.toString('base64');
        const mime = r.mime_type || 'image/jpeg';
        imageDataUrls.push(`data:${mime};base64,${b64}`);
        if (mime === 'image/heic' || mime === 'image/heif') notes.push(`[HEIC 图片] ${r.file_name}（部分模型不支持，若识别失败请告知用户）`);
      } else if (kind === 'text') {
        const res = await extractTextFromAttachment({ buffer: buf, mimeType: r.mime_type, fileName: r.file_name });
        if (res.supported && res.text) textBlocks.push(`【附件：${r.file_name}】\n${res.text}`);
      } else {
        // file 类：PDF / DOCX / XLSX / PPTX / ZIP / 旧 DOC / 旧 XLS
        let text = r.extracted_text;
        if (text == null) {
          const res = await extractTextFromAttachment({ buffer: buf, mimeType: r.mime_type, fileName: r.file_name });
          if (res.supported) {
            text = res.text;
            try {
              await attachmentsTable.update(r.id, { extracted_text: text, extracted_text_at: new Date().toISOString() });
            } catch { /* 列不存在或写失败 → 不缓存，下次重新解析 */ }
          } else if (res.reason === 'zip_not_analyzed') {
            notes.push(`[附件] ${r.file_name}（ZIP 文件，已保存但未解压分析，如需分析压缩包内容请单独提出）`);
            continue;
          } else {
            // 解析失败（损坏/密码保护/空文档/不支持），文件仍已保存，明确告知 AI 正文未提取
            notes.push(`[附件正文解析失败] ${r.file_name}（${r.mime_type || '未知类型'}）：文件已附带但无法读取正文，请如实告知用户`);
            continue;
          }
        }
        if (text) textBlocks.push(`【附件：${r.file_name}】\n${text}`);
        else notes.push(`[附件] ${r.file_name}（${r.mime_type || '未知类型'}，正文为空）`);
      }
    } catch (e) {
      notes.push(`[附件读取失败] ${r.file_name}`);
    }
  }
  return { textBlocks, imageDataUrls, notes };
}

// 返回给前端/消息 metadata 的附件行（脱敏，含可访问 URL）。
//   - Supabase 附件：fileUrl 指向后端鉴权代理 /api/files/{id}/content（私有文件不暴露 storage 直链）
//   - 旧本地附件：fileUrl 仍为 /uploads/xxx
export function attachmentRow(r, publicUrl) {
  const isSupabase = r.storage_provider === 'supabase';
  const fileUrl = isSupabase ? `/api/files/${r.id}/content` : (r.file_url || '');
  return {
    id: r.id,
    fileName: r.file_name,
    fileUrl,
    publicUrl: publicUrl || fileUrl,
    mimeType: r.mime_type,
    size: r.size,
    kind: kindOf(r.mime_type, r.file_name),
    createdAt: r.created_at,
    storageProvider: r.storage_provider || null,
    storageBucket: r.storage_bucket || null,
    storagePath: r.storage_path || null,
  };
}
