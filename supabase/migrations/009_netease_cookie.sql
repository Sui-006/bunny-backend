-- 009_netease_cookie.sql
-- 网易云音乐登录 cookie 持久化：app_settings 单行全局设置加一列，存 MUSIC_U cookie。
-- 用 service_role key 执行（同其它迁移）。
alter table public.app_settings
  add column if not exists netease_cookie text;
