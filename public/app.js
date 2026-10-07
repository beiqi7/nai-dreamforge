'use strict';
/* NovelAI Web Studio 前端交互逻辑 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let CURRENT_ROLE = 'user';
let ME = null;          // { id, username, role }
let META = null;        // /api/models
let lastGen = null;
let resultAlbum = { urls: [], seeds: [], idx: 0, width: 0, height: 0 };
let currentMode = 'txt2img'; // 'txt2img' | 'inpaint' | 'img2img'
let selectedRecord = null;   // 灯箱当前记录

/* ─── Toast ─────────────────────────── */
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast-chip' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

/* ─── API 请求 ──────────────────────── */
async function api(path, opts = {}) {
  const controller = new AbortController();
  const timeoutMs = opts.timeout || 180000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...opts,
    });
    let j = {};
    try { j = await res.json(); } catch {}
    if (!res.ok) throw new Error(j.error || `请求失败 (HTTP ${res.status})`);
    return j;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('请求超时，请检查网络或稍后重试');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── 启动入口 ──────────────────────── */
window.addEventListener('DOMContentLoaded', async () => {
  try {
    ME = await api('/api/me');
    CURRENT_ROLE = ME?.role || 'user';
    showMain();
  } catch {
    CURRENT_ROLE = 'user';
    $('authView').classList.remove('hidden');
  }
  $('loginForm').addEventListener('submit', onLogin);
  $('logoutBtn').addEventListener('click', onLogout);
});

async function onLogin(e) {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    const j = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('loginUser').value.trim(), password: $('loginPass').value }),
    });
    ME = await api('/api/me');
    CURRENT_ROLE = ME?.role || 'user';
    showMain();
    toast(`欢迎归来，${j.username}`);
  } catch (err) {
    $('loginErr').textContent = err.message;
  }
}

async function onLogout() {
  CURRENT_ROLE = 'user';
  ME = null;
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

async function showMain() {
  $('authView').classList.add('hidden');
  $('mainView').classList.remove('hidden');

  updateUserBadge();

  if (ME.role === 'admin') {
    $('adminOpenBtn').classList.remove('hidden');
    $('comicStudioNavBtn')?.classList.remove('hidden');
  }
  renderQuota();

  await loadMeta();
  bindModeTabs();
  bindGenerator();
  bindSizeStepsFold();
  bindMetaLearn();
  bindInpaintModule();
  bindImg2imgModule();
  bindCharPrompts();
  bindProfileModal();
  bindPromptLibrary();
  bindLightbox();
  bindHistoryGrid();
  loadHistory();
  bindViewNavigation();
  bindDedicatedGallery();

  if (ME.role === 'admin') {
    bindAdminModal();
    bindPoolViews();
    bindComicStudio();
    loadPoolBadge();
  }
}

function updateUserBadge() {
  $('userBadge').textContent = ME.username;
  const tierPill = $('userTierPill');
  if (tierPill) {
    tierPill.textContent = caps().name;
    tierPill.className = 'user-tier-pill' + (ME.role === 'admin' ? ' admin' : '');
  }
  const avatar = $('userAvatar');
  if (avatar) avatar.textContent = Array.from(ME.username || '?')[0].toUpperCase();
}

/* ─── 当前用户能力：管理员不限；普通用户取所在等级（/api/me 的 quota.tier） ─── */
const FREE_CAPS = {
  name: '普通用户', maxPixels: 1048576, maxSteps: 28, maxSamples: 1,
  allowImg2img: false, allowInpaint: false, perMinute: 6, perHour: 66, perDay: 240, anlasPerMonth: 0,
};
function caps() {
  if (ME?.role === 'admin') {
    return { admin: true, name: '管理员', maxPixels: 1536 * 1536, maxSteps: 50, maxSamples: 8, allowImg2img: true, allowInpaint: true, anlasPerMonth: Infinity };
  }
  return { admin: false, ...FREE_CAPS, ...(ME?.quota?.tier || {}) };
}

/** 生成后刷新额度用量（管理员不受额度约束，跳过） */
async function refreshQuota() {
  if (!ME || ME.role === 'admin') return;
  try {
    const me = await api('/api/me');
    ME.quota = me.quota;
    renderQuota();
    updateAnlasEstimate();
  } catch {}
}

function fmtLimit(n) {
  return n == null ? '不限' : String(n);
}

/** 生成按钮上方的额度面板：等级名、频率限制、24 小时出图与 Anlas 用量条 */
function renderQuota() {
  const panel = $('quotaPanel');
  if (!panel) return;
  if (!ME || ME.role === 'admin') {
    panel.classList.add('hidden');
    return;
  }
  const c = caps();
  const usage = ME.quota?.usage || { day: 0, anlasMonth: 0 };
  panel.classList.remove('hidden');
  $('quotaTierName').textContent = c.name;
  const rate = [c.perMinute != null ? `${c.perMinute}/分` : null, c.perHour != null ? `${c.perHour}/时` : null].filter(Boolean);
  $('quotaRate').textContent = rate.length ? `限速 ${rate.join(' · ')}` : '不限速';
  const setBar = (barId, txtId, used, max) => {
    const ratio = max == null ? 0 : max === 0 ? 1 : Math.min(1, used / max);
    const bar = $(barId);
    bar.style.width = `${Math.round(ratio * 100)}%`;
    bar.classList.toggle('warn', ratio >= 0.8 && ratio < 1);
    bar.classList.toggle('full', ratio >= 1);
    $(txtId).textContent = `${used} / ${fmtLimit(max)}`;
  };
  setBar('quotaDayBar', 'quotaDayTxt', usage.day, c.perDay);
  const anlasRow = $('quotaAnlasRow');
  if (c.anlasPerMonth > 0) {
    anlasRow.classList.remove('hidden');
    setBar('quotaAnlasBar', 'quotaAnlasTxt', usage.anlasMonth, c.anlasPerMonth);
  } else {
    anlasRow.classList.add('hidden');
  }
  $('quotaCaps').textContent = [
    `≤${Number((c.maxPixels / 1048576).toFixed(2))}MP`,
    `≤${c.maxSteps} 步`,
    c.maxSamples > 1 ? `单次 ≤${c.maxSamples} 张` : '单张',
    c.anlasPerMonth > 0 ? `每月 ${c.anlasPerMonth} Anlas` : '仅免费参数',
  ].join(' · ');
}

/* ─── 元数据加载 ────────────────────── */
async function loadMeta() {
  META = await api('/api/models');

  const msel = $('modelSel');
  msel.innerHTML = '';
  for (const [id, m] of Object.entries(META.models)) {
    if (m.inpaintOnly) continue;
    const o = document.createElement('option');
    o.value = id;
    o.textContent = m.label;
    msel.appendChild(o);
  }
  msel.value = 'nai-diffusion-5-full';


  const samsel = $('samplerSel');
  samsel.innerHTML = '';
  for (const s of META.samplers) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    samsel.appendChild(o);
  }
  samsel.value = 'k_euler';

  applyRoleRestrictions();
}

/* ─── 等级限额下的尺寸与步数约束 ─────────────── */
function withinPixelCap(w, h) {
  return (Number(w) || 0) * (Number(h) || 0) <= caps().maxPixels;
}

function align64(n) {
  return Math.max(64, Math.round((Number(n) || 64) / 64) * 64);
}

function clampToCaps(showToast = true) {
  const c = caps();
  if (c.admin) return;
  const maxPixels = c.maxPixels;
  const wInp = $('widthInp');
  const hInp = $('heightInp');
  if (!wInp || !hInp) return;
  let w = align64(wInp.value);
  let h = align64(hInp.value);
  if (w * h > maxPixels) {
    // 按比例下压且 64 对齐，确保乘积不超过等级上限
    const scale = Math.sqrt(maxPixels / (w * h));
    w = Math.max(64, Math.floor((w * scale) / 64) * 64);
    h = Math.max(64, Math.floor((h * scale) / 64) * 64);
    while (w * h > maxPixels && (w > 64 || h > 64)) {
      if (w >= h && w > 64) w -= 64;
      else if (h > 64) h -= 64;
      else break;
    }
    wInp.value = w;
    hInp.value = h;
    if (showToast) {
      toast(`「${c.name}」分辨率上限 ${Number((maxPixels / 1048576).toFixed(2))}MP`, true);
    }
  } else {
    wInp.value = w;
    hInp.value = h;
  }
  // 步数也同步确保不超过等级上限
  const stepsInp = $('stepsInp');
  if (stepsInp && +stepsInp.value > c.maxSteps) {
    stepsInp.value = c.maxSteps;
  }
  syncRatioChips();
}

function onDimInput(changedAxis) {
  if (!caps().admin) {
    const w = +$('widthInp').value || 0;
    const h = +$('heightInp').value || 0;
    if (!withinPixelCap(w, h)) {
      clampToCaps(true);
    } else {
      syncRatioChips();
    }
  } else {
    syncRatioChips();
  }
  updateAnlasEstimate();
}

function onDimChange(changedAxis) {
  if (!caps().admin) {
    clampToCaps(true);
  } else {
    $('widthInp').value = align64($('widthInp').value);
    $('heightInp').value = align64($('heightInp').value);
    syncRatioChips();
  }
  updateAnlasEstimate();
}

function syncRatioChips() {
  const curW = +$('widthInp')?.value || 0;
  const curH = +$('heightInp')?.value || 0;
  document.querySelectorAll('.ratio-chip').forEach((chip) => {
    const cw = +chip.dataset.w;
    const ch = +chip.dataset.h;
    if (cw === curW && ch === curH && !chip.disabled) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

function applyRoleRestrictions() {
  const c = caps();
  const chips = document.querySelectorAll('.ratio-chip');
  const wInp = $('widthInp');
  const hInp = $('heightInp');
  const stepsInp = $('stepsInp');
  const nSamplesSel = $('nSamplesSel');
  $('anlasBtn')?.classList.toggle('hidden', !c.admin);

  if (stepsInp) {
    stepsInp.max = c.maxSteps;
    if (+stepsInp.value > c.maxSteps) stepsInp.value = c.maxSteps;
  }
  if (wInp) wInp.max = 1536; // 单边上限固定，整体由等级的像素总数约束
  if (hInp) hInp.max = 1536;

  // 1. 超出等级像素上限的预设画幅禁用
  chips.forEach((chip) => {
    const allowed = withinPixelCap(+chip.dataset.w, +chip.dataset.h);
    chip.disabled = !allowed;
    chip.classList.toggle('disabled', !allowed);
    if (allowed) chip.removeAttribute('title');
    else chip.title = `「${c.name}」不可用（超出分辨率上限）`;
  });

  // 2. 张数：按等级上限开放选项
  if (nSamplesSel) {
    Array.from(nSamplesSel.options).forEach((opt) => {
      const allowed = +opt.value <= c.maxSamples;
      opt.disabled = !allowed;
      if (allowed) opt.removeAttribute('title');
      else opt.title = `「${c.name}」单次最多 ${c.maxSamples} 张`;
    });
    if (+nSamplesSel.value > c.maxSamples) nSamplesSel.value = '1';
    nSamplesSel.options[0].textContent = c.admin ? '1 张（免费层）' : '1 张';
  }
  $('nSamplesWrap')?.classList.toggle('hidden', c.maxSamples <= 1);

  // 3. 图生图 / 局部重绘入口：等级未开放时锁定
  const lockTab = (el, allowed, label) => {
    if (!el) return;
    el.classList.toggle('locked', !allowed);
    el.title = allowed ? '' : `「${c.name}」未开放${label}`;
  };
  lockTab($('modeTabInpaint'), c.allowInpaint, '局部重绘');
  lockTab($('modeTabImg2img'), c.allowImg2img, '图生图');
  $('inpaintBtn')?.classList.toggle('hidden', !c.allowInpaint);
  $('sendToI2iBtn')?.classList.toggle('hidden', !c.allowImg2img);

  // 4. 当前尺寸若越界，回落到默认 2:3 人像档位（再按上限压回）
  if (wInp && hInp && !withinPixelCap(+wInp.value, +hInp.value)) {
    wInp.value = 832;
    hInp.value = 1216;
    clampToCaps(false);
  }

  syncRatioChips();
  updateAnlasEstimate();
}
/* ─── 模式切换 ──────────────────────── */
function bindModeTabs() {
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      const c = caps();
      if ((mode === 'inpaint' && !c.allowInpaint) || (mode === 'img2img' && !c.allowImg2img)) {
        toast(`当前等级「${c.name}」未开放${mode === 'inpaint' ? '局部重绘' : '图生图'}，可联系管理员升级`, true);
        return;
      }
      document.querySelectorAll('.mode-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = mode;

      $('inpaintWorkspace').classList.toggle('hidden', mode !== 'inpaint');
      $('img2imgWorkspace').classList.toggle('hidden', mode !== 'img2img');

      if (mode === 'inpaint') {
        $('genBtn').querySelector('.btn-main-text').textContent = '执行局部重绘 (Inpaint)';
      } else if (mode === 'img2img') {
        $('genBtn').querySelector('.btn-main-text').textContent = '执行图生图 (Img2Img)';
      } else {
        $('genBtn').querySelector('.btn-main-text').textContent = '生成图片';
      }

      updateAnlasEstimate();
    });
  });
}

/* ─── 生成器主逻辑 ──────────────────── */
function bindGenerator() {
  ['scaleInp'].forEach((id) => $(id).addEventListener('input', updateAnlasEstimate));
  $('stepsInp').addEventListener('input', () => {
    const c = caps();
    if (+$('stepsInp').value > c.maxSteps) {
      $('stepsInp').value = c.maxSteps;
      toast(`「${c.name}」步数上限为 ${c.maxSteps} 步`, true);
    }
    updateAnlasEstimate();
  });
  $('widthInp').addEventListener('input', () => onDimInput('width'));
  $('heightInp').addEventListener('input', () => onDimInput('height'));
  $('widthInp').addEventListener('change', () => onDimChange('width'));
  $('heightInp').addEventListener('change', () => onDimChange('height'));
  // 快捷标签点击追加
  document.querySelectorAll('.tag-capsules .capsule').forEach((cap) => {
    cap.addEventListener('click', () => {
      const tag = cap.dataset.tag;
      const inp = $('promptInp');
      const val = inp.value.trim();
      if (!val) inp.value = tag;
      else if (!val.includes(tag)) inp.value = val + ', ' + tag;
      inp.focus();
      toast(`已追加标签：${tag}`);
    });
  });
  // 提示词字符数动态统计
  const updatePromptCount = () => {
    const len = $('promptInp').value.trim().length;
    if ($('promptCharCount')) $('promptCharCount').textContent = `${len} 字符`;
  };
  $('promptInp').addEventListener('input', updatePromptCount);
  updatePromptCount();

  // 清空提示词
  $('clearPromptBtn')?.addEventListener('click', () => {
    if ($('promptInp').value && confirm('确定清空当前提示词吗？')) {
      $('promptInp').value = '';
      updatePromptCount();
      toast('提示词已清空');
    }
  });

  // 格式化提示词
  $('formatPromptBtn')?.addEventListener('click', () => {
    let val = $('promptInp').value;
    if (!val.trim()) return;
    val = val.replace(/，/g, ',');
    const lines = val.split('\n').map(line => {
      return line.split(',').map(t => t.trim()).filter(Boolean).join(', ');
    });
    $('promptInp').value = lines.join('\n');
    updatePromptCount();
    toast('提示词格式已整理');
  });

  // Ctrl+Enter / Command+Enter 快捷生图
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (document.querySelector('.modal-backdrop:not(.hidden)')) return;
      e.preventDefault();
      doGenerate();
    }
  });

  // 画幅比例卡尺
  document.querySelectorAll('.ratio-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.disabled || chip.classList.contains('disabled')) return;
      document.querySelectorAll('.ratio-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      $('widthInp').value = chip.dataset.w;
      $('heightInp').value = chip.dataset.h;
      updateAnlasEstimate();
    });
  });

  $('nSamplesSel').addEventListener('change', updateAnlasEstimate);
  $('keyFanoutChk')?.addEventListener('change', updateAnlasEstimate);

  $('genBtn').addEventListener('click', doGenerate);
  $('resultPrev')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showResultAt(resultAlbum.idx - 1);
  });
  $('resultNext')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showResultAt(resultAlbum.idx + 1);
  });
  document.addEventListener('keydown', (e) => {
    if ($('resultNav')?.classList.contains('hidden')) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      showResultAt(resultAlbum.idx - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      showResultAt(resultAlbum.idx + 1);
    }
  });

  $('dlBtn').addEventListener('click', () => {
    if (!lastGen?.image) return;
    const a = document.createElement('a');
    a.href = lastGen.image;
    a.download = `nai-${lastGen.seed}.png`;
    a.click();
  });
  // 复制当前成图提示词
  $('copyPromptDirectBtn')?.addEventListener('click', async () => {
    const prompt = lastGen?.raw?.prompt || $('promptInp').value;
    if (!prompt) return toast('当前没有可复制的提示词', true);
    try {
      await navigator.clipboard.writeText(prompt);
      toast('提示词已复制');
    } catch {
      toast('复制失败', true);
    }
  });

  // 送入图生图
  $('sendToI2iBtn')?.addEventListener('click', () => {
    if (!lastGen?.image) return;
    const tab = document.querySelector('.mode-tab[data-mode="img2img"]');
    if (tab && !tab.classList.contains('disabled')) {
      tab.click();
      loadI2iImageFromUrl(lastGen.image);
      toast('已载入图生图参考');
    }
  });

  $('seedBtn').addEventListener('click', () => {
    if (lastGen?.seed) {
      $('seedInp').value = lastGen.seed;
      toast(`已复用种子 ${lastGen.seed}`);
    }
  });

  $('reuseAllBtn').addEventListener('click', () => {
    if (lastGen?.raw) reuseAllParams(lastGen.raw);
    else toast('暂无可用参数', true);
  });

  // 点击预览图唤起灯箱
  $('resultImg').addEventListener('click', () => {
    if (lastGen?.raw) openLightbox(lastGen.raw);
    else if (lastGen?.image) {
      openLightbox({
        file: lastGen.image.replace('/img/', ''),
        prompt: $('promptInp').value,
        uc: $('ucInp').value,
        model: $('modelSel').value,
        width: +$('widthInp').value,
        height: +$('heightInp').value,
        steps: +$('stepsInp').value,
        seed: lastGen.seed,
        charPrompts: lastGen.charPrompts || [],
      });
    }
  });

  $('histRefresh').addEventListener('click', loadHistory);

  updateAnlasEstimate();
}

function updateAnlasEstimate() {
  $('stepsVal').textContent = $('stepsInp').value;
  $('scaleVal').textContent = Number($('scaleInp').value).toFixed(1);

  const w = +$('widthInp').value, h = +$('heightInp').value;
  const area = w * h;

  const c = caps();
  if (!c.admin && area > c.maxPixels) {
    $('sizeWarn').textContent = `⚠ 总像素 ${area} 超出「${c.name}」上限 ${c.maxPixels}`;
    $('sizeWarn').classList.remove('hidden');
  } else {
    $('sizeWarn').classList.add('hidden');
  }

  const steps = +$('stepsInp').value;
  const nSamples = Math.min(+$('nSamplesSel').value || 1, c.maxSamples);
  const isV5 = $('modelSel').value.startsWith('nai-diffusion-5');

  const isFreeSize = area <= 1048576 && steps <= 28;
  const singleFree = isV5 ? isFreeSize : (isFreeSize && currentMode === 'txt2img');
  const wantFanout = CURRENT_ROLE === 'admin' && nSamples > 1 && !!$('keyFanoutChk')?.checked;
  const canFanout = wantFanout && singleFree;
  if ($('keyFanoutWrap')) {
    $('keyFanoutWrap').classList.toggle('hidden', CURRENT_ROLE !== 'admin' || nSamples <= 1);
    $('keyFanoutChk').disabled = nSamples > 1 && !singleFree;
  }
  const free = (singleFree && nSamples === 1) || canFanout;

  let est = 0;
  if (!free) {
    let base = Math.ceil(2.951823174884865e-6 * area + 5.753298233447344e-7 * area * steps);
    if (isV5) base = Math.ceil(base * 1.5);
    const per = Math.max(base, 2);
    const billable = isFreeSize ? Math.max(nSamples - 1, 0) : nSamples;
    est = per * billable;
  }

  const badge = $('tierBadge');
  badge.classList.remove('hidden');
  badge.className = 'tier-tag ' + (free ? 'free' : 'paid');
  if (canFanout) {
    badge.textContent = `多 Key 轮询 ×${nSamples} · 0 Anlas`;
    $('anlasHint').textContent = `预计 0 Anlas · ${nSamples} 把密钥并行`;
  } else {
    badge.textContent = free ? '免费 · 0 Anlas' : `计费 · 约 ${est} Anlas`;
    $('anlasHint').textContent = free ? '预计 0 Anlas（Opus 免费规格）' : `预计约 ${est} Anlas`;
    if (!c.admin && !free) {
      const left = c.anlasPerMonth - (ME?.quota?.usage?.anlasMonth || 0);
      if (c.anlasPerMonth <= 0) {
        badge.className = 'tier-tag over';
        badge.textContent = '当前等级仅支持免费参数';
      } else {
        $('anlasHint').textContent = `预计约 ${est} Anlas · 本月剩余 ${Math.max(0, left)}`;
        if (est > left) badge.className = 'tier-tag over';
      }
    }
  }
  updateSizeStepsSummary();
}

