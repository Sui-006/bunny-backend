import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  songKey, dedupeSongs, replaceQueue, appendToQueue, indexOfSong,
} from '../lib/music-queue.js';
import { authErrorOf, authState } from '../lib/netease.js';

// 网易云歌曲 id 判重（TEST 4/5：绝不按歌名，同名不同 id 视作两首歌）
const song = (id, name) => ({ id, name, title: name, artist: 'X' });

const PLAYLIST_A = [song('A1', '晴天'), song('A2', '七里香'), song('A3', '稻香')];
const PLAYLIST_B = [song('B1', '海阔天空'), song('B2', '光辉岁月'), song('B3', '真的爱你')];

// TEST 1：播放歌单 A → 队列 = A
test('播放歌单 A：队列 = A，current=0，立即播放', () => {
  const st = replaceQueue(PLAYLIST_A);
  assert.deepEqual(st.playlist.map(songKey), ['A1', 'A2', 'A3']);
  assert.equal(st.current, 0);
  assert.equal(st.playing, true);
  assert.equal(st.currentTime, 0);
});

// TEST 2：播放 A 再播放 B → 队列 = B，绝不 A+B
test('切换歌单：playPlaylist(A) 后 playPlaylist(B) → 队列 = B（替换，不追加）', () => {
  replaceQueue(PLAYLIST_A); // 第一次
  const st = replaceQueue(PLAYLIST_B); // 第二次切换
  assert.deepEqual(st.playlist.map(songKey), ['B1', 'B2', 'B3']); // 不是 A1..B3
  assert.equal(st.playlist.length, 3);
  assert.equal(st.current, 0);
});

// TEST 3：加入队列 = append
test('加入队列：queue=A，addToQueue(B) → A + B（追加，不改当前播放）', () => {
  let q = replaceQueue(PLAYLIST_A).playlist;
  q = appendToQueue(q, PLAYLIST_B[0]);
  assert.deepEqual(q.map(songKey), ['A1', 'A2', 'A3', 'B1']);
});

// TEST 4：加入队列去重 —— 同一 songId 不重复
test('加入队列去重：addToQueue(A1) 不产生重复 songId', () => {
  let q = replaceQueue(PLAYLIST_A).playlist;
  q = appendToQueue(q, song('A1', '晴天')); // 已存在
  assert.deepEqual(q.map(songKey), ['A1', 'A2', 'A3']);
  assert.equal(q.length, 3);
});

// TEST 5：playPlaylist(B) → currentIndex=0、currentSong=B[0]
test('播放歌单 B：currentIndex=0，currentSong=B[0]', () => {
  const st = replaceQueue(PLAYLIST_B);
  assert.equal(st.current, 0);
  assert.equal(st.playlist[st.current].id, 'B1');
});

// 歌单内部去重：同一歌单里出现两次同 id，只保留第一次
test('播放歌单内部按 songId 去重（A1,A1,B1 → A1,B1）', () => {
  const st = replaceQueue([song('A1', 'a'), song('A1', 'a'), song('B1', 'b')]);
  assert.deepEqual(st.playlist.map(songKey), ['A1', 'B1']);
});

// TEST 6：切歌多次不累积 —— replaceQueue 每次返回全新数组，纯函数、无副作用
test('切歌多次不累积：replaceQueue 每次全新，多次切换队列长度不增长', () => {
  const first = replaceQueue(PLAYLIST_A).playlist;
  const again = replaceQueue(PLAYLIST_B).playlist;
  assert.equal(first.length, 3);
  assert.equal(again.length, 3);
  assert.notEqual(first, again); // 不同引用，无共享状态
  // 追加同一首 3 次也始终只有一次
  let q = replaceQueue(PLAYLIST_A).playlist;
  q = appendToQueue(q, song('A1', '晴天'));
  q = appendToQueue(q, song('A1', '晴天'));
  q = appendToQueue(q, song('A1', '晴天'));
  assert.deepEqual(q.map(songKey), ['A1', 'A2', 'A3']);
});

// playSong 语义：已在队列 → 返回索引；不在 → -1（调用方决定追加）
test('playSong 定位：已在队列返回索引，不在返回 -1', () => {
  const q = replaceQueue(PLAYLIST_A).playlist;
  assert.equal(indexOfSong(q, song('A2', '七里香')), 1);
  assert.equal(indexOfSong(q, song('Z9', '未知')), -1);
});

// songKey 统一取 id（不因歌名相同而误判）
test('songKey 统一用网易云 songId 判重，不按歌名', () => {
  assert.equal(songKey(song('A1', '晴天')), 'A1');
  assert.equal(songKey({ songId: 'A2', name: 'x' }), 'A2'); // 兼容 songId 字段
  assert.equal(songKey({ id: null, name: '本地' }), null); // 本地曲目无 id
});

// TEST 7：登录失效 → NETEASE_AUTH_EXPIRED（错误码映射统一，绝不返回空歌单/假数据）
test('登录态错误码映射：expired → NETEASE_AUTH_EXPIRED，not_logged_in → NETEASE_NOT_LOGGED_IN', () => {
  assert.equal(authErrorOf({ status: 'expired' }).code, 'NETEASE_AUTH_EXPIRED');
  assert.equal(authErrorOf({ status: 'not_logged_in' }).code, 'NETEASE_NOT_LOGGED_IN');
  assert.equal(authErrorOf({ status: 'error' }).code, 'NETEASE_NETWORK_ERROR');
  assert.equal(authErrorOf({ status: 'logged_in' }), null);
});

// TEST 7 补充：未登录（无 cookie）绝不伪装成已登录/正在播放
test('authState 无 cookie → not_logged_in（绝不返回假的已登录态）', async () => {
  const st = await authState();
  assert.equal(st.status, 'not_logged_in');
  assert.ok(!('userId' in st));
});
