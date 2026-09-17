// 播放队列语义（前端播放器与后端 AI 音乐工具共用同一套规则，避免状态不同步）。
// 核心区分（本次修复的关键）：
//   playPlaylist（播放 / 切换歌单）= REPLACE 队列：新队列替换旧队列，current 归 0，立即播放。
//   addToQueue（加入队列）        = APPEND 队列：追加到末尾，按 songId 去重，不改变当前播放。
//   playSong（播放歌曲）          = 已在队列则切到该曲；否则追加并播放；绝不无意义重复添加。
// 判重统一用网易云 songId（id / songId 字段），绝不用歌名（同名歌可能不同 id）。

// 统一取出歌曲的网易云 id；本地曲目（无 id）返回 null，不做 id 级去重。
export function songKey(track) {
  const id = track?.id ?? track?.songId;
  return id == null || id === '' ? null : String(id);
}

// 新歌单 → 新队列：按 songId 去重（保留首次出现顺序；无 id 的曲目原样保留）。
export function dedupeSongs(songs) {
  const seen = new Set();
  const out = [];
  for (const s of songs || []) {
    const k = songKey(s);
    if (k != null) {
      if (seen.has(k)) continue; // 同一 songId 已存在，跳过重复
      seen.add(k);
    }
    out.push(s);
  }
  return out;
}

// 播放 / 切换歌单：完全替换队列。返回新的播放器状态片段。
export function replaceQueue(songs, { startIndex = 0 } = {}) {
  const playlist = dedupeSongs(songs);
  return {
    playlist,
    current: Math.max(0, Math.min(startIndex, playlist.length - 1)),
    currentTime: 0,
    playing: true,
  };
}

// 加入队列：追加 + 去重；已存在则原样返回（不重复、不改当前播放）。
export function appendToQueue(queue, song) {
  const list = Array.isArray(queue) ? queue : [];
  const k = songKey(song);
  if (k != null && list.some((t) => songKey(t) === k)) return list;
  return [...list, song];
}

// 播放歌曲：返回该歌曲在队列中的索引；已在队列则返回现索引，否则返回 -1（调用方决定追加）。
export function indexOfSong(queue, song) {
  const list = Array.isArray(queue) ? queue : [];
  const k = songKey(song);
  if (k == null) return -1;
  return list.findIndex((t) => songKey(t) === k);
}
