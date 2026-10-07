'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPolicy } = require('../lib/policy');
const { DEFAULT_TIERS, parseTierInput } = require('../lib/tiers');
const { MODELS, extractZipEntries } = require('../lib/nai');
const scheduler = require('../lib/scheduler');
const { crc32, crc32Table, zipStore, zipStoreChunks } = require('../lib/zip');
const { officialToSiteRequest, fakeOpusSubscription } = require('../lib/nai-compat');
const zlib = require('node:zlib');
const { decodePng, downscale, encodePng, makeThumbnail } = require('../lib/png');
const { encodeJpeg, AC_LUMA_VALS, AC_CHROMA_VALS, ZIGZAG } = require('../lib/jpeg');

const ROOT = path.join(__dirname, '..');
const PORT = 18761;
const UPSTREAM_PORT = 18762;
const TEST_IMG_DIR = path.join(os.tmpdir(), `nai-smoke-${process.pid}`);
const TEST_THUMB_DIR = path.join(os.tmpdir(), `nai-smoke-thumbs-${process.pid}`);

function gradientImage(width, height, channels) {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      data[o] = (x * 255 / width) | 0;
      data[o + 1] = (y * 255 / height) | 0;
      data[o + 2] = ((x + y) * 7) & 0xff;
      if (channels === 4) data[o + 3] = x < width / 2 ? 255 : 128;
    }
  }
  return { width, height, channels, data };
}
// 假上游返回真实可解码的 PNG，缩略图链路才能端到端跑通
const FAKE_PNG = encodePng(gradientImage(512, 768, 3));

/* ─── 工具 ─────────────────────────────────────────────── */

