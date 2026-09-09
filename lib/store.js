import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// 通用表访问层：有 Supabase 走 PostgreSQL，没有则落到内存（本地调试）。
// 与 lib/db.js 的双模式一致，但做成通用适配器，供新增的 users/tokens/attachments/user_memories 使用。
const useSupabase = Boolean(config.supabaseUrl && config.supabaseKey);
const supabase = useSupabase ? createClient(config.supabaseUrl, config.supabaseKey) : null;

export const hasDb = () => useSupabase;

const memTables = new Map();
const memTable = (name) => {
  if (!memTables.has(name)) memTables.set(name, new Map());
  return memTables.get(name);
};
const iso = () => new Date().toISOString();

// 通用表适配器：all / one / insert / update / remove / removeWhere
export function table(name) {
  const map = () => memTable(name);

  async function all({ eq = {}, order = null, limit = null } = {}) {
    if (useSupabase) {
      let q = supabase.from(name).select('*');
      for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
      if (order) q = q.order(order.col, { ascending: order.asc !== false });
      if (limit != null) q = q.limit(limit);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    }
    let rows = [...map().values()];
    for (const [k, v] of Object.entries(eq)) rows = rows.filter((r) => r[k] === v);
    if (order) {
      const col = order.col, asc = order.asc !== false;
      rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (limit != null) rows = rows.slice(0, limit);
    return rows;
  }

  async function one(id) {
    if (useSupabase) {
      const { data, error } = await supabase.from(name).select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data ?? null;
    }
    return map().get(id) ?? null;
  }

  async function insert(row) {
    if (useSupabase) {
      const { data, error } = await supabase.from(name).insert(row).select().single();
      if (error) throw error;
      return data;
    }
    const full = { id: randomUUID(), created_at: iso(), ...row };
    map().set(full.id, full);
    return full;
  }

  async function update(id, patch) {
    if (useSupabase) {
      const { data, error } = await supabase.from(name).update(patch).eq('id', id).select().single();
      if (error) throw error;
      return data;
    }
    const row = map().get(id);
    if (!row) throw new Error(`${name} 记录不存在`);
    Object.assign(row, patch, { updated_at: iso() });
    return row;
  }

  async function remove(id) {
    if (useSupabase) {
      const { error } = await supabase.from(name).delete().eq('id', id);
      if (error) throw error;
      return;
    }
    map().delete(id);
  }

  async function removeWhere(eq) {
    if (useSupabase) {
      let q = supabase.from(name).delete();
      for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
      const { error } = await q;
      if (error) throw error;
      return;
    }
    for (const [k, v] of [...map().entries()]) {
      if (Object.entries(eq).every(([ek, ev]) => v[ek] === ev)) map().delete(k);
    }
  }

  return { all, one, insert, update, remove, removeWhere };
}

// ---- users ----
export const users = table('users');
export const userTokens = table('user_tokens');
export const attachments = table('attachments');
export const userMemories = table('user_memories');

export async function getUserByEmail(email) {
  const rows = await users.all({ eq: { email: String(email).toLowerCase() }, limit: 1 });
  return rows[0] ?? null;
}

export async function createUser({ email, passwordHash, state = {} }) {
  const user = await users.insert({
    email: email ? String(email).toLowerCase() : null,
    password_hash: passwordHash ?? null,
    user_state: state,
  });
  return user;
}

export async function getUserState(userId) {
  const u = await users.one(userId);
  if (!u) return null;
  return (typeof u.user_state === 'string' ? JSON.parse(u.user_state) : u.user_state) ?? {};
}

export async function saveUserState(userId, state) {
  await users.update(userId, { user_state: state });
  return state;
}

export async function findTokenUser(tokenHash) {
  const rows = await userTokens.all({ eq: { token_hash: tokenHash }, limit: 1 });
  return rows[0] ?? null;
}
