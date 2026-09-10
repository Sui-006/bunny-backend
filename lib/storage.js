// Supabase Storage 封装（仅服务端使用，绝不把 service role key 下发前端）。
// 聊天附件迁移到私有 bucket：文件本体不再落 Render 本地磁盘（public/uploads 仅作旧数据兼容）。
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

const enabled = Boolean(config.supabaseUrl && config.supabaseKey);
const supabase = enabled ? createClient(config.supabaseUrl, config.supabaseKey) : null;

// 私有 bucket（public:false）。可用 ATTACHMENT_BUCKET 覆盖，默认 chat-attachments。
export const ATTACHMENT_BUCKET = (process.env.ATTACHMENT_BUCKET || 'chat-attachments').trim();

export const storageEnabled = () => enabled;

let bucketChecked = false;

// 确保 bucket 存在（幂等）。服务启动/首次上传时调用；缺 service role 权限时告警并返回 false。
// 也可用 SQL 一次性创建（见 supabase/migrations/010_attachments_storage.sql）。
export async function ensureBucket() {
  if (!supabase) return false;
  if (bucketChecked) return true;
  bucketChecked = true;
  try {
    const { data } = await supabase.storage.getBucket(ATTACHMENT_BUCKET);
    if (data) return true;
  } catch { /* bucket 不存在，走创建 */ }
  try {
    await supabase.storage.createBucket(ATTACHMENT_BUCKET, { public: false });
    return true;
  } catch (e) {
    console.warn('[storage] 创建 bucket 失败（可先在 Supabase 控制台/SQL 手动创建）：', e.message);
    return false;
  }
}

// 上传对象到私有 bucket。path 必须已由调用方清洗（禁 ../、禁原始文件名）。
export async function uploadObject(path, buffer, contentType) {
  if (!supabase) throw new Error('Supabase Storage 未配置');
  const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).upload(path, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw error;
  return data;
}

// 读取对象为 Buffer；不存在/读取失败抛错（由调用方降级）。
export async function downloadObject(path) {
  if (!supabase) throw new Error('Supabase Storage 未配置');
  const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).download(path);
  if (error) throw error;
  if (!data) throw new Error('对象不存在');
  const ab = await data.arrayBuffer();
  return Buffer.from(ab);
}

// 删除对象（尽力而为，失败仅告警不阻断）。
export async function deleteObject(path) {
  if (!supabase || !path) return;
  try {
    const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]);
    if (error) console.warn('[storage] 删除对象失败：', error.message);
  } catch (e) {
    console.warn('[storage] 删除对象异常：', e.message);
  }
}

// 短期签名 URL（默认 1 小时）。仅用于临时预览，绝不把签名 URL 存进 DB 当永久地址。
export async function signedUrl(path, expiresIn = 3600) {
  if (!supabase || !path) return null;
  try {
    const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrl(path, expiresIn);
    if (error) return null;
    return data?.signedUrl || null;
  } catch {
    return null;
  }
}
