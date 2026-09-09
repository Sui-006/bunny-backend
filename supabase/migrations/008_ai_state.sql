-- 008_ai_state.sql
-- 「我的AI」生活数据文档后端所需 4 张表。
-- 单用户 owner 模型：前端整份 DB 文档存 users.user_state(jsonb)，其余为辅助表。
-- 用 service_role key 访问（RLS 不启用，由 service_role 全量读写）。

-- 1) 用户（单用户 owner）
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique,                          -- 可空（未注册时隐式 owner）
  password_hash text,                                 -- scrypt 格式，可空
  user_state    jsonb not null default '{}'::jsonb,   -- 前端整份 DB 文档
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 2) 不透明登录 token（sha256 hash 存储）
create table if not exists public.user_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists user_tokens_token_hash_idx on public.user_tokens(token_hash);

-- 3) 上传附件
create table if not exists public.attachments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  file_name  text not null,
  file_url   text not null,
  mime_type  text,
  size       bigint not null default 0,
  created_at timestamptz not null default now()
);

-- 4) 用户长期记忆（「我的AI」记忆）
create table if not exists public.user_memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  content    text not null,
  importance int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 自动维护 updated_at（users / user_memories）
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists trg_user_memories_updated_at on public.user_memories;
create trigger trg_user_memories_updated_at
  before update on public.user_memories
  for each row execute function public.set_updated_at();
