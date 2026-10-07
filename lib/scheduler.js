'use strict';
/**
 * lib/scheduler.js — NAI 任务调度器（零依赖，进程内互斥锁、队列排队、多 Key 试锁、429 退避重试与冷却感知）
 */

const { NaiClient } = require('./nai');

// 调度参数常量（支持环境变量覆盖，方便测试）
const QUEUE_TIMEOUT_MS = Number(process.env.SCHEDULER_QUEUE_TIMEOUT_MS || 120000);
const RETRY_DELAYS = [500, 1000, 2000]; // 429 兜底退避重试延迟
const COOLDOWN_DURATION_MS = Number(process.env.SCHEDULER_COOLDOWN_MS || 30000);
const MAX_QUEUE_LENGTH = Math.max(1, Number(process.env.SCHEDULER_MAX_QUEUE || 100));

// Key 级互斥锁状态：keyId -> boolean (true=正在生成中)
const activeLocks = new Map();

// 冷却状态：keyId -> timestamp (冷却截止时间 ms)
const cooldownUntil = new Map();
const cooldownTimers = new Map();

// 等待队列：[{ requiredAnlas, resolve, reject, timer, queuedAt }]
const waitQueue = [];

/** 检查 key 是否处于冷却期中 */
function isKeyCoolingDown(keyId) {
  const until = cooldownUntil.get(keyId);
  if (!until) return false;
  if (Date.now() >= until) {
    cooldownUntil.delete(keyId);
    return false;
  }
  return true;
}

/** 标记 key 冷却，到期后唤醒等待队列 */
function setKeyCooldown(keyId, durationMs = COOLDOWN_DURATION_MS) {
  clearTimeout(cooldownTimers.get(keyId));
  const ms = Math.max(0, Number(durationMs) || 0);
  cooldownUntil.set(keyId, Date.now() + ms);
  const timer = setTimeout(() => {
    cooldownTimers.delete(keyId);
    cooldownUntil.delete(keyId);
    drainQueue();
  }, ms);
  timer.unref();
  cooldownTimers.set(keyId, timer);
}

/** 检查并尝试获取 key 锁 */
function tryAcquireLock(keyId) {
  if (activeLocks.get(keyId)) {
    return false;
  }
  activeLocks.set(keyId, true);
  return true;
}

/** 释放 key 锁，并尝试唤醒队列中的等待任务 */
function releaseLock(keyId) {
  activeLocks.delete(keyId);
  drainQueue();
}

/** 尝试处理等待队列中的任务 */
function drainQueue() {
  if (waitQueue.length === 0) return;

  // 遍历等待队列，寻找有可用 key 的任务并分配
  for (let i = 0; i < waitQueue.length; i++) {
    const item = waitQueue[i];
    const candidate = findAvailableKey(item.requiredAnlas, item.qKeys);
    if (candidate) {
      // 成功获得候选 key 且拿到锁
      waitQueue.splice(i, 1);
      i--;
      clearTimeout(item.timer);
      item.resolve(candidate);
    }
  }
}

/** 在可用 key 列表中按序试锁（跳过冷却中与锁已被持有的 key） */
function findAvailableKey(requiredAnlas, qKeys) {
  let candidates = [];
  if (requiredAnlas === 0) {
    // 免费单：tier = 3, active = 1, verify_state 正常
    // 按 last_used_at / use_count 排序
    if (qKeys.listCandidates) {
      candidates = qKeys.listCandidates(0);
    } else {
      // 如果 db.js 未扩展 listCandidates，尝试备用逻辑
      const all = qKeys.list ? qKeys.list() : [];
      candidates = all.filter(k => k.is_active && (!k.verify_state || !k.verify_state.startsWith('invalid')) && k.tier === 3);
      candidates.sort((a, b) => {
        const la = a.last_used_at || '';
        const lb = b.last_used_at || '';
        if (la !== lb) return la.localeCompare(lb);
        return (a.use_count || 0) - (b.use_count || 0);
      });
    }
  } else {
    // 计费单：anlas >= requiredAnlas, active = 1, verify_state 正常
    if (qKeys.listCandidates) {
      candidates = qKeys.listCandidates(requiredAnlas);
    } else {
      const all = qKeys.list ? qKeys.list() : [];
      candidates = all.filter(k => k.is_active && (!k.verify_state || !k.verify_state.startsWith('invalid')) && (Number(k.anlas) || 0) >= requiredAnlas);
      candidates.sort((a, b) => {
        const diff = (Number(b.anlas) || 0) - (Number(a.anlas) || 0);
        if (diff !== 0) return diff;
        const la = a.last_used_at || '';
        const lb = b.last_used_at || '';
        if (la !== lb) return la.localeCompare(lb);
        return (a.use_count || 0) - (b.use_count || 0);
      });
    }
  }

  // 检查是否有任何候选 key 存在（不论是否忙碌）
  if (candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    if (isKeyCoolingDown(candidate.id)) {
      continue;
    }
    if (tryAcquireLock(candidate.id)) {
      try {
        const fullKey = qKeys.get ? (qKeys.get(candidate.id) || candidate) : candidate;
        if (!fullKey) {
          releaseLock(candidate.id);
          continue;
        }
        return fullKey;
      } catch (error) {
        releaseLock(candidate.id);
        throw error;
      }
    }
  }

  return null;
}

