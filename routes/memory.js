import { Router } from 'express';
import { getState, withDocVersioned } from '../lib/domain.js';
import { HttpError, ok } from '../lib/rest.js';
import * as memory from '../services/memory-service.js';

// 用户长期记忆 REST API（挂载于 /api/memories，requireAuth 由 server.js 保证）。
// 所有读写以 getState(req.user.id) 的 owner 文档为准：天然按 userId 隔离，前端不可传入任意 userId。
// 写操作一律走 withDocVersioned（乐观并发 + 版本 CAS + 冲突重试），响应带最新 version 供前端同步兼容缓存。
const router = Router();

// 从 body 挑出可写字段（只接受白名单，忽略未知字段，防止注入内部字段）
function pickMemoryFields(body) {
  const f = {};
  const copy = (k) => { if (body && body[k] !== undefined) f[k] = body[k]; };
  for (const k of ['category', 'key', 'value', 'summary', 'content', 'title', 'source', 'sourceType', 'sourceId', 'sourceMessageId', 'sourceConversationId', 'importance', 'confidence', 'isActive', 'userConfirmed', 'expiresAt', 'assistantId']) copy(k);
  return f;
}

// 记忆设置（section 十二）
router.get('/settings', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    ok(res, { memorySettings: memory.memorySettings(doc), version: doc.version });
  } catch (e) { next(e); }
});

router.patch('/settings', async (req, res, next) => {
  try {
    const { result, version } = await withDocVersioned(req.user.id, (doc) => {
      const ms = { ...memory.memorySettings(doc) };
      if (req.body && req.body.enabled !== undefined) ms.enabled = Boolean(req.body.enabled);
      if (req.body && req.body.autoSaveEnabled !== undefined) ms.autoSaveEnabled = Boolean(req.body.autoSaveEnabled);
      if (req.body && req.body.confirmationMode !== undefined) {
        const m = req.body.confirmationMode;
        if (!memory.CONFIRMATION_MODES.includes(m)) throw new HttpError(422, 'INVALID', 'confirmationMode 无效');
        ms.confirmationMode = m;
      }
      doc.memorySettings = ms;
      return ms;
    });
    ok(res, { memorySettings: result, version });
  } catch (e) { next(e); }
});

// ---- 候选记忆（section 七）：独立于正式记忆，需确认才转正 ----
router.get('/candidates', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    memory.cleanupExpiredCandidates(doc);
    const candidates = memory.getPendingCandidates(doc);
    ok(res, { candidates, count: candidates.length, version: doc.version });
  } catch (e) { next(e); }
});

router.post('/candidates/:id/confirm', async (req, res, next) => {
  try {
    const { result, version } = await withDocVersioned(req.user.id, (doc) => memory.confirmCandidate(doc, req.params.id));
    ok(res, { memory: result, version });
  } catch (e) { next(e); }
});

router.post('/candidates/:id/reject', async (req, res, next) => {
  try {
    const { result, version } = await withDocVersioned(req.user.id, (doc) => memory.rejectCandidate(doc, req.params.id));
    ok(res, { candidate: result, version });
  } catch (e) { next(e); }
});

// GET /api/memories —— 列表（分类筛选 / 搜索 / 是否含停用）
router.get('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    if (!memory.isEnabled(doc)) return ok(res, { memories: [], count: 0, version: doc.version });
    const list = memory.listMemories(doc, {
      category: req.query.category || null,
      query: req.query.query || '',
      includeInactive: req.query.includeInactive === 'true',
    });
    ok(res, { memories: list, count: list.length, version: doc.version });
  } catch (e) { next(e); }
});

// GET /api/memories/:id
router.get('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const m = memory.getMemory(doc, req.params.id);
    if (!m) throw new HttpError(404, 'NOT_FOUND', '记忆不存在');
    ok(res, { memory: m, version: doc.version });
  } catch (e) { next(e); }
});

// POST /api/memories —— 创建（显式写入；自动保存开关不影响显式写入）
router.post('/', async (req, res, next) => {
  try {
    const fields = pickMemoryFields(req.body || {});
    const { result, version } = await withDocVersioned(req.user.id, (doc) => {
      if (!memory.isEnabled(doc)) throw new HttpError(403, 'MEMORY_DISABLED', '记忆功能已关闭，无法写入');
      return memory.createMemory(doc, { ...fields, userConfirmed: true });
    });
    ok(res, { memory: result, version }, 201);
  } catch (e) { next(e); }
});

// PATCH /api/memories/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const fields = pickMemoryFields(req.body || {});
    const { result, version } = await withDocVersioned(req.user.id, (doc) => memory.updateMemory(doc, req.params.id, fields));
    ok(res, { memory: result, version });
  } catch (e) { next(e); }
});

// DELETE /api/memories/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { result, version } = await withDocVersioned(req.user.id, (doc) => {
      const removed = memory.deleteMemory(doc, req.params.id);
      if (!removed) throw new HttpError(404, 'NOT_FOUND', '记忆不存在');
      return removed;
    });
    ok(res, { ok: true, version });
  } catch (e) { next(e); }
});

// POST /api/memories/clear —— 清空全部（只清记忆，绝不清 memorySettings / 其他 user_state 字段）
router.post('/clear', async (req, res, next) => {
  try {
    const { result, version } = await withDocVersioned(req.user.id, (doc) => memory.clearMemories(doc));
    ok(res, { ok: true, cleared: result, version });
  } catch (e) { next(e); }
});

// POST /api/memories/:id/deactivate —— 停用
router.post('/:id/deactivate', async (req, res, next) => {
  try {
    const { result, version } = await withDocVersioned(req.user.id, (doc) => memory.deactivateMemory(doc, req.params.id));
    ok(res, { memory: result, version });
  } catch (e) { next(e); }
});

// POST /api/memories/:id/restore —— 恢复
router.post('/:id/restore', async (req, res, next) => {
  try {
    const { result, version } = await withDocVersioned(req.user.id, (doc) => memory.restoreMemory(doc, req.params.id));
    ok(res, { memory: result, version });
  } catch (e) { next(e); }
});

export default router;
