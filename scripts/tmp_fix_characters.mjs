// One-off data fix per user instruction: remove loli-type characters, backfill mature picks.
// Single short transaction; deleted after successful run.
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('/opt/nai-site/data/nai.sqlite');
db.exec('PRAGMA busy_timeout=5000');

const mk = (tag, group) => JSON.stringify({ prompt: `${tag}, ${group}`, uc: '', x: null, y: null });

// user_id=1, kind='character'
// Genshin: delete nahida(217)/barbara(223) → insert 凝光/丽莎 into freed sorts 9004/9010
// ZZZ: delete corin(9208)/soukaku(9209) → insert 朱鸢/11号 into freed sorts 9208/9209
const DEL = [
  { id: 217, tag: 'nahida_(genshin_impact)' },
  { id: 223, tag: 'barbara_(genshin_impact)' },
];
const DEL_SORT = [
  { sort: 9208, tag: 'corin_wickes' },
  { sort: 9209, tag: 'soukaku' },
];
const INS = [
  { title: '原神 | 凝光',  tag: 'ningguang_(genshin_impact)',       group: 'genshin_impact',      sort: 9004 },
  { title: '原神 | 丽莎',  tag: 'lisa_(genshin_impact)',            group: 'genshin_impact',      sort: 9010 },
  { title: '绝区零 | 朱鸢', tag: 'zhu_yuan_(zenless_zone_zero)',     group: 'zenless_zone_zero',   sort: 9208 },
  { title: '绝区零 | 11号', tag: 'soldier_11_(zenless_zone_zero)',   group: 'zenless_zone_zero',   sort: 9209 },
];

db.exec('BEGIN IMMEDIATE');
const report = { deleted: [], inserted: [] };
try {
  // dedup snapshot BEFORE deletes
  const blob = db.prepare(`SELECT group_concat(content) b FROM prompt_library WHERE user_id=1 AND kind='character'`).get().b || '';
  for (const r of INS) if (blob.includes(r.tag)) throw new Error(`duplicate tag already present: ${r.tag}`);

  const delById = db.prepare(`DELETE FROM prompt_library WHERE id=? AND user_id=1`);
  for (const { id, tag } of DEL) {
    const row = db.prepare(`SELECT id, sort, title, content FROM prompt_library WHERE id=? AND user_id=1 AND kind='character'`).get(id);
    if (!row) throw new Error(`id ${id}: row missing`);
    if (!row.content.includes(tag)) throw new Error(`id ${id}: expected "${tag}" in ${row.content}`);
    delById.run(id);
    report.deleted.push({ id, sort: row.sort, title: row.title, tag });
  }
  for (const { sort, tag } of DEL_SORT) {
    const row = db.prepare(`SELECT id, sort, title, content FROM prompt_library WHERE sort=? AND user_id=1 AND kind='character'`).get(sort);
    if (!row) throw new Error(`sort ${sort}: row missing`);
    if (!row.content.includes(tag)) throw new Error(`sort ${sort}: expected "${tag}" in ${row.content}`);
    delById.run(row.id);
    report.deleted.push({ id: row.id, sort, title: row.title, tag });
  }

  const free = db.prepare(`SELECT COUNT(*) n FROM prompt_library WHERE user_id=1 AND kind='character' AND sort=?`);
  const ins = db.prepare(`INSERT INTO prompt_library (user_id, kind, title, content, sort) VALUES (1, 'character', ?, ?, ?)`);
  for (const r of INS) {
    if (free.get(r.sort).n !== 0) throw new Error(`sort ${r.sort} not free`);
    const content = mk(r.tag, r.group);
    const info = ins.run(r.title, content, r.sort);
    report.inserted.push({ id: Number(info.lastInsertRowid), sort: r.sort, title: r.title, prompt: `${r.tag}, ${r.group}` });
  }

  db.exec('COMMIT');
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  db.exec('ROLLBACK');
  console.error('rolled back, nothing changed:', e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
