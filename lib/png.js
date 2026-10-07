'use strict';
/**
 * lib/png.js — 零依赖 PNG 解码 / 缩放 / 编码（仅用于生成缩略图）
 *
 * 支持 8 位深、非隔行的灰度 / 灰度+α / RGB / RGBA / 调色板图（NovelAI 输出均在此范围内）；
 * 其余格式 decodePng 返回 null，调用方回退到原图。
 */

const zlib = require('node:zlib');
const { crc32 } = require('./zip');
const { encodeJpeg } = require('./jpeg');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_PIXELS = 4096 * 4096;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** @returns {{width:number,height:number,channels:3|4,data:Uint8Array}|null} 统一输出 RGB 或 RGBA */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (data.length !== len) return null;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr || !idat.length || ihdr.depth !== 8 || ihdr.interlace !== 0) return null;
  const srcCh = CHANNELS[ihdr.color];
  if (!srcCh || (ihdr.color === 3 && !palette)) return null;
  const { width, height } = ihdr;
  if (!width || !height || width * height > MAX_PIXELS) return null;

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * srcCh;
  if (raw.length < (stride + 1) * height) return null;

  // 反滤波：按行分派到专用循环（Uint8Array 写入自动按 256 取模）；首行视上一行为全 0
  const pixels = new Uint8Array(stride * height);
  const zeroRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const i = y * (stride + 1) + 1;
    const o = y * stride;
    const prev = y > 0 ? pixels.subarray(o - stride, o) : zeroRow;
    const cur = pixels.subarray(o, o + stride);
    const line = raw.subarray(i, i + stride);
    switch (filter) {
      case 0:
        cur.set(line);
        break;
      case 1:
        for (let x = 0; x < srcCh; x++) cur[x] = line[x];
        for (let x = srcCh; x < stride; x++) cur[x] = line[x] + cur[x - srcCh];
        break;
      case 2:
        for (let x = 0; x < stride; x++) cur[x] = line[x] + prev[x];
        break;
      case 3:
        for (let x = 0; x < srcCh; x++) cur[x] = line[x] + (prev[x] >> 1);
        for (let x = srcCh; x < stride; x++) cur[x] = line[x] + ((cur[x - srcCh] + prev[x]) >> 1);
        break;
      case 4:
        for (let x = 0; x < srcCh; x++) cur[x] = line[x] + prev[x];
        for (let x = srcCh; x < stride; x++) cur[x] = line[x] + paeth(cur[x - srcCh], prev[x], prev[x - srcCh]);
        break;
      default:
        return null;
    }
  }

  const hasAlpha = ihdr.color === 4 || ihdr.color === 6 || !!trns;
  const channels = hasAlpha ? 4 : 3;
  if (ihdr.color === 2 && !trns) return { width, height, channels, data: pixels };
  if (ihdr.color === 6) return { width, height, channels, data: pixels };

  // 其余类型统一展开为 RGB / RGBA
  const n = width * height;
  const data = new Uint8Array(n * channels);
  for (let i = 0; i < n; i++) {
    let r, g, b, al = 255;
    if (ihdr.color === 0) {
      r = g = b = pixels[i];
      if (trns && trns.length >= 2 && pixels[i] === trns[1]) al = 0;
    } else if (ihdr.color === 4) {
      r = g = b = pixels[i * 2];
      al = pixels[i * 2 + 1];
    } else if (ihdr.color === 2) {
      r = pixels[i * 3]; g = pixels[i * 3 + 1]; b = pixels[i * 3 + 2];
      if (trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5]) al = 0;
    } else {
      const idx = pixels[i];
      r = palette[idx * 3] ?? 0; g = palette[idx * 3 + 1] ?? 0; b = palette[idx * 3 + 2] ?? 0;
      if (trns && idx < trns.length) al = trns[idx];
    }
    const o = i * channels;
    data[o] = r; data[o + 1] = g; data[o + 2] = b;
    if (channels === 4) data[o + 3] = al;
  }
  return { width, height, channels, data };
}

/**
 * 预计算每个目标坐标覆盖的源区间与权重（面积平均，缩小时无锯齿）。
 * 返回扁平数组：start[d]..start[d+1] 为第 d 个目标的抽头，idx/weight 为源坐标与归一化权重。
 */
function axisWeights(src, dst) {
  const scale = src / dst;
  const start = new Int32Array(dst + 1);
  const idx = [];
  const weight = [];
  for (let d = 0; d < dst; d++) {
    const a = d * scale;
    const b = a + scale;
    start[d] = idx.length;
    for (let s = Math.floor(a); s < Math.min(src, Math.ceil(b)); s++) {
      const w = Math.min(b, s + 1) - Math.max(a, s);
      if (w > 0) { idx.push(s); weight.push(w / scale); }
    }
  }
  start[dst] = idx.length;
  return { start, idx: Int32Array.from(idx), weight: Float32Array.from(weight) };
}