function updateSizeStepsSummary() {
  const el = $('sizeStepsSummary');
  if (!el) return;
  const w = +$('widthInp')?.value || 0;
  const h = +$('heightInp')?.value || 0;
  const steps = +$('stepsInp')?.value || 0;
  const cfg = Number($('scaleInp')?.value || 0).toFixed(1);
  el.textContent = `${w}×${h} · ${steps}步 · CFG ${cfg}`;
}

function bindFoldCard(cardId, headId, storageKey, defaultCollapsed = true) {
  const card = $(cardId);
  const head = $(headId);
  if (!card || !head) return;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === '0') card.classList.remove('collapsed');
    else if (saved === '1' || (saved == null && defaultCollapsed)) card.classList.add('collapsed');
    else card.classList.remove('collapsed');
  } catch {
    if (defaultCollapsed) card.classList.add('collapsed');
  }
  head.addEventListener('click', (e) => {
    if (e.target.closest('input, select, button, textarea')) return;
    card.classList.toggle('collapsed');
    try {
      localStorage.setItem(storageKey, card.classList.contains('collapsed') ? '1' : '0');
    } catch { /* ignore */ }
  });
}

function bindSizeStepsFold() {
  bindFoldCard('sizeStepsCard', 'sizeStepsHead', 'nai-size-steps-collapsed', true);
  updateSizeStepsSummary();
}
async function doGenerate() {
  const btn = $('genBtn');
  const st = $('genStatus');
  const scan = $('scanBar');

  btn.disabled = true;
  scan.classList.remove('hidden');
  st.className = 'console-status';
  const nSamples = Math.min(+$('nSamplesSel').value || 1, caps().maxSamples);
  const areaNow = (+$('widthInp').value || 0) * (+$('heightInp').value || 0);
  const stepsNow = +$('stepsInp').value;
  const singleFreeNow = areaNow <= 1048576 && stepsNow <= 28 && ($('modelSel').value.startsWith('nai-diffusion-5') || currentMode === 'txt2img');
  const useFanout = CURRENT_ROLE === 'admin' && nSamples > 1 && !!$('keyFanoutChk')?.checked && singleFreeNow;
  st.textContent = useFanout
    ? `多 Key 轮询出图中（${nSamples} 张并行）…`
    : '正在请求 NovelAI 绘图中… (约 2-8 秒)';
  const prevStrip = $('batchStrip');
  if (prevStrip) {
    prevStrip.classList.add('hidden');
    prevStrip.innerHTML = '';
  }

    clampToCaps(false);
  try {
    const body = {
      model: $('modelSel').value,
      prompt: $('promptInp').value,
      uc: $('ucInp').value,
      width: +$('widthInp').value,
      height: +$('heightInp').value,
      steps: +$('stepsInp').value,
      scale: +$('scaleInp').value,
      sampler: $('samplerSel').value,
      noiseSchedule: 'karras',
      ucPreset: $('ucPresetSel').value,
      qualityTags: $('qualityChk').checked,
      seed: $('seedInp').value ? +$('seedInp').value : undefined,
      nSamples,
    };
    if (useFanout) body.keyFanout = true;

    if (currentMode === 'inpaint') {
      const payload = getInpaintPayload();
      if (!payload) {
        btn.disabled = false;
        scan.classList.add('hidden');
        st.textContent = '';
        return;
      }
      body.inpaint = payload;
    } else if (currentMode === 'img2img') {
      const payload = getImg2imgPayload();
      if (!payload) {
        btn.disabled = false;
        scan.classList.add('hidden');
        st.textContent = '';
        return;
      }
      body.img2img = payload;
    }

    // 独立角色 (Character Prompts) 在所有模式下只要配置并填写了提示词均可生效透传
    const chars = CHARS.filter(c => c && typeof c.prompt === 'string' && c.prompt.trim());
    if (chars.length) {
      body.charPrompts = chars.map(c => ({
        prompt: c.prompt.trim(),
        uc: String(c.uc || '').trim(),
        x: typeof c.x === 'number' && !isNaN(c.x) ? +c.x.toFixed(3) : null,
        y: typeof c.y === 'number' && !isNaN(c.y) ? +c.y.toFixed(3) : null,
      }));
    }

    const j = await api('/api/generate', { method: 'POST', body: JSON.stringify(body) });
    lastGen = j;
    lastGen.raw = {
      file: String(j.image || '').replace('/img/', ''),
      prompt: body.prompt,
      uc: body.uc,
      model: j.model || body.model,
      width: j.width,
      height: j.height,
      steps: body.steps,
      scale: body.scale,
      sampler: body.sampler,
      seed: j.seed,
      charPrompts: body.charPrompts || [],
    };


    setResultAlbum(j);
    const fanoutNote = j.fanout ? ` · 轮询 ${j.okCount}/${j.requested}` : '';
    $('metaInfo').textContent = `${j.width}×${j.height} · seed ${j.seed} · ${j.freeTier ? '免费层' : j.anlas + ' Anlas'} · ${(j.duration_ms / 1000).toFixed(1)}s${fanoutNote}`;
    st.className = 'console-status ok';
    const failNote = j.failed ? `，${j.failed} 张失败` : '';
    st.textContent = j.fanout
      ? `✓ 多 Key 轮询完成 ${j.okCount}/${j.requested} 张 (耗时 ${(j.duration_ms / 1000).toFixed(1)} 秒 · 0 Anlas)${failNote}`
      : `✓ 生成完成 (耗时 ${(j.duration_ms / 1000).toFixed(1)} 秒 · ${j.freeTier ? '免费规格' : '消耗 ' + j.anlas + ' Anlas'})`;
    loadHistory();
    refreshQuota();
  } catch (err) {
    st.className = 'console-status err';
    st.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
    scan.classList.add('hidden');
  }
}

function setResultAlbum(j) {
  const urls = Array.isArray(j?.images) && j.images.length
    ? j.images.filter(Boolean)
    : (j?.image ? [j.image] : []);
  const seeds = Array.isArray(j?.seeds) && j.seeds.length ? j.seeds : urls.map((_, i) => (i === 0 ? j?.seed : undefined));
  resultAlbum = { urls, seeds, idx: 0, width: j?.width, height: j?.height };
  renderBatchStrip();
  showResultAt(0);
}

function showResultAt(idx) {
  const urls = resultAlbum.urls || [];
  if (!urls.length) return;
  const n = urls.length;
  resultAlbum.idx = ((idx % n) + n) % n;
  const url = urls[resultAlbum.idx];
  const seed = resultAlbum.seeds[resultAlbum.idx];

  $('placeholder')?.classList.add('hidden');
  const img = $('resultImg');
  if (img) {
    img.src = url;
    img.classList.remove('hidden');
  }
  $('imgBar')?.classList.remove('hidden');

  if (lastGen) {
    lastGen.image = url;
    lastGen.seed = seed;
    if (lastGen.raw) {
      lastGen.raw.file = String(url).replace('/img/', '');
      lastGen.raw.seed = seed;
    }
  }

  const nav = $('resultNav');
  if (nav) {
    nav.classList.toggle('hidden', n < 2);
    if ($('resultNavIdx')) $('resultNavIdx').textContent = `${resultAlbum.idx + 1} / ${n}`;
  }

  $('batchStrip')?.querySelectorAll('.batch-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === resultAlbum.idx);
  });

  if ($('metaInfo')) {
    const page = n > 1 ? ` · 第 ${resultAlbum.idx + 1}/${n} 张` : '';
    $('metaInfo').textContent = `${resultAlbum.width}×${resultAlbum.height} · seed ${seed ?? '—'}${page}`;
  }
}

function renderBatchStrip() {
  const strip = $('batchStrip');
  if (!strip) return;
  const urls = resultAlbum.urls || [];
  if (urls.length < 2) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }
  strip.classList.remove('hidden');
  strip.innerHTML = '';
  urls.forEach((url, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `batch-thumb${idx === resultAlbum.idx ? ' active' : ''}`;
    btn.title = `第 ${idx + 1} 张`;
    const im = document.createElement('img');
    im.src = url;
    im.alt = `batch-${idx + 1}`;
    btn.appendChild(im);
    btn.addEventListener('click', () => showResultAt(idx));
    strip.appendChild(btn);
  });
}

/* ═════════════════════════════════════════════════════════════
   Inpaint 专属重绘工作台
   ═════════════════════════════════════════════════════════════ */
const IP_STATE = {
  img: null,
  maskCanvas: null,
  painting: false,
  lastPos: null,
};

function bindInpaintModule() {
  const dropzone = $('ipDropzone');
  const fileInput = $('ipFileInput');
  const cv = $('ipPaintCanvas');

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleInpaintFile(f);
    e.target.value = '';
  });

  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const f = e.dataTransfer?.files[0];
    if (f && f.type.startsWith('image/')) handleInpaintFile(f);
  });

  window.addEventListener('paste', (e) => {
    if (currentMode !== 'inpaint') return;
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        handleInpaintFile(it.getAsFile());
        toast('已通过剪贴板载入图片');
        break;
      }
    }
  });

  cv.addEventListener('pointerdown', (e) => {
    if (!IP_STATE.maskCanvas) return;
    IP_STATE.painting = true;
    IP_STATE.lastPos = null;
    drawMaskStroke(getCanvasPos(cv, e));
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (IP_STATE.painting) drawMaskStroke(getCanvasPos(cv, e));
  });
  cv.addEventListener('pointerup', () => { IP_STATE.painting = false; IP_STATE.lastPos = null; updateCoverage(); });
  cv.addEventListener('pointercancel', () => { IP_STATE.painting = false; IP_STATE.lastPos = null; });

  $('ipClearBtn').addEventListener('click', clearMask);
  $('ipReuploadBtn').addEventListener('click', () => fileInput.click());
  $('ipStrengthRange').addEventListener('input', () => {
    $('ipStrengthVal').textContent = Number($('ipStrengthRange').value).toFixed(2);
  });

  $('inpaintBtn').addEventListener('click', () => {
    if (!caps().allowInpaint) return toast(`当前等级「${caps().name}」未开放局部重绘`, true);
    $('modeTabInpaint').click();
    if (lastGen?.image) {
      loadInpaintImageFromUrl(lastGen.image);
    }
  });
}

function handleInpaintFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => loadInpaintImageFromUrl(e.target.result);
  reader.readAsDataURL(file);
}

function loadInpaintImageFromUrl(url) {
  const img = new Image();
  img.crossOrigin = 'same-origin';
  img.onload = () => {
    IP_STATE.img = img;
    setupInpaintCanvas();
    $('ipDropzone').classList.add('hidden');
    $('ipCanvasArea').classList.remove('hidden');
    toast(`原图已加载 (${img.naturalWidth}×${img.naturalHeight})`);
  };
  img.onerror = () => toast('原图加载失败', true);
  img.src = url;
}

function setupInpaintCanvas() {
  const cv = $('ipPaintCanvas');
  const w = IP_STATE.img.naturalWidth;
  const h = IP_STATE.img.naturalHeight;

  let tw = w, th = h;
  const area = w * h;
  if (area > 1048576) {
    const scale = Math.sqrt(1048576 / area);
    tw = Math.round(w * scale);
    th = Math.round(h * scale);
  }
  tw = Math.max(64, Math.round(tw / 64) * 64);
  th = Math.max(64, Math.round(th / 64) * 64);

  cv.width = tw;
  cv.height = th;

  IP_STATE.maskCanvas = document.createElement('canvas');
  IP_STATE.maskCanvas.width = tw;
  IP_STATE.maskCanvas.height = th;
  const mctx = IP_STATE.maskCanvas.getContext('2d');
  mctx.fillStyle = '#000000';
  mctx.fillRect(0, 0, tw, th);

  $('widthInp').value = tw;
  $('heightInp').value = th;
  updateAnlasEstimate();

  renderInpaintComposite();
  updateCoverage();
}

function getCanvasPos(cv, e) {
  const r = cv.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  return { x: cx * cv.width / r.width, y: cy * cv.height / r.height };
}

function drawMaskStroke(pos) {
  const mctx = IP_STATE.maskCanvas.getContext('2d');
  mctx.strokeStyle = '#ffffff';
  mctx.fillStyle = '#ffffff';
  mctx.lineWidth = +$('ipBrushSize').value * (IP_STATE.maskCanvas.width / $('ipPaintCanvas').getBoundingClientRect().width);
  mctx.lineCap = 'round';
  mctx.lineJoin = 'round';

  mctx.beginPath();
  if (IP_STATE.lastPos) {
    mctx.moveTo(IP_STATE.lastPos.x, IP_STATE.lastPos.y);
  } else {
    mctx.moveTo(pos.x - 0.5, pos.y);
  }
  mctx.lineTo(pos.x, pos.y);
  mctx.stroke();

  IP_STATE.lastPos = pos;
  renderInpaintComposite();
}

function clearMask() {
  if (!IP_STATE.maskCanvas) return;
  const mctx = IP_STATE.maskCanvas.getContext('2d');
  mctx.fillStyle = '#000000';
  mctx.fillRect(0, 0, IP_STATE.maskCanvas.width, IP_STATE.maskCanvas.height);
  renderInpaintComposite();
  updateCoverage();
  toast('已清空重绘区域');
}

function renderInpaintComposite() {
  if (!IP_STATE.img) return;
  const cv = $('ipPaintCanvas');
  const ctx = cv.getContext('2d');

  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(IP_STATE.img, 0, 0, cv.width, cv.height);

  const tmp = document.createElement('canvas');
  tmp.width = cv.width;
  tmp.height = cv.height;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(IP_STATE.maskCanvas, 0, 0);
  tctx.globalCompositeOperation = 'source-in';
  tctx.fillStyle = '#ec4899';
  tctx.fillRect(0, 0, tmp.width, tmp.height);

  ctx.globalAlpha = 0.5;
  ctx.drawImage(tmp, 0, 0);
  ctx.globalAlpha = 1;
}

function updateCoverage() {
  if (!IP_STATE.maskCanvas) return;
  const d = IP_STATE.maskCanvas.getContext('2d').getImageData(0, 0, IP_STATE.maskCanvas.width, IP_STATE.maskCanvas.height).data;
  let wCount = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 127) wCount++;
  }
  const pct = (wCount / (d.length / 4) * 100).toFixed(1);
  $('ipCoverageTxt').textContent = `重绘覆盖 ${pct}% (${IP_STATE.maskCanvas.width}×${IP_STATE.maskCanvas.height})`;
}

function getInpaintPayload() {
  if (!IP_STATE.img || !IP_STATE.maskCanvas) {
    toast('请先上传重绘原图', true);
    return null;
  }
  const d = IP_STATE.maskCanvas.getContext('2d').getImageData(0, 0, IP_STATE.maskCanvas.width, IP_STATE.maskCanvas.height).data;
  let hasWhite = false;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 127) { hasWhite = true; break; }
  }
  if (!hasWhite) {
    toast('请在原图上用笔刷涂出想要重绘的区域', true);
    return null;
  }


  const srcCv = document.createElement('canvas');
  srcCv.width = IP_STATE.maskCanvas.width;
  srcCv.height = IP_STATE.maskCanvas.height;
  srcCv.getContext('2d').drawImage(IP_STATE.img, 0, 0, srcCv.width, srcCv.height);

  return {
    image: srcCv.toDataURL('image/png').split(',')[1],
    mask: IP_STATE.maskCanvas.toDataURL('image/png').split(',')[1],
    strength: +$('ipStrengthRange').value,
    addOriginalImage: true,
  };
}

/* 兼容测试冒烟的别名引用 */
const ipSetupCanvas = setupInpaintCanvas;
const ipRender = renderInpaintComposite;
const ipGenerate = doGenerate;

/* ═════════════════════════════════════════════════════════════
   Img2Img 专属模块
   ═════════════════════════════════════════════════════════════ */
const I2I_STATE = { img: null, base64: null };

function bindImg2imgModule() {
  const dropzone = $('i2iDropzone');
  const fileInput = $('i2iFileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleI2iFile(f);
    e.target.value = '';
  });

  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const f = e.dataTransfer?.files[0];
    if (f && f.type.startsWith('image/')) handleI2iFile(f);
  });

  $('i2iRemoveBtn').addEventListener('click', () => {
    I2I_STATE.img = null;
    I2I_STATE.base64 = null;
    $('i2iPreviewArea').classList.add('hidden');
    $('i2iDropzone').classList.remove('hidden');
  });

  $('i2iStrengthRange').addEventListener('input', () => {
    $('i2iStrengthVal').textContent = Number($('i2iStrengthRange').value).toFixed(2);
  });
}

function handleI2iFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      I2I_STATE.img = img;
      I2I_STATE.base64 = e.target.result.split(',')[1];
      $('i2iPreviewImg').src = e.target.result;
      $('i2iDropzone').classList.add('hidden');
      $('i2iPreviewArea').classList.remove('hidden');

      let tw = img.naturalWidth, th = img.naturalHeight;
      const area = tw * th;
      if (area > 1048576) {
        const s = Math.sqrt(1048576 / area);
        tw = Math.round(tw * s);
        th = Math.round(th * s);
      }
      $('widthInp').value = Math.max(64, Math.round(tw / 64) * 64);
      $('heightInp').value = Math.max(64, Math.round(th / 64) * 64);
      updateAnlasEstimate();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function getImg2imgPayload() {
  if (!I2I_STATE.base64) {
    toast('请先上传原图', true);
    return null;
  }
  return {
    image: I2I_STATE.base64,
    strength: +$('i2iStrengthRange').value,
  };
}

/* ═════════════════════════════════════════════════════════════
   独立角色 (Character Prompts) 专属模块
   ═════════════════════════════════════════════════════════════ */
let CHARS = [];
let activeCharIndex = 0;

function bindCharPrompts() {
  const addBtn = $('charAddBtn');
  addBtn.addEventListener('click', () => {
    if (CHARS.length >= 22) {
      toast('最多支持 22 个角色', true);
      return;
    }
    CHARS.push({ prompt: '', uc: '', x: null, y: null });
    activeCharIndex = CHARS.length - 1;
    renderChars();
  });
  renderChars();
}

