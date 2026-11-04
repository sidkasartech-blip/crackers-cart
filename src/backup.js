'use strict';
/**
 * Automatic snapshots of the shop's data, stored in the `backups` table.
 *
 * Taken: before any database upgrade, before deletes / bulk rate changes, and at least once a day
 * (when the admin panel is used). Photos are not copied into snapshots: they are never deleted,
 * and the "Download full backup" file includes them.
 */

const KEEP_ROUTINE = 60; // routine snapshots kept; "before upgrade" snapshots are kept forever

async function collect(q, { images = false } = {}) {
  const tables = await q.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  const has = new Set(tables.map((t) => t.name));
  const all = (sql, t) => (has.has(t) ? q.all(sql) : Promise.resolve([]));
  const [settings, categories, items, discounts, orders, orderItems, imgs] = await Promise.all([
    all("SELECT key, value FROM settings WHERE key NOT IN ('admin_password', 'telegram_bot_token')", 'settings'),
    all('SELECT * FROM categories', 'categories'),
    all('SELECT * FROM items', 'items'),
    all('SELECT * FROM discounts', 'discounts'),
    all('SELECT * FROM orders', 'orders'),
    all('SELECT * FROM order_items', 'order_items'),
    images ? all('SELECT id, mime, data, created_at FROM images', 'images') : Promise.resolve(null),
  ]);
  const out = { app: 'crackers-cart', version: 1, createdAt: new Date().toISOString(), settings, categories, items, discounts, orders, orderItems };
  if (imgs) out.images = imgs.map((i) => ({ ...i, data: Buffer.from(i.data).toString('base64') }));
  return out;
}

async function snapshot(db, reason) {
  const data = await collect(db);
  if (!data.items.length && !data.orders.length && !data.categories.length) return null; // nothing worth saving yet
  const counts = `${data.items.length} items, ${data.orders.length} bills`;
  const info = await db.run('INSERT INTO backups (reason, summary, data) VALUES (?, ?, ?)', [reason, counts, JSON.stringify(data)]);
  // Trim old routine snapshots only. Upgrade snapshots are never removed.
  await db.run(`DELETE FROM backups WHERE reason NOT LIKE 'Before upgrade%' AND id NOT IN (
    SELECT id FROM backups WHERE reason NOT LIKE 'Before upgrade%' ORDER BY id DESC LIMIT ${KEEP_ROUTINE})`);
  return info.lastInsertRowid;
}

async function ensureDaily(db) {
  const last = await db.get("SELECT created_at FROM backups WHERE created_at > datetime('now', '-1 day') LIMIT 1");
  if (!last) await snapshot(db, 'Daily');
}

module.exports = { collect, snapshot, ensureDaily };
