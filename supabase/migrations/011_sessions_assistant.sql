-- 011_sessions_assistant.sql
-- 会话级 AI 助手：Chat 页切换助手只影响当前对话（区别于全局 activeAssistantId）。
-- 可空列，老会话为 NULL → 前端回退到全局 activeAssistantId。幂等，不破坏现有数据。

alter table public.sessions
  add column if not exists assistant_id text;   -- 该会话绑定的助手 id（NULL=跟随全局）

create index if not exists sessions_assistant_id_idx on public.sessions(assistant_id);