function renderChars() {
  const tabsWrap = $('charTabs');
  const wrap = $('charPromptsWrap');
  const countTag = $('charCountTag');

  if (CHARS.length === 0) {
    countTag.classList.add('hidden');
    countTag.textContent = '0/22';
    if (tabsWrap) tabsWrap.innerHTML = '';
    wrap.innerHTML = '';
    return;
  }

  countTag.classList.remove('hidden');
  countTag.textContent = `${CHARS.length}/22`;

  if (activeCharIndex >= CHARS.length) {
    activeCharIndex = CHARS.length - 1;
  }
  if (activeCharIndex < 0) {
    activeCharIndex = 0;
  }

  // 渲染横排 Tab 条
  if (tabsWrap) {
    tabsWrap.innerHTML = '';
    CHARS.forEach((_, i) => {
      const tab = document.createElement('div');
      tab.className = 'char-tab' + (i === activeCharIndex ? ' active' : '');

      const titleSpan = document.createElement('span');
      titleSpan.className = 'char-tab-txt';
      titleSpan.textContent = `角色 ${i + 1}`;
      tab.appendChild(titleSpan);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'char-tab-del';
      delBtn.title = '删除此角色';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        CHARS.splice(i, 1);
        if (activeCharIndex >= CHARS.length) {
          activeCharIndex = Math.max(0, CHARS.length - 1);
        }
        renderChars();
      });
      tab.appendChild(delBtn);

      tab.addEventListener('click', () => {
        if (activeCharIndex !== i) {
          activeCharIndex = i;
          renderChars();
        }
      });

      tabsWrap.appendChild(tab);
    });

    // 末尾固定「＋」Tab 添加新角色
    const plusTab = document.createElement('button');
    plusTab.type = 'button';
    plusTab.className = 'char-tab-plus';
    plusTab.title = '添加角色';
    plusTab.textContent = '＋';
    plusTab.addEventListener('click', () => {
      if (CHARS.length >= 22) {
        toast('最多支持 22 个角色', true);
        return;
      }
      CHARS.push({ prompt: '', uc: '', x: null, y: null });
      activeCharIndex = CHARS.length - 1;
      renderChars();
    });
    tabsWrap.appendChild(plusTab);
  }

  // 渲染当前激活角色的编辑面板
  wrap.innerHTML = '';
  const i = activeCharIndex;
  const c = CHARS[i];
  if (!c) return;

  const card = document.createElement('div');
  card.className = 'char-card';
  card.dataset.index = i;

  // 角色名称 + 模式切换 + 站位预设 + 删除
  const head = document.createElement('div');
  head.className = 'char-card-head';

  const name = document.createElement('span');
  name.className = 'char-name';
  name.textContent = `角色 ${i + 1} 编辑`;
  head.appendChild(name);

  const headControls = document.createElement('div');
  headControls.className = 'char-head-controls';

  // 自动 / 手动 模式切换
  const isAuto = c.x == null || c.y == null;
  const modeToggle = document.createElement('div');
  modeToggle.className = 'char-mode-toggle';

  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'char-mode-btn' + (isAuto ? ' active' : '');
  autoBtn.textContent = '自动';
  autoBtn.title = '模型自动安排站位 (x/y 为 null)';

  const manualBtn = document.createElement('button');
  manualBtn.type = 'button';
  manualBtn.className = 'char-mode-btn' + (!isAuto ? ' active' : '');
  manualBtn.textContent = '手动';
  manualBtn.title = '手动调整 X/Y 站位坐标';

  modeToggle.appendChild(autoBtn);
  modeToggle.appendChild(manualBtn);
  headControls.appendChild(modeToggle);

  const chips = document.createElement('div');
  chips.className = 'pos-chips' + (isAuto ? ' disabled' : '');
  const positions = [
    { label: '左', x: 0.25 },
    { label: '中', x: 0.5 },
    { label: '右', x: 0.75 },
  ];
  const chipBtns = positions.map(pos => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pos-chip' + (!isAuto && typeof c.x === 'number' && Math.abs(c.x - pos.x) < 0.01 ? ' active' : '');
    btn.textContent = pos.label;
    btn.title = `站位 x=${pos.x}`;
    chips.appendChild(btn);
    return { btn, x: pos.x };
  });
  headControls.appendChild(chips);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'char-del';
  delBtn.title = '删除此角色';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => {
    CHARS.splice(i, 1);
    if (activeCharIndex >= CHARS.length) {
      activeCharIndex = Math.max(0, CHARS.length - 1);
    }
    renderChars();
  });
  headControls.appendChild(delBtn);
  head.appendChild(headControls);
  card.appendChild(head);

  // Prompt textarea
  const pText = document.createElement('textarea');
  pText.className = 'char-inp';
  pText.rows = 2;
  pText.placeholder = '1girl, blonde hair, blue eyes, white dress';
  pText.value = c.prompt;
  pText.addEventListener('input', (e) => {
    CHARS[i].prompt = e.target.value;
  });
  card.appendChild(pText);

  // UC input
  const ucInp = document.createElement('input');
  ucInp.type = 'text';
  ucInp.className = 'char-inp';
  ucInp.placeholder = '该角色专属排除词 (选填)';
  ucInp.value = c.uc;
  ucInp.addEventListener('input', (e) => {
    CHARS[i].uc = e.target.value;
  });
  card.appendChild(ucInp);

  // 站位调节区域容器（Auto 时禁用置灰）
  const posSection = document.createElement('div');
  posSection.className = 'char-pos-section' + (isAuto ? ' disabled' : '');

  // X 滑杆行
  const currentX = typeof c.x === 'number' && !isNaN(c.x) ? c.x : 0.5;
  const xRow = document.createElement('div');
  xRow.className = 'char-pos-row';
  const xLbl = document.createElement('label');
  xLbl.textContent = 'X';
  const xRange = document.createElement('input');
  xRange.type = 'range';
  xRange.min = '0';
  xRange.max = '100';
  xRange.value = Math.round(currentX * 100);
  xRange.disabled = isAuto;
  const xVal = document.createElement('span');
  xVal.className = 'pos-val';
  xVal.textContent = isAuto ? '自动' : `${Math.round(currentX * 100)}%`;

  const updateX = (val) => {
    const num = +val;
    CHARS[i].x = num / 100;
    xVal.textContent = `${num}%`;
    chipBtns.forEach(({ btn, x }) => {
      btn.classList.toggle('active', Math.abs(CHARS[i].x - x) < 0.01);
    });
  };

  xRange.addEventListener('input', (e) => updateX(e.target.value));
  chipBtns.forEach(({ btn, x }) => {
    btn.addEventListener('click', () => {
      if (CHARS[i].x == null) return;
      xRange.value = Math.round(x * 100);
      updateX(xRange.value);
    });
  });

  xRow.appendChild(xLbl);
  xRow.appendChild(xRange);
  xRow.appendChild(xVal);
  posSection.appendChild(xRow);

  // Y 滑杆行
  const currentY = typeof c.y === 'number' && !isNaN(c.y) ? c.y : 0.5;
  const yRow = document.createElement('div');
  yRow.className = 'char-pos-row';
  const yLbl = document.createElement('label');
  yLbl.textContent = 'Y';
  const yRange = document.createElement('input');
  yRange.type = 'range';
  yRange.min = '0';
  yRange.max = '100';
  yRange.value = Math.round(currentY * 100);
  yRange.disabled = isAuto;
  const yVal = document.createElement('span');
  yVal.className = 'pos-val';
  yVal.textContent = isAuto ? '自动' : `${Math.round(currentY * 100)}%`;
  yRange.addEventListener('input', (e) => {
    const num = +e.target.value;
    CHARS[i].y = num / 100;
    yVal.textContent = `${num}%`;
  });
  yRow.appendChild(yLbl);
  yRow.appendChild(yRange);
  yRow.appendChild(yVal);
  posSection.appendChild(yRow);

  card.appendChild(posSection);

  // Auto / 手动 模式切换事件处理
  autoBtn.addEventListener('click', () => {
    if (CHARS[i].x === null && CHARS[i].y === null) return;
    CHARS[i].x = null;
    CHARS[i].y = null;
    renderChars();
  });

  manualBtn.addEventListener('click', () => {
    if (CHARS[i].x !== null && CHARS[i].y !== null) return;
    CHARS[i].x = 0.5;
    CHARS[i].y = 0.5;
    renderChars();
  });

  wrap.appendChild(card);
}

function parseCharPrompts(val) {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.filter(c => c && typeof c === 'object');
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed.filter(c => c && typeof c === 'object') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getRecordChars(rec) {
  if (!rec) return [];
  const raw = rec.charPrompts ?? rec.char_prompts;
  return parseCharPrompts(raw);
}

function applyCharPromptsToForm(charsToApply) {
  if (!Array.isArray(charsToApply) || !charsToApply.length) return false;
  CHARS = charsToApply.map(c => ({
    prompt: String(c.prompt || ''),
    uc: String(c.uc || ''),
    x: typeof c.x === 'number' && !isNaN(c.x) ? Math.max(0, Math.min(1, c.x)) : null,
    y: typeof c.y === 'number' && !isNaN(c.y) ? Math.max(0, Math.min(1, c.y)) : null,
  })).slice(0, 22);
  activeCharIndex = 0;
  renderChars();
  return true;
}

/* ═════════════════════════════════════════════════════════════
   大图灯箱预览 (Lightbox)
   ═════════════════════════════════════════════════════════════ */
function bindLightbox() {
  const modal = $('lightboxModal');
  const close = () => modal.classList.add('hidden');
  $('lightboxClose').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  // 完善大图缩放与拖拽交互（支持单击/双击切换、滚轮平滑缩放与鼠标任意抓取拖拽）
  bindLightboxImagePanZoom();

  $('lbReuseCharsBtn')?.addEventListener('click', () => {
    const chars = getRecordChars(selectedRecord);
    if (chars.length) {
      applyCharPromptsToForm(chars);
      close();
      toast(`已回填 ${chars.length} 个角色到独立角色面板`);
    } else {
      toast('该作品无角色参数', true);
    }
  });

  $('lbCopyPrompt').addEventListener('click', () => {
    if (selectedRecord?.prompt) {
      navigator.clipboard.writeText(selectedRecord.prompt);
      toast('Prompt 已复制到剪贴板');
    }
  });

  $('lbReuseBtn').addEventListener('click', () => {
    if (selectedRecord) {
      reuseAllParams(selectedRecord);
      close();
      toast('参数已回填到控制台');
    }
  });

  $('lbDelBtn').addEventListener('click', async () => {
    if (!selectedRecord?.id) return;
    if (!confirm('确定从云端删除该条历史记录吗？')) return;
    try {
      await api(`/api/history/${selectedRecord.id}`, { method: 'DELETE' });
      const removedId = selectedRecord.id;
      close();
      toast('记录已删除');
      loadHistory();
      if (galById.has(removedId)) {
        galCounts.all = Math.max(0, galCounts.all - 1);
        if (galById.get(removedId).is_favorited) galCounts.fav = Math.max(0, galCounts.fav - 1);
        updateGalCounts();
        removeGalleryItem(removedId);
      }
    } catch (e) { toast(e.message, true); }
  });

  $('lbFavBtn')?.addEventListener('click', async () => {
    if (!selectedRecord?.id) return;
    try {
      const next = !selectedRecord.is_favorited;
      await api(`/api/history/${selectedRecord.id}/favorite`, {
        method: 'POST',
        body: JSON.stringify({ favorited: next })
      });
      updateLbFavBtn(next);
      toast(next ? '已加入收藏 ❤️' : '已取消收藏 🤍');
      loadHistory();
      // 画廊里的记录可能与 selectedRecord 是同一对象，先比对再同步，计数才不会被跳过
      if (galById.has(selectedRecord.id)) applyGalleryFavorite(selectedRecord.id, next);
      selectedRecord.is_favorited = next;
    } catch (e) { toast(e.message, true); }
  });
  $('lbDlBtn')?.addEventListener('click', () => {
    if (!selectedRecord?.file) return;
    const a = document.createElement('a');
    a.href = `/img/${selectedRecord.file}`;
    a.download = `nai-${selectedRecord.seed || 'image'}.png`;
    a.click();
  });
}

let lbScale = 1;
let lbTranslateX = 0;
let lbTranslateY = 0;
let lbIsDragging = false;
let lbStartX = 0;
let lbStartY = 0;
let lbHasDragged = false;

function resetLightboxTransform() {
  lbScale = 1;
  lbTranslateX = 0;
  lbTranslateY = 0;
  lbIsDragging = false;
  lbHasDragged = false;
  const img = $('lightboxImg');
  if (img) {
    img.style.transform = 'translate3d(0px, 0px, 0px) scale(1)';
    img.classList.remove('dragging');
    img.style.cursor = 'zoom-in';
  }
}

function applyLightboxTransform() {
  const img = $('lightboxImg');
  if (!img) return;
  img.style.transform = `translate3d(${lbTranslateX}px, ${lbTranslateY}px, 0px) scale(${lbScale})`;
  img.style.cursor = lbScale > 1.05 ? 'grab' : 'zoom-in';
}

function bindLightboxImagePanZoom() {
  const img = $('lightboxImg');
  const pane = document.querySelector('.lightbox-img-pane');
  if (!img || !pane) return;

  // 1. 鼠标滚轮缩放
  pane.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.2 : 0.2;
    const newScale = Math.min(4.0, Math.max(0.8, lbScale + delta));
    if (newScale <= 1.02) {
      resetLightboxTransform();
    } else {
      lbScale = newScale;
      applyLightboxTransform();
    }
  }, { passive: false });

  // 2. 拖拽平移事件监听
  img.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 仅限左键
    e.preventDefault();
    e.stopPropagation();
    lbIsDragging = true;
    lbHasDragged = false;
    lbStartX = e.clientX - lbTranslateX;
    lbStartY = e.clientY - lbTranslateY;
    img.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!lbIsDragging) return;
    const currentX = e.clientX - lbStartX;
    const currentY = e.clientY - lbStartY;
    if (Math.abs(currentX - lbTranslateX) > 3 || Math.abs(currentY - lbTranslateY) > 3) {
      lbHasDragged = true;
    }
    lbTranslateX = currentX;
    lbTranslateY = currentY;
    applyLightboxTransform();
  });

  window.addEventListener('mouseup', () => {
    if (lbIsDragging) {
      lbIsDragging = false;
      img.classList.remove('dragging');
    }
  });

  // 3. 单击放大/还原（若发生过拖拽位移则不触发放大切换）
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    if (lbHasDragged) {
      lbHasDragged = false;
      return;
    }
    if (lbScale > 1.05) {
      resetLightboxTransform();
    } else {
      lbScale = 2.0;
      lbTranslateX = 0;
      lbTranslateY = 0;
      applyLightboxTransform();
    }
  });
}

function updateLbFavBtn(isFav) {
  const btn = $('lbFavBtn');
  if (!btn) return;
  btn.textContent = isFav ? '❤️ 已收藏' : '🤍 收藏';
  btn.style.color = isFav ? 'var(--err, #ef4444)' : '';
}
function openLightbox(rec) {
  if (!rec) return;
  selectedRecord = rec;
  resetLightboxTransform();
  const lbImg = $('lightboxImg');
  if (lbImg) {
    if (!rec.file) {
      lbImg.src = '';
    } else {
      // 先显示网格里已缓存的缩略图，原图解码完成后再无缝替换
      const full = `/img/${rec.file}`;
      const token = String(Math.random());
      lbImg.dataset.loadToken = token;
      lbImg.src = `/thumb/${rec.file}`;
      const loader = new Image();
      loader.src = full;
      loader.decode()
        .then(() => { if (lbImg.dataset.loadToken === token) lbImg.src = full; })
        .catch(() => {});
    }
  }
  $('lbPrompt').textContent = rec.prompt || '—';
  $('lbUc').textContent = rec.uc || '—';
  $('lbModel').textContent = rec.model || '—';
  $('lbSize').textContent = `${rec.width}×${rec.height}`;
  $('lbSteps').textContent = rec.steps || '—';
  $('lbSeed').textContent = rec.seed || '随机';
  updateLbFavBtn(!!rec.is_favorited);
  const chars = getRecordChars(rec);
  const charsField = $('lbCharsField');
  const charsList = $('lbCharsList');
  if (charsField && charsList) {
    if (chars.length) {
      charsList.innerHTML = '';
      chars.forEach((c, idx) => {
        const item = document.createElement('div');
        item.className = 'lb-char-item';

        const isAutoChar = c.x == null || c.y == null;
        const posText = isAutoChar ? '站位: 自动 (Auto)' : `站位 X:${Math.round(c.x * 100)}% Y:${Math.round(c.y * 100)}%`;

        item.innerHTML = `
          <div class="lb-char-item-head">
            <span class="lb-char-idx">角色 #${idx + 1}</span>
            <span class="lb-char-pos">${posText}</span>
          </div>
          <div class="lb-char-row">
            <span class="lb-char-lbl">Prompt:</span>
            <span class="lb-char-val">${esc(c.prompt || '—')}</span>
          </div>
          ${c.uc ? `
          <div class="lb-char-row">
            <span class="lb-char-lbl">UC:</span>
            <span class="lb-char-val">${esc(c.uc)}</span>
          </div>` : ''}
          <div class="lb-char-actions">
            <button type="button" class="btn tiny ghost-btn lb-single-reuse">复用此角色</button>
          </div>
        `;

        item.querySelector('.lb-single-reuse').addEventListener('click', () => {
          CHARS.push({
            prompt: String(c.prompt || ''),
            uc: String(c.uc || ''),
            x: typeof c.x === 'number' && !isNaN(c.x) ? Math.max(0, Math.min(1, c.x)) : null,
            y: typeof c.y === 'number' && !isNaN(c.y) ? Math.max(0, Math.min(1, c.y)) : null,
          });
          if (CHARS.length > 22) {
            CHARS.length = 22;
            toast('最多支持 22 个角色', true);
          }
          activeCharIndex = CHARS.length - 1;
          renderChars();
          $('lightboxModal').classList.add('hidden');
          toast(`已添加角色 #${idx + 1} 到独立角色面板`);
        });

        charsList.appendChild(item);
      });
      charsField.classList.remove('hidden');
    } else {
      charsList.innerHTML = '';
      charsField.classList.add('hidden');
    }
  }

  $('lbDelBtn').classList.toggle('hidden', !rec.id);
  const lb = $('lightboxModal');
  lb.classList.remove('hidden');
  lb.scrollTop = 0;
}
function reuseAllParams(rec) {
  if (rec.prompt) $('promptInp').value = rec.prompt;
  if (rec.uc) $('ucInp').value = rec.uc;
  if (rec.width) $('widthInp').value = rec.width;
  if (rec.height) $('heightInp').value = rec.height;
  if (rec.steps) $('stepsInp').value = rec.steps;
  if (rec.scale) $('scaleInp').value = rec.scale;
  if (rec.seed) $('seedInp').value = rec.seed;
  if (rec.model && META.models[rec.model]) $('modelSel').value = rec.model;
  if (rec.sampler) $('samplerSel').value = rec.sampler;

  const chars = getRecordChars(rec);
  if (chars.length) {
    applyCharPromptsToForm(chars);
  }

  updateAnlasEstimate();
  clampToCaps(false);
}

/* ═════════════════════════════════════════════════════════════
   读图学习：NovelAI PNG meta / 隐写 pnginfo
   ═════════════════════════════════════════════════════════════ */
let lastMetaLearn = null;

function parsePngTextChunks(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 16 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return {};
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const texts = {};
  let off = 8;
  const dec = new TextDecoder('utf-8', { fatal: false });
  while (off + 12 <= u8.length) {
    const len = dv.getUint32(off);
    if (off + 12 + len > u8.length) break;
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    const data = u8.subarray(off + 8, off + 8 + len);
    if (type === 'tEXt' || type === 'iTXt') {
      let i = 0;
      while (i < data.length && data[i] !== 0) i++;
      const key = dec.decode(data.subarray(0, i));
      let valBytes = data.subarray(i + 1);
      if (type === 'iTXt') {
        const compress = valBytes[0];
        let j = 2;
        while (j < valBytes.length && valBytes[j] !== 0) j++;
        j++;
        while (j < valBytes.length && valBytes[j] !== 0) j++;
        valBytes = valBytes.subarray(j + 1);
        if (compress) valBytes = null;
      }
      if (valBytes) texts[key] = dec.decode(valBytes);
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return texts;
}

function bitsToBytes(bits, startBit, nBytes) {
  const out = new Uint8Array(nBytes);
  for (let b = 0; b < nBytes; b++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) v = (v << 1) | (bits[startBit + b * 8 + bit] || 0);
    out[b] = v;
  }
  return out;
}

async function inflateGzipBytes(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeStealthPngInfo(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  let useAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) { useAlpha = true; break; }
  }
  const bits = [];
  if (useAlpha) {
    for (let i = 3; i < data.length; i += 4) bits.push(data[i] & 1);
  } else {
    for (let i = 0; i < data.length; i += 4) {
      bits.push(data[i] & 1);
      bits.push(data[i + 1] & 1);
      bits.push(data[i + 2] & 1);
    }
  }
  const magicLen = 16;
  if (bits.length < magicLen * 8 + 32) return null;
  const magic = new TextDecoder().decode(bitsToBytes(bits, 0, magicLen)).replace(/\0+$/g, '');
  if (magic !== 'stealth_pnginfo' && magic !== 'stealth_pngcomp') return null;
  const lenBits = bitsToBytes(bits, magicLen * 8, 4);
  const dataBitLen = (lenBits[0] << 24) | (lenBits[1] << 16) | (lenBits[2] << 8) | lenBits[3];
  const nBytes = Math.floor(dataBitLen / 8);
  if (nBytes <= 0 || magicLen * 8 + 32 + dataBitLen > bits.length) return null;
  let payload = bitsToBytes(bits, magicLen * 8 + 32, nBytes);
  if (magic === 'stealth_pngcomp') {
    try { payload = await inflateGzipBytes(payload); } catch { return null; }
  }
  return new TextDecoder().decode(payload);
}

function inferModelFromMeta(source, commentObj) {
  const raw = String(source || commentObj?.src || commentObj?.model || '');
  if (META?.models?.[raw]) return raw;
  const s = raw.toLowerCase();
  if (s.includes('nai-diffusion-5-full')) return 'nai-diffusion-5-full';
  if (s.includes('nai-diffusion-5-curated') || s.includes('v5 curated')) return 'nai-diffusion-5-curated';
  if (s.includes('nai-diffusion-4-5-curated') || s.includes('4.5 curated')) return 'nai-diffusion-4-5-curated';
  if (s.includes('nai-diffusion-4-5-full') || s.includes('4.5 full')) return 'nai-diffusion-4-5-full';
  if (s.includes('v5') || s.includes('9b')) return 'nai-diffusion-5-full';
  return '';
}

function normalizeLearnedMeta(texts, stealthText) {
  let comment = {};
  const rawComment = stealthText || texts.Comment || texts.comment || '';
  if (rawComment) {
    try { comment = JSON.parse(rawComment); } catch {
      if (typeof rawComment === 'string' && rawComment.includes('Negative prompt:')) {
        const parts = rawComment.split(/Negative prompt:\s*/i);
        comment = { prompt: (parts[0] || '').trim(), uc: (parts[1] || '').split(/\nSteps:/i)[0].trim() };
        const st = rawComment.match(/Steps:\s*(\d+)/i);
        const sampler = rawComment.match(/Sampler:\s*([^,]+)/i);
        const cfg = rawComment.match(/CFG scale:\s*([\d.]+)/i);
        const seed = rawComment.match(/Seed:\s*(\d+)/i);
        const size = rawComment.match(/Size:\s*(\d+)x(\d+)/i);
        if (st) comment.steps = +st[1];
        if (sampler) comment.sampler = sampler[1].trim();
        if (cfg) comment.scale = +cfg[1];
        if (seed) comment.seed = +seed[1];
        if (size) { comment.width = +size[1]; comment.height = +size[2]; }
      }
    }
  }
  let prompt = comment.prompt || comment.v4_prompt?.caption?.base_caption || texts.Description || '';
  let uc = comment.uc || comment.negative_prompt || comment.v4_negative_prompt?.caption?.base_caption || '';
  const chars = [];
  const list = comment.characterPrompts || comment.v4_prompt?.caption?.char_captions || [];
  if (Array.isArray(list)) {
    list.forEach((c) => {
      if (c.prompt || c.char_caption) {
        const center = c.center || (Array.isArray(c.centers) && c.centers[0]) || {};
        chars.push({
          prompt: formatCharPromptXxxIp(String(c.prompt || c.char_caption || '').trim()),
          uc: String(c.uc || '').trim(),
          x: typeof center.x === 'number' ? center.x : null,
          y: typeof center.y === 'number' ? center.y : null,
        });
      }
    });
  }
  return {
    software: texts.Software || '',
    source: texts.Source || '',
    model: inferModelFromMeta(texts.Source, comment),
    prompt,
    uc,
    width: comment.width,
    height: comment.height,
    steps: comment.steps,
    scale: comment.scale,
    sampler: comment.sampler,
    seed: comment.seed,
    noiseSchedule: comment.noise_schedule,
    qualityToggle: comment.qualityToggle,
    charPrompts: chars.filter((c) => c.prompt),
    rawComment: String(rawComment || '').slice(0, 4000),
  };
}

