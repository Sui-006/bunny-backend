import { Router } from 'express';
import { getState, putState, markPendingJournal } from '../lib/domain.js';
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
    // 「新日志待读」标记（服务端持有）：全量写穿会覆盖服务端字段，这里先读现存状态再判定。
    // 出现新日志 id → 置 true；没有 → 保留现存标记（绝不因无关写穿把 pending 误清）。
    const existing = await getState(req.user.id);
    markPendingJournal(body, existing);
    // version 是服务端持有的乐观并发 CAS token：前端全量写穿提交的 version 是旧值（seed 恒为 1、从不递增），
    // 绝不信任，一律保留服务端真实 version。否则一次普通 PUT 会把 consumePendingJournal 已递增的 version 回退，
    // 使两条并发消息的 CAS 都可能命中，导致同一批 Journal 被重复注入。
    body.version = Number(existing.version) || 1;
    ok(res, await putState(req.user.id, body));
  } catch (e) { next(e); }
});

export default router;
