# Bunny's Home 后端

Node.js + Express 后端：会话管理、消息收发、AI 调用、上下文记忆压缩。

## 技术栈 / 依赖
- express、dotenv、@supabase/supabase-js、cors

## 快速开始
```bash
cd server
npm install
cp .env.example .env   # 填写 SUPABASE_URL/KEY、API_KEY
npm run dev            # 或 npm start
```

未配置 `SUPABASE_URL` 时使用**内存存储**（重启即清空，仅本地调试）；未配置 `API_KEY` 时可设 `MOCK_AI=true` 返回假回复。

## 项目结构
```
server/
  server.js           入口
  lib/
    config.js         环境变量
    db.js             数据层（Supabase + 内存回退）
    ai.js             AI 调用（OpenAI 兼容协议）
    context.js        上下文组装 + 记忆压缩
    tokens.js         token 粗估
  routes/
    sessions.js
    messages.js
    settings.js
```

## API 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 `{ status: 'ok' }` |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 新建会话 `{ name? }` |
| GET | `/api/sessions/:sessionId` | 会话详情（设置 + 最近消息） |
| PATCH | `/api/sessions/:sessionId` | 重命名 `{ name }` |
| DELETE | `/api/sessions/:sessionId` | 删除会话 |
| GET | `/api/sessions/:sessionId/messages` | 消息列表 `?limit=` |
| POST | `/api/sessions/:sessionId/messages` | 发送消息 → AI 回复 |
| GET | `/api/sessions/:sessionId/settings` | 读设置 |
| PUT | `/api/sessions/:sessionId/settings` | 更新设置 |
| GET | `/api/settings` | 全局设置（API key 只打码返回） |
| PUT | `/api/settings` | 更新全局设置（key / 中转地址 / 个性签名） |

## 核心对话流程（POST .../messages）

```
落库用户消息
  → 组装上下文（system 提示词 + 记忆摘要 + 可见消息）
  → token/轮数超阈值时：旧轮次压缩成摘要写入 memories，旧消息标记不可见
  → 调用 AI（OpenAI 兼容协议，Bearer API_KEY）
  → 落库回复（含 reasoning_content 与 usage）
```

请求体：`{ "content": "你好", "model": "deepseek-chat" }`（`model` 可省略，用 `DEFAULT_MODEL`）。

## 环境变量
见 `.env.example`。数据库 `SUPABASE_URL` / `SUPABASE_KEY`。AI 按模型名自动路由到对应厂商，各配一个 Key：

| 厂商 | 环境变量 | 匹配的模型名 |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-*` |
| OpenAI | `OPENAI_API_KEY` | `gpt-*`、`o1`/`o3` 等 |
| Anthropic（Claude） | `ANTHROPIC_API_KEY` | `claude-*` |

> `API_KEY` / `API_BASE_URL` 仍保留为 DeepSeek 的兼容别名。
>
> 也可在网页「API 设置」里配置 key / 中转地址 / 个性签名，存到 Supabase `app_settings` 表（优先于环境变量）。表结构见 `supabase/migrations/001_app_settings.sql`。