function renderMetaFields(meta) {
  const wrap = $('metaFields');
  wrap.innerHTML = '';
  const rows = [
    ['模型', meta.model || meta.source || '（未识别）'],
    ['画幅', (meta.width && meta.height) ? `${meta.width}×${meta.height}` : ''],
    ['步数 / CFG / 采样', [meta.steps, meta.scale, meta.sampler].filter((x) => x != null && x !== '').join(' · ')],
    ['种子', meta.seed != null ? String(meta.seed) : ''],
    ['提示词', meta.prompt],
    ['排除词', meta.uc],
    ['角色', meta.charPrompts?.length ? meta.charPrompts.map((c, i) => `#${i + 1} ${c.prompt}`).join('\n') : ''],
    ['Software', meta.software],
  ];
  rows.forEach(([lbl, val]) => {
    if (!val) return;
    const div = document.createElement('div');
    div.className = 'meta-field';
    div.innerHTML = `<span class="lbl">${esc(lbl)}</span><div class="val">${esc(val)}</div>`;
    wrap.appendChild(div);
  });
  wrap.classList.toggle('hidden', !wrap.childElementCount);
}

async function learnFromImageFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  const texts = parsePngTextChunks(buf);
  let stealthText = '';
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch { /* not a decodable image */ }
  const hasPrompt = !!(texts.Comment || texts.Description);
  if (bitmap && !hasPrompt) {
    try { stealthText = await decodeStealthPngInfo(bitmap) || ''; } catch { stealthText = ''; }
  }
  const meta = normalizeLearnedMeta(texts, stealthText);
  lastMetaLearn = meta;

  $('metaPreviewWrap').classList.remove('hidden');
  if (bitmap) {
    const url = URL.createObjectURL(file);
    $('metaPreviewImg').src = url;
  }
  const ok = !!(meta.prompt || meta.uc || meta.seed || meta.model || meta.software);
  $('metaStatus').textContent = ok
    ? `已解析${meta.software ? ` · ${meta.software}` : ''}${meta.model ? ` · ${meta.model}` : ''}`
    : '未找到 meta。请用「解析当前出图」或「下载原图」，不要用截图/右键另存为';
  renderMetaFields(meta);
  $('metaActions').classList.toggle('hidden', !ok);
  if ($('metaLearnSummary')) {
    $('metaLearnSummary').textContent = ok ? (meta.prompt ? meta.prompt.slice(0, 24) + '…' : '已解析') : '无 meta';
  }
  $('metaLearnCard')?.classList.remove('collapsed');
  if (ok) toast('读图完成');
  else toast('这张图没有可用 meta', true);
}

async function learnFromImageUrl(url) {
  if (!url) return;
  try {
    const abs = new URL(url, location.href).href;
    const res = await fetch(abs, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('读取图片失败');
    const blob = await res.blob();
    const file = new File([blob], 'image.png', { type: blob.type || 'image/png' });
    await learnFromImageFile(file);
  } catch (err) {
    toast(err.message || '读图失败', true);
  }
}

function clearMetaLearn() {
  lastMetaLearn = null;
  $('metaPreviewWrap')?.classList.add('hidden');
  if ($('metaFields')) {
    $('metaFields').classList.add('hidden');
    $('metaFields').innerHTML = '';
  }
  $('metaActions')?.classList.add('hidden');
  if ($('metaPreviewImg')) $('metaPreviewImg').src = '';
  if ($('metaStatus')) $('metaStatus').textContent = '';
  if ($('metaLearnSummary')) $('metaLearnSummary').textContent = '拖入 NAI PNG';
}

function bindMetaLearn() {
  const drop = $('metaDrop');
  const inp = $('metaFileInp');
  bindFoldCard('metaLearnCard', 'metaLearnHead', 'nai-meta-learn-collapsed', true);
  if (!drop || !inp) return;

  drop.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (f) learnFromImageFile(f);
    inp.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) => {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const uri = String(e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '')
      .split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
    if (uri && (/\/img\//.test(uri) || uri.startsWith(location.origin) || uri.startsWith('/'))) {
      learnFromImageUrl(uri);
      return;
    }
    const f = e.dataTransfer?.files?.[0];
    if (f) learnFromImageFile(f);
  });
  document.addEventListener('paste', (e) => {
    if ($('promptLibModal') && !$('promptLibModal').classList.contains('hidden')) return;
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'));
    if (!item) return;
    const f = item.getAsFile();
    if (f) learnFromImageFile(f);
  });
  $('resultImg')?.addEventListener('dragstart', (e) => {
    const src = lastGen?.image || $('resultImg').getAttribute('src');
    if (!src) return;
    e.dataTransfer.setData('text/uri-list', src);
    e.dataTransfer.setData('text/plain', src);
  });
  $('metaFromCurrentBtn')?.addEventListener('click', () => {
    const src = lastGen?.image || $('resultImg')?.getAttribute('src');
    if (!src || $('resultImg')?.classList.contains('hidden')) return toast('还没有当前出图', true);
    learnFromImageUrl(src);
  });
  $('metaRemoveBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearMetaLearn();
  });

  $('metaApplyPromptBtn')?.addEventListener('click', () => {
    if (!lastMetaLearn?.prompt) return toast('没有提示词可导入', true);
    $('promptInp').value = lastMetaLearn.prompt;
    if (lastMetaLearn.uc) {
      $('ucPresetSel').value = 'none';
      $('ucInp').value = lastMetaLearn.uc;
    }
    toast('已导入提示词');
  });
  $('metaApplyAllBtn')?.addEventListener('click', () => {
    if (!lastMetaLearn) return;
    const m = lastMetaLearn;
    if (m.prompt) $('promptInp').value = m.prompt;
    $('ucPresetSel').value = 'none';
    $('ucInp').value = m.uc || '';
    if (m.qualityToggle === false || /masterpiece|very aesthetic/.test(m.prompt || '')) {
      $('qualityChk').checked = false;
    } else if (m.qualityToggle === true) {
      $('qualityChk').checked = true;
    }
    reuseAllParams({
      prompt: m.prompt,
      uc: m.uc,
      width: m.width,
      height: m.height,
      steps: m.steps,
      scale: m.scale,
      seed: m.seed,
      model: m.model,
      sampler: m.sampler,
      charPrompts: m.charPrompts,
    });
    const card = $('sizeStepsCard');
    if (card && (m.width || m.steps)) card.classList.remove('collapsed');
    toast('已导入全部可读参数');
  });
  $('metaApplyCharsBtn')?.addEventListener('click', () => {
    if (!lastMetaLearn?.charPrompts?.length) return toast('没有角色可导入', true);
    applyCharPromptsToForm(lastMetaLearn.charPrompts);
    toast(`已导入 ${lastMetaLearn.charPrompts.length} 个角色`);
  });
}

/* ═════════════════════════════════════════════════════════════
   个人中心设置弹窗
   ═════════════════════════════════════════════════════════════ */
function bindProfileModal() {
  $('userProfileBtn').addEventListener('click', () => {
    $('profUsername').value = ME.username;
    $('profOldPass').value = '';
    $('profNewPass').value = '';
    $('profErr').textContent = '';
    $('profileModal').classList.remove('hidden');
  });

  $('profileCloseBtn').addEventListener('click', () => $('profileModal').classList.add('hidden'));
  $('profileCancelBtn').addEventListener('click', () => $('profileModal').classList.add('hidden'));
  $('profileModal').addEventListener('click', (e) => {
    if (e.target === $('profileModal')) $('profileModal').classList.add('hidden');
  });

  $('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('profErr').textContent = '';
    const newUsername = $('profUsername').value.trim();
    const oldPassword = $('profOldPass').value;
    const newPassword = $('profNewPass').value;

    try {
      const res = await api('/api/user/profile', {
        method: 'POST',
        body: JSON.stringify({ newUsername, oldPassword, newPassword }),
      });
      ME.username = res.username;
      updateUserBadge();
      $('profileModal').classList.add('hidden');
      toast(`用户名已修改为：${res.username}`);
    } catch (err) {
      $('profErr').textContent = err.message;
    }
  });
}

/* ═════════════════════════════════════════════════════════════
   提示词片段库 (Prompt Library)
   打开时一次拉取全部分类并缓存；切换分类、搜索、分组都在本地完成，
   增删改只更新本地缓存，不再整表重拉。
   ═════════════════════════════════════════════════════════════ */
const LIB_KINDS = {
  painter: { name: '画师串', hint: '点击卡片插入到正向提示词光标处' },
  action: { name: '动作串', hint: '点击卡片追加到正向提示词末尾', group: '分类' },
  uc: { name: 'UC', hint: '点击卡片插入到负面提示词 (UC)' },
  character: { name: '角色', hint: '点击卡片添加到独立角色面板（上限 22 个）', group: '作品' },
  main: { name: '主串', hint: '点击卡片替换整个正向提示词' },
};
const LIB_GROUP_ALL = '';
const LIB_GROUP_OTHER = '其他';
const LIB_GROUP_STORE_KEYS = { action: 'nai-action-group-tab', character: 'nai-char-ip-tab' };
const ACTION_GROUP_ORDER = ['常用', '站立', '传教士', '侧躺', '骑乘', '后入', '特殊', '对照', '自拍', '展示', '多人', '口交', '事后', '其他'];
/** 角色站位预设，与独立角色面板的「左 / 中 / 右」一致 */
const LIB_POS_PRESETS = { left: { x: 0.25, y: 0.5, label: '左' }, center: { x: 0.5, y: 0.5, label: '中' }, right: { x: 0.75, y: 0.5, label: '右' } };

const lib = {
  kind: 'painter',
  items: [],
  limit: 500,
  loaded: false,
  query: '',
  group: {},          // { [kind]: 分组名，'' 表示全部 }
  editing: null,      // null | { id: number|null }（id 为 null 表示新建）
  target: null,       // 调用来源（分镜工作室等）；null 表示主工作区
  armedDelete: null,  // 第一次点删除后等待确认的条目 id
  armedTimer: 0,
};

function readLibGroup(kind) {
  if (lib.group[kind] !== undefined) return lib.group[kind];
  try { lib.group[kind] = localStorage.getItem(LIB_GROUP_STORE_KEYS[kind]) || LIB_GROUP_ALL; } catch { lib.group[kind] = LIB_GROUP_ALL; }
  return lib.group[kind];
}

function writeLibGroup(kind, name) {
  lib.group[kind] = name || LIB_GROUP_ALL;
  try {
    if (name) localStorage.setItem(LIB_GROUP_STORE_KEYS[kind], name);
    else localStorage.removeItem(LIB_GROUP_STORE_KEYS[kind]);
  } catch { /* 隐私模式 / 配额满时忽略 */ }
}

async function copyPromptText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    toast('已复制');
  } catch (err) {
    toast(`复制失败：${err.message}`, true);
  }
}

function formatCharPromptXxxIp(prompt) {
  let p = String(prompt || '').replace(/[‎‏​﻿]/g, '').trim();
  if (!p || p.includes('\n') || (p.split(',').length - 1) >= 2) return p;
  let m = p.match(/^(.+?)_\(([^)]+)\)$/);
  if (m) return `${m[1].replace(/_/g, ' ').trim()} (${m[2].replace(/_/g, ' ').trim()})`;
  m = p.match(/^(.+?)\s+\(([^)]+)\)$/);
  if (m && !m[1].includes(',')) return `${m[1].replace(/_/g, ' ').trim()} (${m[2].replace(/_/g, ' ').trim()})`;
  if (p.includes(',')) {
    const idx = p.indexOf(',');
    let a = p.slice(0, idx).trim();
    const b = p.slice(idx + 1).trim();
    a = a.replace(/_\([^)]+\)$/, '').replace(/_/g, ' ').trim();
    const ip = b.replace(/_/g, ' ').trim();
    if (a && ip) return `${a} (${ip})`;
  }
  return p;
}

function parseLibCharContent(item) {
  try {
    const obj = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? Math.max(0, Math.min(1, v)) : null);
      const x = num(obj.x);
      const y = num(obj.y);
      return { prompt: String(obj.prompt || ''), uc: String(obj.uc || ''), x: x === null || y === null ? null : x, y: x === null || y === null ? null : y };
    }
  } catch {
    /* 非 JSON 角色内容时降级为纯文本 */
  }
  return { prompt: String(item.content || ''), uc: '', x: null, y: null };
}

/** 标题「分组 | 名称」中的分组；动作串没有前缀时按关键词归类 */
function libGroupName(item, kind) {
  const title = String(item?.title || '').trim();
  const idx = title.indexOf(' | ');
  if (idx > 0) return title.slice(0, idx).trim();
  if (kind === 'action') {
    if (/口交|跪舔/.test(title)) return '口交';
    if (/传教士|操逼/.test(title)) return '传教士';
    if (/背骑|骑乘/.test(title)) return '骑乘';
    if (/侧位/.test(title)) return '侧躺';
    if (/站立/.test(title)) return '站立';
    if (/后入|俯卧|四足|弯腰/.test(title)) return '后入';
    if (/中出|事后/.test(title)) return '事后';
  }
  return LIB_GROUP_OTHER;
}

/** 分组类条目显示名：去掉「分组 | 」前缀 */
function libDisplayTitle(item, kind) {
  const title = String(item?.title || '').trim();
  if (LIB_KINDS[kind]?.group) {
    const group = libGroupName(item, kind);
    if (title.startsWith(`${group} | `)) return title.slice(group.length + 3).trim() || title;
  }
  return title || '未命名片段';
}

function libSortItems(list) {
  return list.sort((a, b) => (Number(a.sort) - Number(b.sort)) || (Number(a.id) - Number(b.id)));
}

