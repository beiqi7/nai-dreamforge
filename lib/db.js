'use strict';
/**
 * lib/db.js — SQLite 数据层（node:sqlite，零依赖）
 *
 * 表：
 *   users        站点用户（管理员/普通用户）
 *   nai_keys     NovelAI PST 密钥池（仅管理员管理；普通用户生图时轮询选取）
 *   generations  生成记录（含 Anlas 估算与实际扣费）
 *   sessions     登录会话
 */

const { DatabaseSync } = require('node:sqlite');
const { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs');
const { DEFAULT_TIERS } = require('./tiers');

const DB_PATH = process.env.NAI_DB || path.join(__dirname, '..', 'data', 'nai.sqlite');
const IS_MEMORY_DB = DB_PATH === ':memory:';

if (!IS_MEMORY_DB) {
  process.umask(0o077);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(DB_PATH), 0o700); } catch {}
}

const db = new DatabaseSync(DB_PATH);
db.exec(IS_MEMORY_DB
  ? 'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'
  : 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
if (!IS_MEMORY_DB) {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { fs.chmodSync(file, 0o600); } catch {}
  }
}

/** 预编译语句缓存：仅用于固定 SQL（动态 IN 列表仍直接 db.prepare，避免缓存无界增长） */
const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

/* ─── 建表 ──────────────────────────────────────────────── */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  disabled      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nai_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_used_at  TEXT,
  use_count     INTEGER NOT NULL DEFAULT 0,
  verify_state  TEXT,
  tier          INTEGER,
  anlas         INTEGER,
  anlas_checked_at TEXT,
  v5_battery    INTEGER,
  v5_battery_checked_at TEXT,
  email         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS generations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  key_id        INTEGER REFERENCES nai_keys(id),
  model         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  uc            TEXT,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  steps         INTEGER NOT NULL,
  scale         REAL,
  sampler       TEXT,
  seed          INTEGER,
  n_samples     INTEGER NOT NULL DEFAULT 1,
  anlas_est     INTEGER NOT NULL DEFAULT 0,
  anlas_act     INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','fail')),
  error         TEXT,
  file          TEXT,
  duration_ms   INTEGER,
  char_prompts  TEXT,
  is_favorited  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gen_user ON generations(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_library (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('painter','action','uc','character','main')),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prompt_lib_user_kind ON prompt_library(user_id, kind);

CREATE TABLE IF NOT EXISTS api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT 'plugin',
  revoked       INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- 用户等级：仅约束普通用户；限额字段 NULL = 不限，anlas_per_day = 0 = 只能免费生成
CREATE TABLE IF NOT EXISTS user_tiers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  sort             INTEGER NOT NULL DEFAULT 0,
  is_default       INTEGER NOT NULL DEFAULT 0,
  max_pixels       INTEGER NOT NULL,
  max_steps        INTEGER NOT NULL,
  max_samples      INTEGER NOT NULL DEFAULT 1,
  allow_img2img    INTEGER NOT NULL DEFAULT 0,
  allow_inpaint    INTEGER NOT NULL DEFAULT 0,
  limit_per_minute INTEGER,
  limit_per_hour   INTEGER,
  limit_per_day    INTEGER,
  anlas_per_day    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* ─── 数据库迁移 ───────────────────────────────────────── */
const genCols = db.prepare('PRAGMA table_info(generations)').all();
if (!genCols.some((c) => c.name === 'char_prompts')) {
  db.exec('ALTER TABLE generations ADD COLUMN char_prompts TEXT;');
}
if (!genCols.some((c) => c.name === 'is_favorited')) {
  db.exec('ALTER TABLE generations ADD COLUMN is_favorited INTEGER NOT NULL DEFAULT 0;');
}
// 索引须在迁移分支之外创建：全新库的 CREATE TABLE 已含 is_favorited，不会进入上面的分支。
db.exec('CREATE INDEX IF NOT EXISTS idx_gen_user_fav ON generations(user_id, is_favorited, id DESC);');
// /img/:file 每次请求按文件名查属主，无索引时为全表扫描。
db.exec('CREATE INDEX IF NOT EXISTS idx_gen_file ON generations(file);');
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some((c) => c.name === 'quota_reset_at')) {
  db.exec('ALTER TABLE users ADD COLUMN quota_reset_at TEXT;');
}
// 频控重置以“重置时刻的最大生成 id”为界：datetime 只精确到秒，按时间比较会漏算同一秒内的生成
if (!userCols.some((c) => c.name === 'quota_reset_after_id')) {
  db.exec('ALTER TABLE users ADD COLUMN quota_reset_after_id INTEGER;');
  db.exec(`UPDATE users SET quota_reset_after_id = (
    SELECT COALESCE(MAX(g.id), 0) FROM generations g WHERE g.user_id = users.id AND g.created_at <= users.quota_reset_at
  ) WHERE quota_reset_at IS NOT NULL;`);
}
if (!userCols.some((c) => c.name === 'tier_id')) {
  db.exec('ALTER TABLE users ADD COLUMN tier_id INTEGER REFERENCES user_tiers(id);');
}
// 单个用户的覆盖额度：NULL = 跟随所在等级
if (!userCols.some((c) => c.name === 'limit_per_day_override')) {
  db.exec('ALTER TABLE users ADD COLUMN limit_per_day_override INTEGER;');
}
if (!userCols.some((c) => c.name === 'anlas_per_day_override')) {
  db.exec('ALTER TABLE users ADD COLUMN anlas_per_day_override INTEGER;');
}
if (db.prepare('SELECT COUNT(*) c FROM user_tiers').get().c === 0) {
  const insertTier = db.prepare(`
    INSERT INTO user_tiers (name, sort, is_default, max_pixels, max_steps, max_samples, allow_img2img, allow_inpaint,
                            limit_per_minute, limit_per_hour, limit_per_day, anlas_per_day)
    VALUES (@name, @sort, @is_default, @max_pixels, @max_steps, @max_samples, @allow_img2img, @allow_inpaint,
            @limit_per_minute, @limit_per_hour, @limit_per_day, @anlas_per_day)`);
  for (const tier of DEFAULT_TIERS) insertTier.run(tier);
}
// 老用户（含升级前创建的）一律归入默认等级，行为与升级前的免费层一致
db.exec('UPDATE users SET tier_id = (SELECT id FROM user_tiers WHERE is_default = 1 ORDER BY id LIMIT 1) WHERE tier_id IS NULL;');
const keyCols = db.prepare('PRAGMA table_info(nai_keys)').all();
if (!keyCols.some((c) => c.name === 'v5_battery')) {
  db.exec('ALTER TABLE nai_keys ADD COLUMN v5_battery INTEGER;');
}
if (!keyCols.some((c) => c.name === 'v5_battery_checked_at')) {
  db.exec('ALTER TABLE nai_keys ADD COLUMN v5_battery_checked_at TEXT;');
}
if (!keyCols.some((c) => c.name === 'email')) {
  db.exec('ALTER TABLE nai_keys ADD COLUMN email TEXT;');
}

