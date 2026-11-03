'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seedDemo } = require('../src/seed');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const db = await openDb(`file:${path.join(dir, 'shop.db')}`);
  await seedDemo(db);
  const app = createApp(db);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { call, close: () => { server.close(); db.client.close(); }, dir, base };
}

test('customer flow: catalog → quote → order → bill → admin marks paid', async (t) => {
  const { call, close } = await setup();
  t.after(close);

  const cat = await call('GET', '/api/catalog');
  assert.equal(cat.status, 200);
  const item = cat.data.items[0];
  assert.ok(item.price > 0);

  const q = await call('POST', '/api/quote', { items: [{ itemId: item.id, qty: 2 }] });
  assert.equal(q.data.subtotal, item.price * 2);

  // Admin APIs are locked.
  assert.equal((await call('GET', '/api/admin/items')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'admin123' })).status, 200);
  await call('PUT', '/api/admin/settings', { upi_id: 'shop@okaxis', upi_name: 'Test Shop' });

  const o = await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 2 }], customerName: 'Ravi' });
  assert.equal(o.status, 201);

  const bill = await call('GET', `/api/orders/${o.data.id}?t=${o.data.token}`);
  assert.equal(bill.status, 200);
  assert.equal(bill.data.total, q.data.total);
  assert.match(bill.data.upiUri, /^upi:\/\/pay\?pa=shop%40okaxis&pn=Test%20Shop&am=\d+\.\d{2}&cu=INR/);
  assert.match(bill.data.upiQr, /^data:image\/png;base64,/);

  const items = (await call('GET', '/api/admin/items')).data;
  assert.equal(items.find((i) => i.id === item.id).stock, item.stock - 2);

  assert.equal((await call('PATCH', `/api/admin/orders/${o.data.id}`, { status: 'paid' })).status, 200);
  assert.equal((await call('GET', `/api/orders/${o.data.id}/status?t=${o.data.token}`)).data.status, 'paid');

  // Cancelling returns stock.
  await call('PATCH', `/api/admin/orders/${o.data.id}`, { status: 'cancelled' });
  const after = (await call('GET', '/api/admin/items')).data;
  assert.equal(after.find((i) => i.id === item.id).stock, item.stock);
});

test('orders are rejected when stock is short and bills need the token', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  const item = (await call('GET', '/api/catalog')).data.items[0];
  const r = await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: item.stock + 1 }] });
  assert.equal(r.status, 400);
  assert.equal(r.data.errors[0].itemId, item.id);

  const ok = await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 1 }] });
  assert.equal((await call('GET', `/api/orders/${ok.data.id}?t=wrong`)).status, 404);
});

test('admin can manage items, discounts, bulk rates and uploads', async (t) => {
  const { call, close, base } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });

  const created = await call('POST', '/api/admin/items', { name: 'Test Bomb', price: '49.50', stock: 7, categoryId: '' });
  assert.equal(created.status, 201);
  assert.equal(created.data.price, 4950);

  const bad = await call('POST', '/api/admin/items', { name: '', price: 10 });
  assert.equal(bad.status, 400);

  const patched = await call('PATCH', `/api/admin/items/${created.data.id}`, { addStock: 5, price: '55' });
  assert.equal(patched.data.stock, 12);
  assert.equal(patched.data.price, 5500);

  const bulk = await call('POST', '/api/admin/items/bulk-price', { percent: 10, roundTo: 1 });
  assert.ok(bulk.data.updated > 1);
  const items = (await call('GET', '/api/admin/items')).data;
  assert.equal(items.find((i) => i.id === created.data.id).price, 6100); // 55 * 1.1 = 60.5 -> 61

  const disc = await call('POST', '/api/admin/discounts', { name: 'Flash', type: 'flat', value: '20', code: 'flash', minOrder: '0' });
  assert.equal(disc.status, 201);
  const q = await call('POST', '/api/quote', { items: [{ itemId: created.data.id, qty: 1 }], coupon: 'FLASH' });
  assert.equal(q.data.couponStatus, 'applied');

  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await call('POST', '/api/admin/upload', { dataUrl: png1x1 });
  assert.equal(up.status, 201);
  const img = await fetch(base + up.data.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from(png1x1.split(',')[1], 'base64'));
  assert.equal((await call('POST', '/api/admin/upload', { dataUrl: 'data:text/html;base64,PGgxPg==' })).status, 400);

  const qr = await call('GET', '/api/admin/store-qr');
  assert.match(qr.data.qr, /^data:image\/png/);
});

