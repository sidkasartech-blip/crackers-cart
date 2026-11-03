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

  // Customers see one "available" number (online + store by default), never the split, and never the MRP/cost field.
  let pub = (await call('GET', '/api/catalog')).data.items.find((i) => i.id === item.id);
  assert.equal(pub.stock, 11);
  assert.equal(pub.storeStock, undefined);
  assert.equal(pub.mrp, undefined);
  await call('PUT', '/api/admin/settings', { online_sells_store_stock: false });
  pub = (await call('GET', '/api/catalog')).data.items.find((i) => i.id === item.id);
  assert.equal(pub.stock, 7); // the rest of this test checks online-only behaviour

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

test('automatic snapshots: before upgrade, before deletes, daily, and downloadable', async (t) => {
  // Upgrade snapshot: start from an old database with real rows.
  const { createClient } = require('@libsql/client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-snap-'));
  const url = `file:${path.join(dir, 'old.db')}`;
  const old = createClient({ url });
  await old.batch([
    `CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      category_id INTEGER, unit TEXT NOT NULL DEFAULT 'box', price INTEGER NOT NULL, mrp INTEGER, stock INTEGER NOT NULL DEFAULT 0,
      low_stock INTEGER NOT NULL DEFAULT 5, image TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    "INSERT INTO items (name, price, stock) VALUES ('Precious', 1000, 9)",
  ], 'write');
  old.close();
  const db = await openDb(url);
  const snaps = await db.all('SELECT reason, data FROM backups');
  assert.equal(snaps.length, 1);
  assert.match(snaps[0].reason, /^Before upgrade/);
  assert.equal(JSON.parse(snaps[0].data).items[0].name, 'Precious');
  db.client.close();

  // Via the API: delete makes a snapshot first, daily is taken on dashboard, download works.
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  await call('GET', '/api/admin/dashboard');
  let list = (await call('GET', '/api/admin/backups')).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'Daily');
  await call('GET', '/api/admin/dashboard'); // not twice in one day
  const items = (await call('GET', '/api/admin/items')).data;
  await call('DELETE', `/api/admin/items/${items[0].id}`);
  list = (await call('GET', '/api/admin/backups')).data;
  assert.equal(list.length, 2);
  assert.match(list[0].reason, /^Before deleting item/);
  const snap = (await call('GET', `/api/admin/backups/${list[0].id}.json`)).data;
  assert.ok(snap.items.some((i) => i.id === items[0].id)); // the deleted item is in the snapshot
});

test('a fixed SHOP_DATABASE_URL always wins over the per-deployment integration variables', () => {
  const { dbConfig } = require('../src/boot');
  const keep = { ...process.env };
  try {
    Object.assign(process.env, {
      cc_TURSO_DATABASE_URL: 'libsql://dpl-new-empty.turso.io', cc_TURSO_AUTH_TOKEN: 'integration-token',
      SHOP_DATABASE_URL: 'libsql://crackers-shop.turso.io', SHOP_DATABASE_AUTH_TOKEN: 'shop-token',
    });
    assert.deepEqual(dbConfig(), { url: 'libsql://crackers-shop.turso.io', authToken: 'shop-token', source: 'SHOP_DATABASE_URL' });
    delete process.env.SHOP_DATABASE_URL;
    assert.equal(dbConfig().source, 'cc_TURSO_DATABASE_URL');
    assert.equal(dbConfig().authToken, 'integration-token'); // never mixes a URL with another pair's token
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test('home delivery: settings, validation, charge, bill and export', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  await call('PUT', '/api/admin/settings', { delivery_enabled: true, delivery_charge: '50', delivery_free_above: '2000', delivery_note: 'Within 5 km', upi_id: 'shop@okaxis' });
  const cat = (await call('GET', '/api/catalog')).data;
  assert.equal(cat.settings.delivery_enabled, '1');
  assert.equal(cat.settings.delivery_note, 'Within 5 km');
  const item = cat.items.find((i) => i.stock >= 3);
  const items = [{ itemId: item.id, qty: 1 }];

  const pickupQ = (await call('POST', '/api/quote', { items })).data;
  const delQ = (await call('POST', '/api/quote', { items, fulfilment: 'delivery' })).data;
  assert.equal(pickupQ.deliveryCharge, 0);
  assert.equal(delQ.deliveryCharge, 5000);
  assert.equal(delQ.total, pickupQ.total + 5000);

  // Missing details are refused and nothing is sold.
  const stockBefore = (await call('GET', '/api/admin/items')).data.find((i) => i.id === item.id).stock;
  for (const bad of [
    { customerName: '', customerPhone: '9876543210', deliveryAddress: '12 Market Road, Pune' },
    { customerName: 'Asha', customerPhone: '12345', deliveryAddress: '12 Market Road, Pune' },
    { customerName: 'Asha', customerPhone: '9876543210', deliveryAddress: 'short' },
    { customerName: 'Asha', customerPhone: '9876543210', deliveryAddress: '12 Market Road, Pune', deliveryPincode: '41' },
  ]) {
    assert.equal((await call('POST', '/api/orders', { items, fulfilment: 'delivery', ...bad })).status, 400);
  }
  assert.equal((await call('GET', '/api/admin/items')).data.find((i) => i.id === item.id).stock, stockBefore);

  const o = await call('POST', '/api/orders', { items, fulfilment: 'delivery', customerName: 'Asha', customerPhone: '098765 43210',
    deliveryAddress: 'Flat 4, Rose Apts, MG Road, Pune', deliveryLandmark: 'Near temple', deliveryPincode: '411001' });
  assert.equal(o.status, 201);
  const bill = (await call('GET', `/api/orders/${o.data.id}?t=${o.data.token}`)).data;
  assert.equal(bill.fulfilment, 'delivery');
  assert.equal(bill.deliveryAddress, 'Flat 4, Rose Apts, MG Road, Pune');
  assert.equal(bill.deliveryPincode, '411001');
  assert.equal(bill.deliveryCharge, 5000);
  assert.equal(bill.total, delQ.total);
  assert.match(bill.upiUri, new RegExp(`am=${(bill.total / 100).toFixed(2)}`));

  // Pickup orders still need no details.
  const p = await call('POST', '/api/orders', { items });
  assert.equal(p.status, 201);
  assert.equal((await call('GET', `/api/orders/${p.data.id}?t=${p.data.token}`)).data.fulfilment, 'pickup');

  const csv = (await call('GET', '/api/admin/orders.csv')).data;
  assert.match(csv, /"Delivery","Flat 4, Rose Apts, MG Road, Pune","Near temple","411001"/);

  // Switching delivery off refuses delivery orders.
  await call('PUT', '/api/admin/settings', { delivery_enabled: false });
  const off = await call('POST', '/api/orders', { items, fulfilment: 'delivery', customerName: 'Asha', customerPhone: '9876543210', deliveryAddress: 'Flat 4, Rose Apts, MG Road, Pune' });
  assert.equal(off.status, 400);
});

test('online orders use online stock first, then store stock; cancelling puts each back', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  const item = (await call('POST', '/api/admin/items', { name: 'Shared Rocket', price: '100', stock: 2, storeStock: 5 })).data;
  const get = async () => (await call('GET', '/api/admin/items')).data.find((i) => i.id === item.id);

  // Customers can buy 7 (2 online + 5 store), not 8.
  assert.equal((await call('POST', '/api/quote', { items: [{ itemId: item.id, qty: 8 }] })).data.errors.length, 1);
  const o = await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 3 }] });
  assert.equal(o.status, 201);
  let it = await get();
  assert.deepEqual([it.stock, it.storeStock], [0, 4]); // 2 from online, 1 from store

  await call('PATCH', `/api/admin/orders/${o.data.id}`, { status: 'cancelled' });
  it = await get();
  assert.deepEqual([it.stock, it.storeStock], [2, 5]); // back exactly where they came from
  await call('PATCH', `/api/admin/orders/${o.data.id}`, { status: 'pending' });
  it = await get();
  assert.deepEqual([it.stock, it.storeStock], [0, 4]);

  // With the setting off, only online stock is sold.
  await call('PUT', '/api/admin/settings', { online_sells_store_stock: false });
  await call('PATCH', `/api/admin/items/${item.id}`, { addStock: 1 });
  assert.equal((await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 2 }] })).status, 400);
  assert.equal((await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 1 }] })).status, 201);
  it = await get();
  assert.deepEqual([it.stock, it.storeStock], [0, 4]);
});

test('cash or UPI: customer choice, how it was paid, dashboard split', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  await call('PUT', '/api/admin/settings', { upi_id: 'shop@okaxis' });
  const item = (await call('GET', '/api/catalog')).data.items.find((i) => i.stock >= 5);
  const items = [{ itemId: item.id, qty: 1 }];

  const cash = (await call('POST', '/api/orders', { items, payment: 'cash' })).data;
  const upi = (await call('POST', '/api/orders', { items })).data;
  const bill = async (o) => (await call('GET', `/api/orders/${o.id}?t=${o.token}`)).data;
  assert.equal((await bill(cash)).payPref, 'cash');
  assert.equal((await bill(upi)).payPref, 'upi');
  assert.ok((await bill(cash)).upiQr); // UPI still offered as a fallback

  await call('PATCH', `/api/admin/orders/${cash.id}`, { status: 'paid', paidBy: 'cash' });
  await call('PATCH', `/api/admin/orders/${upi.id}`, { status: 'paid' }); // defaults to what the customer chose
  assert.equal((await bill(cash)).paidBy, 'cash');
  assert.equal((await bill(upi)).paidBy, 'upi');
  // Correcting the method on an already-paid bill.
  await call('PATCH', `/api/admin/orders/${upi.id}`, { status: 'paid', paidBy: 'cash' });
  assert.equal((await bill(upi)).paidBy, 'cash');
  await call('PATCH', `/api/admin/orders/${upi.id}`, { status: 'paid', paidBy: 'upi' });

  const d = (await call('GET', '/api/admin/dashboard')).data.today;
  assert.equal(d.paidCash, (await bill(cash)).total);
  assert.equal(d.paidUpi, (await bill(upi)).total);
  assert.match((await call('GET', '/api/admin/orders.csv')).data, /"paid","Cash"/);

  // Cash switched off: the choice is ignored.
  await call('PUT', '/api/admin/settings', { cash_enabled: false });
  const o = (await call('POST', '/api/orders', { items, payment: 'cash' })).data;
  assert.equal((await bill(o)).payPref, 'upi');
});
