import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultTaste, normalizeSong, activeAssistantId, getAssistant, assistantModel,
  startSession, endSession, isActiveSession, shouldAiSpeak, markAiCommented,
  fallbackNextSong, updateTasteProfile, recordReaction, getContext,
  sanitizeSession, sanitizeAssistant,
  AI_COMMENT_COOLDOWN_MS,
} from '../services/music-companion-service.js';
import { config } from '../lib/config.js';

// 构造一份最小文档：两个助手 + 激活的是第二个（不是 assistants[0]），播放列表里有两个本地曲目（无 id，不触发网易云）
function mkDoc() {
  return {
    assistants: [
      { id: 'a1', name: '一号', model: 'deepseek-chat' },
      { id: 'a2', name: '二号', model: 'gpt-x' },
    ],
    activeAssistantId: 'a2',
    player: {
      playlist: [
        { id: null, title: 'Turning Page', artist: 'Sleeping At Last', duration: 255 },
        { id: 'n1', title: '晴天', artist: '周杰伦', duration: 269 },
      ],
      current: 0, playing: false, currentTime: 0, volume: 0.8,
      togetherListening: false, autoNext: false,
    },
    listeningSession: null,
    musicTasteProfile: defaultTaste(),
    listeningHistory: [],
  };
}

test('activeAssistantId 取当前激活助手，绝不 fallback 到 assistants[0]', () => {
  const doc = mkDoc();
  assert.equal(activeAssistantId(doc), 'a2');
  // 助手数组第一个是 a1，若误用 assistants[0] 会得到 a1
  assert.notEqual(activeAssistantId(doc), doc.assistants[0].id);
});

test('assistantModel 取激活助手的模型，缺失时兜底默认模型', () => {
  const doc = mkDoc();
  assert.equal(assistantModel(doc), 'gpt-x');
  const empty = { assistants: [], activeAssistantId: null };
  assert.equal(assistantModel(empty), config.defaultModel);
});

test('normalizeSong 统一 title/name 形状', () => {
  assert.deepEqual(normalizeSong({ id: 'x', name: 'N', artist: 'A', album: 'B', cover: 'c', duration: 10 }), { id: 'x', name: 'N', artist: 'A', album: 'B', cover: 'c', duration: 10 });
  assert.equal(normalizeSong({ title: 'T', artist: 'A' }).name, 'T');
  assert.equal(normalizeSong(null), null);
});

test('startSession 绑定当前 assistantId（activeAssistantId），并写入 player.togetherListening', () => {
  const doc = mkDoc();
  const s = startSession(doc, { autoNext: true });
  assert.equal(s.assistantId, 'a2');
  assert.equal(s.status, 'active');
  assert.equal(s.autoNext, true);
  assert.equal(doc.player.togetherListening, true);
  assert.equal(doc.player.autoNext, true);
  assert.equal(isActiveSession(doc), true);
});

test('startSession 可指定存在的 assistantId；重复开启保留原 id/startedAt', () => {
  const doc = mkDoc();
  const first = startSession(doc, { assistantId: 'a1' });
  assert.equal(first.assistantId, 'a1');
  const startedAt = first.startedAt;
  const second = startSession(doc, { assistantId: 'a1' });
  assert.equal(second.assistantId, 'a1');
  assert.equal(second.id, first.id);
  assert.equal(second.startedAt, startedAt);
});

test('startSession 不传 assistantId 时始终绑定当前激活助手（重新绑定 activeAssistantId）', () => {
  const doc = mkDoc();
  const first = startSession(doc, { assistantId: 'a1' });
  assert.equal(first.assistantId, 'a1');
  const second = startSession(doc, {});
  assert.equal(second.assistantId, 'a2'); // 会话重新绑定到当前激活助手，而非沿用旧值
});

test('endSession 关闭会话：togetherListening=false、status=ended、endedAt 有值', () => {
  const doc = mkDoc();
  startSession(doc, {});
  const s = endSession(doc);
  assert.equal(s.status, 'ended');
  assert.ok(s.endedAt);
  assert.equal(doc.player.togetherListening, false);
  assert.equal(isActiveSession(doc), false);
});

test('shouldAiSpeak：默认（无会话/非 active/无触发）绝不主动开口', () => {
  const now = Date.now();
  assert.equal(shouldAiSpeak(null, { now }).shouldSpeak, false);
  assert.equal(shouldAiSpeak({ status: 'ended' }, { now }).shouldSpeak, false);
  const active = { status: 'active', lastAiCommentAt: 0 };
  assert.equal(shouldAiSpeak(active, { event: 'idle', now }).shouldSpeak, false);
  assert.equal(shouldAiSpeak(active, { event: 'song_started', now }).shouldSpeak, false);
  assert.equal(shouldAiSpeak(active, { event: 'song_changed', now }).shouldSpeak, false);
});

