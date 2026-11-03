'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { hashPassword } = require('./auth');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    unit        TEXT NOT NULL DEFAULT 'box',
    price       INTEGER NOT NULL,            -- selling rate, in paise
    mrp         INTEGER,                     -- optional strike-through price, in paise
    stock       INTEGER NOT NULL DEFAULT 0,
    low_stock   INTEGER NOT NULL DEFAULT 5,  -- warn admin at or below this
    image       TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS discounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL CHECK (type IN ('percent','flat')),
    value        INTEGER NOT NULL,           -- percent (0-100) or flat amount in paise
    category_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE, -- NULL = whole cart
    min_order    INTEGER NOT NULL DEFAULT 0, -- paise
    max_discount INTEGER,                    -- cap in paise, NULL = no cap
    code         TEXT,                       -- NULL = applied automatically
    starts_at    TEXT,                       -- ISO datetime, NULL = always
    ends_at      TEXT,
    active       INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token          TEXT NOT NULL,
    bill_no        TEXT NOT NULL,
    customer_name  TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    subtotal       INTEGER NOT NULL,
    discount       INTEGER NOT NULL DEFAULT 0,
    discount_label TEXT NOT NULL DEFAULT '',
    tax            INTEGER NOT NULL DEFAULT 0,
    tax_percent    REAL NOT NULL DEFAULT 0,
    round_off      INTEGER NOT NULL DEFAULT 0,
    total          INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at        TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id  INTEGER,
    name     TEXT NOT NULL,
    unit     TEXT NOT NULL DEFAULT '',
    price    INTEGER NOT NULL,
    qty      INTEGER NOT NULL,
    total    INTEGER NOT NULL
  )`,
  // Product photos live in the database so the app works on hosts without a persistent disk (e.g. Vercel).
  `CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)',
];

const DEFAULT_SETTINGS = {
  shop_name: 'Sparkle Crackers',
  tagline: 'Celebrate safely!',
  phone: '',
  address: '',
  gstin: '',
  upi_id: '',
  upi_name: '',
  tax_percent: '0',
  bill_prefix: 'SC-',
  bill_footer: 'Thank you! Please keep crackers away from children and burn them in open spaces.',
  site_url: '',
  min_order: '0',
  shop_open: '1',
  closed_message: 'We are not taking orders right now. Please check back soon.',
};

/** libsql rows -> plain objects */
const toObjects = (rs) => rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));

/** Small promise-based API shared by the client and by transactions. */
function wrap(exec) {
  const run = async (sql, args = []) => {
    const rs = await exec({ sql, args });
    return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid), rs };
  };
  return {
    run,
    all: async (sql, args = []) => toObjects((await run(sql, args)).rs),
    get: async (sql, args = []) => toObjects((await run(sql, args)).rs)[0],
  };
}

/**
 * Opens the database.
 *  - Locally: a SQLite file (default ./data/shop.db).
 *  - On Vercel/anywhere else: a Turso database via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
 */
async function openDb(url, authToken) {
  if (url.startsWith('file:') && !url.includes(':memory:')) {
    fs.mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true });
  }
  const client = createClient({ url, authToken });
  const db = {
    client,
    ...wrap((stmt) => client.execute(stmt)),
    /** Runs fn(tx) inside a write transaction; rolls back if it throws. */
    async tx(fn) {
      const t = await client.transaction('write');
      try {
        const result = await fn(wrap((stmt) => t.execute(stmt)));
        await t.commit();
        return result;
      } catch (err) {
        await t.rollback().catch(() => {});
        throw err;
      } finally {
        t.close();
      }
    },
  };

  if (url.startsWith('file:')) await client.execute('PRAGMA journal_mode = WAL').catch(() => {});
  await client.execute('PRAGMA foreign_keys = ON').catch(() => {});

  const seedSettings = Object.entries(DEFAULT_SETTINGS).map(([k, v]) => ({ sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', args: [k, v] }));
  seedSettings.push({ sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', args: ['admin_password', hashPassword(process.env.ADMIN_PASSWORD || 'admin123')] });
  seedSettings.push({ sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', args: ['password_is_default', process.env.ADMIN_PASSWORD ? '0' : '1'] });
  // One round trip for the whole schema + defaults (matters on serverless cold starts).
  await client.batch([...SCHEMA, ...seedSettings], 'write');
  await migrate(client);
  return db;
}

/**
 * Additive-only upgrades for databases created by older versions.
 * Rule: migrations may ADD tables/columns; they never drop, rename or rewrite existing data.
 */
const MIGRATIONS = [
  { table: 'items', column: 'store_stock', sql: 'ALTER TABLE items ADD COLUMN store_stock INTEGER NOT NULL DEFAULT 0' },
];
async function migrate(client) {
  for (const m of MIGRATIONS) {
    const info = await client.execute(`PRAGMA table_info(${m.table})`);
    const nameIdx = info.columns.indexOf('name');
    if (info.rows.some((r) => r[nameIdx] === m.column)) continue;
    try {
      await client.execute(m.sql);
    } catch (err) {
      // Another server instance may have added it at the same moment.
      if (!/duplicate column/i.test(String(err.message))) throw err;
    }
  }
}

async function getSettings(db) {
  const out = {};
  for (const row of await db.all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

module.exports = { openDb, getSettings, DEFAULT_SETTINGS };
