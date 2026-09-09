import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { hasDb } from './lib/store.js';
import { requireAuth } from './lib/auth.js';
import { HttpError } from './lib/rest.js';

// 既有路由（AI 对话 / 全局设置 / 主动消息）
import sessionsRouter from './routes/sessions.js';
import messagesRouter from './routes/messages.js';
import settingsRouter from './routes/settings.js';
import appSettingsRouter from './routes/appSettings.js';
import proactiveRouter from './routes/proactive.js';
import legacyPlansRouter from './routes/plans.js';

// 新增业务路由（计划/任务/习惯/健康/… 持久化到 PostgreSQL）
import authRouter from './routes/auth.js';
import stateRouter from './routes/state.js';
import lifePlansRouter from './routes/lifePlans.js';
import tasksRouter from './routes/tasks.js';
import habitsRouter from './routes/habits.js';
import healthRouter from './routes/health.js';
import calendarRouter from './routes/calendar.js';
import statisticsRouter from './routes/statistics.js';
import notesRouter from './routes/notes.js';
import familyRouter from './routes/family.js';
import workspacesRouter from './routes/workspaces.js';
import conversationsRouter from './routes/conversations.js';
import notificationsRouter from './routes/notifications.js';
import profileRouter from './routes/profile.js';
import userSettingsRouter from './routes/userSettings.js';
import mcpRouter from './routes/mcp.js';
import memoryRouter from './routes/memory.js';
import aiRouter from './routes/ai.js';
import filesRouter from './routes/files.js';
import geoRouter from './routes/geo.js';

const app = express();

// CORS：配置了 FRONTEND_URL 则只允许该来源，否则保持开放（本地/同源部署）
const allowedOrigins = (process.env.FRONTEND_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins, credentials: true } : {}));
app.use(express.json({ limit: '10mb' }));

// 健康检查（Render 用）
app.get('/health', (req, res) => {
  res.json({ status: 'ok', database: hasDb() ? 'connected' : 'memory' });
});

// 认证（不强制鉴权，隐式 owner 兜底）
app.use('/api/auth', authRouter);

// 既有 AI 对话 / 全局设置 / 主动消息（保持不变，前端 AI 聊天仍直接可用）
app.use('/api/sessions', sessionsRouter);
app.use('/api/sessions', messagesRouter);
app.use('/api/sessions', settingsRouter);
app.use('/api/settings', appSettingsRouter);
app.use('/api/proactive', proactiveRouter);
app.use('/api/plans-board', legacyPlansRouter); // 旧版「待办/本月/年度」计划板，已由四级计划取代

// 新增业务路由（均带 requireAuth → 隐式 owner，数据按用户隔离）
app.use('/api/state', requireAuth, stateRouter);
app.use('/api/plans', requireAuth, lifePlansRouter);
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/habits', requireAuth, habitsRouter);
app.use('/api/health', requireAuth, healthRouter);
app.use('/api/calendar', requireAuth, calendarRouter);
app.use('/api/statistics', requireAuth, statisticsRouter);
app.use('/api/notes', requireAuth, notesRouter);
app.use('/api/family', requireAuth, familyRouter);
app.use('/api/workspaces', requireAuth, workspacesRouter);
app.use('/api/conversations', requireAuth, conversationsRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/profile', requireAuth, profileRouter);
app.use('/api/user-settings', requireAuth, userSettingsRouter);
app.use('/api/mcp', requireAuth, mcpRouter);
app.use('/api/memory', requireAuth, memoryRouter);
app.use('/api/ai', requireAuth, aiRouter);
app.use('/api/files', requireAuth, filesRouter);

// 天气 / 定位（高德服务端封装；公开数据代理，不挂 requireAuth）
app.use('/api', geoRouter);

// 静态前端（合并部署：手机直接访问 Render 地址即可打开界面）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not Found', path: req.originalUrl } });
});

// 统一错误处理：HttpError → 结构化；普通 Error → 兼容旧路由的 { error }
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status || 500).json({ success: false, error: { code: err.code || 'ERROR', message: err.message } });
  }
  // 不记录敏感信息（password/key/token 不出现在日志）
  const msg = String(err?.message || 'Internal Server Error').replace(/(password|api[_-]?key|authorization|token)[=:]\s*\S+/gi, '$1=***');
  console.error('[error]', msg);
  res.status(err?.status || 500).json({ error: msg });
});

app.listen(config.port, () => {
  console.log(`Bunny's Home 后端已启动：http://localhost:${config.port}  (db: ${hasDb() ? 'supabase' : 'memory'})`);
});
