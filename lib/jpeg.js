'use strict';
/**
 * lib/jpeg.js — 零依赖基线 JPEG 编码器（YCbCr 4:2:0，标准量化表与 Huffman 表，ITU-T T.81 附录 K）
 * 仅用于不透明图片的缩略图：同尺寸下体积约为 PNG 的 1/10。
 */

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** 附录 C：由码长计数表生成 symbol → {code, len} */
function buildHuffman(bits, vals) {
  const code = new Uint16Array(256);
  const len = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]; i++) {
      code[vals[k]] = c;
      len[vals[k]] = l;
      c++;
      k++;
    }
    c <<= 1;
  }
  return { code, len };
}
const HUFF = {
  dcLuma: buildHuffman(DC_LUMA_BITS, DC_VALS),
  dcChroma: buildHuffman(DC_CHROMA_BITS, DC_VALS),
  acLuma: buildHuffman(AC_LUMA_BITS, AC_LUMA_VALS),
  acChroma: buildHuffman(AC_CHROMA_BITS, AC_CHROMA_VALS),
};

// 8 点 DCT 基：M[u*8+x] = C(u)/2 · cos((2x+1)uπ/16)
const DCT = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    DCT[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos((2 * x + 1) * u * Math.PI / 16);
  }
}

function scaledQuant(base, quality) {
  const q = Math.min(100, Math.max(1, quality));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

class BitWriter {
  constructor(capacity) {
    this.buf = Buffer.alloc(capacity);
    this.pos = 0;
    this.acc = 0;
    this.nbits = 0;
  }
  byte(b) {
    if (this.pos >= this.buf.length) {
      const grown = Buffer.alloc(this.buf.length * 2);
      this.buf.copy(grown);
      this.buf = grown;
    }
    this.buf[this.pos++] = b;
  }
  write(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.nbits === 8) {
        this.byte(this.acc);
        if (this.acc === 0xff) this.byte(0); // 字节填充
        this.acc = 0;
        this.nbits = 0;
      }
    }
  }
  flush() {
    if (this.nbits > 0) this.write((1 << (8 - this.nbits)) - 1, 8 - this.nbits);
    return this.buf.subarray(0, this.pos);
  }
}

function bitLength(v) {
  let n = 0;
  while (v) { n++; v >>= 1; }
  return n;
}

/** 对一个 8×8 块做 DCT、量化并 Huffman 编码；返回本块 DC 值供下一块差分 */
function encodeBlock(writer, block, quant, dc, ac, prevDc, tmp, coef) {
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += DCT[u * 8 + x] * block[y * 8 + x];
      tmp[y * 8 + u] = s;
    }
  }
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += DCT[v * 8 + y] * tmp[y * 8 + u];
      coef[v * 8 + u] = Math.round(s / quant[v * 8 + u]);
    }
  }

  const dcVal = coef[0];
  const diff = dcVal - prevDc;
  const dcSize = bitLength(Math.abs(diff));
  writer.write(dc.code[dcSize], dc.len[dcSize]);
  if (dcSize) writer.write(diff < 0 ? diff + (1 << dcSize) - 1 : diff, dcSize);

  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = coef[ZIGZAG[k]];
    if (v === 0) { run++; continue; }
    while (run > 15) {
      writer.write(ac.code[0xf0], ac.len[0xf0]);
      run -= 16;
    }
    const size = bitLength(Math.abs(v));
    const sym = (run << 4) | size;
    writer.write(ac.code[sym], ac.len[sym]);
    writer.write(v < 0 ? v + (1 << size) - 1 : v, size);
    run = 0;
  }
  if (run > 0) writer.write(ac.code[0], ac.len[0]);
  return dcVal;
}

function segment(marker, payload) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function huffSegment(tableClass, id, bits, vals) {
  return Buffer.from([(tableClass << 4) | id, ...bits, ...vals]);
}

/**
 * @param {{width:number,height:number,channels:3|4,data:Uint8Array}} img 仅取 RGB 通道
 * @param {number} quality 1–100
 */
function encodeJpeg(img, quality = 82) {
  const { width: w, height: h, channels: ch, data } = img;
  const n = w * h;
  // 预先做色彩空间转换并减去 128 电平
  const Y = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += ch) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  const lumaQ = scaledQuant(STD_LUMA_Q, quality);
  const chromaQ = scaledQuant(STD_CHROMA_Q, quality);
  const writer = new BitWriter(Math.max(4096, n >> 1));
  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const coef = new Int32Array(64);
  let dcY = 0, dcCb = 0, dcCr = 0;

  const sample = (plane, x, y) => plane[Math.min(h - 1, y) * w + Math.min(w - 1, x)];
  for (let my = 0; my < h; my += 16) {
    for (let mx = 0; mx < w; mx += 16) {
      for (let by = 0; by < 16; by += 8) {
        for (let bx = 0; bx < 16; bx += 8) {
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) block[y * 8 + x] = sample(Y, mx + bx + x, my + by + y);
          }
          dcY = encodeBlock(writer, block, lumaQ, HUFF.dcLuma, HUFF.acLuma, dcY, tmp, coef);
        }
      }
      for (const [plane, which] of [[Cb, 0], [Cr, 1]]) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const sx = mx + x * 2;
            const sy = my + y * 2;
            block[y * 8 + x] = (sample(plane, sx, sy) + sample(plane, sx + 1, sy)
              + sample(plane, sx, sy + 1) + sample(plane, sx + 1, sy + 1)) / 4;
          }
        }
        if (which === 0) dcCb = encodeBlock(writer, block, chromaQ, HUFF.dcChroma, HUFF.acChroma, dcCb, tmp, coef);
        else dcCr = encodeBlock(writer, block, chromaQ, HUFF.dcChroma, HUFF.acChroma, dcCr, tmp, coef);
      }
    }
  }
  const scan = writer.flush();

  const sof = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(h, 1);
  sof.writeUInt16BE(w, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])),
    segment(0xdb, Buffer.from([
      0x00, ...Array.from(ZIGZAG, (z) => lumaQ[z]),
      0x01, ...Array.from(ZIGZAG, (z) => chromaQ[z]),
    ])),
    segment(0xc0, sof),
    segment(0xc4, Buffer.concat([
      huffSegment(0, 0, DC_LUMA_BITS, DC_VALS),
      huffSegment(1, 0, AC_LUMA_BITS, AC_LUMA_VALS),
      huffSegment(0, 1, DC_CHROMA_BITS, DC_VALS),
      huffSegment(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS),
    ])),
    segment(0xda, Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])),
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

module.exports = { encodeJpeg, AC_LUMA_VALS, AC_CHROMA_VALS, ZIGZAG };
