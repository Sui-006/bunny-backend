import { Router } from 'express';
import { getState, putState } from '../lib/domain.js';
import { HttpError, ok } from '../lib/rest.js';

const router = Router();

// GET /api/state —— 返回整份生活数据文档（前端启动时拉取合并）
router.get('/', async (req, res, next) => {
  try { ok(res, await getState(req.user.id)); } catch (e) { next(e); }
});

// PUT /api/state —— 前端全量写穿（首次上传 / 每次改动后同步）
router.put('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID', 'state 必须是对象');
    ok(res, await putState(req.user.id, body));
  } catch (e) { next(e); }
});

export default router;
