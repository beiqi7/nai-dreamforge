'use strict';

function coord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

function charFromOfficial(parameters) {
  const p = parameters || {};
  const out = [];
  if (Array.isArray(p.characterPrompts)) {
    for (const c of p.characterPrompts) {
      if (!c || typeof c !== 'object') continue;
      const prompt = String(c.prompt || c.char_caption || '').trim();
      if (!prompt) continue;
      out.push({
        prompt,
        uc: String(c.uc || ''),
        x: coord(c.center?.x ?? c.centers?.[0]?.x),
        y: coord(c.center?.y ?? c.centers?.[0]?.y),
      });
    }
  } else if (Array.isArray(p.v4_prompt?.caption?.char_captions)) {
    for (const c of p.v4_prompt.caption.char_captions) {
      const prompt = String(c?.char_caption || '').trim();
      if (!prompt) continue;
      out.push({
        prompt,
        uc: '',
        x: coord(c.centers?.[0]?.x),
        y: coord(c.centers?.[0]?.y),
      });
    }
  }
  return out;
}

/**
 * 柏宝绘 / 官方 POST /ai/generate-image 体 → 本站 applyPolicy 请求。
 * 质量词与 UC 已由客户端拼进 input / negative_prompt，不再套本站预设。
 */
function officialToSiteRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '请求必须是对象' };
  }
  const parameters = body.parameters && typeof body.parameters === 'object' ? body.parameters : {};
  const prompt = String(body.input || parameters.v4_prompt?.caption?.base_caption || '').trim();
  const uc = String(parameters.negative_prompt || parameters.uc || '');
  const action = String(body.action || 'generate');
  const req = {
    prompt,
    model: body.model,
    uc,
    width: parameters.width,
    height: parameters.height,
    steps: parameters.steps,
    scale: parameters.scale,
    sampler: parameters.sampler,
    noiseSchedule: parameters.noise_schedule,
    seed: parameters.seed,
    nSamples: parameters.n_samples || 1,
    cfgRescale: parameters.cfg_rescale,
    qualityTags: false,
    ucPreset: 'none',
    charPrompts: charFromOfficial(parameters),
  };
  if (action === 'img2img' && parameters.image) {
    req.img2img = {
      image: String(parameters.image),
      strength: parameters.strength,
      noise: parameters.noise,
    };
  }
  if (action === 'infill' && parameters.image) {
    req.inpaint = {
      image: String(parameters.image),
      mask: parameters.mask,
      strength: parameters.inpaintImg2ImgStrength ?? parameters.strength,
      addOriginalImage: parameters.add_original_image,
    };
  }
  return { ok: true, body: req };
}

function fakeOpusSubscription() {
  const expiresAt = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  return {
    tier: 3,
    active: true,
    expiresAt,
    perks: {
      unlimitedImageGeneration: true,
      unlimitedImageGenerationLimits: [{ resolution: 1048576, maxPrompts: 28 }],
    },
    trainingStepsLeft: { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 0 },
    subscription: { tier: 3, active: true, expiresAt },
  };
}

module.exports = { officialToSiteRequest, fakeOpusSubscription, charFromOfficial };
