import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getAppSettings, saveAppSettings } from '../lib/db.js';
import { HttpError, ok, requireFields } from '../lib/rest.js';

const router = Router();

async function loadList() {
  const s = await getAppSettings();
  try { return JSON.parse(s?.mcp_servers || '[]'); } catch { return []; }
}
async function persist(list) { await saveAppSettings({ mcp_servers: JSON.stringify(list) }); }

// GET /api/mcp
router.get('/', async (req, res, next) => {
  try { ok(res, await loadList()); } catch (e) { next(e); }
});

// POST /api/mcp
router.post('/', async (req, res, next) => {
  try {
    requireFields(req.body, ['command']);
    const list = await loadList();
    const server = {
      id: `${(req.body.name || 'plugin').replace(/\W+/g, '_')}_${randomUUID().slice(0, 8)}`,
      name: String(req.body.name || '未命名'),
      command: String(req.body.command).trim(),
      enabled: req.body.enabled !== false,
    };
    list.push(server);
    await persist(list);
    ok(res, server, 201);
  } catch (e) { next(e); }
});

// PATCH /api/mcp/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const list = await loadList();
    const s = list.find((x) => x.id === req.params.id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'MCP 配置不存在');
    if (req.body.name !== undefined) s.name = String(req.body.name);
    if (req.body.command !== undefined) s.command = String(req.body.command).trim();
    if (req.body.enabled !== undefined) s.enabled = Boolean(req.body.enabled);
    await persist(list);
    ok(res, s);
  } catch (e) { next(e); }
});

// DELETE /api/mcp/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const list = await loadList();
    await persist(list.filter((x) => x.id !== req.params.id));
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// POST /api/mcp/:id/test —— 仅校验配置格式，不执行任意 shell（安全：生产默认不开放执行）
router.post('/:id/test', async (req, res, next) => {
  try {
    const list = await loadList();
    const s = list.find((x) => x.id === req.params.id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'MCP 配置不存在');
    if (!s.command) throw new HttpError(400, 'INVALID', '命令为空');
    ok(res, { ok: true, message: '配置格式有效（生产环境默认不开放任意 shell 执行，仅校验）' });
  } catch (e) { next(e); }
});

export default router;
