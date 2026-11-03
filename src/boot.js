'use strict';
const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedDemo } = require('./seed');

/**
 * Database location:
 *  - TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)  -> hosted Turso database (use this on Vercel)
 *  - DATABASE_URL (+ DATABASE_AUTH_TOKEN)     -> same, generic names
 *  - otherwise a local SQLite file in DATA_DIR (default ./data/shop.db)
 */
function dbConfig() {
  const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL;
  if (url) return { url, authToken: process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN };
  if (process.env.VERCEL) {
    throw new Error('No database configured. Add a Turso database to this Vercel project (Storage tab) so TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set.');
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
