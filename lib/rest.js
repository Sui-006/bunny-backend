import { Router } from 'express';
import { listColl, getOne, insertOne, patchOne, removeOne } from './domain.js';

// 统一响应 + 校验辅助
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// 只挑出白名单字段
export function pick(body, fields) {
  const o = {};
  for (const f of fields) if (body?.[f] !== undefined) o[f] = body[f];
  return o;
}

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === '');
  if (missing.length) throw new HttpError(400, 'MISSING_FIELDS', '缺少字段: ' + missing.join(', '));
}

export function clampInt(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : min;
}

// 通用 CRUD 路由工厂：针对 user_state 文档里的某个数组集合
export function makeCrudRouter(key, { createDefaults = () => ({}), patchable = [], onCreate, onPatch, onDelete } = {}) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try { ok(res, await listColl(req.user.id, key)); } catch (e) { next(e); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const item = await getOne(req.user.id, key, req.params.id);
      if (!item) throw new HttpError(404, 'NOT_FOUND', '记录不存在');
      ok(res, item);
    } catch (e) { next(e); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const item = await insertOne(req.user.id, key, { ...createDefaults(), ...pick(req.body, patchable) });
      if (onCreate) await onCreate(item, req.body);
      ok(res, item, 201);
    } catch (e) { next(e); }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const patch = pick(req.body, patchable);
      const item = await patchOne(req.user.id, key, req.params.id, patch);
      if (onPatch) await onPatch(item, patch);
      ok(res, item);
    } catch (e) { next(e); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await removeOne(req.user.id, key, req.params.id);
      if (onDelete) await onDelete(req.params.id);
      ok(res, { ok: true });
    } catch (e) { next(e); }
  });

  return router;
}
