import { Router } from 'express';
import { userMemories } from '../lib/store.js';
import { HttpError, ok, requireFields } from '../lib/rest.js';

const router = Router();
const toRow = (r) => ({ id: r.id, content: r.content, importance: r.importance, createdAt: r.created_at, updatedAt: r.updated_at });

// GET /api/memory
router.get('/', async (req, res, next) => {
  try {
    const rows = await userMemories.all({ eq: { user_id: req.user.id }, order: { col: 'created_at', asc: false } });
    ok(res, rows.map(toRow));
  } catch (e) { next(e); }
});

// POST /api/memory
router.post('/', async (req, res, next) => {
  try {
    requireFields(req.body, ['content']);
    const row = await userMemories.insert({
      user_id: req.user.id,
      content: String(req.body.content),
      importance: Number(req.body.importance) || 0,
    });
    ok(res, toRow(row), 201);
  } catch (e) { next(e); }
});

// PATCH /api/memory/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const patch = {};
    if (req.body.content !== undefined) patch.content = String(req.body.content);
    if (req.body.importance !== undefined) patch.importance = Number(req.body.importance) || 0;
    const row = await userMemories.update(req.params.id, patch);
    ok(res, toRow(row));
  } catch (e) { next(e); }
});

// DELETE /api/memory/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const rec = await userMemories.one(req.params.id);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', '记忆不存在');
    await userMemories.remove(req.params.id);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

export default router;
