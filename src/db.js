'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
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
);
CREATE TABLE IF NOT EXISTS discounts (
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
);
CREATE TABLE IF NOT EXISTS orders (
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
);
CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id  INTEGER,
  name     TEXT NOT NULL,
  unit     TEXT NOT NULL DEFAULT '',
  price    INTEGER NOT NULL,
  qty      INTEGER NOT NULL,
  total    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

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

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
  insertSetting.run('admin_password', hashPassword(process.env.ADMIN_PASSWORD || 'admin123'));
  insertSetting.run('password_is_default', process.env.ADMIN_PASSWORD ? '0' : '1');

  return db;
}

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

/** Wraps fn in BEGIN/COMMIT; rolls back on throw. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, getSettings, tx, DEFAULT_SETTINGS };
