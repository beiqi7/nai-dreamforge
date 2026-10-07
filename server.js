'use strict';
/**
 * server.js — NovelAI 在线生图站（零依赖 Node 22）
 *
 * 路由：
 *   GET  /                 前端单页
 *   POST /api/auth/login   登录
 *   POST /api/auth/logout  登出
 *   POST /api/auth/logout-all 撤销本人全部会话
 *   GET  /api/health       探活（DB / 磁盘 / 密钥池计数）
 *   GET  /api/me           当前用户信息
 *   POST /api/generate     生图（普通用户锁死 Opus 免费层级）
 *   GET  /api/models       模型/采样器/尺寸预设/UC 预设等元数据
 *   GET  /api/anlas        查询密钥池 Anlas 余额与订阅
 *   GET  /api/history      我的生成历史
 *   GET  /img/:file        取生成图（含属主校验）
 *   ── 插件 API（管理员 Token）──
 *   GET  /api/v1/models    模型元数据
 *   POST /api/v1/generate  生图，返回 data URL
 *   GET  /api/v1/me        校验 Token
 *   GET  /ai/user/subscription  柏宝绘连通测试（假 Opus）
 *   POST /ai/generate-image     官方协议 ZIP 生图
 *   POST /ai/encode-vibe        未实现（404）
 *   ── 管理员 ──
 *   GET  /api/admin/users          用户列表
 *   POST /api/admin/users          建用户
 *   POST /api/admin/users/:id      改用户（role/disabled/password）
 *   DELETE /api/admin/users/:id    删用户
 *   GET  /api/admin/keys           密钥列表
 *   POST /api/admin/keys           添加 PST
 *   POST /api/admin/keys/:id       启用/停用/验证
 *   GET/POST/DELETE /api/admin/tokens  插件 API Token
 *   GET  /api/admin/generations    全站生成记录
 *   GET  /api/admin/stats          统计
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { NaiClient, MODELS, SAMPLERS, NOISE_SCHEDULES, SIZE_PRESETS, UC_PRESETS, OPUS_FREE, calcAnlas, randomSeed } = require('./lib/nai');
const { db, qUsers, qSessions, qKeys, qGens, qPrompts, qApiTokens, ensureAdmin, verifyPassword, verifyLoginPassword, isUniqueViolation } = require('./lib/db');
const { applyPolicy } = require('./lib/policy');
const { getSessionUser, getSessionToken, getRequestUser, getBearerToken, sessionCookie, clearSessionCookie, readJson } = require('./lib/auth');
const { scheduleGenerate } = require('./lib/scheduler');
const { zipStore, zipStoreChunks } = require('./lib/zip');
const { officialToSiteRequest, fakeOpusSubscription } = require('./lib/nai-compat');
const { createThumbnailer } = require('./lib/thumbs');

const PORT = Number(process.env.PORT || 7860);
const HOST = process.env.HOST || '127.0.0.1';
const IMG_DIR = process.env.NAI_IMG_DIR || path.join(__dirname, 'data', 'images');
fs.mkdirSync(IMG_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(IMG_DIR, 0o700); } catch {}
// 缩略图与原图分目录存放：原图备份脚本递归 rclone copy 原图目录，不应带上缩略图
const THUMB_DIR = process.env.NAI_THUMB_DIR || path.join(path.dirname(IMG_DIR), 'thumbs');
const thumbs = createThumbnailer({ imgDir: IMG_DIR, thumbDir: THUMB_DIR });

ensureAdmin();
qSessions.delExpired();
setInterval(() => {
  try { qSessions.delExpired(); } catch (error) { console.error('[session-cleanup]', error); }
}, 60 * 60 * 1000).unref();

/* ─── 工具 ─────────────────────────────────────────────── */

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function applyPluginCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
function writeHead(res, code, headers = {}) {
  const cors = {};
  const origin = res.getHeader('Access-Control-Allow-Origin');
  if (origin) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Headers'] = res.getHeader('Access-Control-Allow-Headers') || 'Authorization, Content-Type';
    cors['Access-Control-Allow-Methods'] = res.getHeader('Access-Control-Allow-Methods') || 'GET, POST, OPTIONS';
  }
  res.writeHead(code, { ...SECURITY_HEADERS, ...cors, ...headers });
}
/** 按 Accept-Encoding 选压缩算法（br 优先） */
function pickEncoding(req) {
  const accept = String(req?.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

// 小响应压缩不划算；大响应（历史列表、插件 base64 图）放线程池异步压缩，不阻塞事件循环。
const JSON_COMPRESS_MIN_BYTES = 2048;
const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const enc = body.length >= JSON_COMPRESS_MIN_BYTES ? pickEncoding(res.req) : null;
  if (!enc) {
    writeHead(res, code, headers);
    return res.end(body);
  }
  const done = (error, out) => {
    if (res.headersSent || res.destroyed) return;
    if (error) {
      writeHead(res, code, headers);
      return res.end(body);
    }
    writeHead(res, code, { ...headers, 'Content-Encoding': enc, 'Vary': 'Accept-Encoding', 'Content-Length': out.length });
    res.end(out);
  };
  if (enc === 'br') zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }, done);
  else zlib.gzip(body, { level: 6 }, done);
};
const ok = (res, obj) => json(res, 200, { ok: true, ...obj });
const fail = (res, code, error) => json(res, code, { ok: false, error });

function serveFile(req, res, file, type, immutable = false) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return fail(res, 404, '未找到文件');
    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    const headers = {
      'Content-Type': type,
      'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'no-cache',
      'ETag': etag,
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      writeHead(res, 304, headers);
      return res.end();
    }
    writeHead(res, 200, { ...headers, 'Content-Length': stat.size });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

/* ─── 前端静态资源：预压缩 + 内容哈希 URL ─────────────────
 * index.html 中的 /app.js、/style.css 被改写为带 ?v=<哈希> 的地址，命中当前哈希时可永久缓存；
 * 每次请求比对文件 size/mtime，改了前端文件无需重启即可生效。 */
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_TYPES = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'application/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
};
let staticBundle = null;

function buildStaticAsset(raw, type) {
  return {
    type,
    hash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
    identity: raw,
    gzip: zlib.gzipSync(raw, { level: 9 }),
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
  };
}

