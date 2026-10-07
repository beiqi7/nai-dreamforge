'use strict';
/** scripts/import-pool.js — 从 /root/opus-pool.txt 导入 PST 密钥池
 * 格式：email\tpst-key\ttier\tactive\texpires（# 开头为注释）
 */

const fs = require('node:fs');
const path = require('node:path');

const POOL_FILE = process.argv[2] || '/root/opus-pool.txt';
const { qKeys } = require(path.join(__dirname, '..', 'lib', 'db'));
const { NaiClient } = require(path.join(__dirname, '..', 'lib', 'nai'));

async function main() {
  const raw = fs.readFileSync(POOL_FILE, 'utf8');
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  console.log(`解析到 ${lines.length} 行密钥`);
  let ok = 0, dup = 0, fail = 0;

  for (const line of lines) {
    const [email, token, tierHint, activeHint, expiresHint] = line.split('\t');
    if (!token || !/^pst-[A-Za-z0-9_-]{20,}$/.test(token)) {
      console.log(`✗ ${email || '?'} 格式非法，跳过`);
      fail++;
      continue;
    }
    if (qKeys.byToken(token)) {
      console.log(`↷ ${email} 已在池中，跳过`);
      dup++;
      continue;
    }
    // 先验证再入库
    const client = new NaiClient(token);
    const v = await client.verifyToken();
    const id = qKeys.add(email || '未命名', token);
    if (v.ok) {
      const s = v.subscription;
      qKeys.setState(id, 'ok', s.tier, s.anlas);
      const until = s.expiresAt ? new Date(s.expiresAt * 1000).toISOString().slice(0, 10) : '?';
      console.log(`✓ ${email} → tier ${s.tierName} · Anlas ${s.anlas}（订阅 ${s.fixedAnlas} + 购买 ${s.purchasedAnlas}）· 有效至 ${until} · 免费生成:${s.freeGeneration ? '是' : '否'}`);
      ok++;
    } else {
      qKeys.setState(id, `invalid:${v.error}`.slice(0, 120), null, null);
      qKeys.setActive(id, false);
      console.log(`✗ ${email} 验证失败：${v.error}`);
      fail++;
    }
  }

  console.log(`\n── 导入完成：成功 ${ok} · 重复 ${dup} · 失败 ${fail} ──`);
}

main().catch((e) => { console.error('导入失败:', e.message); process.exit(1); });
