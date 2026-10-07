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
    bindComicStudio();
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
  $('anlasBtn').addEventListener('click', showAnlasModal);

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
   📚 提示词片段库 (Prompt Library) 核心实现
   ═════════════════════════════════════════════════════════════ */
let currentLibKind = 'painter';
let libCache = {}; // { [kind]: Array<item> }
let libAddFormCollapsed = true; // 添加片段卡片折叠状态，默认折叠
const LIB_KIND_TITLES = {
  painter: '画师串',
  action: '动作串',
  uc: 'UC片段',
  character: '角色',
  main: '主串',
};

let libTargetContext = null; // 记录当前调用来源，例如 { type: 'comicStyle' }, { type: 'comicPanel', panelId: 1 } 等

function openPromptLibrary(kind = 'painter', targetCtx = null) {
  libTargetContext = targetCtx;
  const modal = $('promptLibModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  switchPromptLibKind(kind);
}

function closePromptLibrary() {
  closeActiveLibPopover();
  libTargetContext = null;
  const modal = $('promptLibModal');
  if (modal) modal.classList.add('hidden');
}

function switchPromptLibKind(kind) {
  currentLibKind = kind;
  // 更新 Tab 导航高亮
  document.querySelectorAll('#promptLibTabNav .nav-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.kind === kind);
  });

  const titleMap = {
    painter: '添加画师串片段',
    action: '添加动作串片段',
    uc: '添加 UC 片段',
    character: '添加预设角色',
    main: '添加完整主串预设',
  };
  const tipMap = {
    painter: '点击条目可选择导入或复制（导入：插入画师串位置）',
    action: '点击条目可选择导入或复制（导入：追加动作串）',
    uc: '点击条目可选择导入或复制（导入：插入排除元素 UC）',
    character: '点击条目直接导入或复制（导入：追加进独立角色面板，上限 22）',
    main: '点击条目可选择导入或复制（导入：替换提示词输入框）',
  };

  $('libFormTitle').textContent = titleMap[kind] || '添加新片段';
  $('libFormTip').textContent = tipMap[kind] || '';
  $('libListTitle').textContent = `已保存 ${LIB_KIND_TITLES[kind] || ''} 片段`;
  // 切换普通模式与角色模式表单
  const isChar = kind === 'character';
  const useGroupTabs = isChar || kind === 'action';
  if ($('libListTip')) {
    $('libListTip').textContent = isChar
      ? '先点作品 Tab，再导入或复制角色'
      : kind === 'action'
        ? '先点分类 Tab，再导入或复制动作'
        : '点击条目可选择导入或复制';
  }
  $('libIpTabs')?.classList.toggle('hidden', !useGroupTabs);
  if ($('libIpTabs')) {
    $('libIpTabs').setAttribute('aria-label', isChar ? '角色作品' : kind === 'action' ? '动作分类' : '分组');
  }
  if (!useGroupTabs) {
    const ipTabs = $('libIpTabs');
    if (ipTabs) ipTabs.innerHTML = '';
  }
  $('libNormalContentWrap').classList.toggle('hidden', isChar);
  $('libCharContentWrap').classList.toggle('hidden', !isChar);
  if ($('libItemTitle')) {
    $('libItemTitle').placeholder = kind === 'action'
      ? '例如：传教士 | 腿扛在肩上（分类 | 名称）'
      : '例如：水墨水彩混搭 / 战斗跳跃姿态 / 主角银发少女';
  }

  if (kind === 'uc') {
    $('libContentLabel').textContent = '排除词内容 (Negative tags)';
    $('libItemContent').placeholder = 'worst quality, bad anatomy, blur...';
  } else {
    $('libContentLabel').textContent = '提示词内容';
    $('libItemContent').placeholder = '填写提示词内容 tags...';
  }

  $('libAddCard')?.classList.toggle('collapsed', libAddFormCollapsed);
  fetchAndRenderLibItems(kind);
}

async function fetchAndRenderLibItems(kind) {
  const listWrap = $('libItemsList');
  listWrap.innerHTML = '<div class="lib-empty">正在拉取云端片段…</div>';

  try {
    const res = await api(`/api/prompts?kind=${encodeURIComponent(kind)}`);
    const items = Array.isArray(res?.items) ? res.items : [];
    libCache[kind] = items;
    renderLibItemsList(kind, items);
  } catch (err) {
    // 后端接口若未就绪或报错，做优雅降级容错
    const cached = libCache[kind] || [];
    if (cached.length) {
      renderLibItemsList(kind, cached);
      toast(`片段库（离线缓存模式）：${err.message}`);
    } else {
      listWrap.innerHTML = `<div class="lib-empty" style="color:var(--err);font-weight:600;font-size:13px;padding:24px;">⚠️ 片段库加载异常：${esc(err.message)}</div>`;
    }
  }
}

const CHAR_IP_TAB_KEY = 'nai-char-ip-tab';
let currentCharIpTab = null;

function readCharIpTab() {
  if (currentCharIpTab) return currentCharIpTab;
  try {
    currentCharIpTab = localStorage.getItem(CHAR_IP_TAB_KEY) || null;
  } catch {
    currentCharIpTab = null;
  }
  return currentCharIpTab;
}

