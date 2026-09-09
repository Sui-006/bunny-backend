# Bunny's Home 后端

个人 AI 生活操作系统的后端。基于 **Node.js + Express + Supabase(PostgreSQL)**，已合并部署前端（`public/index.html`）与后端，手机/浏览器直接访问 Render 地址即可用。

> 架构原则：以前端为唯一 UI 来源，后端只补数据层。核心生活数据（计划/任务/习惯/健康/笔记/家人/工作区/社交/通知/资料/设置）以 **JSON 文档存 PostgreSQL 的 `users.user_state`**，细粒度 REST 读写同一份文档；AI 对话走原有 `sessions/messages` 表。

## 目录结构

```
server/
  server.js             # 入口：路由挂载 + 静态前端 + 统一错误处理
  lib/
    config.js           # 环境变量
    store.js            # 通用表访问（Supabase / 内存兜底）：users/user_tokens/attachments/user_memories
    auth.js             # 单用户 owner + scrypt 口令 + 不透明 token + requireAuth
    domain.js           # 生活数据文档访问层 + 业务规则（计划兜底/连续天数/层级链）
    rest.js             # 统一响应 + 校验 + 通用 CRUD 工厂
    db.js / ai.js / context.js / tokens.js / mcp.js / bark.js   # 既有 AI 对话相关
  routes/
    auth.js state.js lifePlans.js tasks.js habits.js health.js calendar.js statistics.js
    notes.js family.js workspaces.js conversations.js notifications.js profile.js
    userSettings.js mcp.js memory.js ai.js files.js
    sessions.js messages.js settings.js appSettings.js proactive.js plans.js(旧版)
  public/               # 前端（index.html）
  .env.example
  render.yaml
```

## 本地开发

```bash
cd server
cp .env.example .env   # 不填 Supabase 也能跑（内存模式，数据不持久）
npm install
npm run dev            # node --watch server.js
# http://localhost:3001
```

## 环境变量

见 `.env.example`。核心：`SUPABASE_URL` / `SUPABASE_KEY`（PostgreSQL）、`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`（AI）、`BARK_URL`（推送）、`DEFAULT_MODEL`、`FRONTEND_URL`（CORS）、`OWNER_EMAIL` / `ALLOW_IMPLICIT_OWNER`（认证）。

## 数据库

1. 在 Supabase SQL Editor 依次执行：
   - `../supabase/schema.sql`（AI 对话表：sessions/messages/memories/settings/app_settings）
   - `../supabase/schema-v2.sql`（新增：users/user_tokens/attachments/user_memories）
2. 全部幂等，可重复执行。

未配置 Supabase 时后端自动落到内存（本地调试），重启即清空。

## API 概览

统一响应：成功 `{ success:true, data }`；失败 `{ success:false, error:{code,message} }`（旧 AI 路由仍返回 `{ error }`）。

- 认证：`POST /api/auth/register|login|logout`、`GET /api/auth/me`
- 同步：`GET/PUT /api/state`（前端全量读写生活数据文档）
- 计划：`GET/POST /api/plans`、`GET/PATCH/DELETE /api/plans/:id`、`POST /:id/duplicate|archive`、`PATCH /:id/theme`、`?type=` 过滤
- 任务：`GET/POST /api/tasks`、`GET/PATCH/DELETE /:id`、`POST /:id/complete`、`PATCH /:id/date`、`PATCH /api/tasks/reorder`
- 习惯：`GET/POST /api/habits`、`PATCH/DELETE /:id`、`POST /:id/complete`、`GET /:id/streak|history`
- 健康：`GET/POST /api/health`、`PATCH/DELETE /:id`、`GET /api/health/summary`、`?start=&end=`
- 日历：`GET /api/calendar?start=&end=`
- 统计：`GET /api/statistics?range=7d|30d|90d`
- 笔记/家人/工作区：标准 CRUD（`/api/notes` `/api/family` `/api/workspaces`）
- 社交消息：`/api/conversations` + `POST /:id/messages`
- 通知：`GET /api/notifications`、`PATCH /:id/read`、`POST /read-all`
- 资料：`GET/PATCH /api/profile`、`POST /api/profile/avatar`
- 用户设置：`GET/PATCH /api/user-settings`（外观/AI/通知）
- MCP：`GET/POST /api/mcp`、`PATCH/DELETE /:id`、`POST /:id/test`（仅校验，不执行 shell）
- 记忆：`GET/POST /api/memory`、`PATCH/DELETE /:id`
- AI：`POST /api/ai/task/parse`、`POST /api/ai/plan`（预览）、`POST /api/ai/plan/confirm`（原子落库）
- 文件：`POST /api/files/upload`、`GET /api/files`、`DELETE /api/files/:id`
- AI 对话（原有）：`/api/sessions*`（流式 SSE）、`/api/settings`（全局 + API key，打码不回写）、`/api/proactive`

## Render 部署

1. Render → New → Web Service，指向 `server/`（或使用根目录 `render.yaml` 蓝本）。
2. Build `npm install`，Start `npm start`，Health check path `/health`。
3. 环境变量填 `SUPABASE_URL`、`SUPABASE_KEY`、AI keys、`BARK_URL`。
4. 前端已由 `express.static` 托管，部署后访问 Web Service URL 即打开应用。

## 安全

- 所有业务查询按 `user_id` 隔离；API key 只存服务端、前端只读打码值；口令 scrypt、token 存哈希。
- 生产建议：设 `FRONTEND_URL` 限制 CORS；`ALLOW_IMPLICIT_OWNER=false` + Bearer token 强化鉴权。