function loadStaticBundle() {
  const stamp = Object.keys(STATIC_TYPES).map((name) => {
    const st = fs.statSync(path.join(PUBLIC_DIR, name));
    return `${name}:${st.size}:${st.mtimeMs}`;
  }).join('|');
  if (staticBundle?.stamp === stamp) return staticBundle;
  const assets = {};
  for (const name of ['app.js', 'style.css']) {
    assets[name] = buildStaticAsset(fs.readFileSync(path.join(PUBLIC_DIR, name)), STATIC_TYPES[name]);
  }
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('href="/style.css"', `href="/style.css?v=${assets['style.css'].hash}"`)
    .replace('src="/app.js"', `src="/app.js?v=${assets['app.js'].hash}"`);
  assets['index.html'] = buildStaticAsset(Buffer.from(html), STATIC_TYPES['index.html']);
  staticBundle = { stamp, assets };
  return staticBundle;
}

function serveStatic(req, res, name, version) {
  const asset = loadStaticBundle().assets[name];
  const immutable = name !== 'index.html' && version === asset.hash;
  const etag = `W/"${asset.hash}"`;
  const headers = {
    'Content-Type': asset.type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'ETag': etag,
    'Vary': 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === etag) {
    writeHead(res, 304, headers);
    return res.end();
  }
  const enc = pickEncoding(req);
  const body = enc ? asset[enc] : asset.identity;
  writeHead(res, 200, { ...headers, ...(enc ? { 'Content-Encoding': enc } : {}), 'Content-Length': body.length });
  res.end(body);
}

async function removeGeneratedFile(file) {
  if (!file || path.basename(file) !== file) return;
  try {
    await fs.promises.unlink(path.join(IMG_DIR, file));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[image-cleanup]', file, error);
  }
  await thumbs.remove(file);
}

async function persistPng(buf, index = 0) {
  const fname = `${Date.now()}-${index}-${crypto.randomBytes(4).toString('hex')}.png`;
  await fs.promises.writeFile(path.join(IMG_DIR, fname), buf, { mode: 0o600 });
  thumbs.generate(fname); // 后台预生成缩略图，历史/画廊刷新时通常已就绪
  return fname;
}

/** 生成图属主或管理员可见；返回安全的文件名，无权时返回 null */
function authorizedImageFile(req, rawName) {
  const file = path.basename(rawName);
  const rec = qGens.byFile(file);
  const u = getRequestUser(req);
  if (!rec || !u || (u.user_id !== rec.user_id && u.role !== 'admin')) return null;
  return file;
}

async function finishGenerationFile(genId, buf, anlas, t0, index = 0) {
  try {
    const fname = await persistPng(buf, index);
    qGens.finishOk(genId, anlas, fname, Date.now() - t0);
    return fname;
  } catch (error) {
    try { qGens.finishFail(genId, '图片落盘失败', Date.now() - t0); } catch {}
    throw error;
  }
}

function parseLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

// 与画廊单次最多载入条数一致；同时避免超出 SQLite 绑定变量上限与超大 ZIP。
const MAX_BATCH_IDS = 500;
function parseIdList(ids) {
  if (!Array.isArray(ids) || !ids.length) return { error: 'ids 不能为空' };
  if (ids.length > MAX_BATCH_IDS) return { error: `单次最多操作 ${MAX_BATCH_IDS} 项` };
  return { ids: [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] };
}

// 官方客户端可能把站点 origin 当作 api/image 两个域名的根，因此也接受去掉 /ai 前缀的路径
const PLUGIN_ROOT_ALIASES = new Set(['/user/subscription', '/generate-image', '/encode-vibe']);
function isPluginPath(p) {
  return p === '/api/v1' || p.startsWith('/api/v1/') || p === '/ai' || p.startsWith('/ai/') || PLUGIN_ROOT_ALIASES.has(p);
}

async function requireAdmin(req, res) {
  const u = getSessionUser(req);
  if (!u) { fail(res, 401, '请先登录'); return null; }
  if (u.role !== 'admin') { fail(res, 403, '需要管理员权限'); return null; }
  return u;
}

function requirePluginAdmin(req, res) {
  const raw = getBearerToken(req);
  if (!raw) { fail(res, 401, '需要管理员 API Token（Authorization: Bearer nai_…）'); return null; }
  const u = qApiTokens.resolve(raw);
  if (!u) { fail(res, 401, 'API Token 无效或已撤销'); return null; }
  if (u.role !== 'admin') { fail(res, 403, '插件 API 仅管理员可用'); return null; }
  return u;
}

async function sendNaiZip(res, urls) {
  const files = [];
  for (let i = 0; i < urls.length; i++) {
    const fname = path.basename(String(urls[i]));
    if (!fname || fname.includes('/') || fname.includes('\\')) continue;
    const buf = await fs.promises.readFile(path.join(IMG_DIR, fname));
    files.push({ name: `image_${i}.png`, data: buf });
  }
  if (!files.length) return fail(res, 502, '生成失败，请稍后重试');
  const zip = zipStore(files);
  writeHead(res, 200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': 'attachment; filename=image.zip',
  });
  res.end(zip);
}

async function sendGenerateOk(res, user, payload, urls) {
  if (user.naiCompat) return sendNaiZip(res, urls);
  if (!user.pluginApi) return ok(res, payload);
  const b64 = [];
  for (const u of urls) {
    const fname = path.basename(String(u));
    if (!fname || fname.includes('/') || fname.includes('\\')) continue;
    const buf = await fs.promises.readFile(path.join(IMG_DIR, fname));
    b64.push(`data:image/png;base64,${buf.toString('base64')}`);
  }
  return ok(res, { ...payload, image: b64[0] || null, images: b64, url: urls[0], urls });
}

