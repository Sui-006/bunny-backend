import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, getUserState } from '../lib/store.js';
import { buildDomainTools } from '../lib/tools.js';

test('add_shopping_item 严格区分 owner：mine→user，deity/assistant→assistant', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');

  const mine = JSON.parse(await callTool('add_shopping_item', { title: '牛奶', listId: 'mine', reason: '测试' }));
  assert.equal(mine.code, 'CREATED');
  assert.equal(mine.item.owner, 'user');
  assert.equal(mine.item.listId, 'mine');

  const deity = JSON.parse(await callTool('add_shopping_item', { title: '她想要的花', owner: 'assistant', reason: '测试' }));
  assert.equal(deity.code, 'CREATED');
  assert.equal(deity.item.owner, 'assistant');
  assert.equal(deity.item.listId, 'deity');

  // 缺省 listId/owner → 回退 mine（用户清单），绝不默认写进祂的清单
  const def = JSON.parse(await callTool('add_shopping_item', { title: '默认牛奶', reason: '测试' }));
  assert.equal(def.item.owner, 'user');
  assert.equal(def.item.listId, 'mine');
});

test('list_shopping 按 owner 过滤，owner 不串清单', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  await callTool('add_shopping_item', { title: '我的牛奶', listId: 'mine' });
  await callTool('add_shopping_item', { title: '祂的花', owner: 'assistant' });

  const mine = JSON.parse(await callTool('list_shopping', { owner: 'user' }));
  assert.equal(mine.count, 1);
  assert.equal(mine.items[0].title, '我的牛奶');
  assert.ok(mine.items.every((i) => i.owner === 'user'));

  const deity = JSON.parse(await callTool('list_shopping', { owner: 'assistant' }));
  assert.equal(deity.count, 1);
  assert.equal(deity.items[0].title, '祂的花');
  assert.ok(deity.items.every((i) => i.owner === 'assistant'));
});

test('complete_shopping_item 完成切换，不影响另一份清单', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const created = JSON.parse(await callTool('add_shopping_item', { title: '买书', owner: 'user' }));
  const done = JSON.parse(await callTool('complete_shopping_item', { id: created.item.id, completed: true }));
  assert.equal(done.code, 'OK');
  assert.equal(done.item.completed, true);
  assert.equal(done.item.owner, 'user'); // 完成不改 owner

  // 缺省 list_shopping 只列未购 → 完成后不再出现
  const list = JSON.parse(await callTool('list_shopping', { owner: 'user' }));
  assert.equal(list.count, 0);
});

test('update_shopping_item 可把条目移动到另一份清单（listId 与 owner 联动）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const created = JSON.parse(await callTool('add_shopping_item', { title: '移动条目', owner: 'user' }));
  const moved = JSON.parse(await callTool('update_shopping_item', { id: created.item.id, owner: 'assistant' }));
  assert.equal(moved.code, 'OK');
  assert.equal(moved.item.owner, 'assistant');
  assert.equal(moved.item.listId, 'deity');

  const mine = JSON.parse(await callTool('list_shopping', { owner: 'user' }));
  assert.equal(mine.count, 0);
  const deity = JSON.parse(await callTool('list_shopping', { owner: 'assistant' }));
  assert.equal(deity.count, 1);
  assert.equal(deity.items[0].title, '移动条目');
});

test('购物修改写入 Audit（entityType=shopping，actor=assistant）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  await callTool('add_shopping_item', { title: '审计条目', owner: 'user', reason: '测试审计' });
  const doc = await getUserState(user.id);
  const audit = (doc.ai?.auditLog || []).filter((a) => a.entityType === 'shopping');
  assert.ok(audit.length >= 1);
  assert.equal(audit[0].actor, 'assistant');
  assert.equal(audit[0].aiAction, 'add_shopping_item');
});
