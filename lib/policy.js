'use strict';
/**
 * lib/policy.js — 权限策略
 *
 *   管理员：默认免费层参数起步，但可自由越界（大图/多步/多张/img2img/inpaint，越界部分耗 Anlas）
 *            keyFanout=true 时把 N 张拆成 N 次 n_samples=1 的独立请求，走多 Key 并行，仍 0 Anlas
 *   普通用户：锁死 Opus 免费层级 —— n_samples=1、steps≤28、面积 ≤1024×1024、纯 t2i
 */

const { OPUS_FREE, calcAnlas, MODELS, INPAINT_MAP, SAMPLERS, NOISE_SCHEDULES, nearest64 } = require('./nai');

const MAX_DIM = 1536;      // 模型输出上限
const MAX_STEPS_ANY = 50;
const MAX_SAMPLES = 8;     // 单次请求张数上限（含多 Key 轮询）
/** 判定一组钳制后的参数是否落在 Opus 免费层内 */
function isFreeTier(v) {
  return v.width * v.height <= OPUS_FREE.MAX_PIXELS
    && v.steps <= OPUS_FREE.MAX_STEPS
    && v.nSamples === 1
    && !v.img2img && !v.inpaint;
}

/**
 * 按角色归一化并校验生成请求。
 * @returns {{ok:true, v:{...}, anlas:number, freeTier:boolean, model:string} | {ok:false, error:string, code:string}}
 */