const SUB_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const subRefreshAt = new Map();
/** 生图后刷新该 key 的电量/Anlas；同一 key 每分钟最多一次，避免每张图都多打上游接口 */
function refreshKeySubscription(key) {
  const now = Date.now();
  if (now - (subRefreshAt.get(key.id) || 0) < SUB_REFRESH_MIN_INTERVAL_MS) return;
  subRefreshAt.set(key.id, now);
  new NaiClient(key.token).getSubscription({ withInfo: false })
    .then(sub => qKeys.setState(key.id, 'ok', sub.tier, sub.anlas, sub.v5Battery))
    .catch(() => {});
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_ACCOUNT = 5;
const LOGIN_MAX_PER_IP = 20;
const loginFailures = new Map();
const activeUserGenerations = new Map();
let activeGenerationRequests = 0;
const MAX_ACTIVE_GENERATION_REQUESTS = 8;
const PLUGIN_GEN_WINDOW_MS = 60 * 1000;
const PLUGIN_GEN_MAX = Math.max(1, Number(process.env.PLUGIN_GEN_MAX || 20));
const pluginGenHits = new Map();

// 本机前面有几层可信反向代理：只有 nginx 为 1（默认）；Cloudflare → nginx 为 2；不经代理设 0。
const TRUST_PROXY_HOPS = Math.max(0, Math.trunc(Number(process.env.TRUST_PROXY_HOPS ?? 1)) || 0);
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (isLocal && TRUST_PROXY_HOPS > 0) {
    // 每层代理在末尾追加它看到的来源地址，最左侧的条目可被客户端伪造；
    // 从右往左数第 N 个才是最外层可信代理看到的真实客户端。
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length) return chain[Math.max(0, chain.length - TRUST_PROXY_HOPS)].slice(0, 128);
  }
  return remote || 'unknown';
}
function loginFailureKey(req, username) {
  const ip = clientIp(req);
  return { ip: `ip:${ip}`, account: `account:${String(username || '').toLowerCase()}` };
}
function pluginGenerateAllowed(tokenId) {
  const now = Date.now();
  const entry = pluginGenHits.get(tokenId);
  if (!entry || now - entry.startedAt >= PLUGIN_GEN_WINDOW_MS) {
    pluginGenHits.set(tokenId, { count: 1, startedAt: now });
    return true;
  }
  if (entry.count >= PLUGIN_GEN_MAX) return false;
  entry.count++;
  return true;
}
function getFailureCount(key) {
  const entry = loginFailures.get(key);
  if (!entry || Date.now() - entry.startedAt >= LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return 0;
  }
  return entry.count;
}
function recordLoginFailure(key) {
  const entry = loginFailures.get(key);
  if (!entry || Date.now() - entry.startedAt >= LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, startedAt: Date.now() });
  } else {
    entry.count++;
  }
  if (loginFailures.size > 10000) {
    for (const [k, value] of loginFailures) {
      if (Date.now() - value.startedAt >= LOGIN_WINDOW_MS) loginFailures.delete(k);
    }
  }
}

async function handleGenerate(req, res, user, preBody) {
  if (user.role !== 'admin' && activeUserGenerations.has(user.user_id)) {
    return fail(res, 429, '已有生成任务排队或执行中，请等待完成');
  }
  if (activeGenerationRequests >= MAX_ACTIVE_GENERATION_REQUESTS) return fail(res, 503, '服务繁忙，请稍后重试');
  activeGenerationRequests++;
  activeUserGenerations.set(user.user_id, (activeUserGenerations.get(user.user_id) || 0) + 1);
  try { return await handleAdmittedGenerate(req, res, user, preBody); }
  finally {
    activeGenerationRequests--;
    const remaining = activeUserGenerations.get(user.user_id) - 1;
    if (remaining > 0) activeUserGenerations.set(user.user_id, remaining);
    else activeUserGenerations.delete(user.user_id);
  }
}
async function handleAdmittedGenerate(req, res, user, preBody) {
  const body = preBody || await readJson(req, user.role === 'admin' ? 24 * 1024 * 1024 : 64 * 1024);
  const pol = applyPolicy(user.role, body);
  if (!pol.ok) return fail(res, 400, pol.error);
  /* 服务器级频控与权限防线 */
  if (user.role !== 'admin') {
    if (pol.v.img2img || pol.v.inpaint) {
      return fail(res, 403, '免费用户无图生图 (i2i) 与局部重绘 (infill) 权限');
    }
    if (pol.anlas > 0) {
      return fail(res, 400, '免费层仅支持免费参数（需消耗 0 Anlas），当前请求需消耗 Anlas，请降低参数或联系管理员升级');
    }

    // 频控检查：1分钟6张，1小时66张，1天240张
    const counts = qGens.countRecentByUser(user.user_id);
    if (counts.count_1m >= 6) {
      return fail(res, 429, `出图频率过快：普通用户每分钟限 6 张（最近 1 分钟已生成 ${counts.count_1m} 张），请稍息片刻再试`);
    }
    if (counts.count_1h >= 66) {
      return fail(res, 429, `出图频率受限：普通用户每小时限 66 张（最近 1 小时已生成 ${counts.count_1h} 张），请稍后重试`);
    }
    if (counts.count_1d >= 240) {
      return fail(res, 429, `今日配额已达上限：普通用户每日限 240 张（最近 24 小时已生成 ${counts.count_1d} 张），请明日再来`);
    }
  }

  const t0 = Date.now();
  const makeBuildPayloadFn = (overrides = {}) => (client) => client.buildPayload({
    prompt: pol.v.prompt, model: pol.v.model,
    width: pol.v.width, height: pol.v.height,
    steps: pol.v.steps, scale: pol.v.scale,
    sampler: pol.v.sampler, noiseSchedule: pol.v.noiseSchedule,
    seed: overrides.seed !== undefined ? overrides.seed : pol.v.seed,
    nSamples: overrides.nSamples !== undefined ? overrides.nSamples : pol.v.nSamples,
    uc: pol.v.uc, ucPreset: pol.v.ucPreset,
    qualityTags: pol.v.qualityTags, cfgRescale: pol.v.cfgRescale,
    charPrompts: pol.v.charPrompts, v5Mode: pol.v.v5Mode,
    img2img: pol.v.img2img ? {
      image: pol.v.img2img.image, strength: pol.v.img2img.strength, noise: pol.v.img2img.noise,
    } : undefined,
    inpaint: pol.v.inpaint ? {
      image: pol.v.inpaint.image, mask: pol.v.inpaint.mask,
      strength: pol.v.inpaint.strength, addOriginalImage: pol.v.inpaint.addOriginalImage,
    } : undefined,
  });

  try {
    if (user.role === 'admin' && pol.v.keyFanout && pol.v.nSamples > 1) {
      return await handleKeyFanoutGenerate(res, user, pol, t0, makeBuildPayloadFn);
    }

    const result = await scheduleGenerate({
      requiredAnlas: pol.anlas,
      buildPayloadFn: makeBuildPayloadFn(),
      qKeys,
      qGens,
      user,
      pol,
      startTime: t0,
    });

    const { png, pngs, key, genId, payload } = result;
    const allPngs = (pngs && pngs.length) ? pngs : (png ? [png] : []);
    const urls = [];
    for (let i = 0; i < allPngs.length; i++) {
      if (i === 0) {
        const fname = await finishGenerationFile(genId, allPngs[i], pol.anlas, t0, i);
        urls.push(`/img/${fname}`);
      } else {
        const extraId = qGens.insert({
          user_id: user.user_id,
          key_id: key.id,
          model: pol.model,
          prompt: pol.v.prompt,
          uc: pol.v.uc,
          width: pol.v.width,
          height: pol.v.height,
          steps: pol.v.steps,
          scale: pol.v.scale,
          sampler: pol.v.sampler,
          seed: payload.parameters.seed ?? null,
          n_samples: 1,
          anlas_est: 0,
          char_prompts: pol.v.charPrompts?.length ? JSON.stringify(pol.v.charPrompts) : null,
        });
        const fname = await finishGenerationFile(extraId, allPngs[i], 0, t0, i);
        urls.push(`/img/${fname}`);
      }
    }
    qKeys.markUsed(key.id);
    // 若是 V5 模型，后台异步轻量拉取该 key 最新剩余电量与 Anlas，不阻塞生图返回
    if (payload.model?.startsWith('nai-diffusion-5')) refreshKeySubscription(key);
    return sendGenerateOk(res, user, {
      image: urls[0],
      images: urls,
      anlas: pol.anlas,
      freeTier: pol.freeTier,
      model: payload.model,
      action: payload.action,
      seed: payload.parameters.seed,
      width: pol.v.width, height: pol.v.height,
      duration_ms: Date.now() - t0,
      gen_id: genId,
      charPrompts: pol.v.charPrompts || [],
    }, urls);
  } catch (e) {
    if (e.code === 'NO_CANDIDATE' || e.code === 'QUEUE_TIMEOUT' || e.status === 503) {
      return fail(res, 503, e.message);
    }
    return fail(res, 502, '生成失败，请稍后重试');
  }

  async function handleKeyFanoutGenerate(res, user, pol, t0, makeBuildPayloadFn) {
    const count = pol.v.nSamples;
    const baseSeed = Number.isInteger(pol.v.seed) ? pol.v.seed : randomSeed();
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const seed = (baseSeed + i) % 2147483647;
      const jobPol = {
        ...pol,
        anlas: 0,
        freeTier: true,
        v: { ...pol.v, nSamples: 1, seed, keyFanout: false },
      };
      jobs.push((async () => {
        const result = await scheduleGenerate({
          requiredAnlas: 0,
          buildPayloadFn: makeBuildPayloadFn({ seed, nSamples: 1 }),
          qKeys,
          qGens,
          user,
          pol: jobPol,
          startTime: t0,
        });
        const png = result.pngs?.[0] || result.png;
        const fname = await finishGenerationFile(result.genId, png, 0, t0, i);
        qKeys.markUsed(result.key.id);
        return {
          image: `/img/${fname}`,
          seed: result.payload.parameters.seed,
          gen_id: result.genId,
          key_id: result.key.id,
          model: result.payload.model,
          action: result.payload.action,
        };
      })());
    }

    const settled = await Promise.allSettled(jobs);
    const images = [];
    const errors = [];
    for (const item of settled) {
      if (item.status === 'fulfilled') images.push(item.value);
      else errors.push(item.reason?.message || String(item.reason));
    }
    if (!images.length) {
      const msg = errors[0] || '未知错误';
      if (settled.some((s) => s.status === 'rejected' && (s.reason?.code === 'NO_CANDIDATE' || s.reason?.code === 'QUEUE_TIMEOUT' || s.reason?.status === 503))) {
        return fail(res, 503, msg);
      }
      return fail(res, 502, `多 Key 轮询全部失败：${msg}`);
    }
    const first = images[0];
    const urls = images.map((x) => x.image);
    return sendGenerateOk(res, user, {
      image: first.image,
      images: urls,
      seeds: images.map((x) => x.seed),
      gen_ids: images.map((x) => x.gen_id),
      anlas: 0,
      freeTier: true,
      fanout: true,
      requested: count,
      okCount: images.length,
      failed: errors.length,
      errors: errors.length ? errors : undefined,
      model: first.model || pol.model,
      action: first.action || 'generate',
      seed: first.seed,
      width: pol.v.width,
      height: pol.v.height,
      duration_ms: Date.now() - t0,
      gen_id: first.gen_id,
      charPrompts: pol.v.charPrompts || [],
    }, urls);
  }
}

