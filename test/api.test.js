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

test('counter and in-store bills take store stock first and are tracked separately', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  const item = (await call('POST', '/api/admin/items', { name: 'Counter Pot', price: '100', stock: 3, storeStock: 2 })).data;
  const get = async () => (await call('GET', '/api/admin/items')).data.find((i) => i.id === item.id);

  // Staff counter sale, paid in cash: store first (2), then online (1).
  const c = await call('POST', '/api/admin/counter/bills', { items: [{ itemId: item.id, qty: 3 }], paidBy: 'cash', customerName: 'Walk-in' });
  assert.equal(c.status, 201);
  let it = await get();
  assert.deepEqual([it.stock, it.storeStock], [2, 0]); // all 2 from the store, then 1 from online
  const bill = (await call('GET', `/api/orders/${c.data.id}?t=${c.data.token}`)).data;
  assert.equal(bill.status, 'paid');
  assert.equal(bill.paidBy, 'cash');
  assert.equal(bill.channel, 'counter');

  // Counter bill left unpaid (customer scans the QR).
  await call('PATCH', `/api/admin/items/${item.id}`, { addStoreStock: 4 });
  const q = await call('POST', '/api/admin/counter/bills', { items: [{ itemId: item.id, qty: 1 }] });
  assert.equal((await call('GET', `/api/orders/${q.data.id}?t=${q.data.token}`)).data.status, 'pending');
  it = await get();
  assert.deepEqual([it.stock, it.storeStock], [2, 3]);

  // Customer self-billing with the in-store QR: store first as well.
  const s = await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 2 }], channel: 'store' });
  assert.equal(s.status, 201);
  it = await get();
  assert.deepEqual([it.stock, it.storeStock], [2, 1]);
  // Online customer: online first.
  await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 1 }] });
  it = await get();
  assert.deepEqual([it.stock, it.storeStock], [1, 1]);

  // Customers can't pretend to be the counter.
  const fake = await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 1 }], channel: 'counter' });
  assert.equal((await call('GET', `/api/orders/${fake.data.id}?t=${fake.data.token}`)).data.channel, 'online');

  // Counter routes need the admin login.
  await call('POST', '/api/admin/logout');
  assert.equal((await call('POST', '/api/admin/counter/bills', { items: [{ itemId: item.id, qty: 1 }], paidBy: 'cash' })).status, 401);
  await call('POST', '/api/admin/login', { password: 'admin123' });

  // Cancelling a counter bill returns the stock where it came from.
  await call('PATCH', `/api/admin/orders/${c.data.id}`, { status: 'cancelled' });
  it = await get();
  assert.deepEqual([it.stock, it.storeStock], [1, 3]);

  const shopOnly = (await call('GET', '/api/admin/orders?channel=shop')).data;
  assert.ok(shopOnly.length >= 3 && shopOnly.every((o) => o.channel !== 'online'));
  const d = (await call('GET', '/api/admin/dashboard')).data.today;
  assert.equal(d.online + d.shop, d.sales);
  assert.match((await call('GET', '/api/admin/orders.csv')).data, /"Counter"/);
});

test('counter: agreed rate per item and agreed final amount; customers cannot change prices', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  await call('PUT', '/api/admin/settings', { upi_id: 'shop@okaxis' });
  const a = (await call('POST', '/api/admin/items', { name: 'Sparkle 77', price: '77', stock: 10, storeStock: 10 })).data;
  const b = (await call('POST', '/api/admin/items', { name: 'Pot 120', price: '120', stock: 10, storeStock: 10 })).data;

  // ₹77 sold at ₹70 (x2), ₹120 at list rate: 140 + 120 = 260
  const items = [{ itemId: a.id, qty: 2, price: 7000 }, { itemId: b.id, qty: 1 }];
  let q = (await call('POST', '/api/admin/counter/quote', { items })).data;
  assert.equal(q.subtotal, 26000);
  assert.equal(q.listSubtotal, 27400);
  assert.equal(q.total, 26000);

  // Rounded to ₹250 for the whole bill.
  q = (await call('POST', '/api/admin/counter/quote', { items, finalTotal: 25000 })).data;
  assert.equal(q.total, 25000);
  assert.equal(q.adjustment, -1000);

  // Charging more than list (₹80) is allowed too.
  q = (await call('POST', '/api/admin/counter/quote', { items: [{ itemId: a.id, qty: 1, price: 8000 }] })).data;
  assert.equal(q.total, 8000);

  const c = (await call('POST', '/api/admin/counter/bills', { items, finalTotal: 25000, paidBy: 'upi' })).data;
  const bill = (await call('GET', `/api/orders/${c.id}?t=${c.token}`)).data;
  assert.equal(bill.total, 25000);
  assert.equal(bill.adjustment, -1000);
  const line = bill.lines.find((l) => l.itemId === a.id);
  assert.deepEqual([line.price, line.listPrice, line.total], [7000, 7700, 14000]);
  assert.equal(bill.lines.find((l) => l.itemId === b.id).listPrice, 12000);
  assert.match(bill.upiUri, /am=250\.00/);
  // The item's own rate is unchanged.
  assert.equal((await call('GET', '/api/admin/items')).data.find((i) => i.id === a.id).price, 7700);
  const csv = (await call('GET', '/api/admin/orders.csv')).data;
  assert.match(csv, /"Sparkle 77","2","70.00","77.00","140.00"/);
  assert.match(csv, /"-10.00","250.00"/);

  // Customers (online or in-store) can't set prices or totals: ignored.
  const o = (await call('POST', '/api/orders', { items: [{ itemId: a.id, qty: 1, price: 100 }], finalTotal: 1, channel: 'store' })).data;
  const ob = (await call('GET', `/api/orders/${o.id}?t=${o.token}`)).data;
  assert.equal(ob.total, 7700);
  assert.equal(ob.adjustment, 0);
  assert.equal((await call('POST', '/api/quote', { items: [{ itemId: a.id, qty: 1, price: 100 }], finalTotal: 1 })).data.total, 7700);

  // Bad values are refused.
  assert.equal((await call('POST', '/api/admin/counter/quote', { items: [{ itemId: a.id, qty: 1, price: -5 }] })).status, 400);
});

