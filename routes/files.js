import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachments } from '../lib/store.js';
import { HttpError, ok, requireFields } from '../lib/rest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const MAX_BYTES = 8 * 1024 * 1024;

const router = Router();

const toRow = (r) => ({ id: r.id, fileName: r.file_name, fileUrl: r.file_url, mimeType: r.mime_type, size: r.size, createdAt: r.created_at });

// 计算本服务对外可访问的公网 base URL（协议/主机取自反向代理头，本地回退 http）。
// 用于把 /uploads/… 相对路径补全成真实公网 URL（如 Bark icon 需要 iPhone 可访问的 HTTPS 地址）。
function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

// POST /api/files/upload —— JSON base64（前端把文件读成 data URL 再传）
router.post('/upload', async (req, res, next) => {
  try {
    requireFields(req.body, ['fileName', 'dataBase64']);
    const fileName = String(req.body.fileName).replace(/[^\w.\-]+/g, '_').slice(0, 120);
    const mimeType = String(req.body.mimeType || 'application/octet-stream');
    const ext = EXT[mimeType] || 'bin';
    const base64 = String(req.body.dataBase64).replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) throw new HttpError(400, 'INVALID', '文件内容为空');
    if (buf.length > MAX_BYTES) throw new HttpError(413, 'TOO_LARGE', '文件超过 8MB');

    const stored = `${randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
    const row = await attachments.insert({ user_id: req.user.id, file_name: fileName, file_url: `/uploads/${stored}`, mime_type: mimeType, size: buf.length });
    ok(res, { attachment: toRow(row), publicUrl: `${publicBase(req)}/uploads/${stored}` }, 201);
  } catch (e) { next(e); }
});

// GET /api/files
router.get('/', async (req, res, next) => {
  try {
    const rows = await attachments.all({ eq: { user_id: req.user.id }, order: { col: 'created_at', asc: false } });
    ok(res, rows.map(toRow));
  } catch (e) { next(e); }
});

// DELETE /api/files/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const rec = await attachments.one(req.params.id);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', '文件不存在');
    const fname = (rec.file_url || '').replace(/^\/uploads\//, '');
    if (fname && !fname.includes('..')) fs.rmSync(path.join(UPLOAD_DIR, fname), { force: true });
    await attachments.remove(req.params.id);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

export default router;