/* ─── Anlas 汇总查询 ───────────────────────────────────── */

let anlasRefreshPromise = null;
let anlasCache = { expiresAt: 0, data: null };
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function handleAnlas(res) {
  if (anlasCache.data && Date.now() < anlasCache.expiresAt) return ok(res, anlasCache.data);
  if (!anlasRefreshPromise) {
    anlasRefreshPromise = (async () => {
      const keys = qKeys.list().filter(k => k.is_active);
      const detail = await mapWithConcurrency(keys, 4, async (k) => {
        try {
          const raw = qKeys.get(k.id);
          if (!raw) return { id: k.id, label: k.label, tier: '-', anlas: null, error: '密钥已删除', active: false };
          const sub = await new NaiClient(raw.token).getSubscription();
          qKeys.setState(k.id, 'ok', sub.tier, sub.anlas, sub.v5Battery);
          if (sub.email) qKeys.setEmail(k.id, sub.email);
          return {
            id: k.id, label: k.label, email: k.email || sub.email || null,
            tier: sub.tierName, anlas: sub.anlas, active: true,
            expiresAt: sub.expiresAt, v5Battery: sub.v5Battery,
            v5TimeUntilNext: sub.v5TimeUntilNext,
            freeGeneration: sub.freeGeneration, freeLimits: sub.freeLimits,
          };
        } catch (error) {
          // 查询接口不再停用密钥；状态变更只由显式验证或生成鉴权失败触发。
          return { id: k.id, label: k.label, tier: '-', anlas: null, error: '查询失败', active: false };
        }
      });
      const data = {
        totalAnlas: detail.reduce((sum, item) => sum + (Number(item.anlas) || 0), 0),
        activeCount: keys.length,
        keys: detail,
      };
      anlasCache = { expiresAt: Date.now() + 30000, data };
      return data;
    })().finally(() => { anlasRefreshPromise = null; });
  }
  return ok(res, await anlasRefreshPromise);
}
/* ─── 路由 ─────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const rawPath = (req.url || '/').split('?')[0];
  const p = path.posix.normalize(rawPath.startsWith('/') ? rawPath : `/${rawPath}`);
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && p === '/api/health') {
      let dbOk = false;
      try { dbOk = db.prepare('SELECT 1 AS ok').get()?.ok === 1; } catch {}
      let diskOk = false;
      try { fs.accessSync(IMG_DIR, fs.constants.W_OK); diskOk = true; } catch {}
      let keys = 0;
      try { keys = qKeys.count(); } catch {}
      const ready = dbOk && diskOk;
      return json(res, ready ? 200 : 503, { ok: ready, db: dbOk, disk: diskOk, keys });
    }

    if (isPluginPath(p)) {
      applyPluginCors(res);
      if (req.method === 'OPTIONS') {
        writeHead(res, 204);
        return res.end();
      }
      const admin = requirePluginAdmin(req, res);
      if (!admin) return;
      if (p === '/api/v1/me' && req.method === 'GET') {
        return ok(res, { id: admin.user_id, username: admin.username, role: admin.role });
      }
      if (p === '/api/v1/models' && req.method === 'GET') {
        return ok(res, { models: MODELS, samplers: SAMPLERS, noiseSchedules: NOISE_SCHEDULES, sizePresets: SIZE_PRESETS, ucPresets: UC_PRESETS, opusFree: OPUS_FREE });
      }
      if (p === '/api/v1/generate' && req.method === 'POST') {
        if (!pluginGenerateAllowed(admin.token_id || admin.user_id)) {
          return fail(res, 429, `插件生图过快，每分钟最多 ${PLUGIN_GEN_MAX} 次`);
        }
        admin.pluginApi = true;
        return await handleGenerate(req, res, admin);
      }
      if ((p === '/ai/user/subscription' || p === '/user/subscription') && req.method === 'GET') {
        return ok(res, fakeOpusSubscription());
      }
      if ((p === '/ai/generate-image' || p === '/generate-image') && req.method === 'POST') {
        if (!pluginGenerateAllowed(admin.token_id || admin.user_id)) {
          return fail(res, 429, `插件生图过快，每分钟最多 ${PLUGIN_GEN_MAX} 次`);
        }
        const official = await readJson(req, 24 * 1024 * 1024);
        const mapped = officialToSiteRequest(official);
        if (!mapped.ok) return fail(res, 400, mapped.error);
        admin.naiCompat = true;
        return await handleGenerate(req, res, admin, mapped.body);
      }
      if ((p === '/ai/encode-vibe' || p === '/encode-vibe') && req.method === 'POST') {
        return fail(res, 404, '本站不支持 vibe 编码，请在柏宝绘渠道关闭 Vibe Transfer');
      }
      return fail(res, 404, '未知插件接口');
    }


    /* 静态 */
    if (req.method === 'GET' && p === '/') return serveStatic(req, res, 'index.html');
    if (req.method === 'GET' && (p === '/style.css' || p === '/app.js')) return serveStatic(req, res, p.slice(1), url.searchParams.get('v'));

    /* 图片（属主或管理员可见） */
    if (req.method === 'GET' && p.startsWith('/img/')) {
      const file = authorizedImageFile(req, p.slice(5));
      if (!file) return fail(res, 404, '无权访问');
      return serveFile(req, res, path.join(IMG_DIR, file), 'image/png', true);
    }
    /* 缩略图：网格/画廊用，约为原图体积的 1/15；无法生成时回退原图 */
    if (req.method === 'GET' && p.startsWith('/thumb/')) {
      const file = authorizedImageFile(req, p.slice(7));
      if (!file) return fail(res, 404, '无权访问');
      const thumb = await thumbs.get(file);
      if (thumb) return serveFile(req, res, thumb.path, thumb.type, true);
      return serveFile(req, res, path.join(IMG_DIR, file), 'image/png', true);
    }

    /* 登录态 */
    if (p === '/api/auth/login' && req.method === 'POST') {
      const { username, password } = await readJson(req, 8192);
      const normalizedUsername = String(username || '').trim();
      const failureKeys = loginFailureKey(req, normalizedUsername);
      if (getFailureCount(failureKeys.account) >= LOGIN_MAX_PER_ACCOUNT || getFailureCount(failureKeys.ip) >= LOGIN_MAX_PER_IP) {
        return fail(res, 429, '登录失败次数过多，请 15 分钟后重试');
      }
      const u = qUsers.byName(normalizedUsername);
      const passwordValid = await verifyLoginPassword(String(password || ''), u?.password_hash);
      if (!u || u.disabled || !passwordValid) {
        recordLoginFailure(failureKeys.account);
        recordLoginFailure(failureKeys.ip);
        return fail(res, 401, '用户名或密码错误');
      }
      loginFailures.delete(failureKeys.account);
      loginFailures.delete(failureKeys.ip);
      const token = qSessions.create(u.id);
      writeHead(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(token) });
      return res.end(JSON.stringify({ ok: true, username: u.username, role: u.role }));
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const token = getSessionToken(req);
      if (token) qSessions.del(token);
      writeHead(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie() });
      return res.end(JSON.stringify({ ok: true }));
    }

    const user = getSessionUser(req);
    if (p === '/api/auth/logout-all' && req.method === 'POST') {
      if (!user) return fail(res, 401, '未登录');
      qSessions.delByUser(user.user_id);
      writeHead(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie() });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (p === '/api/me' && req.method === 'GET') {
      if (!user) return fail(res, 401, '未登录');
      return ok(res, { id: user.user_id, username: user.username, role: user.role });
    }

    /* 用户个人设置：修改用户名或密码 */
    if (p === '/api/user/profile' && req.method === 'POST') {
      if (!user) return fail(res, 401, '未登录');
      const { newUsername, newPassword, oldPassword } = await readJson(req, 8192);
      if ((newPassword && typeof newPassword !== 'string') || (newUsername && typeof newUsername !== 'string')) {
        return fail(res, 400, '参数格式错误');
      }
      const cur = qUsers.byId(user.user_id);
      const fullCur = qUsers.byName(cur.username);
      if (newPassword) {
        if (!oldPassword || !verifyPassword(oldPassword, fullCur.password_hash)) {
          return fail(res, 400, '原密码错误，无法修改密码');
        }
        if (newPassword.length < 8) return fail(res, 400, '新密码至少需要 8 位');
        qUsers.setPassword(user.user_id, newPassword);
        const token = getSessionToken(req);
        if (token) qSessions.delByUserExcept(user.user_id, token);
        else qSessions.delByUser(user.user_id);
      }
      if (newUsername && newUsername.trim() !== cur.username) {
        const trimmed = newUsername.trim();
        if (trimmed.length < 2 || trimmed.length > 20) return fail(res, 400, '用户名长度须在 2–20 个字符之间');
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(trimmed)) return fail(res, 400, '用户名仅支持汉字、字母、数字和下划线');
        const exist = qUsers.byName(trimmed);
        if (exist && exist.id !== user.user_id) return fail(res, 409, '该用户名已被占用');
        try {
          qUsers.setUsername(user.user_id, trimmed);
        } catch (error) {
          if (isUniqueViolation(error)) return fail(res, 409, '该用户名已被占用');
          throw error;
        }
      }
      const updated = qUsers.byId(user.user_id);
      return ok(res, { username: updated.username });
    }

    if (p === '/api/models' && req.method === 'GET') {
      return ok(res, { models: MODELS, samplers: SAMPLERS, noiseSchedules: NOISE_SCHEDULES, sizePresets: SIZE_PRESETS, ucPresets: UC_PRESETS, opusFree: OPUS_FREE });
    }

    if (p === '/api/anlas' && req.method === 'GET') {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      return handleAnlas(res);
    }

    if (p === '/api/generate' && req.method === 'POST') {
      if (!user) return fail(res, 401, '请先登录');
      return await handleGenerate(req, res, user);
    }

    if (p === '/api/history' && req.method === 'GET') {
      if (!user) return fail(res, 401, '未登录');
      const limit = parseLimit(url.searchParams.get('limit'), 60, 500);
      const before = Number(url.searchParams.get('before'));
      const okOnly = url.searchParams.get('ok') === '1';
      const rows = qGens.byUser(user.user_id, limit, {
        favoritedOnly: url.searchParams.get('favorite') === '1',
        okOnly,
        before,
      });
      const items = rows.map((r) => {
        let charPrompts = [];
        if (r.char_prompts) {
          try { charPrompts = JSON.parse(r.char_prompts); } catch {}
        }
        return { ...r, is_favorited: !!r.is_favorited, charPrompts: Array.isArray(charPrompts) ? charPrompts : [] };
      });
      const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null;
      // 画廊首屏顺带返回总数/收藏数，用于筛选标签计数
      const counts = okOnly && !(before > 0) ? qGens.countGalleryByUser(user.user_id) : undefined;
      return ok(res, { items, nextBefore, counts });
    }

    let histMatch;
    if ((histMatch = p.match(/^\/api\/history\/(\d+)\/favorite$/)) && req.method === 'POST') {
      if (!user) return fail(res, 401, '未登录');
      const gid = Number(histMatch[1]);
      const rec = qGens.byId(gid);
      if (!rec || rec.user_id !== user.user_id) return fail(res, 404, '记录不存在');
      const b = await readJson(req, 4096).catch(() => ({}));
      qGens.toggleFavorite(gid, user.user_id, b.favorited);
      const updated = qGens.byId(gid);
      return ok(res, { id: gid, is_favorited: !!updated.is_favorited });
    }

    if (p === '/api/history/batch-favorite' && req.method === 'POST') {
      if (!user) return fail(res, 401, '未登录');
      const { ids, state } = await readJson(req, 64 * 1024);
      const parsed = parseIdList(ids);
      if (parsed.error) return fail(res, 400, parsed.error);
      qGens.batchFavorite(parsed.ids, user.user_id, state !== false);
      return ok(res, { count: parsed.ids.length });
    }

    if (p === '/api/history/batch-delete' && req.method === 'POST') {
      if (!user) return fail(res, 401, '未登录');
      const parsed = parseIdList((await readJson(req, 64 * 1024)).ids);
      if (parsed.error) return fail(res, 400, parsed.error);
      const { files, changes } = qGens.batchDelByUser(parsed.ids, user.user_id);
      await Promise.all(files.map(removeGeneratedFile));
      return ok(res, { deleted: changes });
    }

    if (p === '/api/history/batch-download' && req.method === 'POST') {
      if (!user) return fail(res, 401, '未登录');
      const parsed = parseIdList((await readJson(req, 64 * 1024)).ids);
      if (parsed.error) return fail(res, 400, parsed.error);
      const items = qGens.getFilesByIds(parsed.ids, user.user_id);
      if (!items.length) return fail(res, 404, '未找到可下载图片');
      const present = [];
      for (const it of items) {
        const fname = path.basename(String(it.file));
        if (!fname || fname.includes('\\')) continue;
        try {
          if ((await fs.promises.stat(path.join(IMG_DIR, fname))).isFile()) present.push({ ...it, fname });
        } catch {}
      }
      if (!present.length) return fail(res, 404, '图片文件缺失');
      // 逐张读取并流式写出，避免把几百张原图同时攒进内存；文件名带 id 防同种子重名。
      async function* entries() {
        for (const it of present) {
          let data;
          try { data = await fs.promises.readFile(path.join(IMG_DIR, it.fname)); } catch { continue; }
          yield { name: it.seed != null ? `nai-${it.seed}-${it.id}.png` : `nai-${it.id}.png`, data };
        }
      }
      writeHead(res, 200, {
        'Content-Type': 'application/zip',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="nai-batch-${Date.now()}.zip"`,
      });
      // 客户端中途断开时 pipeline 会拒绝；响应头已发出，只需丢弃连接。
      await pipeline(Readable.from(zipStoreChunks(entries())), res).catch(() => res.destroy());
      return;
    }

    if (p.startsWith('/api/history/') && req.method === 'DELETE') {
      if (!user) return fail(res, 401, '未登录');
      const gid = Number(p.slice(13));
      if (!gid) return fail(res, 400, '无效记录 ID');
      const rec = qGens.byId(gid);
      if (!rec || rec.user_id !== user.user_id) return fail(res, 404, '记录不存在或无权删除');
      qGens.delByUser(gid, user.user_id);
      await removeGeneratedFile(rec.file);
      return ok(res, {});
    }

    /* ─── 提示词片段库 ─────────────────────────────────────── */
    if (p === '/api/prompts' && req.method === 'GET') {
      if (!user) return fail(res, 401, '未登录');
      const kind = url.searchParams.get('kind');
      const VALID_KINDS = ['painter', 'action', 'uc', 'character', 'main'];
      if (!kind || !VALID_KINDS.includes(kind)) {
        return fail(res, 400, 'kind 参数无效');
      }
      const items = qPrompts.listByUserAndKind(user.user_id, kind);
      return ok(res, { items });
    }

    if (p === '/api/prompts' && req.method === 'POST') {
      if (!user) return fail(res, 401, '未登录');
      const { kind, title, content, sort } = await readJson(req, 64 * 1024);
      const VALID_KINDS = ['painter', 'action', 'uc', 'character', 'main'];
      if (!kind || !VALID_KINDS.includes(kind)) {
        return fail(res, 400, 'kind 参数无效');
      }
      if (typeof title !== 'string' || !title.trim()) {
        return fail(res, 400, '标题必填');
      }
      if (title.length > 200) {
        return fail(res, 400, '标题长度不能超过 200 字符');
      }
      if (typeof content !== 'string') {
        return fail(res, 400, '内容必填');
      }
      if (content.length > 5000) {
        return fail(res, 400, '内容长度不能超过 5000 字符');
      }
      if (qPrompts.countByUser(user.user_id) >= 500) return fail(res, 409, '提示词片段已达 500 条上限，请先整理');
      const sortVal = typeof sort === 'number' && Number.isInteger(sort) ? sort : 0;
      const id = qPrompts.insert({
        user_id: user.user_id,
        kind,
        title: title.trim(),
        content,
        sort: sortVal,
      });
      return ok(res, { id });
    }

    let promptMatch;
    if ((promptMatch = p.match(/^\/api\/prompts\/(\d+)$/)) && req.method === 'POST') {
      if (!user) return fail(res, 401, '未登录');
      const id = Number(promptMatch[1]);
      const rec = qPrompts.byId(id);
      if (!rec) return fail(res, 404, '记录不存在');
      if (rec.user_id !== user.user_id) return fail(res, 403, '无权修改');

      const b = await readJson(req, 64 * 1024);
      const updates = {};
      if (b.title !== undefined) {
        if (typeof b.title !== 'string' || !b.title.trim()) return fail(res, 400, '标题不能为空');
        if (b.title.length > 200) return fail(res, 400, '标题长度不能超过 200 字符');
        updates.title = b.title.trim();
      }
      if (b.content !== undefined) {
        if (typeof b.content !== 'string') return fail(res, 400, '内容格式错误');
        if (b.content.length > 5000) return fail(res, 400, '内容长度不能超过 5000 字符');
        updates.content = b.content;
      }
      if (b.sort !== undefined) {
        if (typeof b.sort !== 'number' || !Number.isInteger(b.sort)) return fail(res, 400, '排序值必须为整数');
        updates.sort = b.sort;
      }

      qPrompts.update(id, user.user_id, updates);
      return ok(res, {});
    }

    if ((promptMatch = p.match(/^\/api\/prompts\/(\d+)$/)) && req.method === 'DELETE') {
      if (!user) return fail(res, 401, '未登录');
      const id = Number(promptMatch[1]);
      const rec = qPrompts.byId(id);
      if (!rec) return fail(res, 404, '记录不存在');
      if (rec.user_id !== user.user_id) return fail(res, 403, '无权删除');

      qPrompts.delByUser(id, user.user_id);
      return ok(res, {});
    }

    /* ── 管理员 ── */
    if (p.startsWith('/api/admin/')) {
      const admin = await requireAdmin(req, res);
      if (!admin) return;

      if (p === '/api/admin/users' && req.method === 'GET') return ok(res, { items: qUsers.listWithUsage() });
      if (p === '/api/admin/users' && req.method === 'POST') {
        const { username, password, role } = await readJson(req, 8192);
        const normalizedUsername = String(username || '').trim();
        if (!normalizedUsername || typeof password !== 'string' || password.length < 8) return fail(res, 400, '用户名与密码必填（密码 ≥8 位）');
        if (normalizedUsername.length < 2 || normalizedUsername.length > 20 || !/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(normalizedUsername)) {
          return fail(res, 400, '用户名须为 2–20 位汉字、字母、数字或下划线');
        }
        if (!['admin', 'user'].includes(role)) return fail(res, 400, '角色须为 admin/user');
        if (qUsers.byName(normalizedUsername)) return fail(res, 409, '用户已存在');
        try {
          const id = qUsers.create(normalizedUsername, password, role);
          return ok(res, { id });
        } catch (error) {
          if (isUniqueViolation(error)) return fail(res, 409, '用户已存在');
          throw error;
        }
      }
      let m;
      if ((m = p.match(/^\/api\/admin\/users\/(\d+)$/)) && req.method === 'POST') {
        const id = Number(m[1]);
        const target = qUsers.byId(id);
        if (!target) return fail(res, 404, '用户不存在');
        const b = await readJson(req, 8192);
        if (b.role !== undefined && !['admin', 'user'].includes(b.role)) return fail(res, 400, '角色须为 admin/user');
        if (b.disabled !== undefined && typeof b.disabled !== 'boolean') return fail(res, 400, 'disabled 必须是布尔值');
        const removesEnabledAdmin = target.role === 'admin' && !target.disabled && ((b.role && b.role !== 'admin') || b.disabled === true);
        if (id === admin.user_id && removesEnabledAdmin) return fail(res, 400, '不能对自己降权/禁用');
        if (removesEnabledAdmin && qUsers.enabledAdminCount() <= 1) return fail(res, 400, '系统至少需要一个可用管理员');
        if (b.username !== undefined) {
          const trimmed = String(b.username || '').trim();
          if (trimmed.length < 2 || trimmed.length > 20 || !/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(trimmed)) {
            return fail(res, 400, '用户名须为 2–20 位汉字、字母、数字或下划线');
          }
          const exist = qUsers.byName(trimmed);
          if (exist && exist.id !== id) return fail(res, 409, '用户名已被占用');
          try {
            qUsers.setUsername(id, trimmed);
          } catch (error) {
            if (isUniqueViolation(error)) return fail(res, 409, '用户名已被占用');
            throw error;
          }
        }
        if (b.password !== undefined) {
          if (typeof b.password !== 'string' || b.password.length < 8) return fail(res, 400, '密码至少 8 位');
          qUsers.setPassword(id, b.password);
          if (id === admin.user_id) {
            const token = getSessionToken(req);
            if (token) qSessions.delByUserExcept(id, token);
            else qSessions.delByUser(id);
          } else {
            qSessions.delByUser(id);
          }
        }
        if (b.role !== undefined) qUsers.setRole(id, b.role);
        if (b.disabled !== undefined) {
          qUsers.setDisabled(id, b.disabled);
          if (b.disabled) qSessions.delByUser(id);
        }
        if (b.resetQuota === true) {
          qGens.resetQuotaByUser(id);
        }
        return ok(res, {});
      }
      if ((m = p.match(/^\/api\/admin\/users\/(\d+)$/)) && req.method === 'DELETE') {
        const id = Number(m[1]);
        const target = qUsers.byId(id);
        if (!target) return fail(res, 404, '用户不存在');
        if (id === admin.user_id) return fail(res, 400, '不能删除自己');
        if (target.role === 'admin' && !target.disabled && qUsers.enabledAdminCount() <= 1) return fail(res, 400, '系统至少需要一个可用管理员');
        const files = qGens.filesByUser(id).map(row => row.file);
        db.exec('BEGIN IMMEDIATE');
        try {
          qSessions.delByUser(id);
          qApiTokens.delByUser(id);
          qPrompts.clearByUser(id);
          qGens.clearByUser(id);
          qUsers.del(id);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        await Promise.all(files.map(removeGeneratedFile));
        return ok(res, {});
      }

      if (p === '/api/admin/keys' && req.method === 'GET') return ok(res, { items: qKeys.list() });
      if (p === '/api/admin/keys' && req.method === 'POST') {
        const { label, token, email } = await readJson(req, 64 * 1024);
        if (!token || !/^pst-[A-Za-z0-9_-]{20,}$/.test(token)) return fail(res, 400, 'PST 格式不正确（应以 pst- 开头）');
        if (qKeys.byToken(token)) return fail(res, 409, '该密钥已在池中');
        const verify = await new NaiClient(token).verifyToken();
        const id = qKeys.add(label || '未命名', token);
        const effectiveEmail = email || verify.subscription?.email || (label && label.includes('@') ? label : null);
        if (effectiveEmail) qKeys.setEmail(id, effectiveEmail);
        if (verify.ok) {
          qKeys.setState(id, 'ok', verify.subscription.tier, verify.subscription.anlas, verify.subscription.v5Battery);
        } else {
          qKeys.setState(id, `invalid:${verify.error}`, null, null);
          qKeys.setActive(id, false);
        }
        return ok(res, { id, verify });
      }

      if ((m = p.match(/^\/api\/admin\/keys\/(\d+)$/)) && req.method === 'POST') {
        const id = Number(m[1]);
        const k = qKeys.get(id);
        if (!k) return fail(res, 404, '密钥不存在');
        const b = await readJson(req, 8192);
        if (b.action === 'toggle') {
          const is_active = !k.is_active;
          qKeys.setActive(id, is_active);
          return ok(res, { is_active });
        }
        if (b.action === 'verify') {
          const verify = await new NaiClient(k.token).verifyToken();
          if (verify.ok) {
            qKeys.setState(id, 'ok', verify.subscription.tier, verify.subscription.anlas, verify.subscription.v5Battery);
            if (verify.subscription.email) qKeys.setEmail(id, verify.subscription.email);
            qKeys.setActive(id, true);
          } else {
            qKeys.setState(id, `invalid:${verify.error}`, null, null);
            qKeys.setActive(id, false);
          }
          return ok(res, { verify });
        }
        if (b.action === 'edit') {
          if (b.label !== undefined) qKeys.setLabel(id, String(b.label || '').trim());
          if (b.email !== undefined) qKeys.setEmail(id, String(b.email || '').trim());
          return ok(res, {});
        }
        return ok(res, {});
      }

      if ((m = p.match(/^\/api\/admin\/keys\/(\d+)$/)) && req.method === 'DELETE') {
        const kid = Number(m[1]);
        if (!qKeys.get(kid)) return fail(res, 404, '密钥不存在');
        qGens.detachKey(kid);
        qKeys.del(kid);
        return ok(res, {});
      }

      if (p === '/api/admin/tokens' && req.method === 'GET') {
        return ok(res, { items: qApiTokens.listByUser(admin.user_id) });
      }
      if (p === '/api/admin/tokens' && req.method === 'POST') {
        const { label } = await readJson(req, 8192);
        const created = qApiTokens.create(admin.user_id, label);
        return ok(res, {
          id: created.id,
          token: created.token,
          prefix: created.prefix,
          label: String(label || 'plugin').slice(0, 40),
        });
      }
      if ((m = p.match(/^\/api\/admin\/tokens\/(\d+)$/)) && req.method === 'DELETE') {
        const tid = Number(m[1]);
        const result = qApiTokens.revoke(tid, admin.user_id);
        if (!result.changes) return fail(res, 404, 'Token 不存在');
        return ok(res, {});
      }

      if (p === '/api/admin/generations' && req.method === 'GET') {
        const rows = qGens.all(parseLimit(url.searchParams.get('limit'), 200, 500));
        const items = rows.map((r) => {
          let charPrompts = [];
          if (r.char_prompts) {
            try { charPrompts = JSON.parse(r.char_prompts); } catch {}
          }
          return { ...r, charPrompts: Array.isArray(charPrompts) ? charPrompts : [] };
        });
        return ok(res, { items });
      }
      if (p === '/api/admin/stats' && req.method === 'GET') {
        const s = qGens.stats();
        return ok(res, { stats: { ...s, activeKeys: qKeys.count(), users: qUsers.count() } });
      }
      if (p === '/api/admin/keys/test-all' && req.method === 'POST') {
        // 并发 4 路验证：串行时每个 key 最多数十秒，池子一大就会超时
        const settled = await mapWithConcurrency(qKeys.list(), 4, async (k) => {
          const raw = qKeys.get(k.id);
          if (!raw) return null;
          const verify = await new NaiClient(raw.token).verifyToken();
          if (verify.ok) {
            qKeys.setState(k.id, 'ok', verify.subscription.tier, verify.subscription.anlas, verify.subscription.v5Battery);
            if (verify.subscription.email) qKeys.setEmail(k.id, verify.subscription.email);
            qKeys.setActive(k.id, true);
          } else {
            qKeys.setState(k.id, `invalid:${verify.error}`, null, null);
            qKeys.setActive(k.id, false);
          }
          return { id: k.id, label: k.label, email: k.email || verify.subscription?.email, ok: verify.ok, anlas: verify.subscription?.anlas, v5Battery: verify.subscription?.v5Battery, tier: verify.subscription?.tierName, error: verify.error };
        });
        return ok(res, { results: settled.filter(Boolean) });
      }
      if (p.startsWith('/api/admin/generations/') && req.method === 'DELETE') {
        const gid = Number(p.slice(23));
        if (!Number.isInteger(gid) || gid <= 0) return fail(res, 400, '无效记录 ID');
        const rec = qGens.byId(gid);
        if (!rec) return fail(res, 404, '记录不存在');
        qGens.delByAdmin(gid);
        await removeGeneratedFile(rec.file);
        return ok(res, {});
      }
      return fail(res, 404, '未知管理接口');
    }
    return fail(res, 404, '未找到');
  } catch (e) {
    if (e.status && e.status >= 400 && e.status < 500) return fail(res, e.status, e.message);
    const errorId = crypto.randomBytes(6).toString('hex');
    console.error(`[request-error:${errorId}]`, e);
    return fail(res, 500, `服务器内部错误（错误编号：${errorId}）`);
  }
});

server.requestTimeout = 130000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;

function shutdown(signal) {
  console.log(`[nai-site] 收到 ${signal}，停止接收新请求`);
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (error) { console.error('[shutdown-checkpoint]', error); }
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

loadStaticBundle(); // 启动时预压缩，首个访客无需等待

server.listen(PORT, HOST, () => {
  console.log(`[nai-site] http://${HOST}:${PORT}  (SQLite: ${process.env.NAI_DB || path.join(__dirname, 'data', 'nai.sqlite')})`);
});