test('deleting a category keeps its items and removes its offers', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  const cats = (await call('GET', '/api/admin/categories')).data;
  const c = cats[0];
  await call('POST', '/api/admin/discounts', { name: 'Cat deal', type: 'percent', value: 10, categoryId: c.id });
  await call('DELETE', `/api/admin/categories/${c.id}`);
  const items = (await call('GET', '/api/admin/items')).data;
  assert.equal(items.length, 11);
  assert.ok(items.every((i) => i.categoryId !== c.id));
  const discs = (await call('GET', '/api/admin/discounts')).data;
  assert.ok(discs.every((d) => d.categoryId !== c.id));
});

test('offline store stock: quick changes, moves, totals, and safe edits', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  const item = (await call('POST', '/api/admin/items', { name: 'Twin Fountain', price: '100', stock: 10, storeStock: 4 })).data;
  assert.equal(item.storeStock, 4);
  assert.equal(item.totalStock, 14);

  let r = await call('PATCH', `/api/admin/items/${item.id}`, { addStoreStock: -3 }); // 3 sold at the store
  assert.equal(r.data.storeStock, 1);
  r = await call('PATCH', `/api/admin/items/${item.id}`, { moveToStore: 5 });
  assert.deepEqual([r.data.stock, r.data.storeStock, r.data.totalStock], [5, 6, 11]);
  r = await call('PATCH', `/api/admin/items/${item.id}`, { moveToStore: 99 });
  assert.equal(r.status, 400); // can't move more than exists
  r = await call('PATCH', `/api/admin/items/${item.id}`, { moveToStore: -2 });
  assert.deepEqual([r.data.stock, r.data.storeStock], [7, 4]);

  // Customers never see store stock.
  const pub = (await call('GET', '/api/catalog')).data.items.find((i) => i.id === item.id);
  assert.equal(pub.stock, 7);
  assert.equal(pub.storeStock, undefined);

  // Admin opens the form (online 7), a customer buys 2 meanwhile, admin adds 1 to store and saves.
  const order = await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 2 }] });
  assert.equal(order.status, 201);
  r = await call('PUT', `/api/admin/items/${item.id}`, {
    name: 'Twin Fountain', price: '100', stock: 7, storeStock: 5, stockWas: 7, storeStockWas: 4,
  });
  assert.deepEqual([r.data.stock, r.data.storeStock], [5, 5]); // the online sale is not lost

  const dash = (await call('GET', '/api/admin/dashboard')).data;
  assert.ok(dash.stockValue.store >= 5);
  assert.equal(dash.stockValue.units, dash.stockValue.online + dash.stockValue.store);

  const csv = await call('GET', '/api/admin/inventory.csv');
  assert.match(csv.data, /"Twin Fountain","","box","100.00","","5","5","10","1000.00","Yes"/);
});

test('backup download and database info', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  const info = (await call('GET', '/api/admin/db-info')).data;
  assert.equal(info.counts.items, 11);
  const backup = (await call('GET', '/api/admin/backup.json')).data;
  assert.equal(backup.items.length, 11);
  assert.ok(backup.settings.length > 5);
  assert.ok(!backup.settings.some((s) => s.key === 'admin_password'));
});

test('upgrading an existing database keeps every row and adds store stock', async () => {
  const { createClient } = require('@libsql/client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-'));
  const url = `file:${path.join(dir, 'old.db')}`;
  // A database as created by the previous version (no store_stock column).
  const old = createClient({ url });
  await old.batch([
    'CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0)',
    `CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      category_id INTEGER, unit TEXT NOT NULL DEFAULT 'box', price INTEGER NOT NULL, mrp INTEGER, stock INTEGER NOT NULL DEFAULT 0,
      low_stock INTEGER NOT NULL DEFAULT 5, image TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)',
    "INSERT INTO settings VALUES ('shop_name', 'My Real Shop'), ('upi_id', 'real@upi')",
    "INSERT INTO items (name, price, stock) VALUES ('Real Item A', 5000, 17), ('Real Item B', 9900, 3)",
  ], 'write');
  old.close();

  const db = await openDb(url);
  const items = await db.all('SELECT name, stock, store_stock FROM items ORDER BY id');
  assert.deepEqual(items, [
    { name: 'Real Item A', stock: 17, store_stock: 0 },
    { name: 'Real Item B', stock: 3, store_stock: 0 },
  ]);
  const s = await db.get("SELECT value FROM settings WHERE key = 'shop_name'");
  assert.equal(s.value, 'My Real Shop'); // existing settings are never overwritten
  // Running start-up again is harmless.
  db.client.close();
  const again = await openDb(url);
  assert.equal((await again.all('SELECT * FROM items')).length, 2);
  again.client.close();
});

test('sample items are never added to a hosted database unless asked', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'boot.js'), 'utf8');
  assert.match(src, /SEED_DEMO === '1' \|\| \(local && process\.env\.SEED_DEMO !== '0'\)/);
});
