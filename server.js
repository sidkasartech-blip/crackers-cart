'use strict';
const path = require('node:path');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { seedDemo } = require('./src/seed');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT) || 3000;

const db = openDb(path.join(DATA_DIR, 'shop.db'));
if (process.env.SEED_DEMO !== '0') seedDemo(db);

const app = createApp(db, { uploadDir: path.join(DATA_DIR, 'uploads') });
app.listen(PORT, () => {
  console.log(`Crackers Cart running on http://localhost:${PORT}`);
  console.log(`Admin panel:            http://localhost:${PORT}/admin`);
});