async function waitForServer(child) {
  let lastError;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/models`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('server did not start');
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, options);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch {}
  return { response, body };
}

async function login(username, password) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { ...result, cookie: result.response.headers.get('set-cookie')?.split(';')[0] };
}

function jsonHeaders(cookie) {
  return { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
}


function testZipAndCompat() {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const zip = zipStore([{ name: 'image_0.png', data: png }]);
  const out = extractZipEntries(zip);
  assert.equal(out.length, 1);
  assert.equal(out[0][0], 0x89);
  const mapped = officialToSiteRequest({
    input: '1girl, solo',
    model: T2I_MODEL,
    action: 'generate',
    parameters: {
      width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler',
      noise_schedule: 'karras', n_samples: 1, negative_prompt: 'lowres',
      characterPrompts: [{ prompt: 'long hair', center: { x: 0.3, y: 0.4 } }],
    },
  });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.body.prompt, '1girl, solo');
  assert.equal(mapped.body.uc, 'lowres');
  assert.equal(mapped.body.qualityTags, false);
  assert.equal(mapped.body.ucPreset, 'none');
  assert.equal(mapped.body.charPrompts[0].prompt, 'long hair');
  assert.equal(fakeOpusSubscription().tier, 3);
}

/** 手工构造 PNG（任意颜色类型、可选 PLTE/tRNS），滤波统一为 Sub 以覆盖反滤波路径 */
function rawPng({ width, height, color, rows, plte, trns }) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = color;
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const filtered = Buffer.concat(rows.map((row) => {
    const out = Buffer.alloc(row.length + 1);
    out[0] = 1;
    for (let x = 0; x < row.length; x++) out[x + 1] = (row[x] - (x >= bpp ? row[x - bpp] : 0)) & 0xff;
    return out;
  }));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []),
    ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
    chunk('IDAT', zlib.deflateSync(filtered)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function testImageCodecs() {
  // PNG 编解码往返无损（含逐行自适应滤波）
  for (const ch of [3, 4]) {
    const img = gradientImage(37, 23, ch);
    const back = decodePng(encodePng(img));
    assert.equal(back.width, 37);
    assert.equal(back.channels, ch);
    assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
  }
  // 调色板 + tRNS → RGBA
  const pal = decodePng(rawPng({
    width: 3, height: 1, color: 3, rows: [[0, 1, 2]],
    plte: [255, 0, 0, 0, 255, 0, 0, 0, 255], trns: [0, 128],
  }));
  assert.deepEqual([...pal.data], [255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]);
  // 灰度 → RGB
  const gray = decodePng(rawPng({ width: 2, height: 2, color: 0, rows: [[10, 20], [30, 40]] }));
  assert.equal(gray.channels, 3);
  assert.deepEqual([...gray.data], [10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40]);
  assert.equal(decodePng(Buffer.from('not a png')), null);

  // 面积平均缩放：尺寸按比例，纯色保持纯色，α 预乘不让透明像素把颜色拉黑
  const small = downscale(gradientImage(400, 600, 3), 100);
  assert.equal(small.width, 100);
  assert.equal(small.height, 150);
  const half = { width: 2, height: 1, channels: 4, data: Uint8Array.from([200, 100, 50, 255, 0, 0, 0, 0]) };
  assert.deepEqual([...downscale(half, 1).data], [200, 100, 50, 128]);

  // JPEG：Huffman 表恰好覆盖 162 个符号，zigzag 为 0..63 的排列，输出结构与尺寸正确
  const symbols = new Set([0x00, 0xf0]);
  for (let r = 0; r < 16; r++) for (let sz = 1; sz <= 10; sz++) symbols.add((r << 4) | sz);
  for (const vals of [AC_LUMA_VALS, AC_CHROMA_VALS]) {
    assert.equal(vals.length, 162);
    assert.deepEqual(new Set(vals), symbols);
  }
  assert.equal(new Set(ZIGZAG).size, 64);
  const jpg = encodeJpeg(gradientImage(50, 30, 3), 80);
  assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...jpg.subarray(-2)], [0xff, 0xd9]);
  const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(jpg.readUInt16BE(sof + 5), 30);
  assert.equal(jpg.readUInt16BE(sof + 7), 50);

  // 缩略图：不透明 → JPEG，含透明 → PNG
  assert.equal(makeThumbnail(FAKE_PNG, 384).type, 'image/jpeg');
  const alphaThumb = makeThumbnail(encodePng(gradientImage(800, 400, 4)), 384);
  assert.equal(alphaThumb.type, 'image/png');
  assert.equal(decodePng(alphaThumb.data).width, 384);
}

async function testZipStreaming() {
  const blob = crypto.randomBytes(100003);
  assert.equal(crc32Table(blob), crc32(blob));
  const files = [
    { name: 'a.png', data: FAKE_PNG },
    { name: '中文.png', data: Buffer.concat([FAKE_PNG, Buffer.from('tail')]) },
  ];
  const chunks = [];
  for await (const chunk of zipStoreChunks(files)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), zipStore(files));
  assert.equal(extractZipEntries(Buffer.concat(chunks)).length, 2);
}
/* ─── 策略层单元测试 ───────────────────────────────────── */

const T2I_MODEL = Object.keys(MODELS).find(k => !MODELS[k].inpaintOnly);
const INPAINT_MODEL = Object.keys(MODELS).find(k => MODELS[k].inpaintOnly);

function testPolicyBasic() {
  const base = { model: T2I_MODEL, prompt: 'test', width: 832, height: 1216, steps: 28, nSamples: 1 };
  assert.equal(applyPolicy('user', base).ok, true);

  // 64 归一化后超出免费层
  const roundedBypass = applyPolicy('user', { ...base, width: 1056, height: 992 });
  assert.equal(roundedBypass.ok, false);
  assert.equal(roundedBypass.code, 'size');

  // 普通用户支持角色提示词（多角色参考）
  assert.equal(applyPolicy('user', { ...base, charPrompts: [{ prompt: '1girl' }] }).ok, true);
}

function testPolicyFreeUserRestrictions() {
  const base = { model: T2I_MODEL, prompt: 'test', width: 832, height: 1216, steps: 28, nSamples: 1 };

  // img2img 被拒
  const i2i = applyPolicy('user', { ...base, img2img: { image: 'data:image/png;base64,abc' } });
  assert.equal(i2i.ok, false);
  assert.equal(i2i.code, 'img2img');

  // inpaint 被拒
  const inp = applyPolicy('user', { ...base, inpaint: { image: 'data:image/png;base64,abc', mask: 'data:image/png;base64,def' } });
  assert.equal(inp.ok, false);
  assert.equal(inp.code, 'inpaint');

  // nSamples > 1 被拒
  const multi = applyPolicy('user', { ...base, nSamples: 2 });
  assert.equal(multi.ok, false);
  assert.equal(multi.code, 'n_samples');

  // steps > 28 被拒
  const tooManySteps = applyPolicy('user', { ...base, steps: 29 });
  assert.equal(tooManySteps.ok, false);
  assert.equal(tooManySteps.code, 'steps');

  // 尺寸超过 1024×1024 总像素
  const tooBig = applyPolicy('user', { ...base, width: 1024, height: 1088 });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.code, 'size');
}

function testPolicyInputValidation() {
  const base = { model: T2I_MODEL, prompt: 'test', width: 832, height: 1216, steps: 28, nSamples: 1 };

  // 无效模型
  const badModel = applyPolicy('user', { ...base, model: 'nonexistent-model' });
  assert.equal(badModel.ok, false);
  assert.equal(badModel.code, 'model');

  // 空提示词
  const noPrompt = applyPolicy('user', { ...base, prompt: '' });
  assert.equal(noPrompt.ok, false);
  assert.equal(noPrompt.code, 'prompt');

  // 提示词过长
  const longPrompt = applyPolicy('user', { ...base, prompt: 'a'.repeat(5001) });
  assert.equal(longPrompt.ok, false);
  assert.equal(longPrompt.code, 'prompt');

  // 尺寸过小
  const tooSmall = applyPolicy('user', { ...base, width: 32, height: 32 });
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.code, 'size');

  // 尺寸过大（管理员上限 1536）
  const tooLarge = applyPolicy('admin', { ...base, width: 2048, height: 2048 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'size');

  // 非对象请求体
  const notObj = applyPolicy('user', 'string');
  assert.equal(notObj.ok, false);

  // 未知采样器/噪声调度在策略层即 400，而不是租到 key 后才失败
  assert.equal(applyPolicy('user', { ...base, sampler: 'ddim_v3' }).code, 'sampler');
  assert.equal(applyPolicy('user', { ...base, noiseSchedule: 'bogus' }).code, 'noiseSchedule');
}

function testPolicyAdminCapabilities() {
  const base = { model: T2I_MODEL, prompt: 'test', width: 832, height: 1216, steps: 28, nSamples: 1 };

  // 管理员可以 img2img
  const adminI2i = applyPolicy('admin', { ...base, width: 1024, height: 1024, img2img: { image: 'data:image/png;base64,abc' } });
  assert.equal(adminI2i.ok, true);

  // 管理员可以 inpaint（需要 inpaint 模型或 t2i 模型映射到 inpaint）
  const adminInp = applyPolicy('admin', { ...base, width: 1024, height: 1024, inpaint: { image: 'data:image/png;base64,abc', mask: 'data:image/png;base64,def' } });
  assert.equal(adminInp.ok, true);

  // 管理员可以多张
  const adminMulti = applyPolicy('admin', { ...base, width: 1024, height: 1024, nSamples: 4 });
  assert.equal(adminMulti.ok, true);
  // 1024x1024 28 步 4 张应该有 Anlas 费用
  assert.ok(adminMulti.anlas > 0);

  // 管理员 keyFanout 仅限免费层参数
  const fanoutPaid = applyPolicy('admin', { ...base, width: 1536, height: 1536, steps: 50, nSamples: 4, keyFanout: true });
  assert.equal(fanoutPaid.ok, false);
  assert.equal(fanoutPaid.code, 'key_fanout');

  // 管理员 keyFanout 免费层参数通过
  const fanoutFree = applyPolicy('admin', { ...base, nSamples: 4, keyFanout: true });
  assert.equal(fanoutFree.ok, true);
  assert.equal(fanoutFree.v.keyFanout, true);
  assert.equal(fanoutFree.anlas, 0);
}

function testPolicyTiers() {
  const base = { prompt: '1girl', model: T2I_MODEL, width: 832, height: 1216, steps: 28 };
  const pro = DEFAULT_TIERS[1];
  // 高级等级：多张、图生图、较大尺寸可用；超出等级上限仍拒绝
  assert.equal(applyPolicy('user', { ...base, nSamples: 4 }, pro).ok, true);
  assert.equal(applyPolicy('user', { ...base, nSamples: 5 }, pro).code, 'n_samples');
  assert.equal(applyPolicy('user', { ...base, img2img: { image: 'data:image/png;base64,abc' } }, pro).ok, true);
  assert.equal(applyPolicy('user', { ...base, width: 1024, height: 1536, steps: 40 }, pro).ok, true);
  assert.equal(applyPolicy('user', { ...base, width: 1536, height: 1536 }, pro).code, 'size');
  // 没有月度 Anlas 额度的等级不能发起计费请求
  const noAnlas = { ...pro, anlas_per_month: 0 };
  assert.equal(applyPolicy('user', { ...base, nSamples: 2 }, noAnlas).code, 'anlas');
  // 未传等级时等同默认免费等级
  assert.equal(applyPolicy('user', { ...base, nSamples: 2 }).code, 'n_samples');

  assert.equal(parseTierInput({ name: '', max_pixels: 1048576, max_steps: 28, max_samples: 1, anlas_per_month: 0 }).ok, false);
  assert.equal(parseTierInput({ name: 'x', max_pixels: 1048576, max_steps: 99, max_samples: 1, anlas_per_month: 0 }).ok, false);
  const parsed = parseTierInput({ name: ' VIP ', max_pixels: 2359296, max_steps: 50, max_samples: 8, anlas_per_month: 1000, limit_per_day: '' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.name, 'VIP');
  assert.equal(parsed.value.limit_per_day, null);
}

/* ─── 调度器租约释放测试 ───────────────────────────────── */

async function testLeaseRelease() {
  scheduler._resetSchedulerForTest();
  const qKeys = {
    count: () => 1,
    listCandidates: () => [{ id: 1, token: 'pst-test', tier: 3, is_active: 1 }],
    get: id => ({ id, token: 'pst-test', tier: 3, is_active: 1 }),
  };
  const qGens = { insert: () => { throw new Error('db-fail'); } };
  const pol = {
    model: 'test', anlas: 0,
    v: { charPrompts: [], prompt: 'x', uc: '', width: 64, height: 64, steps: 1, scale: 1, sampler: 'k_euler', nSamples: 1 },
  };
  await assert.rejects(
    scheduler.scheduleGenerate({ requiredAnlas: 0, buildPayloadFn: () => ({}), qKeys, qGens, user: { user_id: 1 }, pol }),
    /db-fail/,
  );
  assert.equal(scheduler.activeLocks.size, 0);
}

async function testSchedulerNoCandidate() {
  scheduler._resetSchedulerForTest();
  const qKeys = {
    count: () => 0,
    listCandidates: () => [],
    get: () => null,
  };
  const qGens = { insert: () => 1, finishFail: () => {} };
  const pol = {
    model: 'test', anlas: 0,
    v: { charPrompts: [], prompt: 'x', uc: '', width: 64, height: 64, steps: 1, scale: 1, sampler: 'k_euler', nSamples: 1 },
  };
  await assert.rejects(
    scheduler.scheduleGenerate({ requiredAnlas: 0, buildPayloadFn: () => ({}), qKeys, qGens, user: { user_id: 1 }, pol }),
    (err) => err.code === 'NO_CANDIDATE',
  );
}

async function testLockReleasedWhenGetThrows() {
  scheduler._resetSchedulerForTest();
  const qKeys = {
    count: () => 1,
    listCandidates: () => [{ id: 1, token: 'pst-test', tier: 3, is_active: 1 }],
    get: () => { throw new Error('get-fail'); },
  };
  const qGens = { insert: () => 1, finishFail: () => {} };
  const pol = {
    model: 'test', anlas: 0,
    v: { charPrompts: [], prompt: 'x', uc: '', width: 64, height: 64, steps: 1, scale: 1, sampler: 'k_euler', nSamples: 1 },
  };
  await assert.rejects(
    scheduler.scheduleGenerate({ requiredAnlas: 0, buildPayloadFn: () => ({}), qKeys, qGens, user: { user_id: 1 }, pol }),
    /get-fail/,
  );
  assert.equal(scheduler.activeLocks.size, 0);
}

async function testBuildPayloadDoesNotInsert() {
  scheduler._resetSchedulerForTest();
  let inserted = 0;
  const qKeys = {
    count: () => 1,
    listCandidates: () => [{ id: 1, token: 'pst-test', tier: 3, is_active: 1 }],
    get: id => ({ id, token: 'pst-test', tier: 3, is_active: 1 }),
  };
  const qGens = { insert: () => { inserted += 1; return 1; }, finishFail: () => {} };
  const pol = {
    model: 'test', anlas: 0,
    v: { charPrompts: [], prompt: 'x', uc: '', width: 64, height: 64, steps: 1, scale: 1, sampler: 'k_euler', nSamples: 1 },
  };
  await assert.rejects(
    scheduler.scheduleGenerate({
      requiredAnlas: 0,
      buildPayloadFn: () => { throw new Error('bad-payload'); },
      qKeys, qGens, user: { user_id: 1 }, pol,
    }),
    /bad-payload/,
  );
  assert.equal(inserted, 0);
  assert.equal(scheduler.activeLocks.size, 0);
}

async function testCooldownWakesQueue() {
  scheduler._resetSchedulerForTest();
  const key = { id: 1, token: 'pst-test', tier: 3, is_active: 1 };
  const qKeys = {
    count: () => 1,
    listCandidates: () => [key],
    get: () => key,
  };
  scheduler.setKeyCooldown(1, 40);
  const started = Date.now();
  const lease = await scheduler.acquireKey(0, qKeys, 1000);
  assert.ok(Date.now() - started >= 20);
  assert.equal(lease.key.id, 1);
  lease.release();
  assert.equal(scheduler.activeLocks.size, 0);
}

/* ─── HTTP 集成安全测试 ─────────────────────────────────── */

/** 假 NovelAI 上游：订阅查询 + 生图（返回含 n_samples 张 PNG 的 ZIP），记录收到的 payload */
function startFakeUpstream() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/user/subscription') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        tier: 3, active: true, expiresAt: 0, perks: {},
        trainingStepsLeft: { fixedTrainingStepsLeft: 1000, purchasedTrainingSteps: 0 },
        usage: { percent: 80 },
      }));
    }
    if (req.method === 'GET' && req.url === '/user/information') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ plainTextEmail: 'fake@example.com' }));
    }
    if (req.method === 'POST' && req.url === '/ai/generate-image') {
      if (String(req.headers.authorization || '').includes('pst-bad')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Invalid token' }));
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(payload);
      const n = payload.parameters?.n_samples || 1;
      const zip = zipStore(Array.from({ length: n }, (_, i) => ({ name: `image_${i}.png`, data: FAKE_PNG })));
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
      return res.end(zip);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise(resolve => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve({ server, received })));
}

async function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NAI_DB: ':memory:',
      ADMIN_USER: 'auditadmin',
      ADMIN_PASS: 'AuditPassword123',
      COOKIE_SECURE: '0',
      NAI_IMAGE_BASE: `http://127.0.0.1:${UPSTREAM_PORT}`,
      NAI_IMG_DIR: TEST_IMG_DIR,
      NAI_THUMB_DIR: TEST_THUMB_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await waitForServer(child);
  return { child, stderr: () => stderr };
}

