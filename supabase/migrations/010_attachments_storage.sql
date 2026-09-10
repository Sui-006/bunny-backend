-- 010_attachments_storage.sql
-- 聊天附件迁移到 Supabase Storage（私有 bucket）+ 文档正文解析缓存字段。
-- 用 service_role key 执行（同其它迁移）；不破坏现有数据，旧 /uploads 附件继续兼容读取。

-- 1) attachments 表加字段（新上传以 storage_path 为真实来源）
alter table public.attachments
  add column if not exists storage_provider text;            -- 'supabase' | null（旧本地附件）
alter table public.attachments
  add column if not exists storage_bucket text;              -- 如 'chat-attachments'
alter table public.attachments
  add column if not exists storage_path text;                -- 如 users/{userId}/chat-attachments/{uuid}-{name}
alter table public.attachments
  add column if not exists extracted_text text;              -- PDF/DOCX/XLSX/PPTX 解析缓存（受上限约束）
alter table public.attachments
  add column if not exists extracted_text_at timestamptz;    -- 解析时间（用于缓存失效判断）

create index if not exists attachments_user_id_idx on public.attachments(user_id);

-- 2) 私有 bucket（public=false）。代码里 ensureBucket() 也会幂等创建，这里兜底一次性建好。
--    storage 模式需要已启用（Supabase 项目默认已启用 Storage）。
insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', false)
on conflict (id) do nothing;