/* ─── 密码 ──────────────────────────────────────────────── */

function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'));
function verifyPassword(pw, stored) {
  if (typeof pw !== 'string') return false;
  const [salt, hash] = String(stored).split(':');
  if (!/^[a-f0-9]{32}$/i.test(salt || '') || !/^[a-f0-9]{64}$/i.test(hash || '')) return false;
  const test = scryptSync(pw, salt, 32);
  return timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
const scryptAsync = promisify(scrypt);
/** 登录校验：异步 scrypt 放到线程池执行，不阻塞事件循环；用户不存在时也跑一次哈希防计时枚举 */
async function verifyLoginPassword(pw, stored) {
  const validHash = /^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(String(stored || ''));
  const [salt, hash] = (validHash ? stored : DUMMY_PASSWORD_HASH).split(':');
  const test = await scryptAsync(String(pw ?? ''), salt, 32);
  return validHash && timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

/* ─── 用户 ──────────────────────────────────────────────── */

const DEFAULT_TIER_SQL = '(SELECT id FROM user_tiers WHERE is_default = 1 ORDER BY id LIMIT 1)';

const qUsers = {
  create: (username, password, role = 'user', tierId = null) => stmt(`
    INSERT INTO users (username, password_hash, role, tier_id) VALUES (?, ?, ?, COALESCE(?, ${DEFAULT_TIER_SQL}))
  `).run(username, hashPassword(password), role, tierId).lastInsertRowid,
  byName: (username) => stmt('SELECT * FROM users WHERE username = ?').get(username),
  byId: (id) => stmt('SELECT id, username, role, disabled, created_at FROM users WHERE id = ?').get(id),
  listWithUsage: () => stmt(`
    SELECT u.id, u.username, u.role, u.disabled, u.created_at,
           t.id AS tier_id, t.name AS tier_name,
           u.limit_per_day_override, u.anlas_per_day_override,
           t.limit_per_minute, t.limit_per_hour,
           COALESCE(u.limit_per_day_override, t.limit_per_day) AS limit_per_day,
           COALESCE(u.anlas_per_day_override, t.anlas_per_day) AS anlas_per_day,
           COALESCE(SUM(CASE WHEN g.created_at >= datetime('now', '-1 minute') AND g.id > COALESCE(u.quota_reset_after_id, 0) AND g.status IN ('ok','pending') THEN COALESCE(g.n_samples, 1) ELSE 0 END), 0) AS m1,
           COALESCE(SUM(CASE WHEN g.created_at >= datetime('now', '-1 hour') AND g.id > COALESCE(u.quota_reset_after_id, 0) AND g.status IN ('ok','pending') THEN COALESCE(g.n_samples, 1) ELSE 0 END), 0) AS h1,
           COALESCE(SUM(CASE WHEN g.created_at >= datetime('now', '-24 hours') AND g.id > COALESCE(u.quota_reset_after_id, 0) AND g.status IN ('ok','pending') THEN COALESCE(g.n_samples, 1) ELSE 0 END), 0) AS d1,
           COALESCE(SUM(CASE WHEN g.created_at >= datetime('now', '-24 hours') AND g.id > COALESCE(u.quota_reset_after_id, 0) AND g.status IN ('ok','pending') THEN COALESCE(g.anlas_act, g.anlas_est, 0) ELSE 0 END), 0) AS a1,
           COALESCE(SUM(CASE WHEN g.status = 'ok' THEN 1 ELSE 0 END), 0) AS total_ok
    FROM users u
    LEFT JOIN user_tiers t ON t.id = COALESCE(u.tier_id, ${DEFAULT_TIER_SQL})
    LEFT JOIN generations g ON g.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id
  `).all(),
  /** 普通用户的生效限额：等级配置叠加单人覆盖值 */
  limits: (userId) => stmt(`
    SELECT t.id AS tier_id, t.name, t.max_pixels, t.max_steps, t.max_samples, t.allow_img2img, t.allow_inpaint,
           t.limit_per_minute, t.limit_per_hour,
           COALESCE(u.limit_per_day_override, t.limit_per_day) AS limit_per_day,
           COALESCE(u.anlas_per_day_override, t.anlas_per_day) AS anlas_per_day
    FROM users u
    JOIN user_tiers t ON t.id = COALESCE(u.tier_id, ${DEFAULT_TIER_SQL})
    WHERE u.id = ?
  `).get(userId),
  overrides: (id) => stmt('SELECT limit_per_day_override, anlas_per_day_override FROM users WHERE id = ?').get(id),
  setTier: (id, tierId) => stmt('UPDATE users SET tier_id = ? WHERE id = ?').run(tierId, id),
  setOverrides: (id, limitPerDay, anlasPerDay) => stmt(
    'UPDATE users SET limit_per_day_override = ?, anlas_per_day_override = ? WHERE id = ?',
  ).run(limitPerDay, anlasPerDay, id),
  list: () => stmt('SELECT id, username, role, disabled, created_at FROM users ORDER BY id').all(),
  setUsername: (id, name) => stmt('UPDATE users SET username = ? WHERE id = ?').run(name, id),
  setPassword: (id, pw) => stmt('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), id),
  setRole: (id, role) => stmt('UPDATE users SET role = ? WHERE id = ?').run(role, id),
  setDisabled: (id, d) => stmt('UPDATE users SET disabled = ? WHERE id = ?').run(d ? 1 : 0, id),
  del: (id) => stmt('DELETE FROM users WHERE id = ?').run(id),
  count: () => stmt('SELECT COUNT(*) c FROM users').get().c,
  enabledAdminCount: () => stmt("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND disabled = 0").get().c,
};

/* ─── 用户等级 ──────────────────────────────────────────── */

const TIER_COLUMNS = ['name', 'sort', 'max_pixels', 'max_steps', 'max_samples', 'allow_img2img', 'allow_inpaint',
  'limit_per_minute', 'limit_per_hour', 'limit_per_day', 'anlas_per_day'];

const qTiers = {
  list: () => stmt(`
    SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.role = 'user' AND u.tier_id = t.id) AS user_count
    FROM user_tiers t ORDER BY t.sort, t.id
  `).all(),
  get: (id) => stmt('SELECT * FROM user_tiers WHERE id = ?').get(id),
  defaultId: () => stmt('SELECT id FROM user_tiers WHERE is_default = 1 ORDER BY id LIMIT 1').get()?.id,
  create: (input) => {
    // 未指定排序时排在最后
    const tier = { ...input, sort: input.sort ?? (stmt('SELECT COALESCE(MAX(sort), 0) AS m FROM user_tiers').get().m + 10) };
    const cols = TIER_COLUMNS.filter((c) => tier[c] !== undefined);
    return stmt(`INSERT INTO user_tiers (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`)
      .run(Object.fromEntries(cols.map((c) => [c, tier[c]]))).lastInsertRowid;
  },
  update: (id, tier) => {
    const cols = TIER_COLUMNS.filter((c) => tier[c] !== undefined);
    if (!cols.length) return { changes: 0 };
    return stmt(`UPDATE user_tiers SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ ...Object.fromEntries(cols.map((c) => [c, tier[c]])), id });
  },
  /** 删除等级：其下用户先移回默认等级（同一事务） */
  delete: (id, defaultId) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const moved = stmt('UPDATE users SET tier_id = ? WHERE tier_id = ?').run(defaultId, id).changes;
      stmt('DELETE FROM user_tiers WHERE id = ? AND is_default = 0').run(id);
      db.exec('COMMIT');
      return moved;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  },
};

/* ─── 会话 ──────────────────────────────────────────────── */

const SESSION_TTL_DAYS = 7;
const qSessions = {
  create: (userId) => {
    const token = randomBytes(32).toString('hex');
    stmt(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,datetime('now','+${SESSION_TTL_DAYS} days'))`).run(token, userId);
    return token;
  },
  get: (token) => stmt(`
    SELECT s.token, s.user_id, s.expires_at, u.username, u.role, u.disabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.disabled = 0
  `).get(token),
  del: (token) => stmt('DELETE FROM sessions WHERE token = ?').run(token),
  delByUser: (userId) => stmt('DELETE FROM sessions WHERE user_id = ?').run(userId),
  delByUserExcept: (userId, token) => stmt('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, token),
  delExpired: () => stmt(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run(),
};

/* ─── NAI 密钥池 ────────────────────────────────────────── */

const qKeys = {
  add: (label, token) => stmt('INSERT INTO nai_keys (label, token) VALUES (?,?)').run(label, token).lastInsertRowid,
  list: () => stmt("SELECT id, label, email, substr(token,1,8) || '…' AS token_preview, is_active, last_used_at, use_count, verify_state, tier, anlas, anlas_checked_at, v5_battery, v5_battery_checked_at, created_at FROM nai_keys ORDER BY id").all(),
  get: (id) => stmt('SELECT * FROM nai_keys WHERE id = ?').get(id),
  byToken: (token) => stmt('SELECT * FROM nai_keys WHERE token = ?').get(token),
  /** 取可用密钥调度算法：
   *  - invalid 排除；
   *  - 免费生成（required=0）：强制要求 tier=3（Opus）
   *    【高电量优先阶梯算法】：
   *    优先选择高电量（v5_battery 降序）；
   *    若电量相同或未探测，则按最后使用时间 COALESCE(last_used_at, '') ASC 轮询；
   *    设立低电量保护缓冲区：当电量 <= 5% 视为临界衰竭状态，降权排在所有正常电量之后。
   *  - 计费生成（required>0）：anlas >= 所需者优先，anlas 降序
   */
  listCandidates: (requiredAnlas = 0) => {
    if (requiredAnlas === 0) {
      return stmt(`
        SELECT * FROM nai_keys
        WHERE is_active = 1 AND (verify_state IS NULL OR verify_state NOT LIKE 'invalid%')
          AND tier = 3
        ORDER BY
          CASE WHEN COALESCE(v5_battery, 100) > 5 THEN 0 ELSE 1 END ASC,
          COALESCE(v5_battery, 100) DESC,
          COALESCE(last_used_at, '') ASC,
          use_count ASC
      `).all();
    }
    return stmt(`
      SELECT * FROM nai_keys
      WHERE is_active = 1 AND (verify_state IS NULL OR verify_state NOT LIKE 'invalid%')
        AND CAST(COALESCE(anlas, 0) AS INTEGER) >= ?
      ORDER BY -CAST(COALESCE(anlas, 0) AS INTEGER) ASC,
        COALESCE(last_used_at, '') ASC,
        use_count ASC
    `).all(requiredAnlas);
  },
  setEmail: (id, email) => stmt(`UPDATE nai_keys SET email = ? WHERE id = ?`).run(email, id),
  setLabel: (id, label) => stmt(`UPDATE nai_keys SET label = ? WHERE id = ?`).run(label, id),
  markUsed: (id) => stmt(`UPDATE nai_keys SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?`).run(id),
  setActive: (id, active) => stmt('UPDATE nai_keys SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id),
  setState: (id, verify_state, tier, anlas, v5_battery) => {
    if (v5_battery !== undefined) {
      return stmt(`UPDATE nai_keys SET verify_state = ?, tier = ?, anlas = ?, v5_battery = ?, anlas_checked_at = datetime('now'), v5_battery_checked_at = datetime('now') WHERE id = ?`).run(verify_state, tier, anlas, v5_battery, id);
    }
    return stmt(`UPDATE nai_keys SET verify_state = ?, tier = ?, anlas = ?, anlas_checked_at = datetime('now') WHERE id = ?`).run(verify_state, tier, anlas, id);
  },
  del: (id) => stmt('DELETE FROM nai_keys WHERE id = ?').run(id),
  count: () => stmt('SELECT COUNT(*) c FROM nai_keys WHERE is_active = 1').get().c,
};

/* ─── 生成记录 ──────────────────────────────────────────── */

const qGens = {
  insert: (row) => stmt(`
    INSERT INTO generations (user_id, key_id, model, prompt, uc, width, height, steps, scale, sampler, seed, n_samples, anlas_est, char_prompts, status)
    VALUES (@user_id, @key_id, @model, @prompt, @uc, @width, @height, @steps, @scale, @sampler, @seed, @n_samples, @anlas_est, @char_prompts, 'pending')
  `).run(row).lastInsertRowid,
  // 删除密钥前解绑生成记录（generations.key_id 置 NULL，防 FK/残留）
  detachKey: (keyId) => stmt('UPDATE generations SET key_id = NULL WHERE key_id = ?').run(keyId),
  finishOk: (id, anlasAct, file, durationMs) => stmt(`
    UPDATE generations SET status='ok', anlas_act=?, file=?, duration_ms=? WHERE id=?
  `).run(anlasAct, file, durationMs, id),
  finishFail: (id, error, durationMs) => stmt(`
    UPDATE generations SET status='fail', error=?, duration_ms=? WHERE id=?
  `).run(String(error).slice(0, 500), durationMs, id),
  /** 按 id 倒序分页：before 为上一页最后一条的 id（游标），不传则从最新开始 */
  byUser: (userId, limit = 60, { favoritedOnly = false, okOnly = false, before } = {}) => {
    const sql = `SELECT id, model, prompt, uc, width, height, steps, scale, sampler, seed, n_samples, anlas_est, anlas_act, status, error, file, duration_ms, char_prompts, is_favorited, created_at
      FROM generations
      WHERE user_id = ? AND id < ?${favoritedOnly ? ' AND is_favorited = 1' : ''}${okOnly ? " AND status = 'ok' AND file IS NOT NULL" : ''}
      ORDER BY id DESC LIMIT ?`;
    return stmt(sql).all(userId, Number.isInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER, limit);
  },
  countGalleryByUser: (userId) => stmt(`
    SELECT COUNT(*) AS total, COALESCE(SUM(is_favorited), 0) AS favorited
    FROM generations WHERE user_id = ? AND status = 'ok' AND file IS NOT NULL
  `).get(userId),
  toggleFavorite: (id, userId, state) => {
    if (state !== undefined) {
      return stmt('UPDATE generations SET is_favorited = ? WHERE id = ? AND user_id = ?').run(state ? 1 : 0, id, userId);
    }
    return stmt('UPDATE generations SET is_favorited = CASE WHEN is_favorited = 1 THEN 0 ELSE 1 END WHERE id = ? AND user_id = ?').run(id, userId);
  },
  batchFavorite: (ids, userId, state = true) => {
    if (!ids.length) return { changes: 0 };
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`UPDATE generations SET is_favorited = ? WHERE user_id = ? AND id IN (${placeholders})`).run(state ? 1 : 0, userId, ...ids);
  },
  batchDelByUser: (ids, userId) => {
    if (!ids.length) return { files: [], changes: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT file FROM generations WHERE user_id = ? AND id IN (${placeholders}) AND file IS NOT NULL`).all(userId, ...ids);
    const res = db.prepare(`DELETE FROM generations WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...ids);
    return { files: rows.map(r => r.file), changes: res.changes };
  },
  getFilesByIds: (ids, userId) => {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id, file, seed FROM generations WHERE user_id = ? AND id IN (${placeholders}) AND file IS NOT NULL`).all(userId, ...ids);
  },
  // 统计指定用户在最近窗口内的实际出图张数 (status IN ('ok', 'pending'))
  countRecentByUser: (userId) => stmt(`
    SELECT
      COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 minute') THEN COALESCE(n_samples, 1) ELSE 0 END), 0) AS count_1m,
      COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 hour') THEN COALESCE(n_samples, 1) ELSE 0 END), 0) AS count_1h,
      COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-24 hours') THEN COALESCE(n_samples, 1) ELSE 0 END), 0) AS count_1d,
      COALESCE(SUM(COALESCE(anlas_act, anlas_est, 0)), 0) AS anlas_1d
    FROM generations
    WHERE user_id = ? AND status IN ('ok', 'pending')
      AND created_at >= datetime('now', '-24 hours')
      AND id > COALESCE((SELECT quota_reset_after_id FROM users WHERE id = ?), 0)
  `).get(userId, userId),
  // 多图请求落盘后，主记录只代表其中一张（其余各有一条记录），避免频控重复计数
  setSamples: (id, n) => stmt('UPDATE generations SET n_samples = ? WHERE id = ?').run(n, id),
  // 重置频控配额：记录重置时刻，此前的生成不再计入窗口；不改动生成记录本身的时间
  resetQuotaByUser: (userId) => stmt(`
    UPDATE users SET quota_reset_at = datetime('now'), quota_reset_after_id = (SELECT COALESCE(MAX(id), 0) FROM generations)
    WHERE id = ?
  `).run(userId),
  all: (limit = 200) => stmt(`
    SELECT g.*, u.username FROM generations g JOIN users u ON u.id = g.user_id ORDER BY g.id DESC LIMIT ?
  `).all(limit),
  stats: () => stmt(`
    SELECT COUNT(*) total,
           SUM(status='ok') ok,
           SUM(status='fail') failed,
           SUM(CASE WHEN status='ok' THEN COALESCE(anlas_act, anlas_est) ELSE 0 END) anlas_used
    FROM generations
  `).get(),
  byId: (id) => stmt('SELECT * FROM generations WHERE id = ?').get(id),
  delByUser: (id, userId) => stmt('DELETE FROM generations WHERE id = ? AND user_id = ?').run(id, userId),
  filesByUser: (userId) => stmt('SELECT file FROM generations WHERE user_id = ? AND file IS NOT NULL').all(userId),
  clearByUser: (userId) => stmt('DELETE FROM generations WHERE user_id = ?').run(userId),
  delByAdmin: (id) => stmt('DELETE FROM generations WHERE id = ?').run(id),
  byFile: (file) => stmt('SELECT user_id, file FROM generations WHERE file = ?').get(file),
};

/* ─── 提示词片段库 ───────────────────────────────────────── */

const qPrompts = {
  countByUser: (userId) => stmt('SELECT COUNT(*) c FROM prompt_library WHERE user_id = ?').get(userId).c,
  listByUserAndKind: (userId, kind) => stmt(`
    SELECT id, user_id, kind, title, content, sort, created_at, updated_at
    FROM prompt_library
    WHERE user_id = ? AND kind = ?
    ORDER BY sort ASC, id ASC
  `).all(userId, kind),
  byId: (id) => stmt(`
    SELECT id, user_id, kind, title, content, sort, created_at, updated_at
    FROM prompt_library
    WHERE id = ?
  `).get(id),
  insert: ({ user_id, kind, title, content, sort = 0 }) => stmt(`
    INSERT INTO prompt_library (user_id, kind, title, content, sort)
    VALUES (?, ?, ?, ?, ?)
  `).run(user_id, kind, title, content, sort).lastInsertRowid,
  update: (id, userId, { title, content, sort }) => {
    const fields = [];
    const values = [];
    if (title !== undefined) { fields.push('title = ?'); values.push(title); }
    if (content !== undefined) { fields.push('content = ?'); values.push(content); }
    if (sort !== undefined) { fields.push('sort = ?'); values.push(sort); }
    fields.push("updated_at = datetime('now')");
    values.push(id, userId);
    return stmt(`
      UPDATE prompt_library
      SET ${fields.join(', ')}
      WHERE id = ? AND user_id = ?
    `).run(...values);
  },
  delByUser: (id, userId) => stmt(`
    DELETE FROM prompt_library WHERE id = ? AND user_id = ?
  `).run(id, userId),
  clearByUser: (userId) => stmt('DELETE FROM prompt_library WHERE user_id = ?').run(userId),
};

function hashApiToken(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

const qApiTokens = {
  create: (userId, label) => {
    const raw = `nai_${randomBytes(32).toString('hex')}`;
    const hash = hashApiToken(raw);
    const prefix = raw.slice(0, 12);
    const id = stmt(
      'INSERT INTO api_tokens (user_id, token_hash, token_prefix, label) VALUES (?, ?, ?, ?)',
    ).run(userId, hash, prefix, String(label || 'plugin').slice(0, 40)).lastInsertRowid;
    return { id, token: raw, prefix };
  },
  listByUser: (userId) => stmt(`
    SELECT id, token_prefix, label, last_used_at, created_at
    FROM api_tokens WHERE user_id = ? AND revoked = 0 ORDER BY id DESC
  `).all(userId),
  resolve: (raw) => {
    if (typeof raw !== 'string' || !raw.startsWith('nai_') || raw.length < 20) return null;
    const row = stmt(`
      SELECT t.id AS token_id, t.user_id, u.username, u.role, u.disabled
      FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked = 0
    `).get(hashApiToken(raw));
    if (!row || row.disabled || row.role !== 'admin') return null;
    stmt(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.token_id);
    return { user_id: row.user_id, username: row.username, role: row.role, disabled: 0, token_id: row.token_id };
  },
  revoke: (id, userId) => stmt(
    'UPDATE api_tokens SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0',
  ).run(id, userId),
  delByUser: (userId) => stmt('DELETE FROM api_tokens WHERE user_id = ?').run(userId),
};

/* ─── 初始管理员 ───────────────────────────────────────── */

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error && error.message));
}

function ensureAdmin() {
  // 仅在整个用户表彻底为空（第一次部署）时才创建初始管理员；
  // 只要库里已有用户（无论管理员改名叫什么），绝对不自动重建任何 admin 账号！
  if (qUsers.count() === 0) {
    const adminUser = String(process.env.ADMIN_USER || '').trim();
    const adminPass = String(process.env.ADMIN_PASS || '');
    if (!adminUser || adminPass.length < 12) {
      throw new Error('首次启动必须设置 ADMIN_USER 和至少 12 位的 ADMIN_PASS，拒绝创建弱口令管理员');
    }
    qUsers.create(adminUser, adminPass, 'admin');
    console.log(`[db] 首次部署，已创建初始管理员 ${adminUser}`);
  }
}

module.exports = { db, DB_PATH, hashPassword, verifyPassword, verifyLoginPassword, isUniqueViolation, qUsers, qTiers, qSessions, qKeys, qGens, qPrompts, qApiTokens, ensureAdmin };
