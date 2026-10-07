'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { applyPolicy } = require('../lib/policy');
const { MODELS, extractZipEntries } = require('../lib/nai');
const scheduler = require('../lib/scheduler');
const { crc32, zipStore } = require('../lib/zip');
const { officialToSiteRequest, fakeOpusSubscription } = require('../lib/nai-compat');

const ROOT = path.join(__dirname, '..');
const PORT = 18761;

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await waitForServer(child);
  return { child, stderr: () => stderr };
}

async function testHttpSecurity() {
  const { child, stderr } = await startServer();
  try {
    await waitForServer(child);

    // 安全响应头
    const models = await request('/api/models');
    assert.equal(models.response.status, 200);
    assert.match(models.response.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(models.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(models.response.headers.get('x-frame-options'), 'DENY');

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

    console.log('  [http-security] 基础 HTTP 安全测试通过');
    await testAdminProtection(child, adminHeaders, admin.cookie, admin2Id);
    await testProfileUpdate(child, admin.cookie, normalHeaders, normal.cookie);
    await testPromptLibraryAuth(child, normalHeaders, adminHeaders, admin.cookie);
    await testImageAccessControl(child, normal.cookie, admin.cookie);
    await testGalleryBatchAuth(child, normalHeaders);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
  }
  const errText = stderr();
  if (errText && !/ExperimentalWarning/.test(errText)) throw new Error(errText);
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

  console.log('  [gallery-batch] 画廊批量操作鉴权测试通过');
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

/* ─── 主入口 ───────────────────────────────────────────── */

(async () => {
  console.log('Running policy unit tests...');
  testPolicyBasic();
  testPolicyFreeUserRestrictions();
  testPolicyInputValidation();
  testPolicyAdminCapabilities();
  testZipAndCompat();

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
