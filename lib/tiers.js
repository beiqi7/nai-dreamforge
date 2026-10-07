'use strict';
/**
 * lib/tiers.js — 用户等级：默认等级与管理端输入校验
 *
 * 等级只作用于普通用户（role = 'user'）；管理员不受等级约束。
 * 限额字段为 NULL 表示不限；anlas_per_day = 0 表示只能使用 0 Anlas 的免费参数。
 */

const MAX_DIM = 1536;
const MAX_PIXELS = MAX_DIM * MAX_DIM;

/** 首次启动时写入的默认等级；“普通用户”与此前硬编码的免费层规则完全一致 */
const DEFAULT_TIERS = [
  {
    name: '普通用户', sort: 0, is_default: 1,
    max_pixels: 1024 * 1024, max_steps: 28, max_samples: 1,
    allow_img2img: 0, allow_inpaint: 0,
    limit_per_minute: 6, limit_per_hour: 66, limit_per_day: 240,
    anlas_per_day: 0,
  },
  {
    name: '高级用户', sort: 10, is_default: 0,
    max_pixels: 1024 * 1536, max_steps: 40, max_samples: 4,
    allow_img2img: 1, allow_inpaint: 1,
    limit_per_minute: 10, limit_per_hour: 150, limit_per_day: 600,
    anlas_per_day: 300,
  },
];

const FREE_TIER = DEFAULT_TIERS[0];

const INT_FIELDS = {
  max_pixels: [64 * 64, MAX_PIXELS],
  max_steps: [1, 50],
  max_samples: [1, 8],
  anlas_per_day: [0, 1_000_000],
  sort: [-100_000, 100_000],
};
const NULLABLE_FIELDS = { limit_per_minute: 100_000, limit_per_hour: 100_000, limit_per_day: 1_000_000 };
const BOOL_FIELDS = ['allow_img2img', 'allow_inpaint'];

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

/**
 * 校验管理端提交的等级字段。partial=true 时只校验出现的字段（用于修改）。
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
function parseTierInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: '请求格式错误' };
  const value = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 20) return { ok: false, error: '等级名称须为 1–20 个字符' };
    value.name = name;
  }
  for (const [field, [min, max]] of Object.entries(INT_FIELDS)) {
    if (body[field] === undefined) {
      if (!partial && field !== 'sort') return { ok: false, error: `缺少字段 ${field}` };
      continue;
    }
    const n = Number(body[field]);
    if (!Number.isInteger(n) || n < min || n > max) return { ok: false, error: `${field} 须为 ${min}–${max} 的整数` };
    value[field] = n;
  }
  for (const [field, max] of Object.entries(NULLABLE_FIELDS)) {
    if (body[field] === undefined) {
      if (!partial) value[field] = null;
      continue;
    }
    if (isBlank(body[field])) { value[field] = null; continue; }
    const n = Number(body[field]);
    if (!Number.isInteger(n) || n < 0 || n > max) return { ok: false, error: `${field} 须为空（不限）或 0–${max} 的整数` };
    value[field] = n;
  }
  for (const field of BOOL_FIELDS) {
    if (body[field] === undefined) {
      if (!partial) value[field] = 0;
      continue;
    }
    if (typeof body[field] !== 'boolean' && body[field] !== 0 && body[field] !== 1) return { ok: false, error: `${field} 须为布尔值` };
    value[field] = body[field] ? 1 : 0;
  }
  return { ok: true, value };
}

/** 单个用户的覆盖额度：空 = 跟随等级；否则为非负整数 */
function parseOverride(raw, max) {
  if (isBlank(raw)) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) return { ok: false, error: `须为空（跟随等级）或 0–${max} 的整数` };
  return { ok: true, value: n };
}

module.exports = { DEFAULT_TIERS, FREE_TIER, MAX_DIM, MAX_PIXELS, parseTierInput, parseOverride };