async function testHttpSecurity() {
  const upstream = await startFakeUpstream();
  const { child, stderr } = await startServer();
  try {
    await waitForServer(child);

    // 安全响应头
    const models = await request('/api/models');
    assert.equal(models.response.status, 200);
    assert.match(models.response.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(models.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(models.response.headers.get('x-frame-options'), 'DENY');

    // 静态资源：预压缩 + 内容哈希 URL；带当前哈希时可永久缓存
    const index = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(index.headers.get('content-encoding'), 'br');
    assert.equal(index.headers.get('cache-control'), 'no-cache');
    const html = await index.text();
    const jsVersion = html.match(/src="\/app\.js\?v=([a-f0-9]{12})"/)?.[1];
    assert.ok(jsVersion, 'index.html should reference hashed app.js');
    assert.match(html, /href="\/style\.css\?v=[a-f0-9]{12}"/);
    const appJs = await fetch(`http://127.0.0.1:${PORT}/app.js?v=${jsVersion}`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(appJs.headers.get('content-encoding'), 'gzip');
    assert.match(appJs.headers.get('cache-control'), /immutable/);
    assert.equal(await appJs.text(), fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
    const staleJs = await fetch(`http://127.0.0.1:${PORT}/app.js?v=000000000000`);
    assert.equal(staleJs.headers.get('cache-control'), 'no-cache');
    const notModified = await fetch(`http://127.0.0.1:${PORT}/app.js`, { headers: { 'if-none-match': appJs.headers.get('etag') } });
    assert.equal(notModified.status, 304);
    const modelsGz = await fetch(`http://127.0.0.1:${PORT}/api/models`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(modelsGz.headers.get('content-encoding'), 'gzip');
    assert.ok((await modelsGz.json()).models);

    const health = await request('/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.db, true);
    assert.equal(health.body.disk, true);
    assert.equal(typeof health.body.keys, 'number');

    // 登录失败限速
    for (let i = 0; i < 5; i++) {
      const failed = await login('locked-account', 'wrong-password');
      assert.equal(failed.response.status, 401);
    }
    assert.equal((await login('locked-account', 'wrong-password')).response.status, 429);

    // 伪造 X-Forwarded-For 最左侧条目不能绕过按 IP 限速：只认代理追加的最右侧地址
    for (let i = 0; i < 20; i++) {
      const r = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}, 10.9.9.9` },
        body: JSON.stringify({ username: `nobody-${i}`, password: 'wrong-password' }),
      });
      assert.equal(r.response.status, 401);
    }
    const spoofed = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7, 10.9.9.9' },
      body: JSON.stringify({ username: 'nobody-x', password: 'wrong-password' }),
    });
    assert.equal(spoofed.response.status, 429);

    // 管理员登录
    const admin = await login('auditadmin', 'AuditPassword123');
    assert.equal(admin.response.status, 200);
    assert.ok(admin.cookie);
    const adminHeaders = jsonHeaders(admin.cookie);

    // 创建普通用户
    const create = await request('/api/admin/users', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ username: 'normaluser', password: 'NormalPassword123', role: 'user' }),
    });
    assert.equal(create.response.status, 200);
    const normalUserId = create.body.id;

    // 第二管理员（用于后续"不能删最后一个管理员"测试）
    const createAdmin2 = await request('/api/admin/users', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ username: 'admin2', password: 'Admin2Password456', role: 'admin' }),
    });
    assert.equal(createAdmin2.response.status, 200);
    const admin2Id = createAdmin2.body.id;

    const normal = await login('normaluser', 'NormalPassword123');
    assert.equal(normal.response.status, 200);
    const normalHeaders = jsonHeaders(normal.cookie);

    // 普通用户不能查询密钥余额（403）
    const anlas = await request('/api/anlas', { headers: normalHeaders });
    assert.equal(anlas.response.status, 403);

    const sessionUser = await request('/api/admin/users', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ username: 'sessionuser', password: 'SessionPassword123', role: 'user' }),
    });
    assert.equal(sessionUser.response.status, 200);
    const sessA = await login('sessionuser', 'SessionPassword123');
    const sessB = await login('sessionuser', 'SessionPassword123');
    assert.equal(sessA.response.status, 200);
    assert.equal(sessB.response.status, 200);
    const logoutAll = await request('/api/auth/logout-all', { method: 'POST', headers: jsonHeaders(sessA.cookie) });
    assert.equal(logoutAll.response.status, 200);
    assert.equal((await request('/api/me', { headers: jsonHeaders(sessA.cookie) })).response.status, 401);
    assert.equal((await request('/api/me', { headers: jsonHeaders(sessB.cookie) })).response.status, 401);

    // 管理员不能对自己降权
    const selfDemote = await request('/api/admin/users/1', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ role: 'user' }),
    });
    assert.equal(selfDemote.response.status, 400);

    // 未认证用户不能访问受保护端点
    const noAuth = await request('/api/me');
    assert.equal(noAuth.response.status, 401);
    const noAuthGen = await request('/api/generate', { method: 'POST', headers: jsonHeaders(), body: '{}' });
    assert.equal(noAuthGen.response.status, 401);

    // 普通用户不能访问管理员端点
    const userHitAdmin = await request('/api/admin/users', { headers: normalHeaders });
    assert.equal(userHitAdmin.response.status, 403);

    const userTok = await request('/api/v1/models', { headers: { authorization: 'Bearer nai_deadbeefdeadbeefdeadbeef' } });
    assert.equal(userTok.response.status, 401);
    const userAsPlugin = await request('/api/v1/models', { headers: { authorization: 'Bearer x', cookie: normal.cookie } });
    assert.equal(userAsPlugin.response.status, 401);
    const cookieAdminV1 = await request('/api/v1/models', { headers: adminHeaders });
    assert.equal(cookieAdminV1.response.status, 401);
    const minted = await request('/api/admin/tokens', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ label: 'test-plugin' }),
    });
    assert.equal(minted.response.status, 200);
    assert.match(minted.body.token || '', /^nai_[a-f0-9]{64}$/);
    const bearer = { authorization: `Bearer ${minted.body.token}` };
    const me = await request('/api/v1/me', { headers: bearer });
    assert.equal(me.response.status, 200);
    assert.equal(me.body.role, 'admin');
    const modelsV1 = await request('/api/v1/models', { headers: bearer });
    assert.equal(modelsV1.response.status, 200);
    assert.equal(modelsV1.response.headers.get('access-control-allow-origin'), '*');
    const preflight = await request('/api/v1/generate', { method: 'OPTIONS' });
    assert.equal(preflight.response.status, 204);
    const badGen = await request('/api/v1/generate', {
      method: 'POST', headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(badGen.response.status, 400);
    const bearerAdmin = await request('/api/admin/keys', { headers: bearer });
    assert.equal(bearerAdmin.response.status, 401);
    assert.equal((await request('/ai/user/subscription')).response.status, 401);
    const sub = await request('/ai/user/subscription', { headers: bearer });
    assert.equal(sub.response.status, 200);
    assert.equal(sub.body.tier, 3);
    // 去掉 /ai 前缀的别名同样走插件鉴权
    assert.equal((await request('/user/subscription')).response.status, 401);
    const subAlias = await request('/user/subscription', { headers: bearer });
    assert.equal(subAlias.response.status, 200);
    assert.equal(subAlias.body.tier, 3);
    assert.equal((await request('/aix', { headers: bearer })).response.status, 404);
    const aiOpt = await request('/ai/generate-image', { method: 'OPTIONS' });
    assert.equal(aiOpt.response.status, 204);
    const aiBad = await request('/ai/generate-image', {
      method: 'POST', headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ input: '', model: T2I_MODEL, parameters: { width: 832, height: 1216, steps: 28 } }),
    });
    assert.equal(aiBad.response.status, 400);
    const vibe = await request('/ai/encode-vibe', {
      method: 'POST', headers: { ...bearer, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(vibe.response.status, 404);

    const userMint = await request('/api/admin/tokens', {
      method: 'POST', headers: normalHeaders,
      body: JSON.stringify({ label: 'nope' }),
    });
    assert.equal(userMint.response.status, 403);
    const revoked = await request(`/api/admin/tokens/${minted.body.id}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(revoked.response.status, 200);
    assert.equal((await request('/api/v1/me', { headers: bearer })).response.status, 401);


    // 无效 JSON 请求体
    const badJson = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {{{',
    });
    assert.equal(badJson.response.status, 400);

    // 超大请求体
    const bigBody = 'x'.repeat(9 * 1024);
    const bigReq = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'x'.repeat(9 * 1024) }),
    });
    assert.equal(bigReq.response.status, 413);

    // 畸形会话 Cookie 不应让登出 500
    const badCookieLogout = await request('/api/auth/logout', { method: 'POST', headers: { cookie: 'nai_session=%E0%A4%A' } });
    assert.equal(badCookieLogout.response.status, 200);

    console.log('  [http-security] 基础 HTTP 安全测试通过');
    await testAdminProtection(child, adminHeaders, admin.cookie, admin2Id);
    await testProfileUpdate(child, admin.cookie, normalHeaders, normal.cookie);
    await testPromptLibraryAuth(child, normalHeaders, adminHeaders, admin.cookie);
    await testImageAccessControl(child, normal.cookie, admin.cookie);
    await testGalleryBatchAuth(child, normalHeaders);
    await testGenerateFlow(adminHeaders, normalHeaders, upstream, normalUserId);
    await testTiers(adminHeaders, normalHeaders, normalUserId);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    upstream.server.close();
    fs.rmSync(TEST_IMG_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_THUMB_DIR, { recursive: true, force: true });
  }
  // 只允许 Node 实验特性提示与调度器的预期告警；其余 stderr 一律视为失败
  const unexpected = stderr().split('\n')
    .filter(line => line.trim() && !/ExperimentalWarning|--trace-warnings|^\[scheduler\]/.test(line));
  if (unexpected.length) throw new Error(unexpected.join('\n'));
}

async function testAdminProtection(child, adminHeaders, adminCookie, admin2Id) {
  // 管理员不能删除自己
  const selfDelete = await request('/api/admin/users/1', { method: 'DELETE', headers: adminHeaders });
  assert.equal(selfDelete.response.status, 400);

  // 删除第二个管理员后，不能删最后一个可用管理员
  const delAdmin2 = await request(`/api/admin/users/${admin2Id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(delAdmin2.response.status, 200);

  // 现在只剩一个管理员（id=1），禁用自己应被拒
  const selfDisable = await request('/api/admin/users/1', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(selfDisable.response.status, 400);

  // 创建普通用户后降权自己（应被拒）
  await request('/api/admin/users', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ username: 'tempuser', password: 'TempPassword789', role: 'user' }),
  });
  const selfDemoteNow = await request('/api/admin/users/1', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ role: 'user' }),
  });
  assert.equal(selfDemoteNow.response.status, 400);

  console.log('  [admin-protection] 管理员自保护测试通过');
}

async function testProfileUpdate(child, adminCookie, normalHeaders, normalCookie) {
  // 原密码错误
  const wrongOld = await request('/api/user/profile', {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ newPassword: 'NewPass123', oldPassword: 'wrong' }),
  });
  assert.equal(wrongOld.response.status, 400);

  // 新密码过短
  const shortPass = await request('/api/user/profile', {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ newPassword: 'ab', oldPassword: 'NormalPassword123' }),
  });
  assert.equal(shortPass.response.status, 400);

  const sevenPass = await request('/api/user/profile', {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ newPassword: '1234567', oldPassword: 'NormalPassword123' }),
  });
  assert.equal(sevenPass.response.status, 400);

  const otherSession = await login('normaluser', 'NormalPassword123');
  assert.equal(otherSession.response.status, 200);

  // 正常修改密码
  const okPass = await request('/api/user/profile', {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ newPassword: 'NewNormalPass123', oldPassword: 'NormalPassword123' }),
  });
  assert.equal(okPass.response.status, 200);
  assert.equal((await request('/api/me', { headers: normalHeaders })).response.status, 200);
  assert.equal((await request('/api/me', { headers: jsonHeaders(otherSession.cookie) })).response.status, 401);

  // 新密码登录验证
  const relogin = await login('normaluser', 'NewNormalPass123');
  assert.equal(relogin.response.status, 200);
  const newHeaders = jsonHeaders(relogin.cookie);

  // 非字符串字段应 400，而非类型错误导致 500
  const numericPass = await request('/api/user/profile', {
    method: 'POST', headers: newHeaders,
    body: JSON.stringify({ newPassword: 123456789, oldPassword: 'NewNormalPass123' }),
  });
  assert.equal(numericPass.response.status, 400);
  const numericName = await request('/api/user/profile', {
    method: 'POST', headers: newHeaders,
    body: JSON.stringify({ newUsername: 12345 }),
  });
  assert.equal(numericName.response.status, 400);

  // 修改用户名为已占用名
  const dupName = await request('/api/user/profile', {
    method: 'POST', headers: newHeaders,
    body: JSON.stringify({ newUsername: 'auditadmin' }),
  });
  assert.equal(dupName.response.status, 409);

  // 正常修改用户名
  const okName = await request('/api/user/profile', {
    method: 'POST', headers: newHeaders,
    body: JSON.stringify({ newUsername: 'renamed_user' }),
  });
  assert.equal(okName.response.status, 200);

  console.log('  [profile-update] 用户资料修改测试通过');
}

async function testPromptLibraryAuth(child, normalHeaders, adminHeaders, adminCookie) {
  // 普通用户创建提示词
  const createPrompt = await request('/api/prompts', {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ kind: 'main', title: '测试片段', content: '1girl, solo' }),
  });
  assert.equal(createPrompt.response.status, 200);
  const promptId = createPrompt.body.id;
  assert.ok(promptId);

  // 无效 kind 参数
  const badKind = await request('/api/prompts', {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ kind: 'invalid', title: 'x', content: 'y' }),
  });
  assert.equal(badKind.response.status, 400);

  // 标题为空
  const noTitle = await request('/api/prompts', {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ kind: 'main', title: '', content: 'y' }),
  });
  assert.equal(noTitle.response.status, 400);

  // 管理员不能修改普通用户的提示词（不同 user_id）
  const adminModify = await request(`/api/prompts/${promptId}`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ title: 'hacked' }),
  });
  assert.equal(adminModify.response.status, 403);

  // 管理员不能删除普通用户的提示词
  const adminDelete = await request(`/api/prompts/${promptId}`, {
    method: 'DELETE', headers: adminHeaders,
  });
  assert.equal(adminDelete.response.status, 403);

  // 普通用户可以修改自己的提示词
  const okModify = await request(`/api/prompts/${promptId}`, {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ title: '已修改' }),
  });
  assert.equal(okModify.response.status, 200);

  // 普通用户可以删除自己的提示词
  const okDelete = await request(`/api/prompts/${promptId}`, {
    method: 'DELETE', headers: normalHeaders,
  });
  assert.equal(okDelete.response.status, 200);

  console.log('  [prompt-auth] 提示词库鉴权测试通过');
}


async function testGalleryBatchAuth(child, normalHeaders) {
  // 空数组拦截
  const emptyDel = await request('/api/history/batch-delete', {
    method: 'POST', headers: normalHeaders, body: JSON.stringify({ ids: [] })
  });
  assert.equal(emptyDel.response.status, 400);

  const emptyFav = await request('/api/history/batch-favorite', {
    method: 'POST', headers: normalHeaders, body: JSON.stringify({ ids: [] })
  });
  assert.equal(emptyFav.response.status, 400);

  const emptyDl = await request('/api/history/batch-download', {
    method: 'POST', headers: normalHeaders, body: JSON.stringify({ ids: [] })
  });
  assert.equal(emptyDl.response.status, 400);

  const tooMany = await request('/api/history/batch-download', {
    method: 'POST', headers: normalHeaders, body: JSON.stringify({ ids: Array.from({ length: 501 }, (_, i) => i + 1) })
  });
  assert.equal(tooMany.response.status, 400);

  console.log('  [gallery-batch] 画廊批量操作鉴权测试通过');
}

async function testGenerateFlow(adminHeaders, normalHeaders, upstream, normalUserId) {
  const addKey = await request('/api/admin/keys', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ label: 'fake', token: `pst-${'a'.repeat(32)}` }),
  });
  assert.equal(addKey.response.status, 200);
  assert.equal(addKey.body.verify.ok, true);

  // 普通用户未指定种子：响应中的种子须与实际发给上游的一致，并被写进历史
  const gen = await request('/api/generate', {
    method: 'POST', headers: normalHeaders,
    body: JSON.stringify({ prompt: '1girl, solo', model: T2I_MODEL, width: 832, height: 1216, steps: 28 }),
  });
  assert.equal(gen.response.status, 200, JSON.stringify(gen.body));
  const sentSeed = upstream.received.at(-1).parameters.seed;
  assert.ok(Number.isInteger(sentSeed));
  assert.equal(gen.body.seed, sentSeed);

  const hist = await request('/api/history?limit=10', { headers: normalHeaders });
  assert.equal(hist.response.status, 200);
  const rec = hist.body.items.find(it => it.id === gen.body.gen_id);
  assert.ok(rec);
  assert.equal(rec.seed, sentSeed);

  const img = await fetch(`http://127.0.0.1:${PORT}${gen.body.image}`, { headers: normalHeaders });
  assert.equal(img.status, 200);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), FAKE_PNG);

  // 缩略图：属主可取，JPEG、宽 384；其他人 404
  const thumbUrl = gen.body.image.replace('/img/', '/thumb/');
  const thumb = await fetch(`http://127.0.0.1:${PORT}${thumbUrl}`, { headers: normalHeaders });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  const thumbBuf = Buffer.from(await thumb.arrayBuffer());
  const sof = thumbBuf.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(thumbBuf.readUInt16BE(sof + 7), 384);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}${thumbUrl}`)).status, 404);
  const thumbBase = path.basename(gen.body.image, '.png');
  assert.ok(fs.existsSync(path.join(TEST_THUMB_DIR, `${thumbBase}.jpg`)));

  // 流式批量下载：返回合法 ZIP，内容与原图一致，文件名带 id
  const dl = await fetch(`http://127.0.0.1:${PORT}/api/history/batch-download`, {
    method: 'POST', headers: normalHeaders, body: JSON.stringify({ ids: [rec.id, rec.id, 999999] }),
  });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/zip');
  const zipBuf = Buffer.from(await dl.arrayBuffer());
  const pngs = extractZipEntries(zipBuf);
  assert.equal(pngs.length, 1);
  assert.deepEqual(pngs[0], FAKE_PNG);
  assert.ok(zipBuf.includes(Buffer.from(`nai-${sentSeed}-${rec.id}.png`)));

  const del = await request('/api/history/batch-delete', {
    method: 'POST', headers: normalHeaders, body: JSON.stringify({ ids: [rec.id] }),
  });
  assert.equal(del.response.status, 200);
  assert.equal(del.body.deleted, 1);
  assert.ok(!fs.existsSync(path.join(TEST_THUMB_DIR, `${thumbBase}.jpg`)), 'thumbnail should be removed with the image');

  const genBody = JSON.stringify({ prompt: '1girl, solo', model: T2I_MODEL, width: 832, height: 1216, steps: 28 });
  const generate = () => request('/api/generate', { method: 'POST', headers: normalHeaders, body: genBody });

  // 失效 key（上游 401）：自动停用并切到下一个 key，用户请求照常成功
  const badKey = await request('/api/admin/keys', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ label: 'bad', token: `pst-bad${'b'.repeat(32)}` }),
  });
  assert.equal(badKey.response.status, 200);
  const failover = await generate();
  assert.equal(failover.response.status, 200, JSON.stringify(failover.body));
  const keys = await request('/api/admin/keys', { headers: adminHeaders });
  const bad = keys.body.items.find(k => k.id === badKey.body.id);
  assert.equal(bad.is_active, 0);
  assert.equal(bad.verify_state, 'invalid:401');

  // 频控：每分钟 6 张后 429；管理员重置后立即恢复，且历史记录的时间不被改写
  const before = (await request('/api/history?limit=1', { headers: normalHeaders })).body.items[0];
  let limited = null;
  for (let i = 0; i < 8 && !limited; i++) {
    const r = await generate();
    if (r.response.status === 429) limited = r;
    else assert.equal(r.response.status, 200, JSON.stringify(r.body));
  }
  assert.ok(limited, 'expected per-minute limit to trigger');
  const reset = await request(`/api/admin/users/${normalUserId}`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ resetQuota: true }),
  });
  assert.equal(reset.response.status, 200);
  assert.equal((await generate()).response.status, 200);
  const after = (await request('/api/history?limit=60', { headers: normalHeaders })).body.items.find(it => it.id === before.id);
  assert.equal(after.created_at, before.created_at);

  // 画廊游标分页：首屏带计数，翻页不重不漏
  const page1 = await request('/api/history?limit=3&ok=1', { headers: normalHeaders });
  assert.equal(page1.body.items.length, 3);
  assert.ok(page1.body.counts.total >= 6);
  assert.equal(page1.body.nextBefore, page1.body.items[2].id);
  const page2 = await request(`/api/history?limit=3&ok=1&before=${page1.body.nextBefore}`, { headers: normalHeaders });
  assert.equal(page2.body.counts, undefined);
  assert.ok(page2.body.items.every(it => it.id < page1.body.nextBefore && it.status === 'ok'));
  const all = await request('/api/history?limit=500&ok=1', { headers: normalHeaders });
  assert.equal(all.body.items.length, page1.body.counts.total);
  assert.equal(all.body.nextBefore, null);

  console.log('  [generate-flow] 生图/历史/批量下载/失效 key 切换/频控重置测试通过');
}
async function testImageAccessControl(child, normalCookie, adminCookie) {
  // 无会话访问图片 → 404
  const noAuth = await request('/img/nonexistent.png');
  assert.equal(noAuth.response.status, 404);

  // 有会话但图片不存在 → 404
  const noFile = await request('/img/nonexistent.png', { headers: { cookie: normalCookie } });
  assert.equal(noFile.response.status, 404);

  // 路径穿越攻击 → basename 保护，仍然 404
  const traversal = await request('/img/..%2f..%2fetc%2fpasswd');
  assert.equal(traversal.response.status, 404);

  console.log('  [image-access] 图片属主校验测试通过');
}

