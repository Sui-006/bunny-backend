-- 012_conversation_summary.sql
-- 对话摘要（Conversation Summary）：在 sessions 表上新增版本化摘要列，用于长对话的上下文优化。
-- 与长期记忆（users.user_state → doc.ai.memories）严格分离：摘要只存 sessions，绝不写 user_state、绝不写 memories 表。
-- 幂等（add column if not exists），不破坏现有数据。需在 Supabase SQL Editor 手动执行一次（Render 不自动跑迁移）。

alter table public.sessions
  add column if not exists summary text,                              -- 压缩摘要文本
  add column if not exists summary_version integer not null default 0, -- CAS 版本号（乐观并发）
  add column if not exists summarized_until_message_id uuid,           -- 已覆盖到哪条消息（边界）
  add column if not exists summary_stale boolean not null default false, -- 编辑/删除消息后置为 true，下次重建
  add column if not exists summary_updated_at timestamptz,
  add column if not exists summary_token_estimate integer;             -- 摘要 token 估算（可观测性）
