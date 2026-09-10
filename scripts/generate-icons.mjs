// Bunny's Home PWA 图标生成器（零第三方依赖：Node 内置 zlib + 手写 PNG 编码）。
// 设计：品牌渐变圆角方块（#a9c4dc → #3e6b8e）+ 白色爱心（对应助手头像默认 "♥"）。
// 输出：icon-180.png（apple-touch-icon）、icon-192.png、icon-512.png、icon-maskable-512.png。
// 运行：node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../frontend/icons');
mkdirSync(OUT, { recursive: true });

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 几何 ----------
const ACCENT_TOP = [169, 196, 220]; // #a9c4dc
const ACCENT_BOT = [62, 107, 142];  // #3e6b8e

function insideRoundedRect(x, y, r) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const sign = (p, q, x1, y1, x2, y2) => (p - x2) * (y1 - y2) - (x1 - x2) * (q - y2);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
// 爱心（两圆 + 三角），局部坐标 hx/hy ∈ [-1,1]，上为两瓣、下为尖角
function inHeart(hx, hy) {
  const ly = hy + 0.5;
  const lx = hx + 0.5;
  if (lx * lx + ly * ly <= 0.25) return true;
  const rx = hx - 0.5;
  if (rx * rx + ly * ly <= 0.25) return true;
  return pointInTriangle(hx, hy, -1, -0.5, 1, -0.5, 0, 1);
}

function renderIcon(size, heartFrac, roundR) {
  const S = 4; // 超采样抗锯齿
  const rgba = Buffer.alloc(size * size * 4);
  const cy = 0.47; // 光学中心略上移
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          if (!insideRoundedRect(x, y, roundR)) continue;
          let cr = ACCENT_TOP[0] + (ACCENT_BOT[0] - ACCENT_TOP[0]) * y;
          let cg = ACCENT_TOP[1] + (ACCENT_BOT[1] - ACCENT_TOP[1]) * y;
          let cb = ACCENT_TOP[2] + (ACCENT_BOT[2] - ACCENT_TOP[2]) * y;
          const hx = (x - 0.5) / (heartFrac / 2);
          const hy = (y - cy) / (heartFrac / 2);
          if (hx >= -1 && hx <= 1 && hy >= -1 && hy <= 1 && inHeart(hx, hy)) { cr = 255; cg = 255; cb = 255; }
          r += cr; g += cg; b += cb; a += 1; // a 统计覆盖样本数（用于平均颜色与 alpha）
        }
      }
      const idx = (py * size + px) * 4;
      if (a > 0) {
        rgba[idx] = Math.round(r / a);
        rgba[idx + 1] = Math.round(g / a);
        rgba[idx + 2] = Math.round(b / a);
        rgba[idx + 3] = Math.round((a / (S * S)) * 255);
      }
    }
  }
  return encodePNG(size, rgba);
}

const targets = [
  ['icon-180.png', 180, 0.52, 0.20],
  ['icon-192.png', 192, 0.52, 0.20],
  ['icon-512.png', 512, 0.52, 0.20],
  ['icon-maskable-512.png', 512, 0.40, 0.0], // maskable：满铺背景 + 安全区内图标
];
for (const [name, size, heartFrac, roundR] of targets) {
  const buf = renderIcon(size, heartFrac, roundR);
  writeFileSync(join(OUT, name), buf);
  console.log('✓', name, size + 'x' + size, buf.length + ' bytes');
}
console.log('输出目录：' + OUT);
