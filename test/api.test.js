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
  const db = openDb(':memory:');
  seedDemo(db);
  const app = createApp(db, { uploadDir: path.join(dir, 'uploads') });
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
  return { call, close: () => server.close(), dir };
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
  const { call, close, dir } = await setup();
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
  assert.ok(fs.existsSync(path.join(dir, 'uploads', path.basename(up.data.url))));
  assert.equal((await call('POST', '/api/admin/upload', { dataUrl: 'data:text/html;base64,PGgxPg==' })).status, 400);

  const qr = await call('GET', '/api/admin/store-qr');
  assert.match(qr.data.qr, /^data:image\/png/);
});
