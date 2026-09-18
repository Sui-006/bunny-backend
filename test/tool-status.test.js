// 回归测试：AI 工具工作状态文案（tool status）——纯逻辑，与 public/index.html 内联保持一致。
// 核心要求：只展示可展示的工作状态；绝不硬编码「[助手]」；助手名可换；绝不透出 raw tool name / code / JSON。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_TOOL_STATUS_LABELS, TOOL_SUCCESS_CODES,
  toolStatusAction, toolWorkingText, toolResultStatus,
} from '../lib/frontend-logic.js';

test('AI_TOOL_STATUS_LABELS：不包含硬编码助手名（value 里绝无名字，名字由调用方前置）', () => {
  for (const v of Object.values(AI_TOOL_STATUS_LABELS)) {
    assert.ok(typeof v === 'string' && v.length > 0);
    assert.ok(!/小澄|Bunny|\[助手\]/.test(v), 'value 不应硬编码助手名');
  }
});

test('toolWorkingText：助手名前置 + 工作文案；换名自动更新', () => {
  assert.equal(toolWorkingText('send_bark_notification', '小澄'), '小澄正在发送 Bark 通知……');
  assert.equal(toolWorkingText('create_ai_activity', '小澄'), '小澄正在写入动态……');
  assert.equal(toolWorkingText('save_memory', '小澄'), '小澄正在记录记忆……');
  assert.equal(toolWorkingText('send_bark_notification', 'Bunny'), 'Bunny正在发送 Bark 通知……');
});

test('toolWorkingText：未知工具回退「正在处理……」且不透出 raw tool name', () => {
  assert.equal(toolWorkingText('some_unknown_tool', '小澄'), '小澄正在处理……');
});

test('toolResultStatus：成功 code 显示「已…」（done），短暂提示', () => {
  assert.deepEqual(toolResultStatus('send_bark_notification', 'OK', '小澄'), { text: '小澄已发送 Bark 通知', state: 'done' });
  assert.deepEqual(toolResultStatus('create_ai_activity', 'CREATED', '小澄'), { text: '小澄已写入动态', state: 'done' });
  assert.deepEqual(toolResultStatus('save_memory', 'CREATED', '小澄'), { text: '小澄已记录记忆', state: 'done' });
  assert.deepEqual(toolResultStatus('update_task', 'UPDATED', '小澄'), { text: '小澄已更新任务', state: 'done' });
});

test('toolResultStatus：code 缺失（MCP 非 JSON 结果）按成功 done，绝不误报失败', () => {
  assert.deepEqual(toolResultStatus('some_mcp_tool', undefined, '小澄'), { text: '小澄已处理', state: 'done' });
});

test('toolResultStatus：Bark 失败/拒绝/未配置/超时显示真实失败态，绝不假装成功', () => {
  assert.deepEqual(toolResultStatus('send_bark_notification', 'FAILED', '小澄'), { text: '小澄发送 Bark 通知失败', state: 'error' });
  assert.deepEqual(toolResultStatus('send_bark_notification', 'DENIED', '小澄'), { text: '小澄没有获得发送通知的权限', state: 'error' });
  assert.deepEqual(toolResultStatus('send_bark_notification', 'NOT_CONFIGURED', '小澄'), { text: '小澄发现 Bark 还没有配置', state: 'error' });
  assert.deepEqual(toolResultStatus('send_bark_notification', 'TIMEOUT', '小澄'), { text: '小澄发送通知超时', state: 'error' });
});

test('toolResultStatus：其他工具 DENIED / 超时 / 未找到 / 失败均落 error 态', () => {
  assert.deepEqual(toolResultStatus('create_task', 'DENIED', '小澄'), { text: '小澄没有获得权限', state: 'error' });
  assert.deepEqual(toolResultStatus('update_task', 'TIMEOUT', '小澄'), { text: '小澄操作超时', state: 'error' });
  assert.deepEqual(toolResultStatus('update_task', 'NOT_FOUND', '小澄'), { text: '小澄没有找到相关内容', state: 'error' });
  assert.deepEqual(toolResultStatus('create_task', 'FAILED', '小澄'), { text: '小澄创建任务失败', state: 'error' });
});

test('toolResultStatus：成功集合覆盖常见写入成功码', () => {
  for (const c of ['OK', 'CREATED', 'UPDATED', 'DELETED', 'SUCCESS']) {
    assert.ok(TOOL_SUCCESS_CODES.has(c), c + ' 应视为成功');
  }
  for (const c of ['FAILED', 'DENIED', 'NOT_CONFIGURED', 'TIMEOUT', 'NOT_FOUND', 'CONFLICT', 'UNKNOWN_TOOL']) {
    assert.ok(!TOOL_SUCCESS_CODES.has(c), c + ' 不应视为成功');
  }
});

test('toolStatusAction：从工作文案提取动作短语', () => {
  assert.equal(toolStatusAction('send_bark_notification'), '发送 Bark 通知');
  assert.equal(toolStatusAction('create_ai_activity'), '写入动态');
  assert.equal(toolStatusAction('unknown_xyz'), '处理');
});
