-- 013_conversation_cache.sql
-- 对话缓存（Conversation Cache）：在 sessions 表上新增结构化缓存列。
-- 与长期记忆（users.user_state → doc.ai.memories）严格分离：缓存只存 sessions，绝不写 user_state、绝不写 memories 表。
-- 复用 012 的 summary（=cache.summary）与 summarized_until_message_id（=cache.coveredMessageId）。
-- 幂等（add column if not exists），不破坏现有数据。需在 Supabase SQL Editor 手动执行一次。

alter table public.sessions
  add column if not exists cache_key_points jsonb,        -- 对话要点（字符串数组）
  add column if not exists cache_current_topic text,      -- 当前主题
  add column if not exists cache_recent_decisions jsonb,  -- 近期已做决定（字符串数组）
  add column if not exists cache_open_items jsonb,        -- 待办/未完成事项（字符串数组）
  add column if not exists cache_last_message_at timestamptz, -- 缓存覆盖到的最后一条消息时间
  add column if not exists cache_updated_at timestamptz;  -- 缓存最后更新时间