function applyPolicy(role, req) {
  const isAdmin = role === 'admin';
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { ok: false, code: 'body', error: '请求必须是对象' };
  for (const name of ['width', 'height', 'steps', 'scale', 'nSamples', 'cfgRescale']) {
    if (req[name] !== undefined && !Number.isFinite(Number(req[name]))) {
      return { ok: false, code: name, error: `${name} 必须是有限数值` };
    }
  }
  const v = {
    model: req.model,
    prompt: String(req.prompt || '').trim(),
    uc: String(req.uc || ''),
    width: Number(req.width) || 1024,
    height: Number(req.height) || 1024,
    steps: Math.round(Number(req.steps) || 28),
    scale: Number(req.scale) || 5,
    sampler: req.sampler || 'k_euler',
    noiseSchedule: req.noiseSchedule || 'karras',
    seed: Number.isInteger(Number(req.seed)) ? Number(req.seed) : undefined,
    nSamples: Math.max(1, Math.round(Number(req.nSamples) || 1)),
    keyFanout: false,
    ucPreset: req.ucPreset || 'heavy',
    qualityTags: req.qualityTags !== false,
    cfgRescale: Math.min(1, Math.max(0, Number(req.cfgRescale) || 0)),
    img2img: null,
    inpaint: null,
    charPrompts: [],
    v5Mode: req.v5Mode === 'furry' ? 'furry' : undefined,
  };
  /* ── 免费用户纵深防御（第一道，入口即拦）：i2i / infill 一律拒绝 ── */
  if (!isAdmin && (req.inpaint || req.img2img)) {
    return { ok: false, code: req.inpaint ? 'inpaint' : 'img2img', error: '免费用户无图生图 (i2i) 与局部重绘 (infill) 权限' };
  }

  if (typeof v.model !== 'string' || !Object.hasOwn(MODELS, v.model)) return { ok: false, code: 'model', error: '未知模型' };
  if (MODELS[v.model].inpaintOnly && !req.inpaint) {
    return { ok: false, code: 'model', error: `模型 ${v.model} 为局部重绘专用，请上传图片与蒙版` };
  }
  if (!SAMPLERS.includes(v.sampler)) return { ok: false, code: 'sampler', error: '未知采样器' };
  if (!NOISE_SCHEDULES.includes(v.noiseSchedule)) return { ok: false, code: 'noiseSchedule', error: '未知噪声调度' };
  if (!v.prompt) return { ok: false, code: 'prompt', error: '提示词不能为空' };
  if (v.prompt.length > 5000) return { ok: false, code: 'prompt', error: '提示词过长' };
  if (v.width < 64 || v.height < 64 || v.width > MAX_DIM || v.height > MAX_DIM) {
    return { ok: false, code: 'size', error: `尺寸须在 64–${MAX_DIM}px 之间` };
  }

  // 与实际 payload 使用同一归一化函数；权限检查和估价必须使用实际发送尺寸。
  v.width = nearest64(v.width);
  v.height = nearest64(v.height);
  if (v.uc.length > 5000) return { ok: false, code: 'uc', error: '负面提示词过长' };
  if (Array.isArray(req.charPrompts) && req.charPrompts.some(c => !c || typeof c !== 'object' || Array.isArray(c))) {
    return { ok: false, code: 'charPrompts', error: '角色提示词格式错误' };
  }

  /* inpaint 预处理（仅管理员可达——免费用户已在入口被拒）：须有 image+mask */
  if (req.inpaint) {
    if (!req.inpaint.image || !req.inpaint.mask) return { ok: false, code: 'inpaint', error: '局部重绘需要源图与蒙版' };
    if (!INPAINT_MAP[v.model] && !MODELS[v.model].inpaintOnly) {
      return { ok: false, code: 'inpaint', error: `模型 ${v.model} 不支持局部重绘` };
    }
    v.inpaint = {
      image: String(req.inpaint.image),
      mask: String(req.inpaint.mask),
      strength: Number.isFinite(Number(req.inpaint.strength))
        ? Math.min(1, Math.max(0, Number(req.inpaint.strength)))
        : 1,
      addOriginalImage: req.inpaint.addOriginalImage !== false,
    };
  }

  /* img2img 预处理（仅管理员可达） */
  if (req.img2img) {
    if (!req.img2img.image) return { ok: false, code: 'img2img', error: '图生图缺少源图' };
    v.img2img = {
      image: String(req.img2img.image),
      strength: Math.min(1, Math.max(0, Number(req.img2img.strength) || 0.7)),
      noise: Math.min(1, Math.max(0, Number(req.img2img.noise) || 0)),
    };
  }
  if (!isAdmin) {
    /* ── 普通用户：Opus 免费层级硬约束，超出直接 400 拒绝 ── */
    if (v.width * v.height > OPUS_FREE.MAX_PIXELS) {
      return { ok: false, code: 'size', error: `免费层分辨率上限 1024×1024（1MP），当前 ${v.width}×${v.height} 超限，请选择正常档位或升级权限` };
    }
    if (v.steps > OPUS_FREE.MAX_STEPS) {
      return { ok: false, code: 'steps', error: `免费层仅支持最高 ${OPUS_FREE.MAX_STEPS} 步，当前 ${v.steps} 步超限，请调整步数或升级权限` };
    }
  }

  if (v.steps < 1 || v.steps > (isAdmin ? MAX_STEPS_ANY : OPUS_FREE.MAX_STEPS)) {
    return { ok: false, code: 'steps', error: `步数须在 1–${isAdmin ? MAX_STEPS_ANY : OPUS_FREE.MAX_STEPS} 之间（Opus 免费层为 28 步）` };
  }

  if (Array.isArray(req.charPrompts)) {
    const parseCoord = (val) => {
      if (val === null || val === undefined || val === '' || val === 'auto') return null;
      const num = Number(val);
      if (!Number.isFinite(num)) return null;
      return Math.min(1, Math.max(0, num));
    };
    v.charPrompts = req.charPrompts.slice(0, 22).map((c) => {
      const px = parseCoord(c.x);
      const py = parseCoord(c.y);
      const isAuto = px === null || py === null;
      return {
        prompt: String(c.prompt || '').trim().slice(0, 1000),
        uc: String(c.uc || '').trim().slice(0, 1000),
        x: isAuto ? null : px,
        y: isAuto ? null : py,
      };
    }).filter((c) => c.prompt);
  }

  if (!isAdmin) {
    /* ── 普通用户：Opus 免费层级硬约束 ── */
    if (v.nSamples !== 1) return { ok: false, code: 'n_samples', error: '普通用户每次只能生成 1 张（Opus 免费层级）' };
  } else if (v.nSamples > MAX_SAMPLES) {
    return { ok: false, code: 'n_samples', error: `单次最多生成 ${MAX_SAMPLES} 张` };
  }

  /* 最终模型：inpaint 时切到 inpainting 权重 */
  const finalModel = v.inpaint && INPAINT_MAP[v.model] ? INPAINT_MAP[v.model] : v.model;

  const anlas = calcAnlas({
    width: v.width, height: v.height, steps: v.steps, nSamples: v.nSamples,
    strength: v.img2img?.strength, inpaintStrength: v.inpaint?.strength,
    img2img: !!v.img2img, inpaint: !!v.inpaint,
    characterRef: false, opus: true,
    model: finalModel,
  });

  /* freeTier 徽章：V5 在 1MP/28 步内连 img2img/infill 都免费（实测）；旧模型仅纯 t2i 免费 */
  const inBounds = v.width * v.height <= OPUS_FREE.MAX_PIXELS && v.steps <= OPUS_FREE.MAX_STEPS && v.nSamples === 1;
  const isV5Model = finalModel.startsWith('nai-diffusion-5');
  const freeTier = isV5Model ? inBounds : (inBounds && !v.img2img && !v.inpaint);

  if (isAdmin && req.keyFanout && v.nSamples > 1) {
    const anlasOne = calcAnlas({
      width: v.width, height: v.height, steps: v.steps, nSamples: 1,
      strength: v.img2img?.strength, inpaintStrength: v.inpaint?.strength,
      img2img: !!v.img2img, inpaint: !!v.inpaint,
      characterRef: false, opus: true,
      model: finalModel,
    });
    if (anlasOne > 0) {
      return { ok: false, code: 'key_fanout', error: '多 Key 轮询仅适用于 Opus 免费层参数（每张独立请求，0 Anlas）' };
    }
    v.keyFanout = true;
    return { ok: true, v, anlas: 0, freeTier: true, model: finalModel };
  }

  return { ok: true, v, anlas, freeTier, model: finalModel };

}

module.exports = { applyPolicy, isFreeTier, MAX_DIM, MAX_STEPS_ANY, MAX_SAMPLES };
