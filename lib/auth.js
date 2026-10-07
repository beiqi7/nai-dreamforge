'use strict';
/**
 * lib/auth.js — 会话鉴权（Cookie + SQLite 会话表）
 */

const { qSessions, qApiTokens } = require('./db');

const COOKIE_NAME = 'nai_session';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';

function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); }
  catch (error) { if (error instanceof URIError) return null; throw error; }
}

/** 从请求头解析会话用户；失败返回 null */
function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  return qSessions.get(token) || null;
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)/i.exec(header);
  return m ? m[1] : null;
}

/** Cookie 会话或管理员 API Token */
function getRequestUser(req) {
  const bearer = getBearerToken(req);
  if (bearer) return qApiTokens.resolve(bearer);
  return getSessionUser(req);
}

/** 登录成功后种下会话 Cookie（HttpOnly, Secure, SameSite=Lax） */
function cookieSecurityAttribute() {
  return COOKIE_SECURE ? '; Secure' : '';
}
function sessionCookie(token, maxAgeSec = 7 * 24 * 3600) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${cookieSecurityAttribute()}; Max-Age=${maxAgeSec}`;
}
/** 登出清除 Cookie */
function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${cookieSecurityAttribute()}; Max-Age=0`;
}

/** 封装：解析 JSON body（上限 6MB，img2img base64 会较大） */
async function readJson(req, limit = 6 * 1024 * 1024) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw Object.assign(new Error('请求体过大'), { status: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求体不是有效 JSON'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 });
  }
  return value;
}

module.exports = { getSessionUser, getSessionToken, getBearerToken, getRequestUser, sessionCookie, clearSessionCookie, readJson, COOKIE_NAME };