function writeCharIpTab(name) {
  currentCharIpTab = name || null;
  try {
    if (name) localStorage.setItem(CHAR_IP_TAB_KEY, name);
    else localStorage.removeItem(CHAR_IP_TAB_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

const ACTION_GROUP_TAB_KEY = 'nai-action-group-tab';
let currentActionGroupTab = null;

function readActionGroupTab() {
  if (currentActionGroupTab) return currentActionGroupTab;
  try {
    currentActionGroupTab = localStorage.getItem(ACTION_GROUP_TAB_KEY) || null;
  } catch {
    currentActionGroupTab = null;
  }
  return currentActionGroupTab;
}

function writeActionGroupTab(name) {
  currentActionGroupTab = name || null;
  try {
    if (name) localStorage.setItem(ACTION_GROUP_TAB_KEY, name);
    else localStorage.removeItem(ACTION_GROUP_TAB_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

let activeLibPopover = null;

function computePopoverPosition(triggerRect, menuWidth = 140, menuHeight = 44, margin = 6, padding = 8) {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  const spaceBelow = viewportH - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const flip = spaceBelow < menuHeight + margin && spaceAbove >= menuHeight + margin;

  let top = flip ? triggerRect.top - menuHeight - margin : triggerRect.bottom + margin;
  // 垂直贴边防护
  top = Math.max(padding, Math.min(top, viewportH - menuHeight - padding));

  // 默认右对齐触发按钮
  let left = triggerRect.right - menuWidth;
  // 水平贴边防护
  left = Math.max(padding, Math.min(left, viewportW - menuWidth - padding));

  return { top, left, flip };
}

function closeActiveLibPopover() {
  if (activeLibPopover) {
    if (activeLibPopover.menu && activeLibPopover.menu.parentNode) {
      activeLibPopover.menu.parentNode.removeChild(activeLibPopover.menu);
    }
    if (activeLibPopover.trigger) {
      activeLibPopover.trigger.classList.remove('active');
    }
    activeLibPopover = null;
  }
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
  let p = String(prompt || '').replace(/[\u200e\u200f\u200b\ufeff]/g, '').trim();
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


function characterIpName(item) {
  const rawTitle = String(item?.title || '').trim();
  if (rawTitle) {
    const idx = rawTitle.indexOf(' | ');
    if (idx !== -1) {
      const prefix = rawTitle.slice(0, idx).trim();
      if (prefix) return prefix;
    }
  }
  return '其他';
}

function characterDisplayTitle(item) {
  const raw = String(item?.title || '').trim();
  const ip = characterIpName(item);
  if (ip !== '其他' && raw.startsWith(`${ip} | `)) {
    return raw.slice(ip.length + 3).trim() || raw;
  }
  return raw || '未命名片段';
}

function groupCharacterItems(items) {
  const groups = new Map();
  items.forEach((item) => {
    const groupName = characterIpName(item);
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(item);
  });

  for (const list of groups.values()) {
    list.sort((a, b) => (Number(a.sort) - Number(b.sort)) || (Number(a.id) - Number(b.id)));
  }

  const sortedNames = Array.from(groups.keys()).sort((a, b) => {
    if (a === '其他') return 1;
    if (b === '其他') return -1;
    const minA = Math.min(...groups.get(a).map((it) => Number(it.sort) || 0));
    const minB = Math.min(...groups.get(b).map((it) => Number(it.sort) || 0));
    if (minA !== minB) return minA - minB;
    return a.localeCompare(b, 'zh-CN');
  });

  return sortedNames.map((name) => ({
    name,
    items: groups.get(name),
  }));
}

const ACTION_GROUP_ORDER = ['常用', '站立', '传教士', '侧躺', '骑乘', '后入', '特殊', '对照', '自拍', '展示', '多人', '口交', '事后', '其他'];

function actionGroupName(item) {
  const rawTitle = String(item?.title || '').trim();
  if (rawTitle) {
    const idx = rawTitle.indexOf(' | ');
    if (idx !== -1) {
      const prefix = rawTitle.slice(0, idx).trim();
      if (prefix) return prefix;
    }
    if (/口交|跪舔/.test(rawTitle)) return '口交';
    if (/传教士|操逼/.test(rawTitle)) return '传教士';
    if (/背骑|骑乘/.test(rawTitle)) return '骑乘';
    if (/侧位/.test(rawTitle)) return '侧躺';
    if (/站立/.test(rawTitle)) return '站立';
    if (/后入|俯卧|四足|弯腰/.test(rawTitle)) return '后入';
    if (/中出|事后/.test(rawTitle)) return '事后';
  }
  return '其他';
}

function actionDisplayTitle(item) {
  const raw = String(item?.title || '').trim();
  const group = actionGroupName(item);
  if (group !== '其他' && raw.startsWith(`${group} | `)) {
    return raw.slice(group.length + 3).trim() || raw;
  }
  return raw || '未命名片段';
}

function groupActionItems(items) {
  const groups = new Map();
  items.forEach((item) => {
    const groupName = actionGroupName(item);
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(item);
  });

  for (const list of groups.values()) {
    list.sort((a, b) => (Number(a.sort) - Number(b.sort)) || (Number(a.id) - Number(b.id)));
  }

  const sortedNames = Array.from(groups.keys()).sort((a, b) => {
    if (a === '其他') return 1;
    if (b === '其他') return -1;
    const ia = ACTION_GROUP_ORDER.indexOf(a);
    const ib = ACTION_GROUP_ORDER.indexOf(b);
    const oa = ia === -1 ? ACTION_GROUP_ORDER.length : ia;
    const ob = ib === -1 ? ACTION_GROUP_ORDER.length : ib;
    if (oa !== ob) return oa - ob;
    const minA = Math.min(...groups.get(a).map((it) => Number(it.sort) || 0));
    const minB = Math.min(...groups.get(b).map((it) => Number(it.sort) || 0));
    if (minA !== minB) return minA - minB;
    return a.localeCompare(b, 'zh-CN');
  });

  return sortedNames.map((name) => ({
    name,
    items: groups.get(name),
  }));
}

let activeLibEditor = null;

function parseLibCharContent(item) {
  try {
    const obj = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return {
        prompt: String(obj.prompt || ''),
        uc: String(obj.uc || ''),
        x: obj.x === undefined ? null : obj.x,
        y: obj.y === undefined ? null : obj.y,
      };
    }
  } catch {
    /* 非 JSON 角色内容时降级为纯文本 */
  }
  return { prompt: String(item.content || ''), uc: '', x: null, y: null };
}

function closeLibItemEditor() {
  if (!activeLibEditor) return;
  const { card, item, kind } = activeLibEditor;
  activeLibEditor = null;
  if (card && card.parentNode) {
    card.replaceWith(createLibItemCard(item, kind));
  }
}

function enterLibItemEditMode(card, item, kind) {
  closeActiveLibPopover();
  if (activeLibEditor) closeLibItemEditor();

  const isChar = kind === 'character';
  const charObj = isChar ? parseLibCharContent(item) : null;
  let posMode = (charObj && charObj.x !== null && charObj.x !== undefined) ? 'manual' : 'auto';

  const editorCard = document.createElement('div');
  editorCard.className = 'lib-item-card lib-item-editing';
  editorCard.innerHTML = `
    <form class="lib-edit-form">
      <div class="lib-edit-field">
        <label class="field-title">标题</label>
        <input class="styled-admin-input lib-edit-title" maxlength="200" value="${esc(item.title || '')}" placeholder="${isChar ? '作品 | 角色名' : kind === 'action' ? '分类 | 名称' : '片段标题'}">
      </div>
      ${isChar ? `
      <div class="lib-edit-field">
        <label class="field-title">角色提示词</label>
        <textarea class="styled-admin-input lib-textarea lib-edit-prompt" rows="3">${esc(charObj.prompt)}</textarea>
      </div>
      <div class="lib-edit-field">
        <label class="field-title">角色排除词</label>
        <input class="styled-admin-input lib-edit-uc" value="${esc(charObj.uc)}" placeholder="选填">
      </div>
      <div class="lib-edit-pos-row">
        <button type="button" class="char-mode-btn lib-edit-pos-auto${posMode === 'auto' ? ' active' : ''}">自动位置</button>
        <button type="button" class="char-mode-btn lib-edit-pos-manual${posMode === 'manual' ? ' active' : ''}">指定坐标</button>
        <div class="lib-coord-inputs lib-edit-coords${posMode === 'manual' ? '' : ' hidden'}">
          <label class="lib-coord-item">X <input type="number" class="styled-admin-input tiny-num lib-edit-x" min="0" max="1" step="0.05" value="${charObj.x ?? 0.5}"></label>
          <label class="lib-coord-item">Y <input type="number" class="styled-admin-input tiny-num lib-edit-y" min="0" max="1" step="0.05" value="${charObj.y ?? 0.5}"></label>
        </div>
      </div>
      ` : `
      <div class="lib-edit-field">
        <label class="field-title">提示词内容</label>
        <textarea class="styled-admin-input lib-textarea lib-edit-content" rows="6">${esc(item.content || '')}</textarea>
      </div>
      `}
      <div class="lib-edit-actions">
        <button type="submit" class="btn primary tiny lib-edit-save">💾 保存</button>
        <button type="button" class="btn ghost-btn tiny lib-edit-cancel">取消</button>
      </div>
    </form>
  `;

  card.replaceWith(editorCard);
  activeLibEditor = { card: editorCard, item, kind };

  const form = editorCard.querySelector('.lib-edit-form');
  form.addEventListener('click', (e) => e.stopPropagation());

  const autoBtn = editorCard.querySelector('.lib-edit-pos-auto');
  const manualBtn = editorCard.querySelector('.lib-edit-pos-manual');
  const coords = editorCard.querySelector('.lib-edit-coords');
  autoBtn?.addEventListener('click', () => {
    posMode = 'auto';
    autoBtn.classList.add('active');
    manualBtn?.classList.remove('active');
    coords?.classList.add('hidden');
  });
  manualBtn?.addEventListener('click', () => {
    posMode = 'manual';
    manualBtn.classList.add('active');
    autoBtn?.classList.remove('active');
    coords?.classList.remove('hidden');
  });

  editorCard.querySelector('.lib-edit-cancel').addEventListener('click', (e) => {
    e.stopPropagation();
    closeLibItemEditor();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const title = editorCard.querySelector('.lib-edit-title').value.trim();
    if (!title) return toast('请输入标题', true);
    if (title.length > 200) return toast('标题长度不能超过 200 字符', true);

    let content = '';
    if (isChar) {
      const prompt = formatCharPromptXxxIp(editorCard.querySelector('.lib-edit-prompt').value.trim());
      const uc = editorCard.querySelector('.lib-edit-uc').value.trim();
      let x = null;
      let y = null;
      if (posMode === 'manual') {
        const parsedX = parseFloat(editorCard.querySelector('.lib-edit-x').value);
        const parsedY = parseFloat(editorCard.querySelector('.lib-edit-y').value);
        x = !isNaN(parsedX) ? Math.max(0, Math.min(1, +parsedX.toFixed(3))) : 0.5;
        y = !isNaN(parsedY) ? Math.max(0, Math.min(1, +parsedY.toFixed(3))) : 0.5;
      }
      content = JSON.stringify({ prompt, uc, x, y });
    } else {
      content = editorCard.querySelector('.lib-edit-content').value;
      if (!String(content).trim()) return toast('请输入提示词内容', true);
    }
    if (content.length > 5000) return toast('内容长度不能超过 5000 字符', true);

    const saveBtn = editorCard.querySelector('.lib-edit-save');
    saveBtn.disabled = true;
    try {
      await api(`/api/prompts/${item.id}`, { method: 'POST', body: JSON.stringify({ title, content }) });
      const updated = { ...item, title, content };
      if (libCache[kind]) {
        libCache[kind] = libCache[kind].map((it) => (it.id === item.id ? { ...it, title, content } : it));
      }
      if (kind === 'character') writeCharIpTab(characterIpName(updated));
      else if (kind === 'action') writeActionGroupTab(actionGroupName(updated));
      activeLibEditor = null;
      toast('片段已保存');
      fetchAndRenderLibItems(kind);
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
      saveBtn.disabled = false;
    }
  });
}


function createLibItemCard(item, kind) {
  const card = document.createElement('div');
  card.className = 'lib-item-card';

  let previewText = '';
  let badgeText = LIB_KIND_TITLES[kind] || kind;
  if (kind === 'character') {
    try {
      const charObj = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
      const posText = (charObj.x === null || charObj.y === null || charObj.x === undefined)
        ? '自动站位'
        : `(${Math.round(charObj.x * 100)}%, ${Math.round(charObj.y * 100)}%)`;
      badgeText = `角色 · ${posText}`;
    } catch {
      // content 解析失败时仅保留默认 badge
    }
  } else {
    previewText = String(item.content || '');
  }

  if (kind === 'character') {
    // 角色分区卡片：平铺导入 / 复制 / 编辑 / 删除
    card.classList.add('lib-item-card-char');
    card.innerHTML = `
      <div class="lib-item-info">
        <div class="lib-item-title-row">
          <span class="lib-item-title">${esc(characterDisplayTitle(item))}</span>
          <span class="lib-item-badge">${esc(badgeText)}</span>
        </div>
      </div>
      <div class="lib-item-actions">
        <button type="button" class="btn primary tiny lib-act-btn lib-char-apply-btn" title="导入到角色面板">📥 导入</button>
        <button type="button" class="btn ghost-btn tiny lib-act-btn lib-char-copy-btn" title="复制角色提示词">📋 复制</button>
        <button type="button" class="btn ghost-btn tiny lib-act-btn lib-edit-open-btn" title="修改并保存">✏️ 编辑</button>
        <button type="button" class="btn ghost-btn tiny lib-act-btn lib-del-btn" title="删除此片段">✕</button>
      </div>
    `;

    // 【导入】按钮
    card.querySelector('.lib-char-apply-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      applyLibItem(item, kind);
    });

    // 【复制】按钮
    card.querySelector('.lib-char-copy-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      let textToCopy = '';
      try {
        const charObj = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
        textToCopy = String(charObj?.prompt || '');
      } catch {
        textToCopy = String(item.content || '');
      }
      await copyPromptText(textToCopy);
    });
  } else {
    // 非角色分区卡片：保留“操作 ▾”与二级浮层
    card.innerHTML = `
      <div class="lib-item-info">
        <div class="lib-item-title-row">
          <span class="lib-item-title">${esc(kind === 'action' ? actionDisplayTitle(item) : (item.title || '未命名片段'))}</span>
          <span class="lib-item-badge">${esc(badgeText)}</span>
        </div>
        <div class="lib-item-preview" title="${esc(previewText)}">${esc(previewText)}</div>
      </div>
      <div class="lib-item-actions">
        <button type="button" class="btn ghost-btn tiny lib-act-btn lib-popover-trigger" title="选择操作">操作 ▾</button>
        <button type="button" class="btn ghost-btn tiny lib-act-btn lib-edit-open-btn" title="修改并保存">✏️ 编辑</button>
        <button type="button" class="btn ghost-btn tiny lib-act-btn lib-del-btn" title="删除此片段">✕</button>
      </div>
    `;

    const triggerBtn = card.querySelector('.lib-popover-trigger');

    const togglePopover = (e) => {
      e.stopPropagation();
      // 如果当前正在展示此浮层，则关闭
      if (activeLibPopover && activeLibPopover.trigger === triggerBtn) {
        closeActiveLibPopover();
        return;
      }
      closeActiveLibPopover();

      const menu = document.createElement('div');
      menu.className = 'lib-popover-menu';
      menu.innerHTML = `
        <button type="button" class="btn lib-pop-btn lib-pop-apply">📥 导入</button>
        <button type="button" class="btn lib-pop-btn lib-pop-copy">📋 复制</button>
      `;

      // 阻止菜单内点击冒泡到外部
      menu.addEventListener('click', (evt) => evt.stopPropagation());

      // 【导入】按钮
      menu.querySelector('.lib-pop-apply').addEventListener('click', (evt) => {
        evt.stopPropagation();
        closeActiveLibPopover();
        applyLibItem(item, kind);
      });

      // 【复制】按钮
      menu.querySelector('.lib-pop-copy').addEventListener('click', async (evt) => {
        evt.stopPropagation();
        closeActiveLibPopover();
        const textToCopy = String(item.content || '');
        await copyPromptText(textToCopy);
      });

      // 挂载到 document.body 配合 position:fixed 避免任何容器裁剪
      document.body.appendChild(menu);
      triggerBtn.classList.add('active');

      const triggerRect = triggerBtn.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const pos = computePopoverPosition(triggerRect, menuRect.width || 140, menuRect.height || 42);
      menu.style.top = `${pos.top}px`;
      menu.style.left = `${pos.left}px`;
      if (pos.flip) {
        menu.classList.add('flipped');
      }

      activeLibPopover = { menu, trigger: triggerBtn };
    };

    // 点击卡片主体或操作按钮均触发选择浮层
    card.addEventListener('click', togglePopover);
    triggerBtn.addEventListener('click', togglePopover);
  }
  card.querySelector('.lib-edit-open-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeActiveLibPopover();
    enterLibItemEditMode(card, item, kind);
  });
  // 删除按钮
  card.querySelector('.lib-del-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    closeActiveLibPopover();
    if (!confirm(`确定删除片段【${item.title || '未命名'}】吗？`)) return;
    try {
      await api(`/api/prompts/${item.id}`, { method: 'DELETE' });
      toast('片段已删除');
      if (libCache[kind]) {
        libCache[kind] = libCache[kind].filter(it => it.id !== item.id);
      }
      fetchAndRenderLibItems(kind);
    } catch (err) {
      toast(`删除失败：${err.message}`, true);
    }
  });

  return card;
}

function renderGroupedLibrary(kind, items) {
  const tabsWrap = $('libIpTabs');
  const listWrap = $('libItemsList');
  listWrap.innerHTML = '';
  activeLibEditor = null;
  closeActiveLibPopover();
  if (tabsWrap) {
    tabsWrap.classList.remove('hidden');
    tabsWrap.innerHTML = '';
  }

  if (!items || !items.length) {
    listWrap.innerHTML = '<div class="lib-empty">暂无已保存的片段，在上方表单添加一个吧！</div>';
    return;
  }

  const groups = kind === 'action' ? groupActionItems(items) : groupCharacterItems(items);
  const readTab = kind === 'action' ? readActionGroupTab : readCharIpTab;
  const writeTab = kind === 'action' ? writeActionGroupTab : writeCharIpTab;
  let selected = readTab();
  if (!groups.some((g) => g.name === selected)) {
    selected = groups[0].name;
    writeTab(selected);
  }

  if (tabsWrap) {
    groups.forEach((g) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `lib-ip-tab${g.name === selected ? ' active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', g.name === selected ? 'true' : 'false');
      btn.innerHTML = `<span class="lib-ip-tab-name">${esc(g.name)}</span><span class="lib-ip-tab-count">${g.items.length}</span>`;
      btn.addEventListener('click', () => {
        closeActiveLibPopover();
        writeTab(g.name);
        renderGroupedLibrary(kind, libCache[kind] || items);
      });
      tabsWrap.appendChild(btn);
    });
  }

  const active = groups.find((g) => g.name === selected) || groups[0];
  if ($('libListTitle')) {
    $('libListTitle').textContent = kind === 'character'
      ? `${active.name} · ${active.items.length} 名角色`
      : `${active.name} · ${active.items.length} 个动作`;
  }
  active.items.forEach((item) => {
    listWrap.appendChild(createLibItemCard(item, kind));
  });
}

function renderCharacterIpLibrary(items) {
  renderGroupedLibrary('character', items);
}

function renderLibItemsList(kind, items) {
  const listWrap = $('libItemsList');
  listWrap.innerHTML = '';
  activeLibEditor = null;
  closeActiveLibPopover();

  if (kind !== 'character' && kind !== 'action') {
    $('libIpTabs')?.classList.add('hidden');
  }

  if (!items || !items.length) {
    listWrap.innerHTML = '<div class="lib-empty">暂无已保存的片段，在上方表单添加一个吧！</div>';
    return;
  }

  if (kind === 'character' || kind === 'action') {
    renderGroupedLibrary(kind, items);
    return;
  }

  // 非分组分区平铺
  items.forEach((item) => {
    listWrap.appendChild(createLibItemCard(item, kind));
  });
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
  } else {
    if (!val.trim()) {
      textarea.value = textToInsert.trim();
    } else {
      textarea.value = val.trimEnd().replace(/,+$/, '') + ', ' + textToInsert.trim();
    }
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/* 处理自定义上下文的目标注入 */
function handleTargetContextInsert(item, kind, ctx) {
  let textToInsert = '';
  if (kind === 'character') {
    try {
      const raw = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
      textToInsert = String(raw?.prompt || '').trim();
      // 如果是工作室的多角色导入
      if (ctx.type === 'comicAddChar') {
        addComicCharacter({
          name: item.title.split('|').pop().trim(),
          prompt: textToInsert,
          uc: String(raw?.uc || '').trim(),
          x: typeof raw?.x === 'number' ? raw.x : 0.5,
          y: typeof raw?.y === 'number' ? raw.y : 0.5,
        });
        toast(`已将角色【${item.title}】添加到工作室角色列表`);
        return;
      }
    } catch {
      textToInsert = String(item.content || '').trim();
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

/* 执行具体分区的片段插入应用 */
function applyLibItem(item, kind) {
  // 如果是从工作室或自定义上下文调用的，优先走目标注入回调
  if (libTargetContext) {
    handleTargetContextInsert(item, kind, libTargetContext);
    closePromptLibrary();
    return;
  }

  if (kind === 'painter') {
    const inp = $('promptInp');
    const content = String(item.content || '').trim();
    if (!content) return toast('该片段内容为空', true);
    if (inp.value.includes(content)) {
      toast(`已存在相同片段：${item.title}`);
      return;
    }
    insertAtCursor(inp, content);
    toast(`已插入画师串：${item.title}`);
    closePromptLibrary();
  } else if (kind === 'action') {
    const inp = $('promptInp');
    const content = String(item.content || '').trim();
    if (!content) return toast('该片段内容为空', true);

    // 动作串插入：若当前聚焦在光标处则插入光标处，否则追加在末尾
    const isFocused = document.activeElement === inp;
    if (isFocused && inp.selectionStart !== inp.selectionEnd) {
      insertAtCursor(inp, content);
    } else {
      const val = inp.value.trim();
      if (!val) {
        inp.value = content;
      } else {
        inp.value = val.replace(/,+$/, '') + ', ' + content;
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    toast(`已追加动作串：${item.title}`);
    closePromptLibrary();
  } else if (kind === 'main') {
    const inp = $('promptInp');
    const content = String(item.content || '').trim();
    if (!content) return toast('该主串内容为空', true);

    if (inp.value.trim()) {
      if (!confirm(`应用主串【${item.title}】将替换当前提示词的所有内容，确定继续吗？`)) {
        return;
      }
    }
    inp.value = content;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    toast(`已替换为主串：${item.title}`);
    closePromptLibrary();
  } else if (kind === 'uc') {
    const ucInp = $('ucInp');
    const content = String(item.content || '').trim();
    if (!content) return toast('该 UC 片段内容为空', true);

    insertAtCursor(ucInp, content);
    toast(`已插入 UC 片段：${item.title}`);
    closePromptLibrary();
  } else if (kind === 'character') {
    if (CHARS.length >= 22) {
      toast('角色上限为 22 个，无法继续添加', true);
      return;
    }
    try {
      const raw = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
      const charObj = {
        prompt: formatCharPromptXxxIp(String(raw?.prompt || '').trim()),
        uc: String(raw?.uc || '').trim(),
        x: typeof raw?.x === 'number' && !isNaN(raw.x) ? Math.max(0, Math.min(1, raw.x)) : null,
        y: typeof raw?.y === 'number' && !isNaN(raw.y) ? Math.max(0, Math.min(1, raw.y)) : null,
      };
      CHARS.push(charObj);
      activeCharIndex = CHARS.length - 1;
      renderChars();
      toast(`已将角色【${item.title}】导入至独立角色面板`);
      closePromptLibrary();
    } catch (err) {
      toast(`角色数据反序列化失败：${err.message}`, true);
    }
  }
}

function bindPromptLibrary() {
  // 入口按钮监听
  $('promptLibBtn')?.addEventListener('click', () => openPromptLibrary('painter'));
  $('ucLibBtn')?.addEventListener('click', () => openPromptLibrary('uc'));
  $('charFromLibBtn')?.addEventListener('click', () => openPromptLibrary('character'));

  // 关闭与背景点击
  $('promptLibCloseBtn')?.addEventListener('click', closePromptLibrary);
  $('promptLibModal')?.addEventListener('click', (e) => {
    // 点击弹窗内除当前 popover 及其触发按钮以外的区域时，关闭浮层
    if (activeLibPopover && !activeLibPopover.menu.contains(e.target) && !activeLibPopover.trigger.contains(e.target)) {
      closeActiveLibPopover();
    }
    if (e.target === $('promptLibModal')) closePromptLibrary();
  });
  // 全局点击监听，若在弹窗外点击也关闭浮层
  document.addEventListener('click', (e) => {
    if (activeLibPopover && !activeLibPopover.menu.contains(e.target) && !activeLibPopover.trigger.contains(e.target)) {
      closeActiveLibPopover();
    }
  });
  // 滚动、窗口缩放、ESC按键时关闭浮层，避免 fixed 菜单脱离触发按钮
  window.addEventListener('scroll', closeActiveLibPopover, true);
  window.addEventListener('resize', closeActiveLibPopover);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeLibPopover) {
      closeActiveLibPopover();
    }
  });
  // 顶部 5 个 Kind 分区 Tab 切换
  document.querySelectorAll('#promptLibTabNav .nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const kind = tab.dataset.kind;
      if (kind) switchPromptLibKind(kind);
    });
  });
  // 新增片段卡片折叠开关
  $('libAddCardHead')?.addEventListener('click', () => {
    closeActiveLibPopover();
    libAddFormCollapsed = !libAddFormCollapsed;
    $('libAddCard')?.classList.toggle('collapsed', libAddFormCollapsed);
  });


  // 角色站位模式切换 (Auto vs Manual)
  let charPosMode = 'auto'; // 'auto' | 'manual'
  const autoBtn = $('libCharPosAutoBtn');
  const manualBtn = $('libCharPosManualBtn');
  const coordWrap = $('libCharCoordInputs');

  autoBtn?.addEventListener('click', () => {
    charPosMode = 'auto';
    autoBtn.classList.add('active');
    manualBtn?.classList.remove('active');
    coordWrap?.classList.add('hidden');
  });

  manualBtn?.addEventListener('click', () => {
    charPosMode = 'manual';
    manualBtn.classList.add('active');
    autoBtn?.classList.remove('active');
    coordWrap?.classList.remove('hidden');
  });

  // 新增片段表单提交
  $('libAddForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('libItemTitle').value.trim();
    if (!title) return toast('请输入片段标题', true);

    let content = '';
    if (currentLibKind === 'character') {
      const charPrompt = formatCharPromptXxxIp($('libCharPrompt').value.trim());
      const charUc = $('libCharUc').value.trim();
      let posX = null;
      let posY = null;
      if (charPosMode === 'manual') {
        const parsedX = parseFloat($('libCharPosX').value);
        const parsedY = parseFloat($('libCharPosY').value);
        posX = !isNaN(parsedX) ? Math.max(0, Math.min(1, +parsedX.toFixed(3))) : 0.5;
        posY = !isNaN(parsedY) ? Math.max(0, Math.min(1, +parsedY.toFixed(3))) : 0.5;
      }
      const charData = { prompt: charPrompt, uc: charUc, x: posX, y: posY };
      content = JSON.stringify(charData);
    } else {
      content = $('libItemContent').value.trim();
      if (!content) return toast('请输入提示词内容', true);
    }

    const saveBtn = $('libSaveBtn');
    saveBtn.disabled = true;
    try {
      const res = await api('/api/prompts', {
        method: 'POST',
        body: JSON.stringify({
          kind: currentLibKind,
          title,
          content,
        }),
      });
      toast('片段已保存');
      $('libItemTitle').value = '';
      $('libItemContent').value = '';
      $('libCharPrompt').value = '';
      $('libCharUc').value = '';
      fetchAndRenderLibItems(currentLibKind);
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
    } finally {
      saveBtn.disabled = false;
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
   Anlas 额度弹窗
   ═════════════════════════════════════════════════════════════ */
async function showAnlasModal() {
  const bg = document.createElement('div');
  bg.className = 'modal-backdrop';
  bg.innerHTML = `
    <div class="modal-window profile-window" style="max-width:560px;">
      <div class="modal-title-row">
        <h3>💎 PST 密钥池储备 & V5 充能池 <button class="btn icon-btn close">✕</button></h3>
      </div>
      <div id="anlasModalBody" style="font-size:12.5px;max-height:68vh;overflow-y:auto;">查询中…</div>
    </div>`;
  document.body.appendChild(bg);

  const close = () => bg.remove();
  bg.querySelector('.close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });

  try {
    const j = await api('/api/anlas');
    $('anlasBadge').textContent = `${j.totalAnlas} Anlas`;
    let html = j.keys.map((k) => {
      const v5Bat = typeof k.v5Battery === 'number'
        ? `<span style="color:${k.v5Battery > 20 ? '#34d399' : '#f87171'};font-weight:600;">⚡ V5池: ${k.v5Battery}%</span>`
        : '<span style="color:var(--text-dim);">V5池: —</span>';
      const displayEmail = k.email || (k.label && k.label.includes('@') ? k.label : null);
      const emailBadge = displayEmail
        ? `<div style="font-size:11.5px;font-family:var(--font-mono);color:var(--primary-light);margin-bottom:4px;">📧 ${esc(displayEmail)}</div>`
        : '<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">📧 账号未绑定邮箱</div>';
      return `
        <div class="anlas-key-row" style="padding:10px 0;border-bottom:1px solid var(--border-subtle);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
            <strong style="font-size:13px;">${esc(k.label)}</strong>
            <span class="cost-tag" style="padding:2px 8px;font-size:11px;">${esc(k.tier)}</span>
          </div>
          ${emailBadge}
          <div style="display:flex;justify-content:space-between;color:var(--text-dim);font-size:12px;">
            <span>${v5Bat}</span>
            <span>Anlas: <strong style="color:var(--text-main);">${k.anlas ?? '—'}</strong> ${k.error ? '<span style="color:var(--err)">(' + esc(k.error.slice(0, 30)) + ')</span>' : ''}</span>
          </div>
        </div>`;
    }).join('');
    if (!j.keys.length) html = '<div class="anlas-key-row">池内暂无可用的活跃密钥</div>';
    html += `
      <div class="anlas-total-row" style="margin-top:12px;padding-top:8px;font-size:13px;display:flex;justify-content:space-between;align-items:center;">
        <span><strong>总计可用节点：</strong>${j.activeCount} 个</span>
        <span><strong>全池 Anlas 合计：</strong><strong style="color:#a78bfa;font-size:15px;">${j.totalAnlas}</strong></span>
      </div>
      <div style="margin-top:10px;font-size:11.5px;color:var(--text-dim);line-height:1.5;background:rgba(255,255,255,0.03);padding:8px 10px;border-radius:6px;">
        ℹ️ <strong>NovelAI V5 额度机制提示</strong>：<br>
        V5 模型免费生图（≤1024×1024, ≤28步, 单张）采用<strong>动态充能池</strong>（初始最高可达 180%，空槽充满约需一周，每小时自动回血）。池内电量耗尽后将自动消耗 Anlas。
      </div>`;
    bg.querySelector('#anlasModalBody').innerHTML = html;
  } catch (e) {
    bg.querySelector('#anlasModalBody').innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`;
  }
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

  // 测试全部密钥有效性
  $('adminTestAllBtn').addEventListener('click', async () => {
    const btn = $('adminTestAllBtn');
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const j = await api('/api/admin/keys/test-all', { method: 'POST' });
      const pass = j.results.filter((r) => r.ok).length;
      toast(`测试完成：${pass}/${j.results.length} 正常可用`);
      loadKeys();
      loadStats();
    } catch (e) { toast(e.message, true); }
    finally {
      btn.disabled = false;
      btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-zap"/></svg><span>测试全部密钥</span>';
    }
  });
  // 一键粘贴密钥
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

  $('keyAdd').addEventListener('click', async () => {
    const label = $('keyLabel').value.trim();
    const email = $('keyEmail')?.value.trim() || '';
    const token = $('keyToken').value.trim();
    try {
      const j = await api('/api/admin/keys', { method: 'POST', body: JSON.stringify({ label, token, email }) });
      toast(j.verify?.ok ? '密钥已通过真实验证，成功入池' : `已入库但验证未过：${j.verify?.error || ''}`);
      $('keyToken').value = '';
      if ($('keyEmail')) $('keyEmail').value = '';
      loadKeys();
    } catch (e) { toast(e.message, true); }
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

async function loadKeys() {
  try {
    const j = await api('/api/admin/keys');
    const tb = $('keysTbl').querySelector('tbody');
    tb.innerHTML = '';
    for (const k of j.items) {
      const tr = document.createElement('tr');
      let batteryHtml = '—';
      if (typeof k.v5_battery === 'number') {
        const bat = k.v5_battery;
        const color = bat > 40 ? '#34d399' : (bat > 5 ? '#fbbf24' : '#f87171');
        const stateText = bat <= 5 ? ' (保护中)' : '';
        batteryHtml = `<div style="display:flex;align-items:center;gap:6px;"><span style="color:${color};font-weight:700;">⚡ ${bat}%${stateText}</span></div>`;
      }
      const displayEmail = k.email || (k.label && k.label.includes('@') ? k.label : '未绑定');
      tr.innerHTML = `
        <td>${k.id}</td>
        <td><strong style="color:var(--text-main);">${esc(k.label)}</strong> <button class="btn tiny ghost-btn act-edit-lbl" title="修改备注" style="padding:1px 4px;font-size:10px;">✏️</button></td>
        <td><span style="font-family:var(--font-mono);color:${k.email || k.label.includes('@') ? 'var(--primary-light)' : 'var(--text-dim)'};">${esc(displayEmail)}</span> <button class="btn tiny ghost-btn act-edit-em" title="修改/绑定邮箱" style="padding:1px 4px;font-size:10px;">✏️</button></td>
        <td><code>${esc(k.token_preview)}</code></td>
        <td>${k.is_active ? '<span style="color:var(--ok)">✓ 启用中</span>' : '<span style="color:var(--text-dim)">已停用</span>'}${k.verify_state ? `<br><small style="color:var(--text-dim)">${esc(k.verify_state.slice(0, 24))}</small>` : ''}</td>
        <td>${batteryHtml}</td>
        <td>${k.tier ?? '—'}</td><td>${k.anlas ?? '—'}</td><td>${k.use_count}</td>
        <td>
          <button class="btn tiny ghost-btn act-tg">${k.is_active ? '停用' : '启用'}</button>
          <button class="btn tiny ghost-btn act-vf">测试</button>
          <button class="btn tiny ghost-btn act-dl">删除</button>
        </td>`;
      tr.querySelector('.act-edit-lbl').addEventListener('click', async () => {
        const newLbl = prompt('输入新的备注标签：', k.label);
        if (newLbl !== null && newLbl.trim() && newLbl.trim() !== k.label) {
          await api(`/api/admin/keys/${k.id}`, { method: 'POST', body: JSON.stringify({ action: 'edit', label: newLbl.trim() }) });
          toast('备注已更新');
          loadKeys();
        }
      });
      tr.querySelector('.act-edit-em').addEventListener('click', async () => {
        const newEm = prompt('输入该 PST 对应的账号邮箱：', k.email || (k.label.includes('@') ? k.label : ''));
        if (newEm !== null) {
          await api(`/api/admin/keys/${k.id}`, { method: 'POST', body: JSON.stringify({ action: 'edit', email: newEm.trim() }) });
          toast('对应邮箱已保存');
          loadKeys();
        }
      });
      tr.querySelector('.act-tg').addEventListener('click', () =>
        api(`/api/admin/keys/${k.id}`, { method: 'POST', body: JSON.stringify({ action: 'toggle' }) }).then(loadKeys).catch((e) => toast(e.message, true)));
      tr.querySelector('.act-vf').addEventListener('click', () =>
        api(`/api/admin/keys/${k.id}`, { method: 'POST', body: JSON.stringify({ action: 'verify' }) }).then(loadKeys).catch((e) => toast(e.message, true)));
      tr.querySelector('.act-dl').addEventListener('click', () => {
        if (!confirm('确定删除该 PST 密钥？')) return;
        api(`/api/admin/keys/${k.id}`, { method: 'DELETE' }).then(loadKeys).catch((e) => toast(e.message, true));
      });
      tb.appendChild(tr);
    }
  } catch (e) { toast(e.message, true); }
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
