// 「和祂一起听」陪听服务（Music Companion Service）。
// 职责：陪听会话生命周期、上下文聚合、是否该主动发言、推荐下一首、音乐品味画像。
// 纯逻辑 + 文档访问；AI 调用（推荐）走 lib/ai.js，网易云走 lib/netease.js。
// 关键约束：
//   - 所有会话都绑定 assistantId（来自 doc.activeAssistantId，绝不 assistants[0]）。
//   - 绝不每秒调用 AI / 网易云：AI 只在关键事件（推荐、用户要求）时读取状态。
//   - AI 陪听默认不主动说话（shouldAiSpeak 默认 false），一首歌最多主动评论一次，冷却 5 分钟。
//   - AI 失败 / 推荐失败 / 歌词失败都不得中断播放，一律降级。
import { randomUUID } from 'node:crypto';
import { chat } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { search as neteaseSearch, songDetail, lyric as neteaseLyric } from '../lib/netease.js';

// 主动评论冷却（默认 5 分钟）
export const AI_COMMENT_COOLDOWN_MS = 5 * 60 * 1000;

// 默认品味画像结构（阶段一只基于 metadata + 歌词 + 播放行为，不虚构音频分析）
export function defaultTaste() {
  return {
    favoriteArtists: [],
    favoriteGenres: [],
    favoriteSongs: [],
    dislikedArtists: [],
    dislikedSongs: [],
    likedPatterns: [],
    dislikedPatterns: [],
    moodPreferences: [],
    discoveryHistory: [],
    updatedAt: 0,
  };
}

function currentTrack(doc) {
  const p = doc.player || {};
  return (p.playlist && p.playlist[p.current]) || null;
}

// 把播放列表里的曲目规整成统一形状 {id,name,artist,album,cover,duration}
export function normalizeSong(t) {
  if (!t) return null;
  return {
    id: t.id ?? null,
    name: t.name || t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    cover: t.cover || '',
    duration: Number(t.duration) || 0,
  };
}

// 当前激活助手 id（会话/上下文一律从这里取，绝不 assistants[0]）
export function activeAssistantId(doc) {
  return doc.activeAssistantId || null;
}

export function getAssistant(doc, id) {
  if (!id) return null;
  return (doc.assistants || []).find((a) => a.id === id) || null;
}

// 当前激活助手的模型（用于推荐），兜底默认模型
export function assistantModel(doc) {
  const a = getAssistant(doc, activeAssistantId(doc));
  return a?.model || config.defaultModel || 'deepseek-chat';
}

export function sanitizeAssistant(a) {
  if (!a) return null;
  return { id: a.id, name: a.name || '', avatar: a.avatar || '', avatarUrl: a.avatarUrl || '', personality: a.personality || '', model: a.model || '' };
}

export function sanitizeSession(s) {
  if (!s) return null;
  return {
    id: s.id || null,
    assistantId: s.assistantId || null,
    status: s.status || 'idle',
    autoNext: Boolean(s.autoNext),
    companionEnabled: Boolean(s.companionEnabled),
    lastAiCommentAt: s.lastAiCommentAt || 0,
    startedAt: s.startedAt || null,
    endedAt: s.endedAt || null,
  };
}

// ---------------- 会话生命周期 ----------------

export function startSession(doc, { assistantId, autoNext, companionEnabled } = {}) {
  doc.player = doc.player || {};
  const aid = assistantId || activeAssistantId(doc) || null;
  const now = Date.now();
  const prev = doc.listeningSession && typeof doc.listeningSession === 'object' ? doc.listeningSession : null;
  doc.player.togetherListening = true;
  if (autoNext != null) doc.player.autoNext = Boolean(autoNext);
  doc.listeningSession = {
    id: prev?.id || randomUUID(),
    assistantId: aid,
    status: 'active',
    autoNext: Boolean(autoNext ?? doc.player.autoNext ?? false),
    companionEnabled: Boolean(companionEnabled ?? true),
    lastAiCommentAt: prev?.lastAiCommentAt || 0,
    startedAt: prev?.startedAt || now,
    endedAt: null,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
  };
  return doc.listeningSession;
}

export function endSession(doc) {
  const now = Date.now();
  if (doc.player) doc.player.togetherListening = false;
  if (doc.listeningSession && typeof doc.listeningSession === 'object') {
    doc.listeningSession.status = 'ended';
    doc.listeningSession.endedAt = now;
    doc.listeningSession.updatedAt = now;
  }
  return doc.listeningSession || null;
}

export function isActiveSession(doc) {
  const s = doc.listeningSession;
  return Boolean(s && s.status === 'active');
}

// ---------------- 上下文聚合（get_listening_context） ----------------

function recentSongs(doc) {
  const p = doc.player || {};
  const list = p.playlist || [];
  return list
    .map((t) => ({ ...t }))
    .filter((t) => (t.playCount || 0) > 0 || t.lastPlayedAt)
    .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || (b.playCount || 0) - (a.playCount || 0))
    .slice(0, 10)
    .map((t) => ({
      id: t.id ?? null,
      title: t.title || t.name || '',
      artist: t.artist || '',
      album: t.album || '',
      playCount: t.playCount || 0,
    }));
}