/**
 * 按最大宽度等比缩小：先横向后纵向两趟面积平均。
 * 带 α 时在横向趟预乘、输出时反预乘，避免透明边缘发黑。
 */
function downscale(img, maxWidth) {
  if (img.width <= maxWidth) return img;
  const { width: sw, height: sh, channels: ch, data } = img;
  const tw = maxWidth;
  const th = Math.max(1, Math.round(sh * tw / sw));
  const xs = axisWeights(sw, tw);
  const ys = axisWeights(sh, th);

  // 横向：sh 行 × tw 列，预乘后的浮点通道
  const mid = new Float32Array(sh * tw * ch);
  for (let y = 0; y < sh; y++) {
    const srcRow = y * sw * ch;
    const midRow = y * tw * ch;
    for (let tx = 0; tx < tw; tx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = xs.start[tx]; k < xs.start[tx + 1]; k++) {
        const p = srcRow + xs.idx[k] * ch;
        const w = xs.weight[k];
        if (ch === 4) {
          const wa = w * data[p + 3];
          r += data[p] * wa; g += data[p + 1] * wa; b += data[p + 2] * wa; a += wa;
        } else {
          r += data[p] * w; g += data[p + 1] * w; b += data[p + 2] * w;
        }
      }
      const o = midRow + tx * ch;
      mid[o] = r; mid[o + 1] = g; mid[o + 2] = b;
      if (ch === 4) mid[o + 3] = a;
    }
  }

  // 纵向
  const out = new Uint8Array(tw * th * ch);
  const rowLen = tw * ch;
  const acc = new Float32Array(rowLen);
  for (let ty = 0; ty < th; ty++) {
    acc.fill(0);
    for (let k = ys.start[ty]; k < ys.start[ty + 1]; k++) {
      const base = ys.idx[k] * rowLen;
      const w = ys.weight[k];
      for (let i = 0; i < rowLen; i++) acc[i] += mid[base + i] * w;
    }
    const o = ty * rowLen;
    if (ch === 4) {
      for (let i = 0; i < rowLen; i += 4) {
        const a = acc[i + 3];
        out[o + i + 3] = Math.round(a);
        if (a > 0) {
          out[o + i] = Math.round(acc[i] / a);
          out[o + i + 1] = Math.round(acc[i + 1] / a);
          out[o + i + 2] = Math.round(acc[i + 2] / a);
        }
      }
    } else {
      for (let i = 0; i < rowLen; i++) out[o + i] = Math.round(acc[i]);
    }
  }
  return { width: tw, height: th, channels: ch, data: out };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return [head, data, crc];
}

/** 编码为 PNG；逐行在 5 种滤波中挑绝对值和最小者（libpng 的经典启发式） */
function encodePng(img) {
  const { width, height, channels: ch, data } = img;
  const stride = width * ch;
  const filtered = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const cand = candidates[f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const v = data[row + x];
        const a = x >= ch ? data[row + x - ch] : 0;
        const b = y > 0 ? data[prev + x] : 0;
        const c = x >= ch && y > 0 ? data[prev + x - ch] : 0;
        let o;
        switch (f) {
          case 0: o = v; break;
          case 1: o = v - a; break;
          case 2: o = v - b; break;
          case 3: o = v - ((a + b) >> 1); break;
          default: o = v - paeth(a, b, c);
        }
        o &= 0xff;
        cand[x] = o;
        score += o < 128 ? o : 256 - o;
        if (score >= bestScore) break;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    // 提前终止的候选行可能未写完，最终按选中的滤波重新算一遍
    const outRow = y * (stride + 1);
    filtered[outRow] = best;
    for (let x = 0; x < stride; x++) {
      const v = data[row + x];
      const a = x >= ch ? data[row + x - ch] : 0;
      const b = y > 0 ? data[prev + x] : 0;
      const c = x >= ch && y > 0 ? data[prev + x - ch] : 0;
      let o;
      switch (best) {
        case 0: o = v; break;
        case 1: o = v - a; break;
        case 2: o = v - b; break;
        case 3: o = v - ((a + b) >> 1); break;
        default: o = v - paeth(a, b, c);
      }
      filtered[outRow + 1 + x] = o & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([
    SIGNATURE,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
    ...chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hasTransparency(img) {
  if (img.channels !== 4) return false;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
}

/**
 * 生成缩略图：不透明图编码为 JPEG（体积约为 PNG 的 1/10），含透明像素时保留 PNG。
 * @returns {{data:Buffer, type:'image/jpeg'|'image/png'}|null} 不支持的源格式返回 null
 */
function makeThumbnail(buf, maxWidth, quality = 82) {
  const img = decodePng(buf);
  if (!img) return null;
  const small = downscale(img, maxWidth);
  return hasTransparency(small)
    ? { data: encodePng(small), type: 'image/png' }
    : { data: encodeJpeg(small, quality), type: 'image/jpeg' };
}

module.exports = { decodePng, downscale, encodePng, makeThumbnail };
