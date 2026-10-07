'use strict';
/**
 * lib/nai.js — NovelAI API 客户端（仅保留 4.5 及之后现代模型）
 */

const { inflateRawSync } = require('node:zlib');

const IMAGE_BASE = process.env.NAI_IMAGE_BASE || 'https://image.novelai.net';
const TIMEOUT_MS = Number(process.env.NAI_TIMEOUT_MS || 180000);
const MAX_GENERATE_BYTES = 64 * 1024 * 1024;

/* ─── 仅保留 4.5 及之后现代模型 ───────────────────────────── */

const MODELS = {
  'nai-diffusion-5-full':                 { label: 'NovelAI V5 Full（最新旗航 · 完整语料）', family: 'v5', maxTokens: 1471 },
  'nai-diffusion-5-full-inpainting':      { label: 'NovelAI V5 Full Inpainting（重绘专用）', family: 'v5', maxTokens: 1471, inpaintOnly: true },
  'nai-diffusion-5-curated':              { label: 'NovelAI V5 Curated（最新精选 · 干净画风）', family: 'v5', maxTokens: 703 },
  'nai-diffusion-4-5-full':               { label: 'NovelAI V4.5 Full', family: 'v4', maxTokens: 512 },
  'nai-diffusion-4-5-full-inpainting':    { label: 'NovelAI V4.5 Full Inpainting（重绘专用）', family: 'v4', maxTokens: 512, inpaintOnly: true },
  'nai-diffusion-4-5-curated':            { label: 'NovelAI V4.5 Curated', family: 'v4', maxTokens: 512 },
  'nai-diffusion-4-5-curated-inpainting': { label: 'NovelAI V4.5 Curated Inpainting（重绘专用）', family: 'v4', maxTokens: 512, inpaintOnly: true },
};

const isV5  = (m) => MODELS[m]?.family === 'v5';

const SAMPLERS = ['k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde'];
const NOISE_SCHEDULES = ['karras', 'exponential', 'polyexponential', 'native'];

const QUALITY_TAGS = {
  'nai-diffusion-5-full': ', very aesthetic, masterpiece, no text',
  'nai-diffusion-5-full-inpainting': ', very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': ', very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': ', very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full-inpainting': ', very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': ', very aesthetic, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-5-curated-inpainting': ', very aesthetic, masterpiece, no text, -0.8::feet::, rating:general',
};

const UC_HEAVY_V5 = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const UC_HEAVY_V45_FULL = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page,';
const UC_HEAVY_V45_CUR = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page,';

const UC_PRESETS = {
  'nai-diffusion-5-full':              { heavy: UC_HEAVY_V5, none: '' },
  'nai-diffusion-5-full-inpainting':   { heavy: UC_HEAVY_V5, none: '' },
  'nai-diffusion-5-curated':           { heavy: UC_HEAVY_V5, none: '' },
  'nai-diffusion-4-5-full': {
    heavy: UC_HEAVY_V45_FULL,
    light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page,',
    humanFocus: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy,',
    none: '',
  },
  'nai-diffusion-4-5-full-inpainting': {
    heavy: UC_HEAVY_V45_FULL,
    light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page,',
    humanFocus: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy,',
    none: '',
  },
  'nai-diffusion-4-5-curated': {
    heavy: UC_HEAVY_V45_CUR,
    light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page,',
    humanFocus: 'lowres, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page,',
    none: '',
  },
  'nai-diffusion-4-5-curated-inpainting': {
    heavy: UC_HEAVY_V45_CUR,
    light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page,',
    humanFocus: 'lowres, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page,',
    none: '',
  },
};

const SIZE_PRESETS = {
  NORMAL_PORTRAIT:   { width: 832,  height: 1216 },
  NORMAL_LANDSCAPE:  { width: 1216, height: 832 },
  NORMAL_SQUARE:     { width: 1024, height: 1024 },
  SMALL_PORTRAIT:    { width: 512,  height: 768 },
  SMALL_LANDSCAPE:   { width: 768,  height: 512 },
  SMALL_SQUARE:      { width: 640,  height: 640 },
  LARGE_PORTRAIT:    { width: 1024, height: 1536 },
  LARGE_LANDSCAPE:   { width: 1536, height: 1024 },
  LARGE_SQUARE:      { width: 1472, height: 1472 },
  WALLPAPER_PORTRAIT:  { width: 1088, height: 1920 },
  WALLPAPER_LANDSCAPE: { width: 1920, height: 1088 },
};

const OPUS_FREE = {
  MAX_PIXELS: 1024 * 1024,
  MAX_STEPS: 28,
};

function calcAnlas({ width, height, steps, nSamples = 1, strength = 1, inpaintStrength, img2img = false, inpaint = false, characterRef = false, opus = false, model }) {
  const area = width * height;
  const v5 = isV5(model);
  let base = Math.ceil(2.951823174884865e-6 * area + 5.753298233447344e-7 * area * steps);
  if (v5) base = Math.ceil(base * 1.5);
  const factor = inpaint ? (inpaintStrength ?? 1) : img2img ? strength : 1;
  const per = Math.max(Math.ceil(base * factor), 2);
  const withinFree = area <= OPUS_FREE.MAX_PIXELS && steps <= OPUS_FREE.MAX_STEPS;
  const freeEligible = opus && withinFree && (v5 || (!img2img && !inpaint && !characterRef));
  const billable = freeEligible ? Math.max(nSamples - 1, 0) : nSamples;
  return per * billable;
}

