-- 014_toy_channel.sql
-- 震动玩具远程控制：app_settings 单行全局设置加一列，存当前绑定频道的 channelId。
-- 服务端专用（不进前端 /api/settings 的 FIELDS 白名单，绝不返回前端，同 netease_cookie）。
-- 用 service_role key 执行（同其它迁移）。
alter table public.app_settings
  add column if not exists toy_channel_id text;
