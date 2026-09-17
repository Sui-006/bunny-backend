// 「和祂一起听」陪听会话 REST 接口。
// 会话/画像都落在用户 user_state 文档里（listeningSession / musicTasteProfile / listeningHistory），
// 不新建表；所有读写都按 req.user.id 隔离，会话绑定当前激活助手 assistantId。
import { Router } from 'express';
import { getState, putState } from '../lib/domain.js';
import { config } from '../lib/config.js';
import { HttpError, ok, pick } from '../lib/rest.js';
import * as companion from '../services/music-companion-service.js';

const router = Router();

// POST /api/listening/start —— 开启陪听会话（绑定当前 assistantId）
router.post('/start', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const opts = pick(req.body, ['assistantId', 'autoNext', 'companionEnabled']);
    // 绝不接受前端传来的非法 assistantId；一律以当前激活助手为准（除非明确给了且存在）
    const aid = opts.assistantId && companion.getAssistant(doc, opts.assistantId)
      ? opts.assistantId
      : companion.activeAssistantId(doc);
    const session = companion.startSession(doc, {
      assistantId: aid,
      autoNext: opts.autoNext,
      companionEnabled: opts.companionEnabled,
    });
    await putState(req.user.id, doc);
    ok(res, { session: companion.sanitizeSession(session), assistant: companion.sanitizeAssistant(companion.getAssistant(doc, session.assistantId)) }, 201);
  } catch (e) { next(e); }
});

// POST /api/listening/end —— 结束陪听会话
router.post('/end', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const session = companion.endSession(doc);
    await putState(req.user.id, doc);
    ok(res, { session: companion.sanitizeSession(session) });
  } catch (e) { next(e); }
});

// GET /api/listening/session —— 当前会话状态（不含歌词/评论，供前端 UI 轻量读取）
router.get('/session', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const s = doc.listeningSession && typeof doc.listeningSession === 'object' ? doc.listeningSession : null;
    ok(res, {
      active: companion.isActiveSession(doc),
      session: companion.sanitizeSession(s),
      togetherListening: Boolean((doc.player || {}).togetherListening),
      autoNext: Boolean((doc.player || {}).autoNext),
    });
  } catch (e) { next(e); }
});

// GET /api/listening/context —— 完整陪听上下文（含公开歌词；AI/前端调试用）
router.get('/context', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    ok(res, await companion.getContext(doc));
  } catch (e) { next(e); }
});

// POST /api/listening/recommend-next —— 推荐下一首（AI 优先，失败降级列表下一首）
router.post('/recommend-next', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const model = String(req.body?.model || companion.assistantModel(doc) || config.defaultModel || 'deepseek-chat').trim();
    const rec = await companion.recommendNextSong(doc, model);
    ok(res, { song: rec.song, reason: rec.reason });
  } catch (e) { next(e); }
});

// POST /api/listening/reaction —— 记录明确喜欢/不喜欢（写回画像 + 收听历史）
router.post('/reaction', async (req, res, next) => {
  try {
    const reaction = String(req.body?.reaction || '').trim();
    if (reaction !== 'like' && reaction !== 'dislike') throw new HttpError(400, 'INVALID_REACTION', 'reaction 只能是 like 或 dislike');
    const doc = await getState(req.user.id);
    const entry = companion.recordReaction(doc, reaction, req.body?.songId);
    await putState(req.user.id, doc);
    ok(res, { entry, tasteProfile: doc.musicTasteProfile }, 201);
  } catch (e) { next(e); }
});

export default router;