// 完整陪听上下文（含公开歌词）。歌词失败 → lyricsContext.available=false，绝不抛错。
export async function getContext(doc) {
  const p = doc.player || {};
  const track = currentTrack(doc);
  const session = doc.listeningSession && typeof doc.listeningSession === 'object' ? doc.listeningSession : null;
  const assistant = session?.assistantId
    ? getAssistant(doc, session.assistantId)
    : (activeAssistantId(doc) ? getAssistant(doc, activeAssistantId(doc)) : null);

  let lyricsContext = null;
  if (track && track.id) {
    try {
      const lyr = await neteaseLyric(track.id);
      lyricsContext = { lrc: lyr.lrc || '', tlyric: lyr.tlyric || '', available: Boolean(lyr.lrc || lyr.tlyric) };
    } catch (e) {
      lyricsContext = { lrc: '', tlyric: '', available: false };
    }
  }

  return {
    currentSong: track ? {
      id: track.id ?? null,
      name: track.title || track.name || '',
      artist: track.artist || '',
      album: track.album || '',
      duration: Number(track.duration) || 0,
      position: Number(p.currentTime) || 0,
    } : null,
    lyricsContext,
    recentSongs: recentSongs(doc),
    currentPlaylist: (p.playlist || []).map((t, i) => ({
      index: i,
      id: t.id ?? null,
      title: t.title || t.name || '',
      artist: t.artist || '',
      album: t.album || '',
      duration: Number(t.duration) || 0,
      isCurrent: i === (p.current || 0),
    })),
    listeningSession: sanitizeSession(session),
    assistant: sanitizeAssistant(assistant),
    musicTasteProfile: doc.musicTasteProfile && typeof doc.musicTasteProfile === 'object' ? doc.musicTasteProfile : defaultTaste(),
  };
}

// ---------------- 是否该主动发言（反话痨） ----------------

// 输入：会话 + 触发事件 + 上下文；默认 shouldSpeak=false。
// 只有「用户明确要求 / 用户询问 / 用户要求选歌 / 歌曲结束且 autoNext 由 AI 接歌」才可能说话，
// 且受 5 分钟冷却 + 一首歌最多一次约束。
export function shouldAiSpeak(session, { event = 'idle', songId = null, now = Date.now() } = {}) {
  if (!session || session.status !== 'active') {
    return { shouldSpeak: false, reason: 'no_active_session', priority: 0 };
  }
  const last = session.lastAiCommentAt || 0;
  if (now - last < AI_COMMENT_COOLDOWN_MS) {
    return { shouldSpeak: false, reason: 'cooldown', priority: 0 };
  }
  if (session._commentedSongs && session._commentedSongs.includes(songId)) {
    return { shouldSpeak: false, reason: 'already_commented_this_song', priority: 0 };
  }
  // 只有明确触发才说；单纯切歌/播放事件绝不主动开口
  const allowed = ['user_requested', 'user_asked', 'user_wants_next', 'song_ended_autonext'];
  if (!allowed.includes(event)) {
    return { shouldSpeak: false, reason: 'no_trigger', priority: 0 };
  }
  const priority = event === 'user_requested' || event === 'user_asked' ? 3 : 1;
  return { shouldSpeak: true, reason: event, priority };
}

// 记录一次 AI 发言（更新冷却 + 一首歌一次标记）
export function markAiCommented(doc, songId, now = Date.now()) {
  const s = doc.listeningSession;
  if (!s) return;
  s.lastAiCommentAt = now;
  s._commentedSongs = s._commentedSongs || [];
  if (songId && !s._commentedSongs.includes(songId)) {
    s._commentedSongs.push(songId);
    if (s._commentedSongs.length > 20) s._commentedSongs.shift();
  }
}

// ---------------- 推荐下一首 ----------------

function buildRecommendPrompt(track, playlist, taste) {
  const lines = [];
  lines.push('当前歌曲：' + (track ? `${track.title || track.name || ''} - ${track.artist || ''}` + (track.album ? `（专辑：${track.album}）` : '') : '无'));
  lines.push('当前播放列表（id | 歌名 - 歌手）：');
  for (const t of playlist || []) {
    if (t.id) lines.push(`  ${t.id} | ${t.title || t.name || ''} - ${t.artist || ''}`);
  }
  const fav = (taste && taste.favoriteArtists) || [];
  const dis = (taste && taste.dislikedArtists) || [];
  const favSongs = (taste && taste.favoriteSongs) || [];
  lines.push('用户喜欢的歌手：' + (fav.length ? fav.map((x) => x.name || x).join('、') : '（暂无）'));
  lines.push('用户不喜欢的歌手：' + (dis.length ? dis.map((x) => x.name || x).join('、') : '（暂无）'));
  lines.push('用户喜欢的歌：' + (favSongs.length ? favSongs.slice(0, 10).join('、') : '（暂无）'));
  lines.push('请从「当前播放列表」里挑一首最贴合用户口味的下一首（优先喜欢/同歌手，避开不喜欢），或如果要推荐列表外的新歌，给一个搜索关键词。只输出 JSON：{"songId":"列表里的id","reason":"一句话"} 或 {"query":"搜索词","reason":"一句话"}。');
  return lines.join('\n');
}