test('delivery charged by distance from the shop, free from an amount, minimum order', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  await call('POST', '/api/admin/login', { password: 'admin123' });
  const item = (await call('POST', '/api/admin/items', { name: 'Distance Box', price: '100', stock: 50 })).data;
  const items = (qty) => [{ itemId: item.id, qty }];
  const q = async (qty, at) => (await call('POST', '/api/quote', { items: items(qty), fulfilment: 'delivery', deliveryLat: at && at.lat, deliveryLng: at && at.lng })).data;
  const order = (qty, at) => call('POST', '/api/orders', { items: items(qty), fulfilment: 'delivery', customerName: 'Ravi',
    customerPhone: '9876543210', deliveryAddress: '12 Market Road, Pune', deliveryLat: at && at.lat, deliveryLng: at && at.lng });
  const shop = { lat: 18.5204, lng: 73.8567 };
  const north = (deg) => ({ lat: shop.lat + deg, lng: shop.lng }); // 0.009° ≈ 1 km straight line

  // No shop location yet: flat charge for everyone, free from ₹1,200.
  await call('PUT', '/api/admin/settings', { delivery_enabled: true, delivery_charge: '50', delivery_free_above: '1200' });
  assert.equal((await q(2)).deliveryCharge, 5000);
  assert.equal((await q(12)).deliveryCharge, 0);

  // Bad settings are refused.
  assert.equal((await call('PUT', '/api/admin/settings', { shop_lat: '200' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { delivery_slabs: JSON.stringify([{ km: 3, charge: 0 }, { km: 3, charge: 10 }]) })).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { delivery_slabs: JSON.stringify([{ km: -1, charge: 0 }]) })).status, 400);

  // Shop location + bands: up to 3 km free, 6 km ₹40, 10 km ₹80; beyond = no delivery. Minimum ₹300 for delivery.
  const saved = await call('PUT', '/api/admin/settings', {
    shop_lat: String(shop.lat), shop_lng: String(shop.lng), delivery_min_order: '300',
    delivery_slabs: JSON.stringify([{ km: 10, charge: 80 }, { km: 3, charge: 0 }, { km: 6, charge: 40 }]), // saved sorted
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse((await call('GET', '/api/catalog')).data.settings.delivery_slabs).map((x) => x.km), [3, 6, 10]);

  assert.ok((await q(3)).deliveryNeedsLocation);
  const near = await q(3, north(0.0139)); // ~1.5 km straight → ~2 km road
  assert.equal(near.deliveryCharge, 0);
  assert.ok(near.deliveryKm >= 1.8 && near.deliveryKm <= 2.2, near.deliveryKm);
  assert.equal((await q(3, north(0.0308))).deliveryCharge, 4000); // ~4.5 km
  assert.equal((await q(3, north(0.0555))).deliveryCharge, 8000); // ~8 km
  assert.equal((await q(12, north(0.0555))).deliveryCharge, 0);   // free from ₹1,200 still applies
  assert.match((await q(3, north(0.1))).deliveryProblem, /within 10 km.*about 14\.\d km/);
  assert.match((await q(2, north(0.0139))).deliveryProblem, /₹300 or more/);

  // Orders follow the same rules and keep the pin.
  assert.equal((await order(3)).status, 400);                 // no pin
  assert.equal((await order(3, north(0.1))).status, 400);     // too far
  assert.equal((await order(2, north(0.0139))).status, 400);  // below minimum
  const ok = await order(3, north(0.0308));
  assert.equal(ok.status, 201);
  const bill = (await call('GET', `/api/orders/${ok.data.id}?t=${ok.data.token}`)).data;
  assert.equal(bill.deliveryCharge, 4000);
  assert.equal(bill.total, 34000);
  assert.ok(Math.abs(bill.deliveryLat - north(0.0308).lat) < 1e-6);
  assert.ok(bill.deliveryKm > 4 && bill.deliveryKm < 5);
  assert.match((await call('GET', '/api/admin/orders.csv')).data, /"18\.5512,73\.8567"/);
  // Pickup is unaffected.
  assert.equal((await call('POST', '/api/orders', { items: items(1) })).status, 201);
});

