import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  neteaseUiState, memoryLoadFlags, targetWallpaperSize, pickWallpaperMime,
  attachmentMaxSize, validateAttachmentFile, dedupeAttachmentIds,
} from '../lib/frontend-logic.js';

// ---- 网易云登录态（后端 /api/music/status 为权威来源，绝不依赖 localStorage）----

test('neteaseUiState: logged_in + userId → loggedIn（不依赖 localStorage）', () => {
  const s = neteaseUiState({ ok: true, data: { status: 'logged_in', userId: 1775803316, nickname: 'X', avatarUrl: '' } }, null);
  assert.equal(s.action, 'loggedIn');
  assert.equal(s.user.userId, 1775803316);
  assert.equal(s.changed, true);
});

test('neteaseUiState: 同一账号刷新 → changed=false（不误清歌单队列）', () => {
  const s = neteaseUiState({ ok: true, data: { status: 'logged_in', userId: 1775803316 } }, 1775803316);
  assert.equal(s.action, 'loggedIn');
  assert.equal(s.changed, false);
});

test('neteaseUiState: not_logged_in / 缺失 status → notLoggedIn', () => {
  assert.equal(neteaseUiState({ ok: true, data: { status: 'not_logged_in' } }, null).action, 'notLoggedIn');
  assert.equal(neteaseUiState({ ok: true, data: {} }, 1).action, 'notLoggedIn');
});

test('neteaseUiState: expired → expired；error → error；网络失败 → networkError（不误判成过期）', () => {
  assert.equal(neteaseUiState({ ok: true, data: { status: 'expired' } }, null).action, 'expired');
  assert.equal(neteaseUiState({ ok: true, data: { status: 'error' } }, null).action, 'error');
  assert.equal(neteaseUiState({ ok: false, err: 'network' }, null).action, 'networkError');
});

// ---- 记忆加载循环守卫（只加载一次、渲染一次、不无限循环）----

test('memoryLoadFlags: loading=true 时重复调用被忽略（防重入，避免循环刷新）', () => {
  const prev = { loading: true, loaded: false, error: null };
  assert.equal(memoryLoadFlags(prev, { ok: true }), prev);
});

test('memoryLoadFlags: 成功后 loaded=true（不会再自动重拉）', () => {
  const next = memoryLoadFlags({ loading: false, loaded: false, error: null }, { ok: true });
  assert.deepEqual(next, { loading: false, loaded: true, error: null });
});

test('memoryLoadFlags: 失败 → error 置位、loaded 保持 false（不再自动重拉）', () => {
  const next = memoryLoadFlags({ loading: false, loaded: false, error: null }, { ok: false, error: '无法连接服务' });
  assert.deepEqual(next, { loading: false, loaded: false, error: '无法连接服务' });
});

// ---- 壁纸压缩 / 保存回退 ----

test('targetWallpaperSize: 超大图按最长边缩到 maxDim，不放大', () => {
  assert.deepEqual(targetWallpaperSize(4000, 2000, 1600), { width: 1600, height: 800, scaled: true });
  assert.deepEqual(targetWallpaperSize(800, 600, 1600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(targetWallpaperSize(0, 0, 1600), { width: 0, height: 0, scaled: false });
});

test('pickWallpaperMime: WebP 有效用 WebP，否则回退 JPEG', () => {
  assert.equal(pickWallpaperMime('data:image/webp;base64,xxx'), 'image/webp');
  assert.equal(pickWallpaperMime('data:image/png;base64,xxx'), 'image/jpeg');
  assert.equal(pickWallpaperMime(null), 'image/jpeg');
});

// ---- 附件 state / 大小 / 去重 ----

test('attachmentMaxSize / validateAttachmentFile: 图片 20MB、文件 50MB 上限', () => {
  assert.equal(attachmentMaxSize(true), 20 * 1024 * 1024);
  assert.equal(attachmentMaxSize(false), 50 * 1024 * 1024);
  assert.equal(validateAttachmentFile(21 * 1024 * 1024, 'image/png').ok, false);
  assert.equal(validateAttachmentFile(10 * 1024 * 1024, 'image/png').ok, true);
  assert.equal(validateAttachmentFile(49 * 1024 * 1024, 'application/pdf').ok, true);
  assert.equal(validateAttachmentFile(51 * 1024 * 1024, 'application/pdf').ok, false);
});

test('dedupeAttachmentIds: 去重 + 上限 10（过滤空值）', () => {
  assert.deepEqual(dedupeAttachmentIds(['a', 'b', 'a', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(dedupeAttachmentIds(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']).length, 10);
  assert.deepEqual(dedupeAttachmentIds([null, '', 'x']), ['x']);
});