/** 按分组聚合（已排序）：动作串按常用分类顺序，角色按作品内最小排序值 */
function groupLibItems(items, kind) {
  const groups = new Map();
  for (const item of items) {
    const name = libGroupName(item, kind);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  const minSort = (name) => Math.min(...groups.get(name).map((it) => Number(it.sort) || 0));
  const orderOf = (name) => {
    const i = ACTION_GROUP_ORDER.indexOf(name);
    return i === -1 ? ACTION_GROUP_ORDER.length : i;
  };
  const names = [...groups.keys()].sort((a, b) => {
    if (a === LIB_GROUP_OTHER) return 1;
    if (b === LIB_GROUP_OTHER) return -1;
    if (kind === 'action' && orderOf(a) !== orderOf(b)) return orderOf(a) - orderOf(b);
    return (minSort(a) - minSort(b)) || a.localeCompare(b, 'zh-CN');
  });
  return names.map((name) => ({ name, items: libSortItems(groups.get(name)) }));
}

function libSearchText(item) {
  if (item.kind !== 'character') return String(item.content || '');
  const c = parseLibCharContent(item);
  return `${c.prompt}\n${c.uc}`;
}

function libTerms() {
  return lib.query.toLowerCase().split(/\s+/).filter(Boolean);
}

function libMatches(item, terms) {
  if (!terms.length) return true;
  const hay = `${item.title}\n${libSearchText(item)}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** 转义并高亮搜索词 */
function libHighlight(text, terms) {
  const s = String(text || '');
  if (!terms.length) return esc(s);
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return s.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

function countTags(text) {
  return String(text || '').split(/[,，\n]/).filter((s) => s.trim()).length;
}

function libPositionLabel(c) {
  if (c.x === null) return '自动站位';
  const preset = Object.values(LIB_POS_PRESETS).find((p) => Math.abs(p.x - c.x) < 0.01 && Math.abs(p.y - c.y) < 0.01);
  return preset ? `站位 · ${preset.label}` : `坐标 ${+c.x.toFixed(2)}, ${+c.y.toFixed(2)}`;
}

const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function libCardHtml(item, terms) {
  const kind = item.kind;
  const armed = lib.armedDelete === item.id;
  const editing = lib.editing?.id === item.id;
  let text;
  let meta;
  if (kind === 'character') {
    const c = parseLibCharContent(item);
    text = c.prompt;
    meta = `<span class="pl-chip">${esc(libPositionLabel(c))}</span>${c.uc ? '<span class="pl-chip">含 UC</span>' : ''}`;
  } else {
    text = item.content;
    meta = `<span class="pl-meta">${countTags(item.content)} 个标签</span>`;
  }
  return `<article class="pl-card${editing ? ' is-editing' : ''}" data-id="${item.id}" tabindex="0" role="button" aria-label="插入 ${esc(item.title)}">
      <div class="pl-card-title">${libHighlight(libDisplayTitle(item, kind), terms)}</div>
      <div class="pl-card-text">${libHighlight(text, terms) || '<span class="pl-muted">（空）</span>'}</div>
      <div class="pl-card-foot">
        <div class="pl-card-meta">${meta}</div>
        <div class="pl-card-actions">
          <button type="button" class="pl-act" data-act="copy" title="复制内容" aria-label="复制">${icon('copy')}</button>
          <button type="button" class="pl-act" data-act="edit" title="编辑" aria-label="编辑">${icon('edit')}</button>
          <button type="button" class="pl-act" data-act="pin" title="置顶" aria-label="置顶">${icon('pin')}</button>
          <button type="button" class="pl-act danger${armed ? ' armed' : ''}" data-act="del" title="${armed ? '再点一次确认删除' : '删除'}" aria-label="删除">${icon('trash')}${armed ? '<span>确认删除</span>' : ''}</button>
        </div>
      </div>
    </article>`;
}

function libEmptyHtml(kind, terms) {
  if (terms.length) {
    return `<div class="pl-empty">${icon('search')}<b>没有匹配「${esc(lib.query)}」的${esc(LIB_KINDS[kind].name)}</b><span>换个关键词，或切换到其他分类看看（分类上的数字为匹配条数）</span></div>`;
  }
  return `<div class="pl-empty">${icon('book')}<b>还没有${esc(LIB_KINDS[kind].name)}片段</b><span>把常用的提示词存起来，之后一键插入</span><button type="button" class="btn primary small" data-act="new">${icon('plus')}<span>新建${esc(LIB_KINDS[kind].name)}</span></button></div>`;
}

function renderLibrary() {
  const kind = lib.kind;
  const cfg = LIB_KINDS[kind];
  const terms = libTerms();

  // 分类标签：数字 = 该分类条数（搜索时为匹配条数）
  document.querySelectorAll('#promptLibTabNav .pl-kind').forEach((tab) => {
    const k = tab.dataset.kind;
    const n = lib.items.filter((it) => it.kind === k && libMatches(it, terms)).length;
    tab.classList.toggle('active', k === kind);
    tab.setAttribute('aria-selected', k === kind ? 'true' : 'false');
    tab.classList.toggle('dim', terms.length > 0 && n === 0);
    tab.querySelector('em').textContent = lib.loaded ? n : '…';
  });
  $('plTotal').textContent = lib.items.length;
  $('plLimit').textContent = lib.limit;
  $('plApplyHint').textContent = lib.target ? '点击卡片插入到分镜工作室' : cfg.hint;
  $('plNewBtn').querySelector('span').textContent = `新建${cfg.name}`;

  const listWrap = $('libItemsList');
  if (!lib.loaded) {
    listWrap.innerHTML = '<div class="pl-empty pl-loading"><span class="pl-spinner"></span><span>正在加载片段…</span></div>';
    $('plGroups').classList.add('hidden');
    return;
  }

  const matched = lib.items.filter((it) => it.kind === kind && libMatches(it, terms));
  const groupsWrap = $('plGroups');
  if (!cfg.group) {
    groupsWrap.classList.add('hidden');
    listWrap.innerHTML = matched.length
      ? `<div class="pl-grid">${libSortItems(matched).map((it) => libCardHtml(it, terms)).join('')}</div>`
      : libEmptyHtml(kind, terms);
    return;
  }

  const groups = groupLibItems(matched, kind);
  let selected = readLibGroup(kind);
  if (selected !== LIB_GROUP_ALL && !groups.some((g) => g.name === selected)) selected = LIB_GROUP_ALL;
  groupsWrap.classList.toggle('hidden', groups.length < 2 && selected === LIB_GROUP_ALL);
  groupsWrap.innerHTML = [{ name: LIB_GROUP_ALL, label: '全部', count: matched.length }, ...groups.map((g) => ({ name: g.name, label: g.name, count: g.items.length }))]
    .map((g) => `<button type="button" class="pl-group${g.name === selected ? ' active' : ''}" data-group="${esc(g.name)}" role="tab" aria-selected="${g.name === selected}">${esc(g.label)}<em>${g.count}</em></button>`)
    .join('');

  if (!matched.length) {
    listWrap.innerHTML = libEmptyHtml(kind, terms);
    return;
  }
  const shown = selected === LIB_GROUP_ALL ? groups : groups.filter((g) => g.name === selected);
  listWrap.innerHTML = shown.map((g) => `
    ${selected === LIB_GROUP_ALL && groups.length > 1 ? `<div class="pl-section"><span>${esc(g.name)}</span><em>${g.items.length}</em></div>` : ''}
    <div class="pl-grid">${g.items.map((it) => libCardHtml(it, terms)).join('')}</div>`).join('');
}

async function loadLibrary() {
  try {
    const res = await api('/api/prompts');
    lib.items = Array.isArray(res?.items) ? res.items : [];
    lib.limit = res?.limit || lib.limit;
    lib.loaded = true;
  } catch (err) {
    if (!lib.loaded) {
      $('libItemsList').innerHTML = `<div class="pl-empty is-error">${icon('alert')}<b>片段库加载失败</b><span>${esc(err.message)}</span><button type="button" class="btn ghost-btn small" data-act="retry">${icon('refresh')}<span>重试</span></button></div>`;
      return;
    }
    toast(`片段库刷新失败，显示的是缓存：${err.message}`, true);
  }
  renderLibrary();
}

function openPromptLibrary(kind = 'painter', targetCtx = null) {
  const modal = $('promptLibModal');
  if (!modal) return;
  lib.target = targetCtx;
  lib.kind = LIB_KINDS[kind] ? kind : 'painter';
  lib.query = '';
  $('plSearch').value = '';
  closeLibEditor();
  modal.classList.remove('hidden');
  renderLibrary(); // 有缓存时先秒开，再后台刷新
  loadLibrary();
  if (matchMedia('(hover: hover)').matches) setTimeout(() => $('plSearch').focus(), 30);
}

function closePromptLibrary() {
  lib.target = null;
  disarmLibDelete();
  closeLibEditor();
  $('promptLibModal')?.classList.add('hidden');
}

function switchPromptLibKind(kind) {
  if (!LIB_KINDS[kind] || kind === lib.kind) return;
  lib.kind = kind;
  closeLibEditor();
  disarmLibDelete();
  $('plBody').scrollTop = 0;
  renderLibrary();
}

function disarmLibDelete() {
  clearTimeout(lib.armedTimer);
  lib.armedDelete = null;
}

/* ── 新建 / 编辑表单 ── */
function libPositionMode(c) {
  if (c.x === null) return 'auto';
  const hit = Object.entries(LIB_POS_PRESETS).find(([, p]) => Math.abs(p.x - c.x) < 0.01 && Math.abs(p.y - c.y) < 0.01);
  return hit ? hit[0] : 'custom';
}

function libEditorHtml(item, kind) {
  const cfg = LIB_KINDS[kind];
  const isChar = kind === 'character';
  let group = '';
  let name = item?.title || '';
  if (cfg.group) {
    if (item) {
      const g = libGroupName(item, kind);
      if (item.title.startsWith(`${g} | `)) { group = g; name = item.title.slice(g.length + 3); }
    } else {
      const sel = readLibGroup(kind);
      if (sel !== LIB_GROUP_ALL && sel !== LIB_GROUP_OTHER) group = sel;
    }
  }
  const knownGroups = cfg.group
    ? [...new Set(lib.items.filter((it) => it.kind === kind).map((it) => libGroupName(it, kind)))].filter((g) => g !== LIB_GROUP_OTHER)
    : [];
  const c = isChar ? parseLibCharContent(item || { content: '' }) : null;
  const mode = isChar ? libPositionMode(c) : null;
  const content = isChar ? '' : String(item?.content || '');
  const namePlaceholder = { painter: '例如：水墨水彩混搭', action: '例如：回眸', uc: '例如：通用质量 UC', character: '例如：雷电将军', main: '例如：银发少女夜景' }[kind];

  return `<form class="pl-editor" novalidate>
      <div class="pl-editor-head">
        <b>${item ? `编辑${esc(cfg.name)}` : `新建${esc(cfg.name)}`}</b>
        <span class="pl-muted">Ctrl + Enter 保存 · Esc 取消</span>
      </div>
      <div class="pl-editor-grid${cfg.group ? ' has-group' : ''}">
        ${cfg.group ? `<label class="pl-field"><span>${cfg.group}<small>选填，用于分组</small></span>
          <input class="styled-admin-input" name="group" maxlength="60" list="plGroupList" value="${esc(group)}" placeholder="${kind === 'character' ? '例如：原神' : '例如：常用'}">
          <datalist id="plGroupList">${knownGroups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>` : ''}
        <label class="pl-field"><span>${kind === 'character' ? '角色名' : '标题'}</span>
          <input class="styled-admin-input" name="name" maxlength="200" value="${esc(name)}" placeholder="${esc(namePlaceholder)}" required></label>
      </div>
      ${isChar ? `
      <label class="pl-field"><span>角色提示词</span>
        <textarea class="styled-admin-input" name="prompt" rows="2" placeholder="raiden shogun (genshin impact)">${esc(c.prompt)}</textarea></label>
      <label class="pl-field"><span>角色 UC<small>选填</small></span>
        <input class="styled-admin-input" name="uc" value="${esc(c.uc)}" placeholder="该角色专属排除词"></label>
      <div class="pl-field"><span>站位</span>
        <div class="pl-pos">
          <div class="pl-seg" role="radiogroup">
            ${[['auto', '自动'], ['left', '左'], ['center', '中'], ['right', '右'], ['custom', '自定义']].map(([v, l]) => `<button type="button" class="pl-seg-btn${mode === v ? ' active' : ''}" data-pos="${v}" role="radio" aria-checked="${mode === v}">${l}</button>`).join('')}
          </div>
          <div class="pl-coords${mode === 'custom' ? '' : ' hidden'}">
            <label>X <input type="number" class="styled-admin-input" name="x" min="0" max="1" step="0.05" value="${c.x ?? 0.5}"></label>
            <label>Y <input type="number" class="styled-admin-input" name="y" min="0" max="1" step="0.05" value="${c.y ?? 0.5}"></label>
          </div>
        </div>
      </div>` : `
      <label class="pl-field"><span>${kind === 'uc' ? '排除词内容' : '提示词内容'}<small class="pl-counter">${countTags(content)} 个标签 · ${content.length}/5000</small></span>
        <textarea class="styled-admin-input pl-content" name="content" rows="4" maxlength="5000" placeholder="${kind === 'uc' ? 'lowres, bad anatomy, bad hands…' : '用英文逗号分隔的 tags…'}">${esc(content)}</textarea></label>`}
      <div class="pl-editor-actions">
        <button type="button" class="btn ghost-btn small" data-act="cancel">取消</button>
        <button type="submit" class="btn primary small">${icon('check')}<span>${item ? '保存修改' : '保存到片段库'}</span></button>
      </div>
    </form>`;
}

function openLibEditor(item = null) {
  if (lib.editing && !item && lib.editing.id === null) {
    $('plEditorSlot').querySelector('input[name=name]')?.focus();
    return;
  }
  disarmLibDelete();
  lib.editing = { id: item ? item.id : null };
  const slot = $('plEditorSlot');
  slot.innerHTML = libEditorHtml(item, lib.kind);
  $('plBody').scrollTop = 0;
  renderLibrary();
  const form = slot.querySelector('form');
  form.addEventListener('submit', (e) => { e.preventDefault(); saveLibEditor(form, item); });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('input', (e) => {
    if (e.target.name !== 'content') return;
    const v = e.target.value;
    form.querySelector('.pl-counter').textContent = `${countTags(v)} 个标签 · ${v.length}/5000`;
  });
  form.addEventListener('click', (e) => {
    const seg = e.target.closest('.pl-seg-btn');
    if (seg) {
      form.querySelectorAll('.pl-seg-btn').forEach((b) => {
        b.classList.toggle('active', b === seg);
        b.setAttribute('aria-checked', b === seg ? 'true' : 'false');
      });
      form.querySelector('.pl-coords').classList.toggle('hidden', seg.dataset.pos !== 'custom');
    } else if (e.target.closest('[data-act=cancel]')) {
      closeLibEditor();
      renderLibrary();
    }
  });
  const first = form.querySelector(LIB_KINDS[lib.kind].group && !item ? 'input[name=group]' : 'input[name=name]');
  first?.focus();
}

function closeLibEditor() {
  lib.editing = null;
  const slot = $('plEditorSlot');
  if (slot) slot.innerHTML = '';
}

async function saveLibEditor(form, item) {
  const kind = item ? item.kind : lib.kind;
  const f = form.elements;
  const group = f.group ? f.group.value.trim().replace(/\s*\|\s*/g, ' ') : '';
  const name = f.name.value.trim();
  if (!name) { f.name.focus(); return toast('请填写标题', true); }
  const title = group ? `${group} | ${name}` : name;
  if (title.length > 200) return toast('标题长度不能超过 200 字符', true);

  let content;
  if (kind === 'character') {
    const prompt = formatCharPromptXxxIp(f.prompt.value.trim());
    if (!prompt) { f.prompt.focus(); return toast('请填写角色提示词', true); }
    const mode = form.querySelector('.pl-seg-btn.active')?.dataset.pos || 'auto';
    let x = null;
    let y = null;
    if (LIB_POS_PRESETS[mode]) ({ x, y } = LIB_POS_PRESETS[mode]);
    if (mode === 'custom') {
      const clamp = (v) => (Number.isNaN(v) ? 0.5 : Math.max(0, Math.min(1, +v.toFixed(3))));
      x = clamp(parseFloat(f.x.value));
      y = clamp(parseFloat(f.y.value));
    }
    content = JSON.stringify({ prompt, uc: f.uc.value.trim(), x, y });
  } else {
    content = f.content.value.trim();
    if (!content) { f.content.focus(); return toast('请填写提示词内容', true); }
  }
  if (content.length > 5000) return toast('内容长度不能超过 5000 字符', true);

  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    if (item) {
      await api(`/api/prompts/${item.id}`, { method: 'POST', body: JSON.stringify({ title, content }) });
      Object.assign(item, { title, content });
    } else {
      const sort = lib.items.filter((it) => it.kind === kind).reduce((m, it) => Math.max(m, Number(it.sort) || 0), 0);
      const res = await api('/api/prompts', { method: 'POST', body: JSON.stringify({ kind, title, content, sort }) });
      lib.items.push({ id: res.id, kind, title, content, sort });
    }
    if (LIB_KINDS[kind].group) writeLibGroup(kind, libGroupName({ title }, kind));
    toast(item ? '已保存修改' : '已保存到片段库');
    closeLibEditor();
    renderLibrary();
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
    submit.disabled = false;
  }
}

/* ── 卡片操作 ── */
async function libCardAction(act, item) {
  if (act === 'copy') {
    return copyPromptText(item.kind === 'character' ? parseLibCharContent(item).prompt : String(item.content || ''));
  }
  if (act === 'edit') return openLibEditor(item);
  if (act === 'pin') {
    const sort = lib.items.filter((it) => it.kind === item.kind).reduce((m, it) => Math.min(m, Number(it.sort) || 0), 0) - 1;
    try {
      await api(`/api/prompts/${item.id}`, { method: 'POST', body: JSON.stringify({ sort }) });
      item.sort = sort;
      renderLibrary();
      toast('已置顶');
    } catch (err) { toast(`置顶失败：${err.message}`, true); }
    return;
  }
  if (act === 'del') {
    if (lib.armedDelete !== item.id) {
      disarmLibDelete();
      lib.armedDelete = item.id;
      lib.armedTimer = setTimeout(() => { lib.armedDelete = null; renderLibrary(); }, 4000);
      return renderLibrary();
    }
    disarmLibDelete();
    try {
      await api(`/api/prompts/${item.id}`, { method: 'DELETE' });
      lib.items = lib.items.filter((it) => it.id !== item.id);
      if (lib.editing?.id === item.id) closeLibEditor();
      toast('片段已删除');
    } catch (err) { toast(`删除失败：${err.message}`, true); }
    renderLibrary();
  }
}

/* ── 导入 / 导出 ── */
function exportLibrary() {
  if (!lib.items.length) return toast('片段库是空的，没有可导出的内容', true);
  const data = {
    app: 'nai-dreamforge',
    version: 1,
    exportedAt: new Date().toISOString(),
    items: lib.items.map(({ kind, title, content, sort }) => ({ kind, title, content, sort })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `dreamforge-prompts-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${lib.items.length} 条片段`);
}

async function importLibraryFile(file) {
  let items;
  try {
    const parsed = JSON.parse(await file.text());
    items = (Array.isArray(parsed) ? parsed : parsed?.items || [])
      .map(({ kind, title, content, sort }) => ({ kind, title, content, ...(Number.isInteger(sort) ? { sort } : {}) }));
  } catch {
    return toast('文件不是有效的 JSON', true);
  }
  if (!items.length) return toast('文件里没有片段', true);
  try {
    const res = await api('/api/prompts/import', { method: 'POST', body: JSON.stringify({ items }) });
    toast(`已导入 ${res.added} 条${res.skipped ? `，跳过 ${res.skipped} 条重复` : ''}`);
    await loadLibrary();
  } catch (err) {
    toast(`导入失败：${err.message}`, true);
  }
}

/* 在输入框光标位置插入文本，若无光标则追加 */
function insertAtCursor(textarea, textToInsert) {
  textarea.focus();
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;

  if (typeof start === 'number' && typeof end === 'number') {
    const before = val.substring(0, start);
    const after = val.substring(end);
    // 适当补充逗号与空格以保持提示词语法美观
    let prefix = '';
    let suffix = '';
    if (before && !before.trimEnd().endsWith(',')) prefix = ', ';
    if (after && !after.trimStart().startsWith(',')) suffix = ', ';

    const insertText = prefix + textToInsert.trim() + suffix;
    textarea.value = before + insertText + after;
    const newCursor = before.length + insertText.length;
    textarea.setSelectionRange(newCursor, newCursor);
  } else if (!val.trim()) {
    textarea.value = textToInsert.trim();
  } else {
    textarea.value = val.trimEnd().replace(/,+$/, '') + ', ' + textToInsert.trim();
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/* 处理分镜工作室等自定义上下文的目标注入 */
function handleTargetContextInsert(item, kind, ctx) {
  let textToInsert = '';
  if (kind === 'character') {
    const raw = parseLibCharContent(item);
    textToInsert = raw.prompt.trim();
    if (ctx.type === 'comicAddChar') {
      addComicCharacter({
        name: libDisplayTitle(item, kind),
        prompt: textToInsert,
        uc: raw.uc.trim(),
        x: raw.x ?? 0.5,
        y: raw.y ?? 0.5,
      });
      toast(`已将角色【${libDisplayTitle(item, kind)}】添加到工作室角色列表`);
      return;
    }
  } else {
    textToInsert = String(item.content || '').trim();
  }

  if (!textToInsert) return toast('片段内容为空', true);

  if (ctx.type === 'comicStyle') {
    const ta = $('comicStylePrompt');
    if (ta) insertAtCursor(ta, textToInsert);
    toast(`已导入画风片段：${item.title}`);
  } else if (ctx.type === 'comicPanel' && ctx.panelId) {
    const panel = comicPanels.find(p => p.id === ctx.panelId);
    if (panel) {
      const card = document.getElementById(`comic-panel-${panel.id}`);
      const ta = card ? card.querySelector('.comic-panel-prompt') : null;
      if (ta) {
        insertAtCursor(ta, textToInsert);
        panel.prompt = ta.value;
      } else {
        panel.prompt = panel.prompt ? panel.prompt + ', ' + textToInsert : textToInsert;
        renderComicPanels();
      }
      toast(`已插入分镜 #${comicPanels.indexOf(panel) + 1}：${item.title}`);
    }
  } else if (ctx.type === 'comicUc') {
    const ta = $('comicUc');
    if (ta) insertAtCursor(ta, textToInsert);
    toast(`已插入排除词：${item.title}`);
  }
}

/* 把片段应用到主工作区（或调用来源）；成功后关闭片段库 */
function applyLibItem(item) {
  const kind = item.kind;
  if (lib.target) {
    handleTargetContextInsert(item, kind, lib.target);
    closePromptLibrary();
    return;
  }

  const content = String(item.content || '').trim();
  if (kind !== 'character' && !content) return toast('该片段内容为空', true);
  const inp = $('promptInp');

  if (kind === 'painter') {
    if (inp.value.includes(content)) return toast(`提示词里已包含：${item.title}`);
    insertAtCursor(inp, content);
    toast(`已插入画师串：${item.title}`);
  } else if (kind === 'action') {
    // 有选区时替换选区，否则追加在末尾
    if (document.activeElement === inp && inp.selectionStart !== inp.selectionEnd) {
      insertAtCursor(inp, content);
    } else {
      const val = inp.value.trim();
      inp.value = val ? `${val.replace(/,+$/, '')}, ${content}` : content;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    toast(`已追加动作串：${libDisplayTitle(item, kind)}`);
  } else if (kind === 'main') {
    if (inp.value.trim() && inp.value.trim() !== content && !confirm(`应用主串【${item.title}】将替换当前提示词的所有内容，确定继续吗？`)) return;
    inp.value = content;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    toast(`已替换为主串：${item.title}`);
  } else if (kind === 'uc') {
    insertAtCursor($('ucInp'), content);
    toast(`已插入 UC：${item.title}`);
  } else if (kind === 'character') {
    if (CHARS.length >= 22) return toast('角色上限为 22 个，无法继续添加', true);
    const c = parseLibCharContent(item);
    CHARS.push({ prompt: formatCharPromptXxxIp(c.prompt.trim()), uc: c.uc.trim(), x: c.x, y: c.y });
    activeCharIndex = CHARS.length - 1;
    renderChars();
    toast(`已将角色【${libDisplayTitle(item, kind)}】导入至独立角色面板`);
  }
  closePromptLibrary();
}

function bindPromptLibrary() {
  $('promptLibBtn')?.addEventListener('click', () => openPromptLibrary('painter'));
  $('ucLibBtn')?.addEventListener('click', () => openPromptLibrary('uc'));
  $('charFromLibBtn')?.addEventListener('click', () => openPromptLibrary('character'));

  const modal = $('promptLibModal');
  $('promptLibCloseBtn').addEventListener('click', closePromptLibrary);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePromptLibrary();
  });
  $('promptLibTabNav').addEventListener('click', (e) => {
    const tab = e.target.closest('.pl-kind');
    if (tab) switchPromptLibKind(tab.dataset.kind);
  });
  $('plGroups').addEventListener('click', (e) => {
    const chip = e.target.closest('.pl-group');
    if (!chip) return;
    writeLibGroup(lib.kind, chip.dataset.group);
    $('plBody').scrollTop = 0;
    renderLibrary();
  });

  let searchTimer = 0;
  $('plSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { lib.query = e.target.value.trim(); renderLibrary(); }, 80);
  });
  $('plSearch').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(searchTimer);
    lib.query = e.target.value.trim();
    renderLibrary();
    $('libItemsList').querySelector('.pl-card')?.click();
  });
  $('plNewBtn').addEventListener('click', () => openLibEditor(null));
  $('plExportBtn').addEventListener('click', exportLibrary);
  $('plImportBtn').addEventListener('click', () => $('plImportFile').click());
  $('plImportFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) importLibraryFile(file);
  });

  // 卡片点击统一委托：按钮执行对应操作，点卡片其余位置即插入
  const list = $('libItemsList');
  list.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-act]');
    if (actBtn?.dataset.act === 'new') return openLibEditor(null);
    if (actBtn?.dataset.act === 'retry') return loadLibrary();
    const card = e.target.closest('.pl-card');
    const item = card && lib.items.find((it) => it.id === Number(card.dataset.id));
    if (!item) return;
    if (actBtn) {
      e.stopPropagation();
      libCardAction(actBtn.dataset.act, item);
    } else if (lib.armedDelete !== null) {
      disarmLibDelete();
      renderLibrary();
    } else {
      applyLibItem(item);
    }
  });
  list.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('pl-card')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // Esc 逐级退出：编辑器 → 搜索词 → 关闭弹窗；“/” 聚焦搜索
  modal.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea, select');
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (lib.editing) { closeLibEditor(); renderLibrary(); return; }
      if (lib.query || (e.target === $('plSearch') && $('plSearch').value)) {
        $('plSearch').value = '';
        lib.query = '';
        renderLibrary();
        return;
      }
      closePromptLibrary();
    } else if (e.key === '/' && !typing) {
      e.preventDefault();
      $('plSearch').focus();
    }
  });
}

/* ═════════════════════════════════════════════════════════════
   历史作品画廊
   ═════════════════════════════════════════════════════════════ */
let historyById = new Map();

function historyCellHtml(it) {
  if (it.status !== 'ok' || !it.file) {
    return `<div class="hist-cell failed">${esc(it.error ? `✗ ${it.error.slice(0, 50)}` : '✗ 失败')}</div>`;
  }
  const chars = getRecordChars(it);
  const badgeHtml = chars.length ? `<span class="hist-badge" title="${chars.length} 个独立角色">👤×${chars.length}</span>` : '';
  const favBadge = it.is_favorited ? `<span class="hist-fav-badge" title="已收藏">❤️</span>` : '';
  return `<div class="hist-cell" data-id="${it.id}" title="${esc(`点击查看大图与参数\n${it.prompt}`)}">
          ${badgeHtml}
          ${favBadge}
          <img src="/thumb/${esc(it.file)}" loading="lazy" decoding="async">
          <div class="hist-overlay">
            <button type="button" class="btn tiny ghost-btn hist-quick-reuse" title="复用参数">⚙️</button>
            <button type="button" class="btn tiny ghost-btn hist-quick-dl" title="下载原图">⬇</button>
          </div>
          <div class="cap">${esc(it.model.replace('nai-diffusion-', ''))} · ${it.width}×${it.height}</div>
        </div>`;
}

/** 历史网格点击统一委托：复用参数 / 下载原图 / 打开灯箱 */
function bindHistoryGrid() {
  $('histGrid').addEventListener('click', (e) => {
    const it = historyById.get(Number(e.target.closest('.hist-cell[data-id]')?.dataset.id));
    if (!it) return;
    if (e.target.closest('.hist-quick-reuse')) {
      reuseAllParams(it);
      toast('已复用该图参数');
    } else if (e.target.closest('.hist-quick-dl')) {
      const a = document.createElement('a');
      a.href = `/img/${it.file}`;
      a.download = `nai-${it.seed || 'image'}.png`;
      a.click();
    } else {
      openLightbox(it);
    }
  });
}

async function loadHistory() {
  try {
    const j = await api('/api/history?limit=60');
    const grid = $('histGrid');
    historyById = new Map(j.items.map((it) => [it.id, it]));
    grid.innerHTML = j.items.length
      ? j.items.map(historyCellHtml).join('')
      : '<div style="color:var(--text-dim);font-size:12px;padding:12px;">暂无生成记录</div>';
  } catch {}
}

