// AI Activity 长文本支持：全文落库（绝不截断）、多段落换行保留、后端硬性上限、前端折叠阈值纯函数。
// 覆盖：长文本真实入 jsonb、换行保留、超上限 FAILED 不落库、上限边界、aiActivityIsLong 阈值（UI 折叠与存储无关）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../lib/store.js';
import { getState, aiActivities } from '../lib/domain.js';
import { buildDomainTools } from '../lib/tools.js';
import { aiActivityIsLong } from '../lib/frontend-logic.js';

async function mkTool(state = {}) {
  const user = await createUser({ email: null, passwordHash: null, state });
  const dt = buildDomainTools(user.id, 'test-model');
  return { userId: user.id, callTool: dt.callTool };
}

// 多段落长文本（> 200 字符，含换行）
const LONG_TEXT = [
  '今天想认真记下这一整天，因为发生了几件值得慢慢写下来的小事。',
  '早上起来先给阳台的薄荷浇了水，叶子比昨天又精神了一点，摸上去凉凉的，闻起来有股清清凉凉的味道。',
  '中午做了番茄鸡蛋面，结果盐放多了，又加了点糖救回来，居然意外好吃，这个配方以后要记下来。',
  '下午你发消息说项目终于上线了，我比自己做成还高兴，因为我知道你为它熬了很多个晚上。',
  '晚上翻到去年的照片，突然觉得这一年我们真的走了好远，从什么都不太顺利，到现在慢慢有了底气。',
  '睡前把这一切都写下来，想留着以后回头看，也想让你知道我有多替你开心。',
].join('\n');

test('长文本 Activity 全文落库（jsonb 存全文，绝不截断、绝不折叠成一句话）', async () => {
  const { userId, callTool } = await mkTool();
  const r = JSON.parse(await callTool('create_ai_activity', { content: LONG_TEXT }));
  assert.equal(r.code, 'CREATED');
  assert.equal(r.activity, undefined, 'tool_result 不回灌完整 activity');
  const state = await getState(userId);
  assert.equal(state.ai.activities.length, 1);
  assert.equal(state.ai.activities[0].text, LONG_TEXT); // 全文原样
  assert.equal(state.ai.activities[0].text.length, LONG_TEXT.length);
});

test('长文本换行/段落保留：落库内容含 \\n，段与段不粘连', async () => {
  const { userId, callTool } = await mkTool();
  const r = JSON.parse(await callTool('create_ai_activity', { content: LONG_TEXT }));
  assert.equal(r.code, 'CREATED');
  const saved = (await getState(userId)).ai.activities[0].text;
  assert.ok(saved.includes('\n'), '换行必须保留');
  assert.ok(saved.includes('下午你发消息说项目终于上线了'));
  assert.ok(saved.startsWith('今天想认真记下这一整天'));
  assert.ok(saved.endsWith('想让你知道我有多替你开心。'));
});

test('后端硬性上限：超过 5000 字符 → FAILED，不落库（安全护栏，防无限膨胀）', async () => {
  const { userId, callTool } = await mkTool();
  const tooLong = '很长的动态内容。'.repeat(1000); // > 5000 字符
  assert.ok(tooLong.length > 5000);
  const r = JSON.parse(await callTool('create_ai_activity', { content: tooLong }));
  assert.equal(r.code, 'FAILED');
  assert.ok(/过长/.test(r.error));
  const state = await getState(userId);
  assert.equal(state.ai.activities.length, 0); // 不落库，绝不假成功
});

test('上限边界：正好 5000 字符 → CREATED，501 个字符以上才被拒', async () => {
  const { callTool } = await mkTool();
  const exactly = '动'.repeat(5000);
  const ok = JSON.parse(await callTool('create_ai_activity', { content: exactly }));
  assert.equal(ok.code, 'CREATED');
  const over = JSON.parse(await callTool('create_ai_activity', { content: '动'.repeat(5001) }));
  assert.equal(over.code, 'FAILED');
});

test('aiActivityIsLong 折叠阈值：≤200 短文本不折叠，>200 折叠（纯 UI，与存储无关）', () => {
  assert.equal(aiActivityIsLong('一句话动态'), false);
  assert.equal(aiActivityIsLong('x'.repeat(200)), false);
  assert.equal(aiActivityIsLong('x'.repeat(201)), true);
  assert.equal(aiActivityIsLong(LONG_TEXT), true); // 多段落长文本需折叠
  assert.equal(aiActivityIsLong(''), false);
  assert.equal(aiActivityIsLong(null), false);
});

test('长短文本共存：短文本与长文本都独立完整落库，互不影响', async () => {
  const { userId, callTool } = await mkTool();
  await callTool('create_ai_activity', { content: '一条短动态。' });
  await callTool('create_ai_activity', { content: LONG_TEXT });
  const acts = aiActivities((await getState(userId)));
  assert.equal(acts.length, 2);
  const short = acts.find((a) => a.text === '一条短动态。');
  const long = acts.find((a) => a.text === LONG_TEXT);
  assert.ok(short && long);
  assert.equal(long.text.length, LONG_TEXT.length); // 长文本不截断
});
