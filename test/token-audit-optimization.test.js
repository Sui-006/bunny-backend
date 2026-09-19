// Token 降本优化回归测试。
// 覆盖：领域检测收紧（通用时间/日常词绝不触发 tasks/journal）、Context/Tool 领域分离、
//       Tool→Domain 映射完整性、按领域裁剪工具注入（绝不全量 87 个）、Bark 常驻、Cost Guard 计入工具 schema。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContextDomains, detectToolDomains } from '../lib/aiContext.js';
import { buildDomainTools, CORE_ALWAYS_TOOLS, TOOL_DOMAIN_MAP, toolsForDomains } from '../lib/tools.js';
import { buildAIContext } from '../lib/context-builder.js';
import { defaultState } from '../lib/domain.js';
import { createSession, createMessage } from '../lib/db.js';

// ---------------- 领域检测收紧 ----------------

test('通用时间/日常词绝不触发 tasks 工具领域', () => {
  for (const t of ['今天过得怎么样？', '你在干嘛？', '最近怎么样？', '今天吃什么？', '今天心情不错', '现在几点', '我好累', '谢谢', '晚安', '讲个笑话']) {
    assert.ok(!detectToolDomains(t).includes('tasks'), `${t} 不应命中 tasks 工具领域`);
  }
});

test('强意图触发对应工具领域', () => {
  assert.ok(detectToolDomains('帮我创建一个任务').includes('tasks'));
  assert.ok(detectToolDomains('把这个任务完成').includes('tasks'));
  assert.ok(detectToolDomains('修改我的周计划').includes('plans'));
  assert.ok(detectToolDomains('记录这条记忆').includes('memory'));
  assert.ok(detectToolDomains('修改健康记录').includes('health'));
  assert.ok(detectToolDomains('修改账单').includes('finance'));
});

test('「把买猫粮加入我的清单」只触发 shopping，不触发 finance', () => {
  const ds = detectToolDomains('把买猫粮加入我的清单');
  assert.ok(ds.includes('shopping'));
  assert.ok(!ds.includes('finance'));
});

test('journal 不被「今天心情不错」误触发，明确写/看日志才触发', () => {
  assert.ok(!detectToolDomains('今天心情不错').includes('journal'));
  assert.ok(detectToolDomains('帮我写日志').includes('journal'));
  assert.ok(detectToolDomains('查看我的日志').includes('journal'));
});

test('life 是只读上下文领域，绝不触发工具注入', () => {
  assert.ok(detectContextDomains('今天过得怎么样？').includes('life'));
  assert.ok(!detectToolDomains('今天过得怎么样？').includes('life'));
});

// ---------------- Tool→Domain 映射完整性 ----------------

test('每个工具要么在 CORE_ALWAYS_TOOLS，要么在 TOOL_DOMAIN_MAP 有归属（共 90 个）', () => {
  const { names } = buildDomainTools('x', 'test-model');
  assert.equal(names.length, 90);
  const core = new Set(CORE_ALWAYS_TOOLS);
  for (const n of names) {
    assert.ok(core.has(n) || TOOL_DOMAIN_MAP[n], `工具 ${n} 缺少领域映射`);
  }
});

test('TOOL_DOMAIN_MAP / CORE_ALWAYS_TOOLS 里没有幽灵工具名（全为真实工具）', () => {
  const nameSet = new Set(buildDomainTools('x', 'test-model').names);
  for (const n of Object.keys(TOOL_DOMAIN_MAP)) assert.ok(nameSet.has(n), `TOOL_DOMAIN_MAP 含未知工具 ${n}`);
  for (const c of CORE_ALWAYS_TOOLS) assert.ok(nameSet.has(c), `CORE_ALWAYS_TOOLS 含未知工具 ${c}`);
});

// ---------------- 按领域裁剪工具注入 ----------------

test('普通聊天只注入核心工具（9 个），远小于全量 90', () => {
  const full = buildDomainTools('x', 'test-model').tools;
  const core = toolsForDomains([]);
  assert.equal(core.length, CORE_ALWAYS_TOOLS.length);
  assert.equal(core.length, 9);
  assert.ok(core.length < full.length / 2, '核心工具应远少于全量');
});

test('shopping 聊天只带 shopping + 核心，不带 finance/health/plan 工具', () => {
  const ts = toolsForDomains(detectToolDomains('把买猫粮加入我的清单'));
  const names = ts.map((t) => t.name);
  assert.ok(names.includes('add_shopping_item'));
  assert.ok(names.includes('send_bark_notification')); // Bark 常驻
  assert.ok(!names.includes('create_task'));
  assert.ok(!names.includes('add_expense'));
  assert.ok(!names.includes('update_plan'));
  assert.ok(!names.includes('get_health_records'));
});

test('plans 聊天只带 plan + 核心，不带 shopping/health 工具', () => {
  const ts = toolsForDomains(detectToolDomains('修改我的周计划'));
  const names = ts.map((t) => t.name);
  assert.ok(names.includes('update_plan'));
  assert.ok(!names.includes('add_shopping_item'));
  assert.ok(!names.includes('get_health_records'));
});

test('「提醒我喝水」保留 Bark（常驻），且仍能命中 health', () => {
  const ts = toolsForDomains(detectToolDomains('提醒我喝水'));
  const names = ts.map((t) => t.name);
  assert.ok(names.includes('send_bark_notification'));
  assert.ok(names.includes('add_health_record'));
});

// ---------------- Cost Guard 计入工具 schema ----------------

test('buildAIContext 真实计入工具 schema tokens（不再恒为 0）', async () => {
  const s = await createSession('工具schema');
  await createMessage(s.id, { role: 'user', content: '把猫粮加入清单' });
  const domainTools = toolsForDomains(['shopping']);
  const built = await buildAIContext({
    sessionId: s.id, doc: defaultState(), settings: {},
    content: '把猫粮加入清单', model: 'deepseek-chat', tools: domainTools,
  });
  assert.ok(built.stats.toolTokens > 0, '应真实计算工具 schema tokens');
  assert.equal(built.stats.toolCount, domainTools.length);
  assert.ok(built.stats.totalEstimatedTokens >= built.stats.toolTokens);
});

test('不带工具时 toolTokens 为 0，且不破坏既有字段', async () => {
  const s = await createSession('无工具');
  await createMessage(s.id, { role: 'user', content: '你好' });
  const built = await buildAIContext({ sessionId: s.id, doc: defaultState(), settings: {}, content: '你好', model: 'deepseek-chat' });
  assert.equal(built.stats.toolTokens, 0);
  assert.equal(built.stats.toolCount, 0);
});
