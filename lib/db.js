import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// 会话级默认设置（与 supabase/schema.sql 中 settings 表列一致）
export const DEFAULT_SETTINGS = {
  system_prompt: '',
  temperature: 0.7,
  max_context_rounds: 20,
  max_context_tokens: 60000,
  compress_threshold: 60000,
  compress_keep_rounds: 10,
  max_reply_tokens: 2048,
};

const useSupabase = Boolean(config.supabaseUrl && config.supabaseKey);
const supabase = useSupabase ? createClient(config.supabaseUrl, config.supabaseKey) : null;

// ---------------- 内存后端（未配置 Supabase 时用于本地调试） ----------------
const mem = {
  sessions: new Map(),
  messages: new Map(),
  memories: new Map(),
  settings: new Map(),
  appSettings: null,
};
const iso = () => new Date().toISOString();

// ---------------- sessions ----------------
export async function listSessions() {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }
  return [...mem.sessions.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

export async function createSession(name = '新的对话') {
  if (useSupabase) {
    const { data, error } = await supabase.from('sessions').insert({ name }).select().single();
    if (error) throw error;
    return data;
  }
  const s = { id: randomUUID(), name, created_at: iso(), updated_at: iso() };
  mem.sessions.set(s.id, s);
  return s;
}

export async function getSession(id) {
  if (useSupabase) {
    const { data, error } = await supabase.from('sessions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ?? null;
  }
  return mem.sessions.get(id) ?? null;
}

export async function updateSession(id, { name }) {
  if (useSupabase) {
    const { data, error } = await supabase.from('sessions').update({ name }).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  const s = mem.sessions.get(id);
  if (!s) throw new Error('会话不存在');
  s.name = name;
  s.updated_at = iso();
  return s;
}

export async function deleteSession(id) {
  if (useSupabase) {
    const { error } = await supabase.from('sessions').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  mem.sessions.delete(id);
  for (const map of [mem.messages, mem.memories, mem.settings]) {
    for (const [k, v] of map) if (v.session_id === id) map.delete(k);
  }
}

// ---------------- settings ----------------
export async function getSettings(sessionId) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }
  return mem.settings.get(sessionId) ?? null;
}

export async function saveSettings(sessionId, partial) {
  const merged = { ...DEFAULT_SETTINGS, ...partial };
  if (useSupabase) {
    const { data, error } = await supabase
      .from('settings')
      .upsert({ session_id: sessionId, ...merged }, { onConflict: 'session_id' })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const row = { id: randomUUID(), session_id: sessionId, ...merged, updated_at: iso() };
  mem.settings.set(sessionId, row);
  return row;
}

// ---------------- 全局设置（app_settings，单行） ----------------
export async function getAppSettings() {
  if (useSupabase) {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .eq('id', true)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    } catch (e) {
      // app_settings 表尚未创建（迁移没跑）时回退环境变量，不阻断对话
      console.warn('[db] getAppSettings 失败，回退环境变量：', e.message);
      return null;
    }
  }
  return mem.appSettings ?? null;
}

export async function saveAppSettings(partial) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('app_settings')
      .upsert({ id: true, ...partial }, { onConflict: 'id' })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  mem.appSettings = { id: true, ...(mem.appSettings || {}), ...partial, updated_at: iso() };
  return mem.appSettings;
}

// ---------------- messages ----------------
export async function listMessages(sessionId, { limit = null, visibleOnly = false } = {}) {
  if (useSupabase) {
    let q = supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    if (visibleOnly) q = q.eq('visible', true);
    if (limit != null) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  }
  let arr = [...mem.messages.values()].filter((m) => m.session_id === sessionId);
  if (visibleOnly) arr = arr.filter((m) => m.visible !== false);
  arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (limit != null) arr = arr.slice(-limit);
  return arr;
}

export async function listVisibleMessages(sessionId) {
  return listMessages(sessionId, { visibleOnly: true });
}

export async function createMessage(
  sessionId,
  { role, content, reasoningContent = '', visible = true, metadata = null }
) {
  const row = {
    session_id: sessionId,
    role,
    content,
    reasoning_content: reasoningContent,
    visible,
    metadata,
    created_at: iso(),
  };
  if (useSupabase) {
    const { data, error } = await supabase.from('messages').insert(row).select().single();
    if (error) throw error;
    return data;
  }
  const full = { id: randomUUID(), ...row };
  mem.messages.set(full.id, full);
  return full;
}

export async function markMessagesInvisible(ids) {
  if (!ids || ids.length === 0) return;
  if (useSupabase) {
    const { error } = await supabase.from('messages').update({ visible: false }).in('id', ids);
    if (error) throw error;
    return;
  }
  for (const id of ids) {
    const m = mem.messages.get(id);
    if (m) m.visible = false;
  }
}

// 最近一条消息所属的会话（用于「主动发消息」确定目标会话）；无消息则退回最新会话
export async function getLatestActiveSessionId() {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('messages')
      .select('session_id')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.session_id) return data.session_id;
    const sessions = await listSessions();
    return sessions[0]?.id ?? null;
  }
  let latest = null;
  let latestAt = '';
  for (const m of mem.messages.values()) {
    if (m.created_at > latestAt) {
      latestAt = m.created_at;
      latest = m.session_id;
    }
  }
  if (latest) return latest;
  const sessions = await listSessions();
  return sessions[0]?.id ?? null;
}

// 某会话最后一条消息的时间（用于空闲判断）；无消息返回 null
export async function getLastMessageAt(sessionId) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('messages')
      .select('created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data?.created_at ?? null;
  }
  const arr = [...mem.messages.values()]
    .filter((m) => m.session_id === sessionId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return arr[0]?.created_at ?? null;
}

// 更新会话 updated_at（主动消息落库后，让该会话冒泡到列表顶部）
export async function touchSession(id) {
  if (useSupabase) {
    const { error } = await supabase.from('sessions').update({ updated_at: iso() }).eq('id', id);
    if (error) throw error;
    return;
  }
  const s = mem.sessions.get(id);
  if (s) s.updated_at = iso();
}

// ---------------- memories ----------------
export async function listMemories(sessionId) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .eq('session_id', sessionId)
      .order('timestamp', { ascending: true });
    if (error) throw error;
    return data ?? [];
  }
  return [...mem.memories.values()]
    .filter((m) => m.session_id === sessionId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function createMemory(sessionId, summary) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('memories')
      .insert({ session_id: sessionId, summary })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const m = { id: randomUUID(), session_id: sessionId, summary, timestamp: iso() };
  mem.memories.set(m.id, m);
  return m;
}