async function testTiers(adminHeaders, normalHeaders, normalUserId) {
  const post = (url, body, headers = adminHeaders) => request(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const me = async () => (await request('/api/me', { headers: normalHeaders })).body.quota;
  const genBody = { prompt: '1girl, solo', model: T2I_MODEL, width: 832, height: 1216, steps: 28 };

  // 默认两个等级；普通用户不能管理等级
  const tiers = await request('/api/admin/tiers', { headers: adminHeaders });
  assert.equal(tiers.response.status, 200);
  assert.deepEqual(tiers.body.items.map(t => t.name), ['普通用户', '高级用户']);
  const [freeTier, proTier] = tiers.body.items;
  assert.equal((await request('/api/admin/tiers', { headers: normalHeaders })).response.status, 403);
  assert.equal((await post('/api/admin/tiers', { name: '' })).response.status, 400);
  assert.equal((await post('/api/admin/tiers', { ...proTier, name: '普通用户' })).response.status, 409);

  // /api/me 带出等级与用量；免费等级不能出多张
  let quota = await me();
  assert.equal(quota.tier.name, '普通用户');
  assert.equal(quota.tier.maxSamples, 1);
  assert.equal((await post('/api/generate', { ...genBody, nSamples: 2 }, normalHeaders)).response.status, 400);

  // 升到高级等级后可出多张；一次 2 张只计 2 张（不再把主记录重复计数）
  assert.equal((await post(`/api/admin/users/${normalUserId}`, { tierId: proTier.id })).response.status, 200);
  quota = await me();
  assert.equal(quota.tier.name, '高级用户');
  const dayBefore = quota.usage.day;
  const anlasBefore = quota.usage.anlasMonth;
  const two = await post('/api/generate', { ...genBody, nSamples: 2 }, normalHeaders);
  assert.equal(two.response.status, 200, JSON.stringify(two.body));
  assert.equal(two.body.images.length, 2);
  assert.ok(two.body.anlas > 0);
  quota = await me();
  assert.equal(quota.usage.day, dayBefore + 2);
  assert.equal(quota.usage.anlasMonth, anlasBefore + two.body.anlas);

  // 单人覆盖：本月 Anlas 额度不足时拒绝，清空覆盖后恢复跟随等级
  assert.equal((await post(`/api/admin/users/${normalUserId}`, { anlasPerMonthOverride: quota.usage.anlasMonth + 1 })).response.status, 200);
  const broke = await post('/api/generate', { ...genBody, nSamples: 2 }, normalHeaders);
  assert.equal(broke.response.status, 429);
  assert.match(broke.body.error, /本月 Anlas 额度不足/);
  // “重置计数”只清张数频控，不会把本月已用 Anlas 清零
  assert.equal((await post(`/api/admin/users/${normalUserId}`, { resetQuota: true })).response.status, 200);
  assert.equal((await me()).usage.anlasMonth, quota.usage.anlasMonth);
  assert.equal((await post('/api/generate', { ...genBody, nSamples: 2 }, normalHeaders)).response.status, 429);
  assert.equal((await post(`/api/admin/users/${normalUserId}`, { anlasPerMonthOverride: '' })).response.status, 200);
  assert.equal((await me()).tier.anlasPerMonth, proTier.anlas_per_month);

  // 单人覆盖：每日张数到顶即拒绝（上面重置过计数，以当前用量为准）
  assert.equal((await post(`/api/admin/users/${normalUserId}`, { limitPerDayOverride: (await me()).usage.day })).response.status, 200);
  const capped = await post('/api/generate', genBody, normalHeaders);
  assert.equal(capped.response.status, 429);
  assert.match(capped.body.error, /每天限/);
  assert.equal((await post(`/api/admin/users/${normalUserId}`, { limitPerDayOverride: -1 })).response.status, 400);
  assert.equal((await post(`/api/admin/users/${normalUserId}`, { limitPerDayOverride: null })).response.status, 200);

  // 管理员列表带出等级与本月 Anlas 用量
  const users = await request('/api/admin/users', { headers: adminHeaders });
  const row = users.body.items.find(u => u.id === normalUserId);
  assert.equal(row.tier_name, '高级用户');
  assert.ok(row.anlas_month >= two.body.anlas);

  // 删除等级：其下用户回到默认等级；默认等级不可删
  const temp = await post('/api/admin/tiers', { ...proTier, name: '临时等级' });
  assert.equal(temp.response.status, 200);
  await post(`/api/admin/users/${normalUserId}`, { tierId: temp.body.id });
  const edited = await post(`/api/admin/tiers/${temp.body.id}`, { max_samples: 2 });
  assert.equal(edited.response.status, 200);
  assert.equal((await me()).tier.maxSamples, 2);
  const removed = await request(`/api/admin/tiers/${temp.body.id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(removed.body.moved, 1);
  assert.equal((await me()).tier.name, '普通用户');
  assert.equal((await request(`/api/admin/tiers/${freeTier.id}`, { method: 'DELETE', headers: adminHeaders })).response.status, 400);

  console.log('  [tiers] 用户等级 / 单人额度 / 多张计数测试通过');
}

/* ─── 主入口 ───────────────────────────────────────────── */

(async () => {
  console.log('Running policy unit tests...');
  testPolicyBasic();
  testPolicyFreeUserRestrictions();
  testPolicyInputValidation();
  testPolicyAdminCapabilities();
  testPolicyTiers();
  testZipAndCompat();
  testImageCodecs();
  await testZipStreaming();

  console.log('Running scheduler tests...');
  await testLeaseRelease();
  await testSchedulerNoCandidate();
  await testLockReleasedWhenGetThrows();
  await testBuildPayloadDoesNotInsert();
  await testCooldownWakesQueue();

  console.log('Running HTTP security tests...');
  await testHttpSecurity();

  console.log('\nAll security tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