/* ═════════════════════════════════════════════════════════════
   密钥池：顶栏 Anlas 徽章、概况弹窗、管理后台「PST 密钥池」页共用一份快照
   快照先读数据库（秒开），再按需向 NovelAI 实时同步。
   ═════════════════════════════════════════════════════════════ */
const pool = {
  data: null,        // { items, summary, nextFreeKeyId, live, errors, refreshedAt }
  syncing: false,
  editing: null,     // 正在行内编辑的密钥 id
  armedDelete: null,
  armedTimer: 0,
};
const NAI_TIER_NAMES = ['Paper', 'Tablet', 'Scroll', 'Opus'];

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');

/** 解析 SQLite 的 UTC 时间（YYYY-MM-DD HH:MM:SS）或 ISO 字符串 */
function parseServerTime(s) {
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? new Date(`${s.replace(' ', 'T')}Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function timeAgo(s) {
  const d = parseServerTime(s);
  if (!d) return '从未';
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

function keyStatus(k) {
  const state = String(k.verify_state || '');
  if (state.startsWith('invalid')) return { cls: 'bad', text: '失效', title: state.slice(8) || '验证未通过' };
  if (!k.is_active) return { cls: 'off', text: '已停用', title: '手动停用，不参与调度' };
  if (!state) return { cls: 'warn', text: '未验证', title: '尚未成功查询过订阅' };
  return { cls: 'ok', text: '正常', title: '参与调度' };
}

function expiryInfo(sec) {
  if (!sec) return { cls: '', text: '—' };
  const ms = sec * 1000;
  const days = Math.ceil((ms - Date.now()) / 86400000);
  const date = new Date(ms).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  if (days < 0) return { cls: 'bad', text: `已过期 ${date}` };
  if (days <= 7) return { cls: 'warn', text: `${days} 天后到期` };
  return { cls: '', text: date };
}

function batteryHtml(v) {
  if (typeof v !== 'number') {
    return `<div class="battery-row"><span class="battery-label">${icon('battery')}V5 充能</span><span class="battery"></span><b class="battery-val">—</b></div>`;
  }
  const cls = v > 100 ? 'over' : v > 40 ? 'ok' : v > 5 ? 'warn' : 'low';
  const note = v > 100 ? '超充' : v <= 5 ? '保护中' : '';
  return `<div class="battery-row" title="V5 充能 ${v}%${note ? `（${note}）` : ''}">
      <span class="battery-label">${icon('battery')}V5 充能</span>
      <span class="battery"><i class="${cls}" style="width:${Math.min(100, Math.max(3, v))}%"></i></span>
      <b class="battery-val ${cls}">${v}%</b>${note ? `<span class="battery-note ${cls}">${note}</span>` : ''}
    </div>`;
}

function poolStatsHtml(s) {
  const tile = (name, label, value, sub, cls = '') => `<div class="pool-stat ${cls}">
      <span class="pool-stat-icon">${icon(name)}</span>
      <div class="pool-stat-body"><div class="pool-stat-val">${value}</div><div class="pool-stat-label">${label}</div><div class="pool-stat-sub">${sub}</div></div>
    </div>`;
  const down = s.total - s.healthy;
  return [
    tile('key', '可用节点', `${s.healthy}<small>/${s.total}</small>`, s.total ? (down ? `${down} 个停用或失效` : '全部正常') : '还没有添加密钥', s.total && !s.healthy ? 'bad' : ''),
    tile('gem', '全池 Anlas', fmtNum(s.totalAnlas), '仅统计可用节点'),
    tile('battery', 'V5 平均充能', s.avgBattery == null ? '—' : `${s.avgBattery}%`, `${s.opus} 个 Opus 节点`),
    tile('zap', '可免费出图', `${s.freeReady}<small>/${s.opus}</small>`,
      !s.opus ? '没有 Opus 节点' : s.freeReady ? '充能 > 5% 的 Opus' : '全部保护中，出图将扣 Anlas',
      s.opus && !s.freeReady ? 'warn' : ''),
  ].join('');
}

function keyCardHtml(k, { manage = false } = {}) {
  const d = pool.data || {};
  const st = keyStatus(k);
  const email = k.email || (k.label?.includes('@') ? k.label : '');
  const exp = expiryInfo(k.expires_at);
  const editing = manage && pool.editing === k.id;
  const armed = pool.armedDelete === k.id;
  const error = d.errors?.[k.id];
  const tier = NAI_TIER_NAMES[k.tier] || '未知';
  const head = editing
    ? `<input class="styled-admin-input key-edit-label" value="${esc(k.label)}" maxlength="60" placeholder="备注标签" aria-label="备注标签">`
    : `<b class="key-label" title="${esc(k.label)}">${esc(k.label)}</b>`;
  const sub = editing
    ? `<input class="styled-admin-input key-edit-email" value="${esc(email)}" maxlength="120" placeholder="账号邮箱（选填）" aria-label="账号邮箱">`
    : `<span class="key-email">${email ? esc(email) : '<span class="pl-muted">未绑定邮箱</span>'}</span>`;
  const actions = !manage ? '' : editing
    ? `<div class="key-actions"><span></span><div>
        <button type="button" class="btn ghost-btn tiny" data-act="cancel">取消</button>
        <button type="button" class="btn primary tiny" data-act="save">${icon('check')}<span>保存</span></button></div></div>`
    : `<div class="key-actions"><span class="pl-muted" title="余额与充能的最近同步时间">同步于 ${timeAgo(k.anlas_checked_at)}</span><div>
        <button type="button" class="pl-act" data-act="edit" title="编辑备注 / 邮箱" aria-label="编辑">${icon('edit')}</button>
        <button type="button" class="pl-act" data-act="verify" title="重新验证（通过后自动启用）" aria-label="测试">${icon('activity')}</button>
        <button type="button" class="pl-act" data-act="toggle" title="${k.is_active ? '停用' : '启用'}" aria-label="${k.is_active ? '停用' : '启用'}">${icon('power')}</button>
        <button type="button" class="pl-act danger${armed ? ' armed' : ''}" data-act="del" title="${armed ? '再点一次确认删除' : '删除'}" aria-label="删除">${icon('trash')}${armed ? '<span>确认删除</span>' : ''}</button>
      </div></div>`;
  return `<article class="key-card ${st.cls}${editing ? ' is-editing' : ''}" data-id="${k.id}">
      <div class="key-card-head">
        <span class="key-status ${st.cls}" title="${esc(st.title)}">${st.text}</span>
        ${head}
        ${k.id === d.nextFreeKeyId ? `<span class="key-next" title="下一张免费 V5 图会优先派给这个节点">${icon('zap')}优先</span>` : ''}
        <span class="key-tier${k.tier === 3 ? ' opus' : ''}">${esc(tier)}</span>
      </div>
      <div class="key-sub">${sub}<code title="密钥预览">${esc(k.token_preview || '')}</code></div>
      ${batteryHtml(k.v5_battery)}
      <div class="key-facts">
        <span><em>Anlas</em><b>${k.anlas == null ? '—' : fmtNum(k.anlas)}</b></span>
        <span><em>调用</em><b>${fmtNum(k.use_count)}</b></span>
        <span><em>最近使用</em><b>${timeAgo(k.last_used_at)}</b></span>
        <span class="${exp.cls}"><em>订阅到期</em><b>${exp.text}</b></span>
      </div>
      ${error ? `<div class="key-error">${icon('alert')}<span>同步失败：${esc(error)}</span></div>` : ''}
      ${actions}
    </article>`;
}

function poolSyncText(d, { syncing = false } = {}) {
  if (!d) return '读取中…';
  if (syncing) return '正在向 NovelAI 同步余额与充能…';
  if (d.live && d.refreshedAt) return `已实时同步 · ${timeAgo(d.refreshedAt)}`;
  const latest = d.items.map((k) => k.anlas_checked_at).filter(Boolean).sort().at(-1);
  return latest ? `数据同步于 ${timeAgo(latest)}` : '尚未同步';
}

function applyPoolData(d) {
  pool.data = d;
  $('anlasBadge').textContent = `${fmtNum(d.summary.totalAnlas)} Anlas`;
  $('anlasBtn').title = `密钥池：${d.summary.healthy}/${d.summary.total} 个节点可用 · 可免费出图 ${d.summary.freeReady} 个`;
  renderPoolViews();
}

/** 只重绘当前可见的视图 */
function renderPoolViews() {
  const d = pool.data;
  if (!d) return;
  const sync = poolSyncText(d, { syncing: pool.syncing });
  document.querySelectorAll('.pool-sync-btn').forEach((b) => {
    b.disabled = pool.syncing;
    b.classList.toggle('spinning', pool.syncing);
  });
  if (!$('poolModal').classList.contains('hidden')) {
    $('poolModalSync').textContent = sync;
    $('poolModalStats').innerHTML = poolStatsHtml(d.summary);
    const keys = [...d.items].sort((a, b) => (b.id === d.nextFreeKeyId) - (a.id === d.nextFreeKeyId)
      || (keyStatus(a).cls === 'ok' ? 0 : 1) - (keyStatus(b).cls === 'ok' ? 0 : 1) || a.id - b.id);
    $('poolModalKeys').innerHTML = keys.length
      ? keys.map((k) => keyCardHtml(k)).join('')
      : `<div class="pl-empty">${icon('key')}<b>池中还没有密钥</b><span>到管理后台添加 NovelAI PST 后，这里会显示余额与充能</span></div>`;
  }
  if (!$('adminModal').classList.contains('hidden') && !$('tab-keys').classList.contains('hidden')) {
    $('poolSyncInfo').textContent = sync;
    $('poolStats').innerHTML = poolStatsHtml(d.summary);
    $('keysList').innerHTML = d.items.length
      ? d.items.map((k) => keyCardHtml(k, { manage: true })).join('')
      : `<div class="pl-empty">${icon('key')}<b>还没有添加 PST 密钥</b><span>添加后会自动验证并同步订阅等级、Anlas 余额与 V5 充能</span></div>`;
    if (!d.items.length) $('keyAddForm').classList.remove('hidden');
  }
}

async function loadPoolBadge() {
  try { applyPoolData(await api('/api/anlas?cached=1')); } catch { /* 徽章保持“查询额度” */ }
}

/** 向 NovelAI 实时查询；force=true 跳过服务端 30 秒缓存 */
async function syncPool(force = false) {
  if (pool.syncing) return;
  pool.syncing = true;
  renderPoolViews();
  try {
    const d = await api(`/api/anlas${force ? '?refresh=1' : ''}`);
    pool.syncing = false;
    applyPoolData(d);
    const failed = Object.keys(d.errors || {}).length;
    if (force) toast(failed ? `同步完成，${failed} 个节点查询失败` : '已同步最新余额与充能', failed > 0);
  } catch (e) {
    pool.syncing = false;
    renderPoolViews();
    toast(e.message, true);
  }
}

async function showPoolModal() {
  $('poolModal').classList.remove('hidden');
  if (pool.data) renderPoolViews();
  else {
    $('poolModalSync').textContent = '读取中…';
    $('poolModalStats').innerHTML = '';
    $('poolModalKeys').innerHTML = '<div class="pl-empty pl-loading"><span class="pl-spinner"></span><span>读取密钥池…</span></div>';
    await loadPoolBadge();
  }
  syncPool(false);
}

function closePoolModal() {
  $('poolModal').classList.add('hidden');
}

async function loadKeys() {
  try {
    const d = await api('/api/admin/keys');
    // 管理页的快照来自数据库；沿用上次实时同步得到的错误信息直到下次同步
    applyPoolData({ ...d, live: false, errors: pool.data?.errors || {}, refreshedAt: pool.data?.refreshedAt });
  } catch (e) { toast(e.message, true); }
}

async function keyAction(id, body, okMsg) {
  try {
    const j = await api(`/api/admin/keys/${id}`, { method: 'POST', body: JSON.stringify(body) });
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(j) : okMsg, j?.verify && !j.verify.ok);
    if (pool.data?.errors) delete pool.data.errors[id];
  } catch (e) { toast(e.message, true); }
  await loadKeys();
}

function disarmKeyDelete() {
  clearTimeout(pool.armedTimer);
  pool.armedDelete = null;
}

function bindPoolViews() {
  $('anlasBtn').addEventListener('click', showPoolModal);
  $('poolModalClose').addEventListener('click', closePoolModal);
  $('poolModal').addEventListener('click', (e) => { if (e.target === $('poolModal')) closePoolModal(); });
  document.querySelectorAll('.pool-sync-btn').forEach((b) => b.addEventListener('click', () => syncPool(true)));
  $('poolManageBtn').addEventListener('click', () => {
    closePoolModal();
    $('adminModal').classList.remove('hidden');
    document.querySelector('#adminModal .admin-tab-nav .nav-tab[data-tab=keys]').click();
  });

  // 添加密钥
  $('keyAddToggle').addEventListener('click', () => {
    const form = $('keyAddForm');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) $('keyLabel').focus();
  });
  $('keyAddCancel').addEventListener('click', () => $('keyAddForm').classList.add('hidden'));
  $('keyPasteBtn').addEventListener('click', async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) {
        $('keyToken').value = txt.trim();
        toast('已从剪贴板粘贴密钥');
      }
    } catch {
      $('keyToken').focus();
      toast('请使用 Ctrl+V 粘贴至输入框');
    }
  });
  $('keyAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('keyAdd');
    btn.disabled = true;
    try {
      const j = await api('/api/admin/keys', {
        method: 'POST',
        body: JSON.stringify({ label: $('keyLabel').value.trim(), token: $('keyToken').value.trim(), email: $('keyEmail').value.trim() }),
      });
      toast(j.verify?.ok ? '密钥验证通过，已加入密钥池' : `已入库但验证未通过：${j.verify?.error || ''}`, !j.verify?.ok);
      $('keyAddForm').reset();
      $('keyAddForm').classList.add('hidden');
      loadKeys();
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  });

  // 测试全部：逐个重新验证，通过的自动启用，失败的停用
  $('adminTestAllBtn').addEventListener('click', async () => {
    const btn = $('adminTestAllBtn');
    btn.disabled = true;
    btn.classList.add('spinning');
    try {
      const j = await api('/api/admin/keys/test-all', { method: 'POST' });
      const pass = j.results.filter((r) => r.ok).length;
      toast(`测试完成：${pass}/${j.results.length} 个可用`, pass < j.results.length);
      if (pool.data) pool.data.errors = {};
      await loadKeys();
      loadStats();
    } catch (e) { toast(e.message, true); }
    finally {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  });

  // 密钥卡片操作统一委托
  const list = $('keysList');
  const saveEdit = (card, id) => {
    const label = card.querySelector('.key-edit-label').value.trim();
    if (!label) return toast('备注标签不能为空', true);
    pool.editing = null;
    keyAction(id, { action: 'edit', label, email: card.querySelector('.key-edit-email').value.trim() }, '已保存');
  };
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('.key-card');
    if (!btn || !card) return;
    const id = Number(card.dataset.id);
    const k = pool.data?.items.find((x) => x.id === id);
    if (!k) return;
    const act = btn.dataset.act;
    if (act !== 'del') disarmKeyDelete();
    if (act === 'edit') {
      pool.editing = id;
      renderPoolViews();
      list.querySelector(`.key-card[data-id="${id}"] .key-edit-label`)?.focus();
    } else if (act === 'cancel') {
      pool.editing = null;
      renderPoolViews();
    } else if (act === 'save') {
      saveEdit(card, id);
    } else if (act === 'verify') {
      btn.disabled = true;
      btn.classList.add('spinning');
      keyAction(id, { action: 'verify' }, (j) => (j.verify?.ok ? `「${k.label}」验证通过` : `「${k.label}」验证失败：${j.verify?.error || ''}`));
    } else if (act === 'toggle') {
      keyAction(id, { action: 'toggle' }, k.is_active ? `已停用「${k.label}」` : `已启用「${k.label}」`);
    } else if (act === 'del') {
      if (pool.armedDelete !== id) {
        disarmKeyDelete();
        pool.armedDelete = id;
        pool.armedTimer = setTimeout(() => { pool.armedDelete = null; renderPoolViews(); }, 4000);
        return renderPoolViews();
      }
      disarmKeyDelete();
      api(`/api/admin/keys/${id}`, { method: 'DELETE' })
        .then(() => toast(`已删除「${k.label}」`))
        .catch((err) => toast(err.message, true))
        .finally(loadKeys);
    }
  });
  list.addEventListener('keydown', (e) => {
    const card = e.target.closest('.key-card.is-editing');
    if (!card) return;
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(card, Number(card.dataset.id)); }
    if (e.key === 'Escape') { e.stopPropagation(); pool.editing = null; renderPoolViews(); }
  });
}

/* ═════════════════════════════════════════════════════════════
   管理员管理后台弹窗
   ═════════════════════════════════════════════════════════════ */
function bindAdminModal() {
  $('adminOpenBtn').addEventListener('click', () => {
    $('adminModal').classList.remove('hidden');
    loadActiveAdminTab();
  });
  $('adminCloseBtn').addEventListener('click', () => $('adminModal').classList.add('hidden'));
  bindUsersTable();
  bindTiersTab();
  $('gensTbl').querySelector('tbody').addEventListener('click', (e) => {
    const g = adminGensById.get(Number(e.target.closest('tr[data-id]')?.dataset.id));
    if (!g) return;
    if (e.target.closest('.thumb')) {
      openLightbox(g);
    } else if (e.target.closest('.act-del-gen')) {
      if (!confirm('确定删除此全站记录？')) return;
      api(`/api/admin/generations/${g.id}`, { method: 'DELETE' })
        .then(() => { toast('已删除记录'); loadGens(); loadStats(); })
        .catch((err) => toast(err.message, true));
    }
  });
  $('adminModal').addEventListener('click', (e) => {
    if (e.target === $('adminModal')) $('adminModal').classList.add('hidden');
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('adminModal').classList.add('hidden');
      $('profileModal').classList.add('hidden');
      $('lightboxModal').classList.add('hidden');
      closePoolModal();
      closePromptLibrary();
    }
  });

  document.querySelectorAll('#adminModal .admin-tab-nav .nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#adminModal .admin-tab-nav .nav-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
      $(`tab-${tab.dataset.tab}`).classList.remove('hidden');
      loadActiveAdminTab();
    });
  });

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch {
      prompt('复制以下内容：', text);
    }
  };
  const updatePluginBaseUrl = () => {
    const origin = location.origin;
    if ($('pluginBaseUrlText')) $('pluginBaseUrlText').textContent = origin;
    if ($('pluginBaseUrl')) $('pluginBaseUrl').value = origin;
  };
  updatePluginBaseUrl();
  $('pluginCopyUrl')?.addEventListener('click', () => copyText(location.origin));
  $('pluginCopyRepoBtn')?.addEventListener('click', () => copyText('https://github.com/baibai-git/ST-BaiBai-Image'));
  $('pluginCopyToken')?.addEventListener('click', () => {
    const val = $('pluginTokenOnceVal')?.textContent || '';
    if (val) copyText(val);
  });
  $('pluginTokenAdd')?.addEventListener('click', async () => {
    const label = ($('pluginTokenLabel')?.value || '').trim() || '柏宝绘';
    try {
      const j = await api('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ label }) });
      const box = $('pluginTokenOnce');
      const val = $('pluginTokenOnceVal');
      if (box && val) {
        box.classList.remove('hidden');
        val.textContent = j.token;
      }
      if ($('pluginTokenLabel')) $('pluginTokenLabel').value = '';
      loadPluginTokens();
      toast('Token 已生成，请立即复制');
    } catch (e) { toast(e.message, true); }
  });

  $('userAdd').addEventListener('click', async () => {
    const username = $('newUserName').value.trim();
    const password = $('newUserPass').value;
    const role = $('newUserRole').value;
    const tierId = $('newUserTier')?.value || undefined;
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, role, tierId }) });
      toast(`用户 ${username} 创建成功`);
      $('newUserName').value = '';
      $('newUserPass').value = '';
      loadUsers();
    } catch (e) { toast(e.message, true); }
  });
}

/** 管理后台按需加载：只拉取当前可见的标签页（原先登录即拉 5 个接口并渲染 200 行记录表） */
function loadActiveAdminTab() {
  const loaders = { keys: loadKeys, users: loadUsers, tiers: loadTiers, gens: loadGens, stats: loadStats, plugin: loadPluginTokens };
  const active = document.querySelector('#adminModal .admin-tab-nav .nav-tab.active')?.dataset.tab || 'keys';
  return loaders[active]?.();
}

async function loadPluginTokens() {
  const tb = $('pluginTokTbl')?.querySelector('tbody');
  if (!tb) return;
  try {
    const j = await api('/api/admin/tokens');
    tb.innerHTML = '';
    for (const t of j.items || []) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${t.id}</td>
        <td>${esc(t.label || '')}</td>
        <td class="mono">${esc(t.token_prefix)}…</td>
        <td>${esc(t.last_used_at || '—')}</td>
        <td>${esc(t.created_at || '')}</td>
        <td><button class="act-dl">撤销</button></td>`;
      tr.querySelector('.act-dl').addEventListener('click', () => {
        if (!confirm('撤销后插件将无法再调用 API')) return;
        api(`/api/admin/tokens/${t.id}`, { method: 'DELETE' }).then(loadPluginTokens).catch((e) => toast(e.message, true));
      });
      tb.appendChild(tr);
    }
  } catch (e) { toast(e.message, true); }
}

let adminTiers = [];

