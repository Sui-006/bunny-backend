import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCommand, extractChannelId } from '../lib/toy.js';

const hex = (buf) => Buffer.from(buf).toString('hex');

// 编码逐字节对照网页端真实输出（逆向时抓包核对过）。
test('encodeCommand：单马达 motor(0, 80, 2000ms) 与网页端一致', () => {
  const b = encodeCommand('motor', { motorIndex: 0, strength: 80, durationMs: 2000 });
  assert.equal(hex(b), '5813e201070800105018d00f');
});

test('encodeCommand：爆发 burst(on, 1000ms) 与网页端一致', () => {
  const b = encodeCommand('burst', { active: true, durationMs: 1000 });
  assert.equal(hex(b), '580dba0105080110e807');
});

test('encodeCommand：多马达 array([100,50], 1000ms) 与网页端一致', () => {
  const b = encodeCommand('array', { strengths: [100, 50], durationMs: 1000 });
  assert.equal(hex(b), '5815ea01150a070800106418e8070a070801103218e80710e807');
});

test('encodeCommand：深喉 deep_throat(on, 1000ms)', () => {
  const b = encodeCommand('deep_throat', { active: true, durationMs: 1000 });
  assert.equal(hex(b), '580cb20105080110e807');
});

test('encodeCommand：停止 stop = 爆发 off(0ms)', () => {
  const b = encodeCommand('stop', {});
  assert.equal(hex(b), '580dba010408001000');
});

test('encodeCommand：沉浸 immersion(60, on) fixed32 百分比', () => {
  const b = encodeCommand('immersion', { percentage: 60, active: true });
  assert.equal(hex(b), '5810ca01070d000070421001');
});

test('encodeCommand：strength 越界被夹到 0-100', () => {
  const b = encodeCommand('motor', { motorIndex: 1, strength: 999, durationMs: 0 });
  // strength 999 → 100（0x64）
  assert.equal(hex(b), '5813e20106080110641800');
});

test('encodeCommand：缺省 durationMs/strength 时给安全默认值（不再 0 时长导致不动）', () => {
  // 只给 strength 漏传 durationMs → 时长默认 2000ms、强度 100
  assert.equal(hex(encodeCommand('motor', { strength: 100 })), '5813e201070800106418d00f');
  // 全缺省 → strength 100、durationMs 2000
  assert.equal(hex(encodeCommand('motor', {})), '5813e201070800106418d00f');
  // 显式 durationMs=0 仍尊重（0 不被默认覆盖）
  assert.equal(hex(encodeCommand('motor', { strength: 80, durationMs: 0 })), '5813e20106080010501800');
});

test('encodeCommand：burst 缺省 active 默认开、时长默认 2000ms', () => {
  assert.equal(hex(encodeCommand('burst', {})), '580dba0105080110d00f');
  assert.equal(hex(encodeCommand('burst', { active: false })), '580dba0105080010d00f');
});

test('extractChannelId：从分享链接抽取 channelId', () => {
  const url = 'http://vibrator.game.sihande.vip/?viewid=3&channelId=ws0hlva1rm8dli1xypi879f7.1006522611&language=en-CN&motorCountList=8,9';
  assert.equal(extractChannelId(url), 'ws0hlva1rm8dli1xypi879f7.1006522611');
});

test('extractChannelId：非链接文本返回 null', () => {
  assert.equal(extractChannelId('今天天气不错'), null);
});
