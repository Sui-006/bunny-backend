import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiCan, USER_ONLY_EDITABLE, AI_PERMISSION_POLICY, TOOL_ACTIONS } from '../lib/permissions.js';
import { createUser } from '../lib/store.js';
import { getState } from '../lib/domain.js';
import { buildDomainTools } from '../lib/tools.js';

// ---- 权限策略（单一来源，四粒度，非 ADMIN 兜底） ----
test('日志 / 签名 = USER_ONLY_EDITABLE：AI 只读，绝不 create/write/delete', () => {
  assert.ok(USER_ONLY_EDITABLE.has('journal'));
  assert.ok(USER_ONLY_EDITABLE.has('signature'));
  for (const e of ['journal', 'signature']) {
    assert.equal(aiCan(e, 'read'), true);
    assert.equal(aiCan(e, 'create'), false);
    assert.equal(aiCan(e, 'write'), false);
    assert.equal(aiCan(e, 'delete'), false);
  }
});

test('任务 / 计划 / 日历 / 习惯 / 购物 / 笔记 / 记忆 四粒度全开', () => {
  for (const e of ['tasks', 'plans', 'calendar', 'habit', 'shopping', 'notes', 'memory']) {
    assert.equal(aiCan(e, 'read'), true, e + '.read');
    assert.equal(aiCan(e, 'create'), true, e + '.create');
    assert.equal(aiCan(e, 'write'), true, e + '.write');
    assert.equal(aiCan(e, 'delete'), true, e + '.delete');
  }
});

test('统计 / 会话历史 / AI 动态 = 派生只读，不可写', () => {
  for (const e of ['statistics', 'conversation', 'activity']) {
    assert.equal(aiCan(e, 'read'), true);
    assert.equal(aiCan(e, 'create'), false);
    assert.equal(aiCan(e, 'write'), false);
    assert.equal(aiCan(e, 'delete'), false);
  }
});

test('未知实体 / 未知动作默认拒绝（绝不默认放行）', () => {
  assert.equal(aiCan('nonexistent', 'read'), false);
  assert.equal(aiCan('journal', 'nuke'), false);
});

test('日志只有 get_journal 一个只读工具，无任何写/删工具', () => {
  const journalTools = Object.keys(TOOL_ACTIONS).filter((n) => TOOL_ACTIONS[n].entity === 'journal');
  assert.deepEqual(journalTools, ['get_journal']);
  assert.equal(TOOL_ACTIONS.get_journal.action, 'read');
});

test('策略表覆盖需求模块（含 Health/Statistics 等），不设 ADMIN', () => {
  for (const k of ['journal', 'signature', 'tasks', 'plans', 'calendar', 'habit', 'shopping', 'notes', 'memory', 'health', 'statistics', 'activity']) {
    assert.ok(AI_PERMISSION_POLICY[k], k);
  }
  assert.equal('admin' in AI_PERMISSION_POLICY, false);
});

// ---- 端到端：真实修改必须落审计（before/after/actor/原因/动作） ----
test('update_task：落一条 assistant 审计，含 before/after/原因/aiAction', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { tasks: [{ id: 't1', title: '整理房间', date: '2026-09-18', completed: false, priority: 'med', createdAt: 1, updatedAt: 1 }] },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = JSON.parse(await callTool('update_task', { id: 't1', date: '2026-09-20', reason: '用户要求改到明天' }));
  assert.equal(r.code, 'OK');

  const state = await getState(user.id);
  assert.equal(state.tasks[0].date, '2026-09-20'); // 数据库真实改到了
  const log = state.ai.auditLog.find((a) => a.entityType === 'tasks' && a.entityId === 't1');
  assert.ok(log, '存在审计记录');
  assert.equal(log.actor, 'assistant');
  assert.equal(log.action, 'update');
  assert.equal(log.aiAction, 'update_task');
  assert.equal(log.reason, '用户要求改到明天');
  assert.equal(log.entityLabel, '整理房间');
  assert.equal(log.before.date, '2026-09-18');
  assert.equal(log.after.date, '2026-09-20');
});

test('create_task / delete_task：action 分别为 create/delete，删除保留原始快照', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const created = JSON.parse(await callTool('create_task', { title: '临时任务', reason: '测试' }));
  assert.equal(created.code, 'CREATED');
  const taskId = created.task.id;

  const deleted = JSON.parse(await callTool('delete_task', { id: taskId, reason: '不需要了' }));
  assert.equal(deleted.code, 'OK');

  const state = await getState(user.id);
  const createLog = state.ai.auditLog.find((a) => a.entityId === taskId && a.action === 'create');
  const deleteLog = state.ai.auditLog.find((a) => a.entityId === taskId && a.action === 'delete');
  assert.ok(createLog, 'create 审计');
  assert.equal(createLog.after.title, '临时任务');
  assert.ok(deleteLog, 'delete 审计');
  assert.equal(deleteLog.reason, '不需要了');
  assert.equal(deleteLog.before.title, '临时任务'); // 删除保留原始快照
});

// ---- 日历薄封装 task：审计 entityType 必须落 'tasks'（前端任务行据此渲染痕迹） ----
test('update_calendar_event：权限判 calendar，审计落 tasks（前端能渲染痕迹）', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { tasks: [{ id: 't2', title: '开会', date: '2026-09-19', completed: false, priority: 'med', createdAt: 1, updatedAt: 1 }] },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = JSON.parse(await callTool('update_calendar_event', { id: 't2', date: '2026-09-21', reason: '改期' }));
  assert.equal(r.code, 'OK');

  const state = await getState(user.id);
  const log = state.ai.auditLog.find((a) => a.entityId === 't2');
  assert.ok(log);
  assert.equal(log.entityType, 'tasks'); // 关键：不是 calendar，任务行能看到痕迹
  assert.equal(log.aiAction, 'update_calendar_event');
  assert.equal(log.after.date, '2026-09-21');
});

// ---- AI 无权修改日志：不存在任何写日志工具，且策略硬性拦截 ----
test('AI 无法通过工具写日志（策略 + 无工具双重保障）', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { journal: [{ id: 'j1', date: '2026-09-17', content: '用户原话', mood: '平静' }] },
  });
  const { callTool, names } = buildDomainTools(user.id, 'test-model');
  assert.equal(names.includes('get_journal'), true);
  assert.equal(names.some((n) => /journal/.test(n) && n !== 'get_journal'), false); // 无 create/update/delete journal

  const r = JSON.parse(await callTool('get_journal', {}));
  assert.equal(r.code, 'OK');
  assert.equal(r.journal[0].content, '用户原话'); // 原话原样返回，只读
});
