import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachments } from '../lib/store.js';
import { HttpError, ok, requireFields } from '../lib/rest.js';
import { sanitizeFileName, validateAttachment, extOf, attachmentRow, buildStoragePath, readBuffer } from '../lib/attachments.js';
import { storageEnabled, ensureBucket, uploadObject, deleteObject, ATTACHMENT_BUCKET } from '../lib/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const router = Router();

// 计算本服务对外可访问的公网 base URL（协议/主机取自反向代理头，本地回退 http）。
function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

// 附件可访问 URL：Supabase 走鉴权代理 /api/files/{id}/content；旧本地走 /uploads/xxx。
function accessibleUrl(req, row) {
  const base = publicBase(req);
  const p = row.storage_provider === 'supabase' ? `/api/files/${row.id}/content` : (row.file_url || '');
  return base ? base + p : p;
}

// 统一上传核心：JSON base64（前端把文件读成 data URL 再传，与现有 /api/files/upload 一致）。
// 图片 ≤ 20MB、文件 ≤ 50MB；MIME/扩展名/大小服务端校验；文件名清洗。
// 迁移：优先写 Supabase Storage 私有 bucket；未配置/失败/迁移未跑时回退本地磁盘（不阻断上传）。
async function storeUpload(req, res) {
  requireFields(req.body, ['fileName', 'dataBase64']);
  const rawName = String(req.body.fileName);
  const mimeType = String(req.body.mimeType || 'application/octet-stream');
  const base64 = String(req.body.dataBase64).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) throw new HttpError(400, 'INVALID', '文件内容为空');

  const { name, kind } = validateAttachment({ fileName: rawName, mimeType, size: buf.length });

  if (storageEnabled()) {
    const storagePath = buildStoragePath(req.user.id, name);
    try {
      await ensureBucket();
      await uploadObject(storagePath, buf, mimeType);
      const row = await attachments.insert({
        user_id: req.user.id,
        file_name: name,
        file_url: '', // 真实来源是 storage_path，file_url 仅保留给旧本地附件
        mime_type: mimeType,
        size: buf.length,
        storage_provider: 'supabase',
        storage_bucket: ATTACHMENT_BUCKET,
        storage_path: storagePath,
      });
      return { row };
    } catch (e) {
      // 迁移未跑（列不存在）/ bucket 无权限 / 上传失败 → 删除已上传对象，回退本地磁盘
      await deleteObject(storagePath).catch(() => {});
      console.warn('[files] Supabase Storage 上传失败，回退本地磁盘：', e.message);
    }
  }

  // 本地磁盘兜底（本地调试 / 未配置 Supabase / 上游失败）
  const stored = `${randomUUID()}.${extOf(name, mimeType)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  const row = await attachments.insert({ user_id: req.user.id, file_name: name, file_url: `/uploads/${stored}`, mime_type: mimeType, size: buf.length });
  return { row };
}

// POST /api/files/upload —— JSON base64（头像/壁纸等公共图片上传，沿用）
router.post('/upload', async (req, res, next) => {
  try {
    const { row } = await storeUpload(req, res);
    const publicUrl = accessibleUrl(req, row);
    ok(res, { attachment: attachmentRow(row, publicUrl), publicUrl }, 201);
  } catch (e) { next(e); }
});

// POST /api/chat/attachments —— 聊天附件上传（同一存储；返回 attachment 供消息携带 attachmentIds）。
// 挂载点：server.js 里 filesRouter 同时挂到 /api/chat 与 /api/files，故此处相对路径为 /attachments。
router.post('/attachments', async (req, res, next) => {
  try {
    const { row } = await storeUpload(req, res);
    ok(res, { attachment: attachmentRow(row, accessibleUrl(req, row)) }, 201);
  } catch (e) { next(e); }
});

// GET /api/files —— 当前用户的附件列表（按时间倒序）
router.get('/', async (req, res, next) => {
  try {
    const rows = await attachments.all({ eq: { user_id: req.user.id }, order: { col: 'created_at', asc: false } });
    ok(res, rows.map((r) => attachmentRow(r, accessibleUrl(req, r))));
  } catch (e) { next(e); }
});

// GET /api/files/:id —— 单个附件元数据（所有权校验）
router.get('/:id', async (req, res, next) => {
  try {
    const rec = await attachments.one(req.params.id);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', '文件不存在');
    if (rec.user_id !== req.user.id) throw new HttpError(403, 'FORBIDDEN', '无权访问该文件');
    ok(res, attachmentRow(rec, accessibleUrl(req, rec)));
  } catch (e) { next(e); }
});

// GET /api/files/:id/content —— 文件内容代理（所有权校验后流式返回，供前端预览/缩略图）。
// 私有 bucket 不暴露 storage 直链、也不下发 service role key，前端凭同一会话/隐式 owner 访问。
router.get('/:id/content', async (req, res, next) => {
  try {
    const rec = await attachments.one(req.params.id);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', '文件不存在');
    if (rec.user_id !== req.user.id) throw new HttpError(403, 'FORBIDDEN', '无权访问该文件');
    const buf = await readBuffer(rec);
    if (!buf) throw new HttpError(404, 'NOT_FOUND', '文件内容不可用');
    res.setHeader('Content-Type', rec.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rec.file_name || 'file')}`);
    res.send(buf);
  } catch (e) { next(e); }
});

// DELETE /api/files/:id —— 删除附件（所有权校验：用户 A 不能删用户 B 的文件）
router.delete('/:id', async (req, res, next) => {
  try {
    const rec = await attachments.one(req.params.id);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', '文件不存在');
    if (rec.user_id !== req.user.id) throw new HttpError(403, 'FORBIDDEN', '无权删除该文件');
    if (rec.storage_provider === 'supabase' && rec.storage_path) {
      await deleteObject(rec.storage_path);
    } else {
      const fname = (rec.file_url || '').replace(/^\/uploads\//, '');
      if (fname && !fname.includes('..') && !/[\\/]/.test(fname)) fs.rmSync(path.join(UPLOAD_DIR, fname), { force: true });
    }
    await attachments.remove(req.params.id);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

export default router;
