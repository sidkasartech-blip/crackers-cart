'use strict';
const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedDemo } = require('./seed');

/**
 * Database location, first match wins. URL and token always come from the same pair.
 *  1. SHOP_DATABASE_URL + SHOP_DATABASE_AUTH_TOKEN  -> your permanent database (recommended on Vercel)
 *  2. cc_TURSO_DATABASE_URL + cc_TURSO_AUTH_TOKEN   -> set by the Vercel Turso integration
 *  3. TURSO_DATABASE_URL / DATABASE_URL (+ tokens)  -> other hosts
 *  4. otherwise a local SQLite file in DATA_DIR (default ./data/shop.db)
 *
 * Why (1) comes first: the Vercel integration can create a new, empty "dpl-..." database for every
 * deployment. A variable you set yourself never changes between deployments.
 */
const SOURCES = [
  ['SHOP_DATABASE_URL', 'SHOP_DATABASE_AUTH_TOKEN'],
  ['cc_TURSO_DATABASE_URL', 'cc_TURSO_AUTH_TOKEN'],
  ['CC_TURSO_DATABASE_URL', 'CC_TURSO_AUTH_TOKEN'],
  ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'],
  ['DATABASE_URL', 'DATABASE_AUTH_TOKEN'],
];
const val = (n) => (process.env[n] && process.env[n].trim()) || undefined;

function dbConfig() {
  for (const [urlVar, tokenVar] of SOURCES) {
    if (val(urlVar)) return { url: val(urlVar), authToken: val(tokenVar), source: urlVar };
  }
  if (process.env.VERCEL) {
    throw new Error('No database configured. Set SHOP_DATABASE_URL and SHOP_DATABASE_AUTH_TOKEN in Vercel, then redeploy.');
  }
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return { url: `file:${path.join(dir, 'shop.db')}`, source: 'local file' };
}

async function boot() {
  const { url, authToken, source } = dbConfig();
  const db = await openDb(url, authToken);
  // Sample items are only for trying the app locally. On a hosted database they are never added
  // unless SEED_DEMO=1, so a misconfigured/empty database can't look like your catalog was replaced.
  const local = url.startsWith('file:');
  if (process.env.SEED_DEMO === '1' || (local && process.env.SEED_DEMO !== '0')) await seedDemo(db);
  return createApp(db, { dbUrl: url, dbSource: source });
}

module.exports = { boot, dbConfig };
