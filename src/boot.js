'use strict';
const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedDemo } = require('./seed');

/**
 * Database location:
 *  - cc_TURSO_DATABASE_URL (+ cc_TURSO_AUTH_TOKEN) -> hosted Turso database (Vercel)
 *  - TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)        -> same, unprefixed names
 *  - DATABASE_URL (+ DATABASE_AUTH_TOKEN)     -> same, generic names
 *  - otherwise a local SQLite file in DATA_DIR (default ./data/shop.db)
 */
const env = (...names) => names.map((n) => process.env[n]).find((v) => v && v.trim())?.trim();

function dbConfig() {
  // The Vercel Turso integration may add a custom prefix (this project uses "cc_").
  const url = env('cc_TURSO_DATABASE_URL', 'CC_TURSO_DATABASE_URL', 'TURSO_DATABASE_URL', 'DATABASE_URL');
  if (url) return { url, authToken: env('cc_TURSO_AUTH_TOKEN', 'CC_TURSO_AUTH_TOKEN', 'TURSO_AUTH_TOKEN', 'DATABASE_AUTH_TOKEN') };
  if (process.env.VERCEL) {
    throw new Error('No database configured. Connect the Turso database to this Vercel project so cc_TURSO_DATABASE_URL and cc_TURSO_AUTH_TOKEN are set, then redeploy.');
  }
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return { url: `file:${path.join(dir, 'shop.db')}` };
}

async function boot() {
  const { url, authToken } = dbConfig();
  const db = await openDb(url, authToken);
  if (process.env.SEED_DEMO !== '0') await seedDemo(db);
  return createApp(db);
}

module.exports = { boot };