async function fetchTiers() {
  const j = await api('/api/admin/tiers');
  adminTiers = j.items || [];
  const sel = $('newUserTier');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = adminTiers.map((t) => `<option value="${t.id}">${esc(t.name)}${t.is_default ? '（默认）' : ''}</option>`).join('');
    if (prev && adminTiers.some((t) => String(t.id) === prev)) sel.value = prev;
    else sel.value = String(adminTiers.find((t) => t.is_default)?.id || '');
  }
  return adminTiers;
}

/** 用量条：used / max（max 为 null 表示不限） */
function usageBarHtml(label, used, max) {
  const ratio = max == null ? 0 : max === 0 ? 1 : Math.min(1, used / max);
  const cls = ratio >= 1 ? 'full' : ratio >= 0.8 ? 'warn' : '';
  return `<div class="usage-line" title="${esc(label)}：${used} / ${max == null ? '不限' : max}">
      <span class="usage-label">${esc(label)}</span>
      <span class="usage-bar"><i class="${cls}" style="width:${Math.round(ratio * 100)}%"></i></span>
      <span class="usage-num">${used}<small>/${max == null ? '∞' : max}</small></span>
    </div>`;
}

let adminUsersById = new Map();
async function loadUsers() {
  try {
    const [j] = await Promise.all([api('/api/admin/users'), fetchTiers()]);
    adminUsersById = new Map(j.items.map((u) => [u.id, u]));
    const tierOptions = (selected) => adminTiers.map((t) => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    $('usersTbl').querySelector('tbody').innerHTML = j.items.map((u) => {
      const isAdm = u.role === 'admin';
      const hasOverride = u.limit_per_day_override != null || u.anlas_per_month_override != null;
      const overrideTxt = [
        u.limit_per_day_override != null ? `${u.limit_per_day_override} 张/天` : null,
        u.anlas_per_month_override != null ? `${u.anlas_per_month_override} Anlas/月` : null,
      ].filter(Boolean).join(' · ');
      return `<tr data-id="${u.id}">
        <td><div class="user-cell"><span class="avatar-dot">${esc(Array.from(u.username)[0].toUpperCase())}</span><div><b>${esc(u.username)}</b><small>#${u.id} · ${esc(String(u.created_at).slice(0, 10))}</small></div></div></td>
        <td>${isAdm ? '<span class="role-badge admin">管理员</span>' : `<select class="tier-select act-tier">${tierOptions(u.tier_id)}</select>`}</td>
        <td>${u.disabled ? '<span class="status-dot off">已封禁</span>' : '<span class="status-dot on">正常</span>'}</td>
        <td class="usage-cell">${isAdm
          ? `<span class="muted-note">不受额度限制 · 累计 ${u.total_ok || 0} 张</span>`
          : usageBarHtml('24h 出图', u.d1 || 0, u.limit_per_day) + (u.anlas_per_month > 0 ? usageBarHtml('本月 Anlas', u.anlas_month || 0, u.anlas_per_month) : '')
            + `<div class="usage-sub">近 1 分钟 ${u.m1 || 0}${u.limit_per_minute != null ? '/' + u.limit_per_minute : ''} · 近 1 小时 ${u.h1 || 0}${u.limit_per_hour != null ? '/' + u.limit_per_hour : ''} · 累计 ${u.total_ok || 0}</div>`}</td>
        <td>${isAdm ? '<span class="muted-note">—</span>' : `<button class="btn tiny ghost-btn act-quota" title="单独设置该用户的每日额度">${hasOverride ? esc(overrideTxt) : '跟随等级'} ✎</button>`}</td>
        <td class="row-actions">
          <button class="btn tiny ghost-btn act-rn">改名</button>
          <button class="btn tiny ghost-btn act-rw">${isAdm ? '降为用户' : '设为管理'}</button>
          <button class="btn tiny ghost-btn act-ds">${u.disabled ? '解禁' : '封禁'}</button>
          <button class="btn tiny ghost-btn act-pw">改密</button>
          ${!isAdm ? '<button class="btn tiny ghost-btn act-reset-quota" title="清零分钟/小时/每日出图计数（不影响本月 Anlas）">重置计数</button>' : ''}
        </td>
      </tr>`;
    }).join('');
  } catch (e) { toast(e.message, true); }
}

function updateUser(id, body, okMsg) {
  return api(`/api/admin/users/${id}`, { method: 'POST', body: JSON.stringify(body) })
    .then(() => { if (okMsg) toast(okMsg); loadUsers(); })
    .catch((e) => { toast(e.message, true); loadUsers(); });
}

/** 用户表交互统一委托（只绑定一次） */
function bindUsersTable() {
  const tbody = $('usersTbl').querySelector('tbody');
  tbody.addEventListener('change', (e) => {
    const sel = e.target.closest('.act-tier');
    if (!sel) return;
    const u = adminUsersById.get(Number(sel.closest('tr').dataset.id));
    const tier = adminTiers.find((t) => String(t.id) === sel.value);
    u.tier_id = Number(sel.value); // 先更新本地数据，列表刷新前打开的额度弹窗也不会显示旧等级
    updateUser(u.id, { tierId: u.tier_id }, `已将 ${u.username} 调整为「${tier?.name}」`);
  });
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    const u = btn && adminUsersById.get(Number(btn.closest('tr')?.dataset.id));
    if (!u) return;
    if (btn.classList.contains('act-rn')) {
      const name = prompt('输入新的用户名 (2-20位)：', u.username);
      if (name && name.trim()) updateUser(u.id, { username: name.trim() }, '用户名已修改');
    } else if (btn.classList.contains('act-rw')) {
      updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });
    } else if (btn.classList.contains('act-ds')) {
      updateUser(u.id, { disabled: !u.disabled });
    } else if (btn.classList.contains('act-pw')) {
      const pw = prompt('新密码 (≥8 位)：');
      if (pw) updateUser(u.id, { password: pw }, '密码已重置');
    } else if (btn.classList.contains('act-reset-quota')) {
      if (!confirm(`确定重置用户「${u.username}」的出图计数吗？\n此前的生成不再计入分钟/小时/每日张数限制，用户可立即恢复出图。\n本月 Anlas 用量不受影响；如需追加 Anlas，请调高该用户的月度额度。`)) return;
      updateUser(u.id, { resetQuota: true }, `已重置 ${u.username} 的用量`);
    } else if (btn.classList.contains('act-quota')) {
      openQuotaDialog(u);
    }
  });
}

/** 单人额度覆盖：留空 = 跟随等级 */
function openQuotaDialog(u) {
  if (document.querySelector('.quota-dialog')) return;
  const tier = adminTiers.find((t) => t.id === u.tier_id);
  const bg = document.createElement('div');
  bg.className = 'modal-backdrop';
  bg.innerHTML = `
    <form class="modal-window quota-dialog">
      <div class="modal-title-row"><h3>单独设置额度 · ${esc(u.username)}</h3></div>
      <p class="dialog-hint">留空表示跟随所在等级「${esc(tier?.name || '')}」（每天 ${tier?.limit_per_day ?? '不限'} 张 · 每月 ${tier?.anlas_per_month ?? 0} Anlas）。</p>
      <label class="form-row"><span>每天最多出图（张）</span>
        <input class="styled-admin-input" name="day" type="number" min="0" placeholder="跟随等级" value="${u.limit_per_day_override ?? ''}"></label>
      <label class="form-row"><span>每月最多消耗 Anlas（每月 1 日重置）</span>
        <input class="styled-admin-input" name="anlas" type="number" min="0" placeholder="跟随等级" value="${u.anlas_per_month_override ?? ''}"></label>
      <div class="modal-actions">
        <button type="button" class="btn ghost-btn" data-act="cancel">取消</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`;
  document.body.appendChild(bg);
  const form = bg.querySelector('form');
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.dataset.act === 'cancel') close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { limitPerDayOverride: form.elements.day.value, anlasPerMonthOverride: form.elements.anlas.value };
    close();
    await updateUser(u.id, body, '额度已保存');
  });
  form.day.focus();
}

/* ─── 用户等级管理 ─────────────────────────────────────── */
const PIXEL_PRESETS = [
  [1048576, '1MP · 1024×1024（Opus 免费上限）'],
  [1572864, '1.5MP · 1024×1536'],
  [2359296, '2.25MP · 1536×1536（最大）'],
];

function tierCardHtml(t, isNew = false) {
  const pixelOptions = [...PIXEL_PRESETS];
  if (!pixelOptions.some(([v]) => v === t.max_pixels)) pixelOptions.push([t.max_pixels, `${Number((t.max_pixels / 1048576).toFixed(2))}MP（自定义）`]);
  const num = (name, value, attrs = '') => `<input class="styled-admin-input" name="${name}" type="number" ${attrs} value="${value ?? ''}">`;
  return `<form class="tier-card${isNew ? ' is-new' : ''}" data-id="${isNew ? '' : t.id}">
    <div class="tier-card-head">
      <input class="tier-name-input" name="name" maxlength="20" value="${esc(t.name)}" placeholder="等级名称" required>
      <span class="tier-meta">${isNew ? '新等级' : `${t.user_count || 0} 位用户`}${t.is_default ? ' · <b>默认</b>' : ''}</span>
    </div>
    <div class="tier-grid">
      <label><span>最大分辨率</span><select class="styled-admin-select" name="max_pixels">${pixelOptions.map(([v, l]) => `<option value="${v}"${v === t.max_pixels ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><span>最大步数</span>${num('max_steps', t.max_steps, 'min="1" max="50" required')}</label>
      <label><span>单次最多张数</span>${num('max_samples', t.max_samples, 'min="1" max="8" required')}</label>
      <label><span>每月 Anlas 额度</span>${num('anlas_per_month', t.anlas_per_month, 'min="0" required')}<small>0 = 只能用免费参数 · 每月 1 日重置</small></label>
      <label><span>每分钟上限（张）</span>${num('limit_per_minute', t.limit_per_minute, 'min="0" placeholder="不限"')}</label>
      <label><span>每小时上限（张）</span>${num('limit_per_hour', t.limit_per_hour, 'min="0" placeholder="不限"')}</label>
      <label><span>每天上限（张）</span>${num('limit_per_day', t.limit_per_day, 'min="0" placeholder="不限"')}</label>
      <div class="tier-toggles">
        <label class="chk-container"><input type="checkbox" name="allow_img2img"${t.allow_img2img ? ' checked' : ''}><span class="chk-custom"></span><span class="chk-text">允许图生图</span></label>
        <label class="chk-container"><input type="checkbox" name="allow_inpaint"${t.allow_inpaint ? ' checked' : ''}><span class="chk-custom"></span><span class="chk-text">允许局部重绘</span></label>
      </div>
    </div>
    <div class="tier-card-actions">
      ${!isNew && !t.is_default ? '<button type="button" class="btn tiny ghost-btn danger act-del-tier">删除等级</button>' : '<span></span>'}
      <div>
        ${isNew ? '<button type="button" class="btn tiny ghost-btn act-cancel-tier">取消</button>' : ''}
        <button type="submit" class="btn tiny primary">${isNew ? '创建等级' : '保存修改'}</button>
      </div>
    </div>
  </form>`;
}

function readTierForm(form) {
  const v = (name) => form.elements[name].value.trim();
  const nullable = (name) => (v(name) === '' ? null : Number(v(name)));
  return {
    name: v('name'),
    max_pixels: Number(v('max_pixels')),
    max_steps: Number(v('max_steps')),
    max_samples: Number(v('max_samples')),
    anlas_per_month: Number(v('anlas_per_month') || 0),
    limit_per_minute: nullable('limit_per_minute'),
    limit_per_hour: nullable('limit_per_hour'),
    limit_per_day: nullable('limit_per_day'),
    allow_img2img: form.elements.allow_img2img.checked,
    allow_inpaint: form.elements.allow_inpaint.checked,
  };
}

async function loadTiers() {
  try {
    await fetchTiers();
    $('tiersList').innerHTML = adminTiers.map((t) => tierCardHtml(t)).join('');
  } catch (e) { toast(e.message, true); }
}

function bindTiersTab() {
  const list = $('tiersList');
  $('tierAddBtn').addEventListener('click', () => {
    if (list.querySelector('.tier-card.is-new')) return;
    const base = adminTiers.find((t) => t.is_default) || adminTiers[0];
    list.insertAdjacentHTML('beforeend', tierCardHtml({ ...base, name: '', is_default: 0, user_count: 0 }, true));
    list.lastElementChild.querySelector('[name=name]').focus();
  });
  list.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = readTierForm(form);
    try {
      if (form.dataset.id) {
        await api(`/api/admin/tiers/${form.dataset.id}`, { method: 'POST', body: JSON.stringify(body) });
        toast(`等级「${body.name}」已保存`);
      } else {
        await api('/api/admin/tiers', { method: 'POST', body: JSON.stringify(body) });
        toast(`已创建等级「${body.name}」`);
      }
      loadTiers();
    } catch (err) { toast(err.message, true); }
  });
  list.addEventListener('click', async (e) => {
    const form = e.target.closest('.tier-card');
    if (e.target.closest('.act-cancel-tier')) return form.remove();
    if (!e.target.closest('.act-del-tier')) return;
    const t = adminTiers.find((x) => String(x.id) === form.dataset.id);
    if (!confirm(`删除等级「${t.name}」？\n其下 ${t.user_count || 0} 位用户会移回默认等级。`)) return;
    try {
      const r = await api(`/api/admin/tiers/${t.id}`, { method: 'DELETE' });
      toast(`已删除，${r.moved} 位用户移回默认等级`);
      loadTiers();
    } catch (err) { toast(err.message, true); }
  });
}

let adminGensById = new Map();
async function loadGens() {
  try {
    const j = await api('/api/admin/generations?limit=200');
    adminGensById = new Map(j.items.map((g) => [g.id, g]));
    // 整表拼成一段 HTML 一次写入，点击统一委托（见 bindAdminModal），不再逐行建节点、绑监听
    $('gensTbl').querySelector('tbody').innerHTML = j.items.map((g) => `<tr data-id="${g.id}">
        <td>${g.id}</td><td>${esc(g.username)}</td>
        <td>${esc(g.model.replace('nai-diffusion-', ''))}</td>
        <td>${g.width}×${g.height}</td><td>${g.steps}</td>
        <td>${g.anlas_act ?? g.anlas_est}</td>
        <td>${g.status === 'ok' ? '<span style="color:var(--ok)">✓</span>' : '<span style="color:var(--err)">✗</span>'}</td>
        <td>${g.duration_ms ? (g.duration_ms / 1000).toFixed(1) + 's' : '—'}</td>
        <td>${esc(g.created_at)}</td>
        <td class="prompt-cell" title="${esc(g.prompt)}">${esc(g.prompt)}</td>
        <td>${g.file ? `<img class="thumb" src="/thumb/${esc(g.file)}" loading="lazy" decoding="async" style="cursor:pointer;" title="点击打开灯箱">` : '—'}</td>
        <td><button class="btn tiny ghost-btn act-del-gen" style="color:var(--err)">删除</button></td></tr>`).join('');
  } catch {}
}

async function loadStats() {
  try {
    const j = await api('/api/admin/stats');
    const s = j.stats;
    $('statsBox').innerHTML = `
      <div class="stat-item"><div class="stat-num">${s.total || 0}</div><div class="stat-desc">总生成次数</div></div>
      <div class="stat-item"><div class="stat-num">${s.ok || 0}</div><div class="stat-desc">成功生成</div></div>
      <div class="stat-item"><div class="stat-num">${s.failed || 0}</div><div class="stat-desc">失败次数</div></div>
      <div class="stat-item"><div class="stat-num">${s.anlas_used || 0}</div><div class="stat-desc">计费 Anlas 消耗</div></div>
      <div class="stat-item"><div class="stat-num">${s.activeKeys || 0}</div><div class="stat-desc">活跃 PST 节点</div></div>
      <div class="stat-item"><div class="stat-num">${s.users || 0}</div><div class="stat-desc">用户总数</div></div>`;
  } catch {}
}

/* ═════════════════════════════════════════════════════════════
   8. 连环画 / 分镜剧情工作室业务逻辑 (Comic Studio Workflow)
   ═════════════════════════════════════════════════════════════ */
let comicCharacters = [
  { id: 1, name: '主角 (Main)', prompt: '1girl, kitagawa marin, blonde hair, purple eyes', uc: '', pos: 'auto', x: 0.5, y: 0.5 },
];
let comicPanels = [
  { id: 1, prompt: 'sitting at desk, looking at viewer, gentle smile, coffee cup on table', result: null, status: 'idle' },
  { id: 2, prompt: 'standing up, turning around, surprised expression, blushing, looking back', result: null, status: 'idle' },
  { id: 3, prompt: 'running towards doorway, waving hand, happy expression, hair flying', result: null, status: 'idle' },
];
let isComicRunning = false;

function addComicCharacter(charData = null) {
  const nextId = comicCharacters.length ? Math.max(...comicCharacters.map(c => c.id)) + 1 : 1;
  comicCharacters.push({
    id: nextId,
    name: charData?.name || `角色 #${nextId}`,
    prompt: charData?.prompt || '1girl, solo',
    uc: charData?.uc || '',
    pos: 'auto',
    x: typeof charData?.x === 'number' ? charData.x : 0.5,
    y: typeof charData?.y === 'number' ? charData.y : 0.5,
  });
  renderComicCharacters();
}

function renderComicCharacters() {
  const list = $('comicCharList');
  if (!list) return;
  list.innerHTML = '';

  comicCharacters.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = 'comic-char-item';
    item.innerHTML = `
      <div class="comic-char-head">
        <span class="comic-char-name">👤 ${esc(c.name)}</span>
        <div>
          <button type="button" class="btn tiny ghost-btn c-lib-pick" title="从片段库替换角色">📚</button>
          ${comicCharacters.length > 1 ? '<button type="button" class="btn tiny ghost-btn c-del" title="移除角色">✕</button>' : ''}
        </div>
      </div>
      <textarea class="comic-char-prompt" placeholder="角色固定特征，例如 1girl, kitagawa marin, blonde hair...">${esc(c.prompt)}</textarea>
      <div class="comic-char-pos">
        <span>画面站位：</span>
        <select class="c-pos-sel">
          <option value="auto"${c.pos === 'auto' ? ' selected' : ''}>自动居中</option>
          <option value="left"${c.pos === 'left' ? ' selected' : ''}>左侧 (Left 25%)</option>
          <option value="center"${c.pos === 'center' ? ' selected' : ''}>中间 (Center 50%)</option>
          <option value="right"${c.pos === 'right' ? ' selected' : ''}>右侧 (Right 75%)</option>
        </select>
      </div>
    `;

    const ta = item.querySelector('.comic-char-prompt');
    ta.addEventListener('change', () => { c.prompt = ta.value; });
    ta.addEventListener('blur', () => { c.prompt = ta.value; });

    const sel = item.querySelector('.c-pos-sel');
    sel.addEventListener('change', () => {
      c.pos = sel.value;
      if (c.pos === 'left') { c.x = 0.25; c.y = 0.5; }
      else if (c.pos === 'right') { c.x = 0.75; c.y = 0.5; }
      else if (c.pos === 'center') { c.x = 0.5; c.y = 0.5; }
      else { c.x = null; c.y = null; }
    });

    item.querySelector('.c-lib-pick')?.addEventListener('click', () => {
      openPromptLibrary('character', {
        type: 'comicAddChar',
      });
    });

    item.querySelector('.c-del')?.addEventListener('click', () => {
      comicCharacters = comicCharacters.filter(item => item.id !== c.id);
      renderComicCharacters();
    });

    list.appendChild(item);
  });
}

function bindViewNavigation() {
  const stdView = $('standardStudioView');
  const cmcView = $('comicStudioView');
  const galView = $('dedicatedGalleryView');
  const cmcNavBtn = $('comicStudioNavBtn');
  const galNavBtn = $('galleryNavBtn');

  const hideAllViews = () => {
    stdView.classList.add('hidden');
    cmcView?.classList.add('hidden');
    galView?.classList.add('hidden');
    cmcNavBtn?.classList.remove('active');
    galNavBtn?.classList.remove('active');
  };

  const switchToStd = () => {
    hideAllViews();
    stdView.classList.remove('hidden');
  };

  const switchToComic = () => {
    hideAllViews();
    cmcView.classList.remove('hidden');
    cmcNavBtn.classList.add('active');
    syncComicBaseDefaults();
    renderComicCharacters();
    renderComicPanels();
  };

  const switchToGallery = () => {
    hideAllViews();
    galView.classList.remove('hidden');
    galNavBtn.classList.add('active');
    loadDedicatedGallery();
  };

  cmcNavBtn?.addEventListener('click', () => {
    if (cmcView.classList.contains('hidden')) switchToComic();
    else switchToStd();
  });
  $('comicBackToStdBtn')?.addEventListener('click', switchToStd);

  galNavBtn?.addEventListener('click', () => {
    if (galView.classList.contains('hidden')) switchToGallery();
    else switchToStd();
  });
  $('galBackStudioBtn')?.addEventListener('click', switchToStd);
  $('galRefreshBtn')?.addEventListener('click', () => loadDedicatedGallery());
}

/* ═════════════════════════════════════════════════════════════
   单独个人作品画廊业务逻辑 (Dedicated Gallery Workflow)
   ═════════════════════════════════════════════════════════════ */
const GAL_PAGE_SIZE = 60;
let galItems = [];            // 当前筛选下已载入的记录（按 id 倒序）
const galById = new Map();
let galFilter = 'all';        // 'all' | 'fav'
let galSelectedIds = new Set();
let galNextBefore = null;     // 下一页游标；null 表示已到底
let galLoadSeq = 0;           // 切换筛选/刷新时递增，丢弃过期响应
let galPagePromise = null;
let galObserver = null;
const galCounts = { all: 0, fav: 0 };

