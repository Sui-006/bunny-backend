// 审计日志：AI 对用户数据的每一次真实修改都落一条记录（before/after/actor/原因/会话/动作）。
// 存于 doc.ai.auditLog（数组，随整文档同步到前端，无需新表），上限裁剪最旧。
import { randomUUID } from 'node:crypto';

const AUDIT_MAX = 300;
const META_KEYS = new Set(['id', 'createdAt', 'updatedAt']);

export const AUDIT_ACTOR = { USER: 'user', ASSISTANT: 'assistant', SYSTEM: 'system' };

export function recordAudit(doc, {
  action, aiAction, entityType, entityId, entityLabel,
  before = null, after = null, actor = AUDIT_ACTOR.ASSISTANT, reason = '', conversationId = null,
}) {
  if (!doc.ai) doc.ai = {};
  if (!Array.isArray(doc.ai.auditLog)) doc.ai.auditLog = [];
  doc.ai.auditLog.unshift({
    id: randomUUID(), at: Date.now(), action, aiAction, entityType,
    entityId: entityId ?? null, entityLabel: entityLabel ?? null,
    before, after, actor, reason: reason ?? '', conversationId: conversationId ?? null,
  });
  if (doc.ai.auditLog.length > AUDIT_MAX) doc.ai.auditLog.length = AUDIT_MAX;
}

// 供前端按实体取最近一条痕迹（渲染「[助手] 于 … 编辑」）
export function latestAuditFor(doc, entityType, entityId) {
  return (doc.ai?.auditLog || []).find((a) => a.entityType === entityType && a.entityId === entityId) || null;
}

// 深拷贝某个键值（支持 'ai.memories' 点路径）
export function clonePath(doc, key) {
  if (!key) return undefined;
  let cur = doc;
  for (const seg of key.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return clone(cur);
}

function clone(v) {
  if (v === undefined || v === null) return v;
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

function publicFields(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) if (!META_KEYS.has(k)) out[k] = v;
  return out;
}

function labelOf(entity) {
  if (!entity || typeof entity !== 'object') return null;
  return entity.title || entity.name || entity.itemName || entity.summary || entity.content || entity.text || entity.date || entity.key || entity.emotion || entity.id || null;
}

// 对比 before/after 两个快照（数组或对象），定位本次改动：
// 返回 { action:'create'|'update'|'delete', entityId, entityLabel, before, after } 或 null（无变化）。
export function diffValue(before, after, idArg, result) {
  // 数组实体
  if (Array.isArray(after) && Array.isArray(before)) {
    const bMap = new Map(before.map((x) => [x.id, x]));
    const aMap = new Map(after.map((x) => [x.id, x]));
    // create：新增
    for (const x of after) if (!bMap.has(x.id)) {
      return { action: 'create', entityId: x.id, entityLabel: labelOf(x), before: null, after: publicFields(x) };
    }
    // delete：被移除
    for (const x of before) if (!aMap.has(x.id)) {
      return { action: 'delete', entityId: x.id, entityLabel: labelOf(x), before: publicFields(x), after: null };
    }
    // update：同 id 且字段变化（优先按 args.id / result.id 定位）
    const targetId = idArg || result?.id || result?.record?.id || result?.task?.id || result?.memory?.id || result?.habit?.id || result?.note?.id || result?.plan?.id || result?.item?.id;
    for (const x of after) {
      if (!bMap.has(x.id)) continue;
      if (targetId != null && x.id !== targetId) continue;
      const d = diffObjects(bMap.get(x.id), x);
      if (d.changed) return { action: 'update', entityId: x.id, entityLabel: labelOf(x), before: d.before, after: d.after };
      if (targetId != null) return null; // 指定了实体但没变化
    }
    return null;
  }

  // 非数组对象 / 值：null 过渡视为 create/delete，否则做字段级 diff
  const bObj = before && typeof before === 'object' && !Array.isArray(before) ? before : null;
  const aObj = after && typeof after === 'object' && !Array.isArray(after) ? after : null;
  if (!bObj && aObj) {
    return { action: 'create', entityId: idArg ?? null, entityLabel: labelOf(aObj), before: null, after: publicFields(aObj) };
  }
  if (bObj && !aObj) {
    return { action: 'delete', entityId: idArg ?? null, entityLabel: labelOf(bObj), before: publicFields(bObj), after: null };
  }
  if (bObj && aObj) {
    const d = diffObjects(bObj, aObj);
    if (d.changed) return { action: 'update', entityId: idArg ?? null, entityLabel: labelOf(aObj) || labelOf(bObj), before: d.before, after: d.after };
  }
  return null;
}

function diffObjects(prev, now) {
  const beforeFields = {};
  const afterFields = {};
  let changed = false;
  for (const [k, v] of Object.entries(now)) {
    if (META_KEYS.has(k)) continue;
    const pv = prev[k];
    if (JSON.stringify(pv) !== JSON.stringify(v)) { beforeFields[k] = pv; afterFields[k] = v; changed = true; }
  }
  for (const [k, v] of Object.entries(prev)) {
    if (META_KEYS.has(k) || k in now) continue;
    beforeFields[k] = v; afterFields[k] = undefined; changed = true;
  }
  return { before: beforeFields, after: afterFields, changed };
}