/**
 * 检查池中是否存在任何理论上能接该单的活跃 key（用于区分 503 节点全忙 vs 根本无可用 key）
 */
function hasAnyCandidateKey(requiredAnlas, qKeys) {
  if (qKeys.listCandidates) {
    return qKeys.listCandidates(requiredAnlas).length > 0;
  }
  const all = qKeys.list ? qKeys.list() : [];
  if (requiredAnlas === 0) {
    return all.some(k => k.is_active && (!k.verify_state || !k.verify_state.startsWith('invalid')) && k.tier === 3);
  }
  return all.some(k => k.is_active && (!k.verify_state || !k.verify_state.startsWith('invalid')) && (Number(k.anlas) || 0) >= requiredAnlas);
}

/**
 * 等待分配可用 key（带互斥锁）
 * @returns {Promise<{ key: object, release: Function }>}
 */
async function acquireKey(requiredAnlas, qKeys, timeoutMs = QUEUE_TIMEOUT_MS) {
  if (!hasAnyCandidateKey(requiredAnlas, qKeys)) {
    const err = new Error(requiredAnlas === 0
      ? '免费层需要 Opus 订阅密钥，池内暂无可用 Opus 节点，请联系管理员'
      : '密钥池为空，请联系管理员添加 NovelAI PST 密钥');
    err.code = 'NO_CANDIDATE';
    throw err;
  }

  // 首次快速尝试
  const key = findAvailableKey(requiredAnlas, qKeys);
  if (key) {
    let released = false;
    return {
      key,
      release: () => {
        if (!released) {
          released = true;
          releaseLock(key.id);
        }
      }
    };
  }

  // 进入等待队列前限制深度，避免请求体和 Promise 无界驻留内存。
  if (waitQueue.length >= MAX_QUEUE_LENGTH) {
    const err = new Error('等待队列已满，请稍后再试');
    err.status = 503;
    err.code = 'QUEUE_FULL';
    throw err;
  }
  return new Promise((resolve, reject) => {
    let timer;
    const queueItem = {
      requiredAnlas,
      qKeys,
      resolve: (acquiredKey) => {
        let released = false;
        resolve({
          key: acquiredKey,
          release: () => {
            if (!released) {
              released = true;
              releaseLock(acquiredKey.id);
            }
          }
        });
      },
      reject,
      queuedAt: Date.now(),
    };

    timer = setTimeout(() => {
      const idx = waitQueue.indexOf(queueItem);
      if (idx !== -1) {
        waitQueue.splice(idx, 1);
      }
      const timeoutErr = new Error('所有节点忙，请稍后再试');
      timeoutErr.status = 503;
      timeoutErr.code = 'QUEUE_TIMEOUT';
      reject(timeoutErr);
    }, timeoutMs);

    queueItem.timer = timer;
    waitQueue.push(queueItem);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 统一执行生图（调度核心入口）：
 * 1. 尝试试锁与排队获取 key
 * 2. 持锁执行 client.generate(payload)
 * 3. 遇到 429 退避重试（最多 3 次，期间持锁）；若仍 429，标记 key 冷却 30s，换下一个 key
 * 4. 401: setActive(false) 标记 invalid
 * 5. 确保释放锁
 */
async function scheduleGenerate({ requiredAnlas, buildPayloadFn, qKeys, qGens, user, pol, startTime = Date.now() }) {
  const maxKeyAttempts = Math.max(qKeys.count ? qKeys.count() : 3, 3);
  let attemptsCount = 0;

  while (attemptsCount < maxKeyAttempts) {
    attemptsCount++;
    const lease = await acquireKey(requiredAnlas, qKeys);
    const { key, release } = lease;

    try {
      const client = new NaiClient(key.token);

      // payload 必须在 insert 之前：未知模型等同步错误不应留下 pending 记录。
      const payload = buildPayloadFn(client);
      const charPromptsJson = pol.v.charPrompts?.length ? JSON.stringify(pol.v.charPrompts) : null;
      const genId = qGens.insert({
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
        // 记录实际发送的种子（未指定时由 buildPayload 随机生成），否则历史无法复现
        seed: payload.parameters?.seed ?? pol.v.seed ?? null,
        n_samples: pol.v.nSamples,
        anlas_est: pol.anlas,
        char_prompts: charPromptsJson,
      });

      let lastError = null;
      let successPngs = null;

      // 429 兜底重试循环（重试期间持续持锁）
      for (let retryIdx = 0; retryIdx <= RETRY_DELAYS.length; retryIdx++) {
        try {
          const got = await client.generate(payload);
          successPngs = Array.isArray(got) ? got : (got ? [got] : []);
          lastError = null;
          break; // 成功
        } catch (err) {
          lastError = err;
          const is429 = err.status === 429 || (err.message && err.message.includes('429'));
          if (is429 && retryIdx < RETRY_DELAYS.length) {
            const delay = RETRY_DELAYS[retryIdx];
            console.log(`[scheduler] Key ${key.id} 收到 429，持锁等待 ${delay}ms 后第 ${retryIdx + 1} 次重试...`);
            await sleep(delay);
            continue;
          }
          break;
        }
      }

      if (!lastError && successPngs && successPngs.length) {
        return {
          png: successPngs[0],
          pngs: successPngs,
          key,
          genId,
          payload,
        };
      }

      if (!lastError) {
        lastError = new Error('上游未返回图片');
      }

      // 如果是 429 最终重试失败：标记冷却 30s，换下一个 key
      const is429 = lastError.status === 429 || (lastError.message && lastError.message.includes('429'));
      if (is429) {
        console.warn(`[scheduler] Key ${key.id} 429 重试耗尽，进入冷却 ${COOLDOWN_DURATION_MS / 1000}s`);
        setKeyCooldown(key.id, COOLDOWN_DURATION_MS);
        qGens.finishFail(genId, lastError.message, Date.now() - startTime);
        // 尝试换下一个 key
        continue;
      }

      // 其他错误：如 401 / 402 / 500 等
      if (lastError.status === 401) {
        qKeys.setState(key.id, 'invalid:401', null, null);
        qKeys.setActive(key.id, false);
      }
      qGens.finishFail(genId, lastError.message, Date.now() - startTime);
      throw lastError;
    } finally {
      release();
    }
  }

  // 若多次换 key 均因 429 冷却耗尽
  const err = new Error('所有节点忙，请稍后再试');
  err.status = 503;
  throw err;
}

/** 重置调度状态（仅测试使用） */
function _resetSchedulerForTest() {
  activeLocks.clear();
  cooldownUntil.clear();
  for (const timer of cooldownTimers.values()) clearTimeout(timer);
  cooldownTimers.clear();
  while (waitQueue.length > 0) {
    const item = waitQueue.shift();
    clearTimeout(item.timer);
  }
}

module.exports = {
  scheduleGenerate,
  acquireKey,
  tryAcquireLock,
  releaseLock,
  isKeyCoolingDown,
  setKeyCooldown,
  findAvailableKey,
  hasAnyCandidateKey,
  _resetSchedulerForTest,
  activeLocks,
  cooldownUntil,
  waitQueue,
  QUEUE_TIMEOUT_MS,
  RETRY_DELAYS,
  COOLDOWN_DURATION_MS,
  MAX_QUEUE_LENGTH,
};