test('shouldAiSpeak：5 分钟冷却 + 一首歌最多一次', () => {
  const now = Date.now();
  const active = { status: 'active', lastAiCommentAt: 0 };
  assert.equal(shouldAiSpeak(active, { event: 'user_requested', now }).shouldSpeak, true);
  // 冷却期内禁止
  const justSpoke = { status: 'active', lastAiCommentAt: now - 1000 };
  assert.equal(shouldAiSpeak(justSpoke, { event: 'user_requested', now }).shouldSpeak, false);
  assert.equal(shouldAiSpeak(justSpoke, { event: 'user_requested', now }).reason, 'cooldown');
  // 冷却期已过 + 同一首歌已评论过 → 不再说
  const commented = { status: 'active', lastAiCommentAt: now - AI_COMMENT_COOLDOWN_MS - 1, _commentedSongs: ['n1'] };
  assert.equal(shouldAiSpeak(commented, { event: 'song_ended_autonext', songId: 'n1', now }).shouldSpeak, false);
  // 冷却期已过 + 新歌 → 可以说
  assert.equal(shouldAiSpeak(commented, { event: 'song_ended_autonext', songId: 'n2', now }).shouldSpeak, true);
});

test('markAiCommented 记录发言时间 + 一首歌一次标记', () => {
  const doc = mkDoc();
  startSession(doc, {});
  const now = Date.now();
  markAiCommented(doc, 'n1', now);
  assert.equal(doc.listeningSession.lastAiCommentAt, now);
  assert.deepEqual(doc.listeningSession._commentedSongs, ['n1']);
  markAiCommented(doc, 'n1', now + 1);
  assert.equal(doc.listeningSession._commentedSongs.length, 1); // 不重复
});

test('fallbackNextSong：列表下一首，结尾回绕到第一首', () => {
  const doc = mkDoc();
  doc.player.current = 0;
  assert.equal(fallbackNextSong(doc).id, 'n1');
  doc.player.current = 1;
  assert.equal(fallbackNextSong(doc).id, null); // 回绕到第 0 首（本地曲目无 id）
  assert.equal(fallbackNextSong({ player: { playlist: [], current: 0 } }), null);
});

test('updateTasteProfile：只有明确 like/dislike 才更新画像，dislike 不抛错', () => {
  const doc = mkDoc();
  updateTasteProfile(doc, 'like', { name: '晴天', artist: '周杰伦' });
  assert.ok(doc.musicTasteProfile.favoriteArtists.some((x) => x.name === '周杰伦'));
  assert.ok(doc.musicTasteProfile.favoriteSongs.includes('晴天'));

  updateTasteProfile(doc, 'dislike', { name: '某歌', artist: '某歌手' });
  assert.ok(doc.musicTasteProfile.dislikedArtists.some((x) => x.name === '某歌手'));
  assert.ok(doc.musicTasteProfile.dislikedSongs.includes('某歌'));
  // 播放一次/跳过 不算偏好：favoriteArtists 不应因无关 reaction 变动
  const before = doc.musicTasteProfile.favoriteArtists.length;
  updateTasteProfile(doc, 'play', { name: 'x', artist: '周杰伦' });
  assert.equal(doc.musicTasteProfile.favoriteArtists.length, before);
});

test('recordReaction：写回播放列表曲目 reaction + 收听历史 + 画像', () => {
  const doc = mkDoc();
  const entry = recordReaction(doc, 'like', 'n1');
  assert.equal(entry.reaction, 'like');
  const track = doc.player.playlist.find((t) => t.id === 'n1');
  assert.equal(track.reaction, 'like');
  assert.equal(track.liked, true);
  assert.equal(doc.listeningHistory.length, 1);
  assert.ok(doc.musicTasteProfile.favoriteArtists.some((x) => x.name === '周杰伦'));
});

test('getContext：无 id 的本地曲目不触发网易云，返回结构化上下文', async () => {
  const doc = mkDoc();
  startSession(doc, {});
  const ctx = await getContext(doc);
  assert.equal(ctx.currentSong.name, 'Turning Page');
  assert.equal(ctx.lyricsContext, null); // 本地曲目无 id → 不拉歌词
  assert.equal(ctx.currentPlaylist.length, 2);
  assert.equal(ctx.listeningSession.status, 'active');
  assert.equal(ctx.assistant.id, 'a2'); // 上下文里的助手也是当前激活助手
});

// 路由 /api/listening/* 直接调用 sanitizeSession / sanitizeAssistant；二者必须是具名导出，且不泄露内部字段
test('sanitizeSession / sanitizeAssistant 被导出且只返回白名单字段', () => {
  const doc = mkDoc();
  startSession(doc, { assistantId: 'a1' });
  doc.listeningSession._commentedSongs = ['n1']; // 内部字段，绝不外泄

  const s = sanitizeSession(doc.listeningSession);
  assert.equal(s.id, doc.listeningSession.id);
  assert.equal(s.assistantId, 'a1');
  assert.equal(s.status, 'active');
  assert.equal(s.autoNext, false); // startSession 未传 autoNext → 沿用 player.autoNext（默认 false）
  assert.equal(s.companionEnabled, true);
  assert.equal('_commentedSongs' in s, false);
  assert.equal('createdAt' in s, false); // 内部时间戳不外泄
  assert.equal(sanitizeSession(null), null);

  const a = sanitizeAssistant(getAssistant(doc, 'a1'));
  assert.equal(a.id, 'a1');
  assert.equal(a.name, '一号');
  assert.equal(sanitizeAssistant(null), null);
});