test('order alerts: Telegram message per customer order, token kept secret, failures never block orders', async (t) => {
  const http = require('node:http');
  const sent = [];
  let failNext = false;
  const tg = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const [, token, method] = req.url.match(/^\/bot([^/]+)\/(\w+)/) || [];
      res.setHeader('Content-Type', 'application/json');
      if (token !== '111:SECRET') { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); }
      if (method === 'getUpdates') return res.end(JSON.stringify({ ok: true, result: [{ message: { chat: { id: 987654, first_name: 'Ravi' } } }] }));
      if (failNext) { failNext = false; res.statusCode = 500; return res.end(JSON.stringify({ ok: false, description: 'boom' })); }
      sent.push(JSON.parse(body));
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((r) => tg.listen(0, r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${tg.address().port}`;
  const { call, close } = await setup();
  t.after(() => { close(); tg.close(); delete process.env.TELEGRAM_API_BASE; });
  await call('POST', '/api/admin/login', { password: 'admin123' });
  const item = (await call('GET', '/api/catalog')).data.items.find((i) => i.stock >= 5);

  // Wrong token is reported clearly; right token finds the chat.
  assert.match((await call('POST', '/api/admin/telegram/find-chat', { token: 'bad' })).data.error, /token is wrong/);
  const found = await call('POST', '/api/admin/telegram/find-chat', { token: '111:SECRET' });
  assert.equal(found.data.chats[0].id, '987654');

  await call('PUT', '/api/admin/settings', { telegram_bot_token: '111:SECRET', telegram_chat_id: '987654', phone: '98765 43210' });
  // The token never comes back in full, and saving the masked value keeps it.
  const got = (await call('GET', '/api/admin/settings')).data;
  assert.ok(got.telegram_bot_token.startsWith('••••••') && !got.telegram_bot_token.includes('111:'));
  await call('PUT', '/api/admin/settings', { telegram_bot_token: got.telegram_bot_token, shop_name: 'Cypress Fireworks' });
  assert.equal((await call('POST', '/api/admin/telegram/test')).status, 200);
  assert.match(sent.pop().text, /order alerts are working/);
  // Customers and backups never see it.
  assert.equal((await call('GET', '/api/catalog')).data.settings.telegram_bot_token, undefined);
  assert.ok(!(await call('GET', '/api/admin/backup.json')).data.settings.some((s) => s.key === 'telegram_bot_token'));

  // A customer order sends one alert with the details.
  const lastBefore = (await call('GET', '/api/admin/orders/new?after=0')).data.lastId;
  const o = await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 2 }], customerName: 'Asha', customerPhone: '9876543210', payment: 'cash' });
  assert.equal(o.status, 201);
  const msg = sent.pop();
  assert.equal(msg.chat_id, '987654');
  assert.match(msg.text, /New order SC-\d+/);
  assert.match(msg.text, new RegExp(`${item.name.replace(/[()]/g, '.')} × 2`));
  assert.match(msg.text, /Asha · 9876543210/);
  assert.match(msg.text, /Will pay cash/);
  assert.match(msg.text, /\/admin#orders/);

  // Counter bills (made by staff) don't alert.
  await call('POST', '/api/admin/counter/bills', { items: [{ itemId: item.id, qty: 1 }], paidBy: 'cash' });
  assert.equal(sent.length, 0);

  // If Telegram is down, the order still goes through.
  failNext = true;
  assert.equal((await call('POST', '/api/orders', { items: [{ itemId: item.id, qty: 1 }] })).status, 201);

  // The admin panel's live check sees the customer orders, not the counter bill.
  const fresh = (await call('GET', `/api/admin/orders/new?after=${lastBefore}`)).data;
  assert.equal(fresh.orders.length, 2);
  assert.ok(fresh.orders.every((x) => x.channel !== 'counter'));

  // Phone and WhatsApp are public (for contact buttons); bad numbers are refused.
  assert.equal((await call('GET', '/api/catalog')).data.settings.phone, '98765 43210');
  assert.equal((await call('PUT', '/api/admin/settings', { whatsapp: 'abc' })).status, 400);
});
