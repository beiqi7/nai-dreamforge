'use strict';
/**
 * lib/policy.js — 权限策略
 *
 *   管理员：默认免费层参数起步，但可自由越界（大图/多步/多张/img2img/inpaint，越界部分耗 Anlas）
 *            keyFanout=true 时把 N 张拆成 N 次 n_samples=1 的独立请求，走多 Key 并行，仍 0 Anlas
 *   普通用户：受所在等级约束（见 lib/tiers.js）—— 最大像素/步数/张数、是否允许 i2i/infill、
 *            是否允许计费生成（anlas_per_day > 0）。默认等级即 Opus 免费层：单张、≤28 步、≤1MP、纯 t2i
 */

const { OPUS_FREE, calcAnlas, MODELS, INPAINT_MAP, SAMPLERS, NOISE_SCHEDULES, nearest64 } = require('./nai');
const { FREE_TIER } = require('./tiers');

/** 1048576 → "1MP"，1572864 → "1.5MP" */
function formatPixels(n) {
  return `${Number((n / 1048576).toFixed(2))}MP`;
}

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
 * 按角色与等级归一化并校验生成请求。
 * @param {'admin'|'user'} role
 * @param {object} req 前端请求体
 * @param {object} [limits] 普通用户的生效等级限额（qUsers.limits 的结果），缺省为默认免费等级
 * @returns {{ok:true, v:{...}, anlas:number, freeTier:boolean, model:string} | {ok:false, error:string, code:string}}
 */
function applyPolicy(role, req, limits = FREE_TIER) {
  const isAdmin = role === 'admin';
  const tier = limits || FREE_TIER;
  const tierLabel = `当前等级「${tier.name || '普通用户'}」`;
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
  /* ── 纵深防御第一道（入口即拦）：等级未开放的 i2i / infill 一律拒绝 ── */
  if (!isAdmin && req.inpaint && !tier.allow_inpaint) {
    return { ok: false, code: 'inpaint', error: `${tierLabel}没有局部重绘 (infill) 权限` };
  }
  if (!isAdmin && req.img2img && !tier.allow_img2img) {
    return { ok: false, code: 'img2img', error: `${tierLabel}没有图生图 (i2i) 权限` };
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
    /* ── 普通用户：按等级硬约束，超出直接 400 拒绝 ── */
    if (v.width * v.height > tier.max_pixels) {
      return { ok: false, code: 'size', error: `${tierLabel}分辨率上限 ${formatPixels(tier.max_pixels)}（1MP = 1024×1024），当前 ${v.width}×${v.height} 超限，请选择较小档位或联系管理员升级` };
    }
    if (v.steps > tier.max_steps) {
      return { ok: false, code: 'steps', error: `${tierLabel}最高 ${tier.max_steps} 步，当前 ${v.steps} 步超限` };
    }
  }

  const maxSteps = isAdmin ? MAX_STEPS_ANY : tier.max_steps;
  if (v.steps < 1 || v.steps > maxSteps) {
    return { ok: false, code: 'steps', error: `步数须在 1–${maxSteps} 之间（Opus 免费层为 28 步）` };
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
    if (v.nSamples > tier.max_samples) {
      return { ok: false, code: 'n_samples', error: `${tierLabel}每次最多生成 ${tier.max_samples} 张` };
    }
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

  /* 没有 Anlas 日额度的等级只能使用 0 Anlas 的参数；有额度时由服务端按 24 小时用量再核对 */
  if (!isAdmin && anlas > 0 && !(tier.anlas_per_day > 0)) {
    return { ok: false, code: 'anlas', error: `${tierLabel}仅支持 0 Anlas 的免费参数，本次约需 ${anlas} Anlas，请降低参数或联系管理员升级` };
  }

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
