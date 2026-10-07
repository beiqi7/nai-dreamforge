'use strict';
/**
 * lib/thumbs.js — 缩略图服务：worker_threads 池中解码/缩放/编码，结果缓存到磁盘。
 *
 * 主线程：createThumbnailer() 负责去重、排队、找缓存；worker：同一文件被当作 worker 脚本加载。
 * 缩略图目录独立于原图目录，避免被原图备份脚本（rclone copy 递归）一并上传。
 */

const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const THUMB_WIDTH = 384;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const VARIANTS = [['.jpg', 'image/jpeg'], ['.png', 'image/png']];

if (!isMainThread && parentPort) {
  const { makeThumbnail } = require('./png');
  parentPort.on('message', ({ id, src, dir, base }) => {
    try {
      const out = makeThumbnail(fs.readFileSync(src), THUMB_WIDTH);
      if (!out) return parentPort.postMessage({ id, ok: false });
      const dst = path.join(dir, base + (out.type === 'image/jpeg' ? '.jpg' : '.png'));
      const tmp = `${dst}.${process.pid}-${id}.tmp`;
      fs.writeFileSync(tmp, out.data, { mode: 0o600 });
      fs.renameSync(tmp, dst); // 原子替换，读者不会看到写了一半的文件
      parentPort.postMessage({ id, ok: true, path: dst, type: out.type });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
  });
}

/** 生成图文件名形如 1700000000000-0-abcd1234.png；其余一律拒绝，防路径穿越 */
function isImageName(file) {
  return typeof file === 'string' && /^[\w-]+\.png$/.test(file);
}

function createThumbnailer({ imgDir, thumbDir, poolSize = Math.max(1, Math.min(2, os.availableParallelism() - 1)) }) {
  fs.mkdirSync(thumbDir, { recursive: true, mode: 0o700 });
  const pool = []; // { worker, jobs: Map<id, resolve> }
  const inflight = new Map(); // file -> Promise
  const failedAt = new Map(); // file -> ts，不支持的格式短期内不再重试
  let seq = 0;

  function spawn() {
    const entry = { worker: new Worker(__filename), jobs: new Map() };
    entry.worker.unref();
    entry.worker.on('message', ({ id, ...result }) => {
      const resolve = entry.jobs.get(id);
      entry.jobs.delete(id);
      resolve?.(result);
    });
    const drop = () => {
      const i = pool.indexOf(entry);
      if (i !== -1) pool.splice(i, 1);
      for (const resolve of entry.jobs.values()) resolve({ ok: false, error: 'worker exited' });
      entry.jobs.clear();
    };
    entry.worker.on('error', (error) => { console.error('[thumbs] worker error', error); drop(); });
    entry.worker.on('exit', drop);
    pool.push(entry);
    return entry;
  }

  function leastBusy() {
    if (pool.length < poolSize) return spawn();
    return pool.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
  }

  async function find(file) {
    const base = path.basename(file, '.png');
    for (const [ext, type] of VARIANTS) {
      const p = path.join(thumbDir, base + ext);
      try {
        if ((await fs.promises.stat(p)).isFile()) return { path: p, type };
      } catch {}
    }
    return null;
  }

  /** 生成（去重）：同一文件并发请求共享一次计算；失败返回 null */
  function generate(file) {
    if (!isImageName(file)) return Promise.resolve(null);
    if (inflight.has(file)) return inflight.get(file);
    const failed = failedAt.get(file);
    if (failed && Date.now() - failed < FAILURE_TTL_MS) return Promise.resolve(null);
    const job = new Promise((resolve) => {
      const entry = leastBusy();
      const id = ++seq;
      entry.jobs.set(id, resolve);
      entry.worker.postMessage({ id, src: path.join(imgDir, file), dir: thumbDir, base: path.basename(file, '.png') });
    }).then((result) => {
      inflight.delete(file);
      if (result.ok) {
        failedAt.delete(file);
        return { path: result.path, type: result.type };
      }
      failedAt.set(file, Date.now());
      if (failedAt.size > 10000) failedAt.clear();
      return null;
    });
    inflight.set(file, job);
    return job;
  }

  /** 取缩略图：有缓存直接用，否则现场生成；null 表示调用方应回退到原图 */
  async function get(file) {
    if (!isImageName(file)) return null;
    return (await find(file)) || generate(file);
  }

  async function remove(file) {
    if (!isImageName(file)) return;
    await inflight.get(file); // 等正在生成的那张写完再删，避免留下孤儿缩略图
    const base = path.basename(file, '.png');
    await Promise.all(VARIANTS.map(([ext]) => fs.promises.unlink(path.join(thumbDir, base + ext)).catch(() => {})));
  }

  async function close() {
    await Promise.all(pool.splice(0).map((entry) => entry.worker.terminate()));
  }

  return { get, generate, remove, close, find };
}

module.exports = { createThumbnailer, isImageName, THUMB_WIDTH };
