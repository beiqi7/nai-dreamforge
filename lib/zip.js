'use strict';

const zlib = require('node:zlib');

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  CRC_TABLE[n] = c;
}

function crc32Table(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (~crc) >>> 0;
}

/** Node ≥22.2 自带原生 zlib.crc32；更早的 22.x 退回查表实现。 */
const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : crc32Table;

function localHeader(name, size, crc) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  return local;
}

function centralHeader(name, size, crc, offset) {
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  return central;
}

function endOfCentralDir(count, cdSize, cdOffset) {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return eocd;
}

/**
 * 逐个产出 STORED ZIP 的分片；entries 可为异步可迭代对象，每项 { name, data }。
 * 一次只持有一个文件，适合批量下载这类可能很大的打包。
 */
async function* zipStoreChunks(entries) {
  const centrals = [];
  let offset = 0;
  let count = 0;
  for await (const file of entries) {
    const name = Buffer.from(String(file.name || 'image.png'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || []);
    const crc = crc32(data);
    yield localHeader(name, data.length, crc);
    yield name;
    yield data;
    centrals.push(centralHeader(name, data.length, crc, offset), name);
    offset += 30 + name.length + data.length;
    count++;
  }
  const centralDir = Buffer.concat(centrals);
  yield centralDir;
  yield endOfCentralDir(count, centralDir.length, offset);
}

/** 无压缩 ZIP（STORED），给柏宝绘 / 官方客户端解包 PNG。 */
function zipStore(files) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(String(file.name || 'image.png'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || []);
    const crc = crc32(data);
    parts.push(localHeader(name, data.length, crc), name, data);
    centrals.push(centralHeader(name, data.length, crc, offset), name);
    offset += 30 + name.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  return Buffer.concat([...parts, centralDir, endOfCentralDir(files.length, centralDir.length, offset)]);
}

module.exports = { crc32, crc32Table, zipStore, zipStoreChunks };