function extractZipEntries(buf) {
  const out = [];
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const cdCount = buf.readUInt16LE(i + 10);
    const cdOffset = buf.readUInt32LE(i + 16);
    let off = cdOffset;
    for (let n = 0; n < cdCount; n++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;
      const method = buf.readUInt16LE(off + 10);
      const csize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOff = buf.readUInt32LE(off + 42);
      if (buf.readUInt32LE(localOff) === 0x04034b50) {
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataOff = localOff + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(dataOff, dataOff + csize);
        let raw = null;
        if (method === 0) raw = Buffer.from(data);
        else if (method === 8) {
          try { raw = Buffer.from(inflateRawSync(data)); } catch { raw = null; }
        }
        if (raw && raw.length >= 8 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) {
          out.push(raw);
        }
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    break;
  }
  return out;
}

async function readLimitedBody(res, limit = MAX_GENERATE_BYTES) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error('上游响应过大');
  }
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error('上游响应过大');
    return buf;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw new Error('上游响应过大');
    }
    chunks.push(Buffer.from(value));
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
}

async function fetchRetry(url, opts, { retries = 0, timeoutMs = TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      if (e?.name === 'TimeoutError') break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

class NaiClient {
  constructor(token) {
    if (!token) throw new Error('缺少 NovelAI PST 令牌');
    this.token = token;
  }

  headers() { return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }; }

  async getSubscription() {
    const res = await fetchRetry(`${IMAGE_BASE}/user/subscription`, { headers: this.headers() }, { retries: 1, timeoutMs: 30000 });
    if (!res.ok) {
      const err = new Error(`NAI 订阅查询失败: HTTP ${res.status}`); err.status = res.status; throw err;
    }
    const j = await res.json();
    const t = j.trainingStepsLeft || {};
    const u = j.usage || {};

    // 尝试拉取 user/information 端点获取官方登记的明文邮箱（如有设置）
    let email = null;
    let accountCreatedAt = null;
    try {
      const infoRes = await fetchRetry(`${IMAGE_BASE}/user/information`, { headers: this.headers() }, { retries: 0, timeoutMs: 15000 });
      if (infoRes.ok) {
        const info = await infoRes.json();
        email = info.plainTextEmail || info.plaintextEmail || null;
        accountCreatedAt = info.accountCreatedAt ? new Date(info.accountCreatedAt * 1000).toISOString().slice(0, 10) : null;
      }
    } catch {}

    return {
      tier: j.tier,
      tierName: ['Paper', 'Tablet', 'Scroll', 'Opus'][j.tier] || `Tier ${j.tier}`,
      active: !!j.active,
      expiresAt: j.expiresAt,
      anlas: (t.fixedTrainingStepsLeft || 0) + (t.purchasedTrainingSteps || 0),
      fixedAnlas: t.fixedTrainingStepsLeft || 0,
      purchasedAnlas: t.purchasedTrainingSteps || 0,
      freeGeneration: !!j.perks?.unlimitedImageGeneration || j.tier === 3,
      freeLimits: j.perks?.unlimitedImageGenerationLimits || [],
      v5Battery: u.percent ?? null, // V5 充能池电量百分比
      v5TimeUntilNext: u.timeUntilNextPercent ?? null,
      email,
      accountCreatedAt,
      perks: j.perks,
    };
  }

  async verifyToken() {
    try { const s = await this.getSubscription(); return { ok: true, subscription: s }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  buildPayload({ action = 'generate', prompt, model, width, height, steps = 28, scale = 5, sampler = 'k_euler', noiseSchedule = 'karras', seed, nSamples = 1, uc = '', ucPreset = 'heavy', qualityTags = true, cfgRescale = 0, charPrompts = [], useCoords = false, useOrder = true, img2img, inpaint, v5Mode }) {
    if (!MODELS[model]) throw new Error(`未知模型: ${model}`);
    if (inpaint && !MODELS[model].inpaintOnly) {
      const inpaintModel = INPAINT_MAP[model];
      if (!inpaintModel) throw new Error(`模型 ${model} 暂无专属局部重绘支持`);
      model = inpaintModel;
    }
    if (!inpaint && MODELS[model].inpaintOnly) throw new Error(`模型 ${model} 仅用于局部重绘（inpaint）`);
    if (!SAMPLERS.includes(sampler)) throw new Error(`未知采样器: ${sampler}`);
    if (!NOISE_SCHEDULES.includes(noiseSchedule)) throw new Error(`未知噪声调度: ${noiseSchedule}`);
    width = nearest64(width); height = nearest64(height);
    seed = Number.isInteger(seed) ? seed : randomSeed();

    let finalPrompt = String(prompt || '');
    if (v5Mode === 'furry' && isV5(model)) finalPrompt = `fur dataset, ${finalPrompt}`;
    if (qualityTags) finalPrompt += (QUALITY_TAGS[model] || ', very aesthetic, masterpiece, no text');

    let finalUC = String(uc || '');
    if (ucPreset !== 'none' && UC_PRESETS[model]?.[ucPreset]) {
      finalUC = UC_PRESETS[model][ucPreset] + (finalUC ? ', ' + finalUC : '');
    }

    const effectiveUseCoords = !!(useCoords || charPrompts.length);
    const buildCharCaptions = (textKey) => charPrompts.map((c) => {
      const isManual = c.x !== null && c.x !== undefined && c.y !== null && c.y !== undefined;
      const item = {
        char_caption: c[textKey] || '',
        centers: [{ x: isManual ? c.x : 0.5, y: isManual ? c.y : 0.5 }],
      };
      return item;
    });

    const params = {
      cfg_rescale: cfgRescale,
      controlnet_strength: 1,
      dynamic_thresholding: false,
      skip_cfg_above_sigma: null,
      legacy: false,
      legacy_uc: false,
      legacy_v3_extend: false,
      n_samples: nSamples,
      negative_prompt: finalUC,
      params_version: isV5(model) ? 4 : 3,
      noise_schedule: noiseSchedule === 'native' ? 'karras' : noiseSchedule,
      qualityToggle: !!qualityTags,
      sampler, scale, seed,
      steps, width, height,
      use_coords: effectiveUseCoords,
      prefer_brownian: true,
      deliberate_euler_ancestral_bug: false,
      v4_prompt: {
        use_coords: effectiveUseCoords,
        use_order: !!useOrder,
        caption: {
          base_caption: finalPrompt,
          char_captions: buildCharCaptions('prompt'),
        },
      },
      v4_negative_prompt: {
        legacy_uc: false,
        caption: {
          base_caption: finalUC,
          char_captions: buildCharCaptions('uc'),
        },
      },
    };

    if (charPrompts.length) {
      params.characterPrompts = charPrompts.map((c) => {
        const isManual = c.x !== null && c.x !== undefined && c.y !== null && c.y !== undefined;
        return {
          prompt: c.prompt,
          uc: c.uc || '',
          center: { x: isManual ? c.x : 0.5, y: isManual ? c.y : 0.5 },
        };
      });
    }

    if (isV5(model)) {
      params.ucPresetId = ucPreset === 'none' ? 'none' : ucPreset;
      params.qualityPresetId = 'standard';
      params.tag_hint_qt = qualityTags ? 1 : 0;
      params.tag_hint_uc_preset = 2;
      params.normalize_reference_strength_multiple = true;
      params.straight_alpha = true;
      params.image_format = 'png';
      params.inpaintImg2ImgStrength ??= 1;
      params.add_original_image ??= true;
      delete params.qualityToggle;
      delete params.skip_cfg_above_sigma;
    }

    if (img2img) {
      action = 'img2img';
      params.image = img2img.image;
      params.strength = img2img.strength ?? 0.7;
      params.noise = img2img.noise ?? 0;
      params.extra_noise_seed = img2img.noiseSeed ?? seed;
    }
    if (inpaint) {
      action = 'infill';
      params.image = inpaint.image;
      params.mask = inpaint.mask;
      params.add_original_image = inpaint.addOriginalImage ?? true;
      params.inpaintImg2ImgStrength = inpaint.strength ?? 1;
      params.img2img = { strength: inpaint.strength ?? 1, color_correct: false };
    }

    return { action, input: finalPrompt, model, parameters: params };
  }

  async generate(payload) {
    const res = await fetchRetry(`${IMAGE_BASE}/ai/generate-image`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(payload),
    }, { retries: 0, timeoutMs: TIMEOUT_MS });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json())?.message || ''; } catch { try { msg = (await res.text()).slice(0, 300); } catch {} }
      const err = new Error(`NAI ${res.status}: ${msg || res.statusText}`); err.status = res.status; throw err;
    }
    const zip = await readLimitedBody(res);
    const pngs = extractZipEntries(zip);
    if (!pngs.length) throw new Error('NAI 响应 ZIP 解析失败');
    return pngs;
  }
}

/** t2i 模型 → inpainting 专属模型映射（仅 4.5 以后） */
const INPAINT_MAP = {
  'nai-diffusion-5-full': 'nai-diffusion-5-full-inpainting',
  'nai-diffusion-4-5-full': 'nai-diffusion-4-5-full-inpainting',
  'nai-diffusion-4-5-curated': 'nai-diffusion-4-5-curated-inpainting',
};

function nearest64(n) { return Math.max(64, Math.round(n / 64) * 64); }
function randomSeed() { return Math.floor(Math.random() * 2 ** 31); }

module.exports = {
  NaiClient, MODELS, SAMPLERS, NOISE_SCHEDULES, SIZE_PRESETS, UC_PRESETS, QUALITY_TAGS,
  OPUS_FREE, calcAnlas, nearest64, randomSeed, isV5, INPAINT_MAP,
  IMAGE_BASE, extractZipEntries,
};