async function findSongById(doc, id) {
  const sid = String(id);
  const p = doc.player || {};
  const inList = (p.playlist || []).find((t) => String(t.id) === sid);
  if (inList) return normalizeSong(inList);
  const h = (doc.listeningHistory || []).find((e) => String(e.songId) === sid);
  if (h) return { id: h.songId || null, name: h.title || '', artist: h.artist || '', album: '', cover: '', duration: 0 };
  try {
    const arr = await songDetail([sid]);
    if (arr && arr[0]) return normalizeSong(arr[0]);
  } catch (e) { /* 详情失败忽略 */ }
  return null;
}

async function resolveRecommendation(doc, parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.songId) {
    const s = await findSongById(doc, parsed.songId);
    if (s) return { song: s, reason: parsed.reason || '' };
  }
  if (parsed.query) {
    try {
      const results = await neteaseSearch(String(parsed.query), 3);
      if (results && results.length) return { song: results[0], reason: parsed.reason || '' };
    } catch (e) { /* 搜索失败忽略 */ }
  }
  return null;
}

// 确定性兜底：播放列表下一首（可循环）
export function fallbackNextSong(doc) {
  const p = doc.player || {};
  const list = p.playlist || [];
  if (!list.length) return null;
  const next = (p.current + 1) % list.length;
  return normalizeSong(list[next]);
}

// 推荐下一首：AI 优先（从列表选 id 或给搜索词），失败降级为列表下一首。
// 绝不因 AI 失败中断播放。
export async function recommendNextSong(doc, model) {
  const fb = fallbackNextSong(doc);
  try {
    if (model) {
      const track = currentTrack(doc);
      const prompt = buildRecommendPrompt(track, (doc.player || {}).playlist, doc.musicTasteProfile);
      const reply = await chat({
        model,
        temperature: 0.5,
        maxTokens: 260,
        system: '你是音乐推荐助手。根据用户当前播放与音乐偏好，从给定列表选一首最合适的下一首，或给一个搜索关键词。只输出 JSON（songId 或 query，加一句 reason）。',
        messages: [{ role: 'user', content: prompt }],
      });
      const text = String(reply.content || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) {}
      const resolved = await resolveRecommendation(doc, parsed);
      if (resolved && resolved.song) return resolved;
    }
  } catch (e) {
    // AI 推荐失败 → 继续播放列表
  }
  return { song: fb, reason: '继续播放列表' };
}

// ---------------- 音乐品味画像 ----------------

function pushUniq(arr, v) {
  if (v == null || v === '') return;
  const s = String(v).trim();
  if (!s) return;
  if (!arr.includes(s)) arr.push(s);
}

function bump(arr, name) {
  if (!name) return;
  const s = String(name).trim();
  if (!s) return;
  const hit = arr.find((x) => String(x.name || x) === s);
  if (hit) {
    if (typeof hit === 'object') hit.count = (hit.count || 0) + 1;
    else Object.assign(arr, arr.map((x) => (String(x.name || x) === s ? { name: s, count: 2 } : x)));
  } else {
    arr.push({ name: s, count: 1 });
  }
}

// 只有用户明确表达（like/dislike）才更新画像；播放一次/跳过一次绝不擅自判断。
export function updateTasteProfile(doc, reaction, song) {
  const t = doc.musicTasteProfile && typeof doc.musicTasteProfile === 'object'
    ? doc.musicTasteProfile
    : (doc.musicTasteProfile = defaultTaste());
  for (const k of Object.keys(defaultTaste())) if (!Array.isArray(t[k])) t[k] = [];
  if (reaction === 'like') {
    pushUniq(t.favoriteSongs, song?.name || song?.title || song?.id || null);
    bump(t.favoriteArtists, song?.artist);
  } else if (reaction === 'dislike') {
    pushUniq(t.dislikedSongs, song?.name || song?.title || song?.id || null);
    bump(t.dislikedArtists, song?.artist);
  }
  t.updatedAt = Date.now();
  return t;
}

// 记录一次明确喜欢/不喜欢（写回播放列表曲目 + 收听历史 + 品味画像）
export function recordReaction(doc, reaction, songId) {
  const p = doc.player || {};
  const list = p.playlist || [];
  const track = (songId ? list.find((t) => String(t.id) === String(songId)) : list[p.current]) || null;
  const now = Date.now();
  if (track) {
    track.reaction = reaction;
    track.liked = reaction === 'like';
    track.disliked = reaction === 'dislike';
  }
  const entry = {
    songId: track?.id ?? songId ?? null,
    title: track?.title || track?.name || '',
    artist: track?.artist || '',
    reaction,
    at: now,
  };
  const hist = doc.listeningHistory || (doc.listeningHistory = []);
  hist.unshift(entry);
  if (hist.length > 100) hist.length = 100;
  updateTasteProfile(doc, reaction, track || { id: songId });
  return entry;
}