function updateGalCounts() {
  if ($('galCountAll')) $('galCountAll').textContent = galCounts.all;
  if ($('galCountFav')) $('galCountFav').textContent = galCounts.fav;
}

function updateGalToolbar() {
  const count = galSelectedIds.size;
  const badge = $('galSelectedCount');
  if (badge) {
    badge.classList.toggle('hidden', count === 0);
    badge.textContent = `已选 ${count} 项`;
  }
  for (const id of ['galBatchFavBtn', 'galBatchUnfavBtn', 'galBatchDlBtn', 'galBatchDelBtn']) {
    if ($(id)) $(id).disabled = count === 0;
  }
  const chkAll = $('galSelectAll');
  if (chkAll) chkAll.checked = galItems.length > 0 && galItems.every(it => galSelectedIds.has(it.id));
}

function galEmptyHtml() {
  const text = galFilter === 'fav' ? '暂无收藏图片，点击卡片右上角 ❤️ 即可收藏' : '暂无已生成的作品记录';
  return `<div class="lib-empty">${text}</div>`;
}

function galSentinel() {
  let el = $('galSentinel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'galSentinel';
    el.className = 'gal-sentinel';
    $('galGrid').after(el);
  }
  return el;
}

function updateGalSentinel() {
  const el = galSentinel();
  el.textContent = galNextBefore ? '加载更多…' : (galItems.length > GAL_PAGE_SIZE ? '— 已经到底了 —' : '');
}

/** 重新载入第一页（打开画廊、切换筛选、刷新、批量删除后） */
async function loadDedicatedGallery() {
  const grid = $('galGrid');
  if (!grid) return;
  const seq = ++galLoadSeq;
  galNextBefore = null;
  if (!galItems.length) grid.innerHTML = '<div class="lib-empty">正在加载画廊作品…</div>';
  await fetchGalleryPage(seq, null);
  if (seq === galLoadSeq && galSentinelNearViewport()) loadMoreGallery();
  if (!galObserver && 'IntersectionObserver' in window) {
    // 提前 800px 预取下一页，滚动时不出现空白等待
    galObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) loadMoreGallery();
    }, { rootMargin: '800px 0px' });
    galObserver.observe(galSentinel());
  }
}

/** IntersectionObserver 只在相交状态“变化”时触发；页面很高或卡片被移除后需主动补查 */
function galSentinelNearViewport() {
  const el = $('galSentinel');
  if (!el || $('dedicatedGalleryView')?.classList.contains('hidden')) return false;
  return el.getBoundingClientRect().top < window.innerHeight + 800;
}

function loadMoreGallery() {
  if (!galNextBefore || galPagePromise) return;
  const seq = galLoadSeq;
  galPagePromise = fetchGalleryPage(seq, galNextBefore).finally(() => {
    galPagePromise = null;
    if (seq === galLoadSeq && galSentinelNearViewport()) loadMoreGallery();
  });
}

async function fetchGalleryPage(seq, before) {
  const grid = $('galGrid');
  const params = new URLSearchParams({ limit: String(GAL_PAGE_SIZE), ok: '1' });
  if (galFilter === 'fav') params.set('favorite', '1');
  if (before) params.set('before', String(before));
  try {
    const res = await api(`/api/history?${params}`);
    if (seq !== galLoadSeq) return; // 期间筛选已切换
    const items = res.items || [];
    if (res.counts) {
      galCounts.all = res.counts.total;
      galCounts.fav = res.counts.favorited;
      updateGalCounts();
    }
    if (!before) {
      galItems = [];
      galById.clear();
      grid.innerHTML = '';
    }
    galNextBefore = res.nextBefore || null;
    appendGalleryCards(items);
    if (!galItems.length) grid.innerHTML = galEmptyHtml();
    // 清除已不在当前列表中的勾选项（仅首屏时整体校正）
    if (!before) for (const id of galSelectedIds) if (!galById.has(id)) galSelectedIds.delete(id);
    updateGalToolbar();
    updateGalSentinel();
  } catch (err) {
    if (seq !== galLoadSeq) return;
    if (!before) grid.innerHTML = `<div class="lib-empty" style="color:var(--err)">画廊载入失败：${esc(err.message)}</div>`;
    else toast(`加载更多失败：${err.message}`, true);
  }
}

function galCardHtml(it) {
  const isSel = galSelectedIds.has(it.id);
  return `
      <div class="gal-img-frame">
        <div class="gal-chk-wrap">
          <input type="checkbox" class="gal-item-chk" ${isSel ? 'checked' : ''}>
        </div>
        <button type="button" class="gal-fav-btn${it.is_favorited ? ' active' : ''}" title="${it.is_favorited ? '取消收藏' : '加入收藏'}">
          ${it.is_favorited ? '❤️' : '🤍'}
        </button>
        <img src="/thumb/${esc(it.file)}" loading="lazy" decoding="async" alt="画廊图片">
      </div>
      <div class="gal-card-meta">
        <div class="gal-card-prompt" title="${esc(it.prompt)}">${esc(it.prompt)}</div>
        <div class="gal-card-info">
          <span class="model">${esc(it.model.replace('nai-diffusion-', ''))}</span>
          <span>${it.width}×${it.height} · ${it.steps}步</span>
        </div>
      </div>`;
}

function appendGalleryCards(items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (galById.has(it.id)) continue;
    galItems.push(it);
    galById.set(it.id, it);
    const card = document.createElement('div');
    card.className = `gal-card${galSelectedIds.has(it.id) ? ' selected' : ''}`;
    card.dataset.id = it.id;
    card.innerHTML = galCardHtml(it);
    frag.appendChild(card);
  }
  $('galGrid').appendChild(frag);
}

function galCardEl(id) {
  return $('galGrid')?.querySelector(`.gal-card[data-id="${Number(id)}"]`) || null;
}

function syncGalCardFav(card, it) {
  const btn = card?.querySelector('.gal-fav-btn');
  if (!btn) return;
  btn.classList.toggle('active', !!it.is_favorited);
  btn.textContent = it.is_favorited ? '❤️' : '🤍';
  btn.title = it.is_favorited ? '取消收藏' : '加入收藏';
}

function syncGalSelection() {
  $('galGrid')?.querySelectorAll('.gal-card').forEach((card) => {
    const sel = galSelectedIds.has(Number(card.dataset.id));
    card.classList.toggle('selected', sel);
    const chk = card.querySelector('.gal-item-chk');
    if (chk) chk.checked = sel;
  });
  updateGalToolbar();
}

/** 从画廊状态与 DOM 中移除一条记录（灯箱删除、收藏页取消收藏时） */
function removeGalleryItem(id) {
  const it = galById.get(id);
  if (!it) return;
  galById.delete(id);
  galItems = galItems.filter(x => x.id !== id);
  galSelectedIds.delete(id);
  galCardEl(id)?.remove();
  if (!galItems.length && !galNextBefore) $('galGrid').innerHTML = galEmptyHtml();
  updateGalToolbar();
  if (galSentinelNearViewport()) loadMoreGallery();
}

/** 收藏状态变化后同步画廊（来自卡片按钮、灯箱或批量操作） */
function applyGalleryFavorite(id, favorited) {
  const it = galById.get(id);
  if (!it || !!it.is_favorited === !!favorited) return;
  it.is_favorited = favorited;
  galCounts.fav = Math.max(0, galCounts.fav + (favorited ? 1 : -1));
  updateGalCounts();
  if (galFilter === 'fav' && !favorited) removeGalleryItem(id);
  else syncGalCardFav(galCardEl(id), it);
}

function bindDedicatedGallery() {
  // Tab 筛选（全部 vs 仅收藏）
  document.querySelectorAll('.gallery-filter-tabs .gallery-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.gallery-filter-tabs .gallery-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      galFilter = tab.dataset.filter || 'all';
      galItems = [];
      galById.clear();
      loadDedicatedGallery();
    });
  });

  // 全选 / 全不选（作用于已载入的卡片）
  $('galSelectAll')?.addEventListener('change', (e) => {
    for (const it of galItems) {
      if (e.target.checked) galSelectedIds.add(it.id);
      else galSelectedIds.delete(it.id);
    }
    syncGalSelection();
  });

  // 卡片交互统一委托到网格：勾选、收藏、打开灯箱
  const grid = $('galGrid');
  grid?.addEventListener('change', (e) => {
    const chk = e.target.closest('.gal-item-chk');
    if (!chk) return;
    const card = chk.closest('.gal-card');
    const id = Number(card.dataset.id);
    if (chk.checked) galSelectedIds.add(id);
    else galSelectedIds.delete(id);
    card.classList.toggle('selected', chk.checked);
    updateGalToolbar();
  });
  grid?.addEventListener('click', async (e) => {
    const card = e.target.closest('.gal-card');
    if (!card) return;
    const it = galById.get(Number(card.dataset.id));
    if (!it || e.target.closest('.gal-chk-wrap')) return;
    if (e.target.closest('.gal-fav-btn')) {
      e.stopPropagation();
      const next = !it.is_favorited;
      try {
        await api(`/api/history/${it.id}/favorite`, { method: 'POST', body: JSON.stringify({ favorited: next }) });
        applyGalleryFavorite(it.id, next);
      } catch (err) { toast(err.message, true); }
      return;
    }
    openLightbox(it);
  });

  // 批量收藏
  $('galBatchFavBtn')?.addEventListener('click', async () => {
    const ids = Array.from(galSelectedIds);
    if (!ids.length) return;
    try {
      await api('/api/history/batch-favorite', {
        method: 'POST',
        body: JSON.stringify({ ids, state: true })
      });
      ids.forEach(id => applyGalleryFavorite(id, true));
      toast(`已批量收藏 ${ids.length} 项作品`);
      loadHistory();
    } catch (err) { toast(err.message, true); }
  });

  // 批量取消收藏
  $('galBatchUnfavBtn')?.addEventListener('click', async () => {
    const ids = Array.from(galSelectedIds);
    if (!ids.length) return;
    try {
      await api('/api/history/batch-favorite', {
        method: 'POST',
        body: JSON.stringify({ ids, state: false })
      });
      ids.forEach(id => applyGalleryFavorite(id, false));
      toast(`已取消收藏 ${ids.length} 项作品`);
      loadHistory();
    } catch (err) { toast(err.message, true); }
  });

  // 批量下载 ZIP
  $('galBatchDlBtn')?.addEventListener('click', async () => {
    const ids = Array.from(galSelectedIds);
    if (!ids.length) return;
    const btn = $('galBatchDlBtn');
    btn.disabled = true;
    btn.textContent = '打包下载中…';
    try {
      const resp = await fetch('/api/history/batch-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `下载失败 (${resp.status})`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nai-gallery-${Date.now()}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast(`已启动下载，打包 ${ids.length} 张原图`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>📦 批量下载 ZIP</span>';
    }
  });

  // 批量删除
  $('galBatchDelBtn')?.addEventListener('click', async () => {
    const ids = Array.from(galSelectedIds);
    if (!ids.length) return;
    if (!confirm(`确定彻底删除选中的 ${ids.length} 项生成作品及本地图片？删除后无法找回。`)) return;
    try {
      await api('/api/history/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids })
      });
      toast(`已批量删除 ${ids.length} 项作品`);
      galSelectedIds.clear();
      await loadDedicatedGallery();
      loadHistory(); // 同时同步常规小画廊
    } catch (err) { toast(err.message, true); }
  });
}

function bindComicStudio() {
  // 画风库快速选择
  $('comicStyleLibBtn')?.addEventListener('click', () => {
    openPromptLibrary('painter', { type: 'comicStyle' });
  });

  // 角色库快速导入
  $('comicCharLibBtn')?.addEventListener('click', () => {
    openPromptLibrary('character', { type: 'comicAddChar' });
  });

  // 添加角色按钮
  $('comicAddCharBtn')?.addEventListener('click', () => {
    if (comicCharacters.length >= 6) return toast('工作室多角色上限为 6 位', true);
    addComicCharacter();
  });

  // 换随机种子
  $('comicRandSeedBtn')?.addEventListener('click', () => {
    $('comicSeedInp').value = Math.floor(Math.random() * 2 ** 31);
    toast(`已设定新固定种子：${$('comicSeedInp').value}`);
  });

  // 从主页导入当前参数
  $('comicPullCurrentBtn')?.addEventListener('click', () => {
    const style = $('promptInp').value.trim();
    if (style) $('comicStylePrompt').value = style;
    if ($('ucInp').value.trim()) $('comicUc').value = $('ucInp').value.trim();
    if ($('widthInp').value) $('comicWidth').value = $('widthInp').value;
    if ($('heightInp').value) $('comicHeight').value = $('heightInp').value;
    if ($('stepsInp').value) $('comicSteps').value = $('stepsInp').value;
    if ($('scaleInp').value) $('comicScale').value = $('scaleInp').value;
    if ($('modelSel').value) $('comicModelSel').value = $('modelSel').value;

    if (CHARS.length) {
      comicCharacters = CHARS.map((c, i) => ({
        id: i + 1,
        name: `角色 #${i + 1}`,
        prompt: c.prompt,
        uc: c.uc,
        pos: c.x === 0.25 ? 'left' : (c.x === 0.75 ? 'right' : (c.x === 0.5 ? 'center' : 'auto')),
        x: c.x,
        y: c.y,
      }));
      renderComicCharacters();
    }
    toast('已导入环境画风与出场角色配置');
  });

  // 添加分镜卡
  $('comicAddPanelBtn')?.addEventListener('click', () => {
    const nextId = comicPanels.length ? Math.max(...comicPanels.map(p => p.id)) + 1 : 1;
    comicPanels.push({
      id: nextId,
      prompt: '',
      result: null,
      status: 'idle',
    });
    renderComicPanels();
  });

  // 清空已生成
  $('comicClearDoneBtn')?.addEventListener('click', () => {
    if (confirm('确定清除所有分镜的当前成图吗？')) {
      comicPanels.forEach(p => { p.result = null; p.status = 'idle'; });
      renderComicPanels();
      toast('分镜成图已清空');
    }
  });

  // 批量连续生成分镜剧情
  $('comicRunBatchBtn')?.addEventListener('click', runComicBatchWorkflow);
}

function syncComicBaseDefaults() {
  const sel = $('comicModelSel');
  if (sel && !sel.options.length && META?.models) {
    for (const [id, m] of Object.entries(META.models)) {
      if (m.inpaintOnly) continue;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
  }
  if (!$('comicSeedInp').value) {
    $('comicSeedInp').value = lastGen?.seed || Math.floor(Math.random() * 2 ** 31);
  }
  if (!$('comicStylePrompt').value.trim()) {
    $('comicStylePrompt').value = 'year 2026, anime screencap, masterpiece, very aesthetic, cinematic lighting';
  }
  if (!$('comicUc').value.trim()) {
    $('comicUc').value = 'lowres, bad quality, jpeg artifacts, bad hands, bad anatomy, text, watermark';
  }
}

function renderComicPanels() {
  const container = $('comicPanelsList');
  if (!container) return;
  container.innerHTML = '';

  $('comicPanelCount').textContent = `共 ${comicPanels.length} 个分镜 (${comicCharacters.length} 位角色)`;

  comicPanels.forEach((panel, idx) => {
    const card = document.createElement('div');
    card.className = `comic-panel-card${panel.status === 'running' ? ' active-gen' : ''}`;
    card.id = `comic-panel-${panel.id}`;

    const previewHtml = panel.result?.file
      ? `<img src="/thumb/${esc(panel.result.file)}" decoding="async" alt="分镜 ${idx + 1}" title="点击查看大图">`
      : `<div class="comic-panel-empty">${panel.status === 'running' ? '⏳ 正在绘制该镜头…' : '待生成分镜'}</div>`;

    card.innerHTML = `
      <div class="comic-panel-header">
        <span class="panel-badge">分镜 #${idx + 1}</span>
        <div class="panel-actions">
          <button type="button" class="btn tiny ghost-btn p-del" title="删除该分镜">✕</button>
        </div>
      </div>
      <div class="comic-panel-preview">
        ${previewHtml}
      </div>
      <div class="comic-panel-body">
        <div class="comic-panel-tools">
          <button type="button" class="btn tiny ghost-btn p-act-lib" title="从动作库选动作">🏃 选动作</button>
          <button type="button" class="btn tiny ghost-btn p-main-lib" title="从主串库选镜头">🌟 选镜头</button>
        </div>
        <textarea class="comic-panel-prompt" placeholder="该分镜动作/镜头，例如 sitting on chair, looking down...">${esc(panel.prompt)}</textarea>
        <div class="comic-panel-footer">
          <span class="p-status">${panel.status === 'done' ? '✓ 已生成' : (panel.status === 'running' ? '绘制中…' : '就绪')}</span>
          <button type="button" class="btn tiny ghost-btn p-run-single">单独重绘</button>
        </div>
      </div>
    `;

    const ta = card.querySelector('.comic-panel-prompt');
    // 采用 change/blur 双向同步，彻底避免拉长/输入时卡顿
    ta.addEventListener('change', () => { panel.prompt = ta.value; });
    ta.addEventListener('blur', () => { panel.prompt = ta.value; });

    card.querySelector('.p-act-lib')?.addEventListener('click', () => {
      openPromptLibrary('action', { type: 'comicPanel', panelId: panel.id });
    });

    card.querySelector('.p-main-lib')?.addEventListener('click', () => {
      openPromptLibrary('main', { type: 'comicPanel', panelId: panel.id });
    });

    card.querySelector('.p-del').addEventListener('click', () => {
      comicPanels = comicPanels.filter(p => p.id !== panel.id);
      renderComicPanels();
    });

    card.querySelector('.p-run-single').addEventListener('click', () => {
      if (isComicRunning) return toast('当前有批量任务正在执行，请稍候', true);
      generateSingleComicPanel(panel);
    });

    const img = card.querySelector('.comic-panel-preview img');
    if (img && panel.result) {
      img.addEventListener('click', () => {
        openLightbox(panel.result);
      });
    }

    container.appendChild(card);
  });
}

async function generateSingleComicPanel(panel) {
  const style = $('comicStylePrompt').value.trim();
  const main = panel.prompt.trim();

  // 构建主提示词：固定画风 + 当前分镜独有镜头描述
  const fullPromptParts = [style, main].filter(Boolean);
  const fullPrompt = fullPromptParts.join(', ');

  // 构建多角色独立分框数据 (charPrompts)
  const charPrompts = comicCharacters.map(c => {
    const p = c.prompt.trim();
    if (!p) return null;
    return {
      prompt: p,
      uc: c.uc || '',
      x: typeof c.x === 'number' ? c.x : null,
      y: typeof c.y === 'number' ? c.y : null,
    };
  }).filter(Boolean);

  if (!fullPrompt && !charPrompts.length) {
    toast('画风提示词或角色提示词不能为空', true);
    return;
  }

  panel.status = 'running';
  // 局部更新该卡片状态，不进行全部 DOM 销毁重绘
  const card = document.getElementById(`comic-panel-${panel.id}`);
  if (card) {
    card.classList.add('active-gen');
    const st = card.querySelector('.p-status');
    if (st) st.textContent = '绘制中…';
    const prev = card.querySelector('.comic-panel-preview');
    if (prev && !panel.result?.file) prev.innerHTML = '<div class="comic-panel-empty">⏳ 正在绘制该镜头…</div>';
  }

  try {
    const body = {
      prompt: fullPrompt || 'masterpiece',
      uc: $('comicUc').value.trim(),
      model: $('comicModelSel').value,
      width: Number($('comicWidth').value) || 832,
      height: Number($('comicHeight').value) || 1216,
      steps: Number($('comicSteps').value) || 28,
      scale: Number($('comicScale').value) || 5.0,
      seed: Number($('comicSeedInp').value) || Math.floor(Math.random() * 2 ** 31),
      sampler: $('samplerSel')?.value || 'k_euler',
      noiseSchedule: 'karras',
      nSamples: 1,
      charPrompts: charPrompts.length ? charPrompts : undefined,
    };

    const res = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    panel.result = {
      file: String(res.image || '').replace('/img/', ''),
      prompt: fullPrompt,
      uc: body.uc,
      model: body.model,
      width: body.width,
      height: body.height,
      steps: body.steps,
      seed: body.seed,
      charPrompts: charPrompts,
    };
    panel.status = 'done';
    toast(`分镜 #${comicPanels.indexOf(panel) + 1} 绘制完成`);
  } catch (err) {
    panel.status = 'idle';
    toast(`分镜生成失败：${err.message}`, true);
  } finally {
    renderComicPanels();
    loadHistory();
  }
}

async function runComicBatchWorkflow() {
  if (isComicRunning) return;
  if (!comicPanels.length) return toast('请先添加分镜卡', true);

  isComicRunning = true;
  const btn = $('comicRunBatchBtn');
  btn.disabled = true;
  $('comicRunBtnText').textContent = '连环画剧情生成中…';
  const banner = $('comicStatusTxt');
  banner.classList.remove('hidden');

  try {
    for (let i = 0; i < comicPanels.length; i++) {
      const p = comicPanels[i];
      banner.textContent = `[${i + 1}/${comicPanels.length}] 正在连续生成分镜 #${i + 1}…`;
      await generateSingleComicPanel(p);
      await new Promise(r => setTimeout(r, 600));
    }
    banner.textContent = `✓ 全部分镜剧情生成完成 (${comicPanels.length} 张)`;
    toast('连续分镜剧情生成完毕！');
  } catch (err) {
    banner.textContent = `✗ 批量中断：${err.message}`;
  } finally {
    isComicRunning = false;
    btn.disabled = false;
    $('comicRunBtnText').textContent = '连续批量生成分镜剧情';
  }
}
