'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { getSettings } = require('./db');
const { computeBill } = require('./pricing');
const auth = require('./auth');

const PUBLIC_SETTING_KEYS = [
  'shop_name', 'tagline', 'phone', 'address', 'gstin', 'tax_percent', 'bill_footer',
  'min_order', 'shop_open', 'closed_message',
];
const EDITABLE_SETTING_KEYS = [...PUBLIC_SETTING_KEYS, 'upi_id', 'upi_name', 'bill_prefix', 'site_url'];

// Servers (e.g. Vercel) run in UTC; "today" on the dashboard should follow the shop's clock. Default: India (+5:30).
const TZ_OFFSET_MIN = Number.isFinite(Number(process.env.SHOP_TZ_OFFSET_MINUTES)) && process.env.SHOP_TZ_OFFSET_MINUTES !== ''
  ? Number(process.env.SHOP_TZ_OFFSET_MINUTES) : 330;
const LOCAL = `'${TZ_OFFSET_MIN >= 0 ? '+' : ''}${TZ_OFFSET_MIN} minutes'`;

/* ---------- helpers ---------- */

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg, extra) => new HttpError(400, msg, extra);

/** Rupees (string/number from a form) -> integer paise. */
function toPaise(v, { allowNull = false, field = 'amount' } = {}) {
  if (v === '' || v == null) {
    if (allowNull) return null;
    throw bad(`${field} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${field} must be a positive number`);
  return Math.round(n * 100);
}
function toInt(v, { min = 0, field = 'value', allowNull = false } = {}) {
  if ((v === '' || v == null) && allowNull) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw bad(`${field} must be a whole number${min >= 0 ? ` ≥ ${min}` : ''}`);
  return n;
}
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0);
/** Accepts "" / null / ISO-ish datetime string; returns ISO string or null. */
function toDate(v, field) {
  if (v === '' || v == null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad(`${field} is not a valid date`);
  return d.toISOString();
}

function itemOut(row) {
  return {
    id: row.id, name: row.name, description: row.description, categoryId: row.category_id,
    unit: row.unit, price: row.price, mrp: row.mrp, stock: row.stock, lowStock: row.low_stock,
    storeStock: row.store_stock ?? 0, totalStock: row.stock + (row.store_stock ?? 0),
    image: row.image, active: !!row.active, sortOrder: row.sort_order, updatedAt: row.updated_at,
  };
}
function discountOut(row) {
  return {
    id: row.id, name: row.name, type: row.type, value: row.value, categoryId: row.category_id,
    minOrder: row.min_order, maxDiscount: row.max_discount, code: row.code,
    startsAt: row.starts_at, endsAt: row.ends_at, active: !!row.active,
  };
}

function upiUri(settings, order) {
  if (!settings.upi_id) return null;
  const params = new URLSearchParams({
    pa: settings.upi_id,
    pn: settings.upi_name || settings.shop_name || 'Shop',
    am: (order.total / 100).toFixed(2),
    cu: 'INR',
    tn: `Bill ${order.bill_no}`,
  });
  return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

/* ---------- app ---------- */

function createApp(db, { dbUrl = '' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));

  const loadPricingContext = async (q = db) => {
    const queries = [() => q.all('SELECT * FROM items'), () => q.all('SELECT * FROM discounts'), () => q.all('SELECT id, name FROM categories')];
    // Parallel on the shared client; one at a time inside a transaction.
    const [items, discounts, cats] = q === db
      ? await Promise.all(queries.map((f) => f()))
      : [await queries[0](), await queries[1](), await queries[2]()];
    return {
      items: new Map(items.map((r) => [r.id, r])),
      discounts,
      categoryNames: new Map(cats.map((c) => [c.id, c.name])),
    };
  };

  const quote = async (body, settings, q = db) => computeBill({
    ...(await loadPricingContext(q)),
    cart: body.items,
    coupon: body.coupon,
    taxPercent: Number(settings.tax_percent) || 0,
  });

  const orderOut = async (order, settings, withLines = true) => {
    const out = {
      id: order.id, token: order.token, billNo: order.bill_no,
      customerName: order.customer_name, customerPhone: order.customer_phone,
      subtotal: order.subtotal, discount: order.discount, discountLabel: order.discount_label,
      tax: order.tax, taxPercent: order.tax_percent, roundOff: order.round_off, total: order.total,
      status: order.status, createdAt: order.created_at, paidAt: order.paid_at,
    };
    if (withLines) {
      out.lines = await db.all('SELECT item_id AS itemId, name, unit, price, qty, total FROM order_items WHERE order_id = ? ORDER BY id', [order.id]);
    }
    if (settings) out.upiUri = upiUri(settings, order);
    return out;
  };

  /* ===== Public API ===== */

  app.get('/api/catalog', async (req, res) => {
    const [settings, discounts, categories, items] = await Promise.all([
      getSettings(db),
      db.all('SELECT * FROM discounts WHERE active = 1 AND code IS NULL'),
      db.all('SELECT id, name FROM categories ORDER BY sort_order, name'),
      db.all('SELECT * FROM items WHERE active = 1 ORDER BY sort_order, name'),
    ]);
    const pub = Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, settings[k]]));
    pub.upi_enabled = !!settings.upi_id;
    const now = Date.now();
    const offers = discounts
      .filter((d) => (!d.starts_at || new Date(d.starts_at).getTime() <= now) && (!d.ends_at || new Date(d.ends_at).getTime() >= now))
      .map(discountOut);
    res.set('Cache-Control', 'no-store');
    res.json({
      settings: pub,
      categories,
      items: items.map(itemOut).map(({ lowStock, active, sortOrder, updatedAt, storeStock, totalStock, ...rest }) => rest),
      offers,
    });
  });

  app.post('/api/quote', async (req, res) => {
    res.json(await quote(req.body || {}, await getSettings(db)));
  });

  app.post('/api/orders', async (req, res) => {
    const body = req.body || {};
    const settings = await getSettings(db);
    if (settings.shop_open !== '1') throw bad(settings.closed_message || 'Shop is closed');

    const order = await db.tx(async (t) => {
      const bill = await quote(body, settings, t);
      if (bill.errors.length) throw bad('Some items in your cart need attention', { errors: bill.errors });
      if (!bill.lines.length) throw bad('Your cart is empty');
      const minOrder = Number(settings.min_order) || 0;
      if (bill.subtotal < minOrder * 100) throw bad(`Minimum order is ₹${minOrder}`);

      const token = crypto.randomBytes(12).toString('hex');
      const info = await t.run(`INSERT INTO orders
        (token, bill_no, customer_name, customer_phone, subtotal, discount, discount_label, tax, tax_percent, round_off, total)
        VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        token, str(body.customerName, 80), str(body.customerPhone, 20),
        bill.subtotal, bill.discount, bill.discountLabel, bill.tax, bill.taxPercent, bill.roundOff, bill.total,
      ]);
      const id = info.lastInsertRowid;
      const billNo = `${settings.bill_prefix || ''}${String(id).padStart(5, '0')}`;
      await t.run('UPDATE orders SET bill_no = ? WHERE id = ?', [billNo, id]);

      for (const l of bill.lines) {
        await t.run('INSERT INTO order_items (order_id, item_id, name, unit, price, qty, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, l.itemId, l.name, l.unit, l.price, l.qty, l.total]);
        const taken = await t.run('UPDATE items SET stock = stock - ? WHERE id = ? AND stock >= ?', [l.qty, l.itemId, l.qty]);
        if (taken.changes !== 1) throw bad(`${l.name} just went out of stock`);
      }
      return { id, token };
    });
    res.status(201).json(order);
  });

  app.get('/api/orders/:id', async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [Number(req.params.id)]);
    const allowed = order && (req.query.t === order.token || await auth.isAuthed(db, req));
    if (!allowed) throw new HttpError(404, 'Bill not found');
    const settings = await getSettings(db);
    const out = await orderOut(order, settings);
    out.upiQr = out.upiUri ? await QRCode.toDataURL(out.upiUri, { margin: 1, width: 360 }) : null;
    out.shop = Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, settings[k]]));
    out.shop.upi_id = settings.upi_id;
    res.set('Cache-Control', 'no-store');
    res.json(out);
  });

  // Lightweight status poll so the bill page can flip to "Paid" when the admin confirms.
  app.get('/api/orders/:id/status', async (req, res) => {
    const order = await db.get('SELECT token, status FROM orders WHERE id = ?', [Number(req.params.id)]);
    if (!order || order.token !== req.query.t) throw new HttpError(404, 'Bill not found');
    res.set('Cache-Control', 'no-store');
    res.json({ status: order.status });
  });

  // Product photos (stored in the database). Ids are random and never reused, so they cache forever.
  app.get(['/img/:id', '/api/img/:id'], async (req, res) => {
    const row = await db.get('SELECT mime, data FROM images WHERE id = ?', [String(req.params.id).replace(/\.\w+$/, '')]);
    if (!row) throw new HttpError(404, 'Image not found');
    res.set('Content-Type', row.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(row.data));
  });

  /* ===== Admin auth ===== */

  const loginAttempts = new Map();
  app.post('/api/admin/login', async (req, res) => {
    const ip = req.ip;
    const a = loginAttempts.get(ip) || { n: 0, until: 0 };
    if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
    if (!auth.verifyPassword((req.body || {}).password, (await getSettings(db)).admin_password)) {
      a.n += 1;
      if (a.n >= 5) { a.n = 0; a.until = Date.now() + 60_000; }
      loginAttempts.set(ip, a);
      throw new HttpError(401, 'Wrong password');
    }
    loginAttempts.delete(ip);
    await auth.createSession(db, res, req.secure);
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', async (req, res) => { await auth.destroySession(db, req, res); res.json({ ok: true }); });
  app.get('/api/admin/me', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ authed: await auth.isAuthed(db, req), passwordIsDefault: (await getSettings(db)).password_is_default === '1' });
  });

  const admin = express.Router();
  admin.use(auth.requireAdmin(db));
  admin.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/admin', admin);

  /* ----- dashboard ----- */
  admin.get('/dashboard', async (req, res) => {
    const today = `date(created_at, ${LOCAL}) = date('now', ${LOCAL})`;
    const [todayRow, paidToday, pending, allTime, lowStock, topItems, stockValue] = await Promise.all([
      db.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales FROM orders WHERE status != 'cancelled' AND ${today}`),
      db.get(`SELECT COALESCE(SUM(total),0) AS v FROM orders WHERE status = 'paid' AND ${today}`),
      db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM orders WHERE status = 'pending'`),
      db.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales FROM orders WHERE status = 'paid'`),
      db.all('SELECT * FROM items WHERE active = 1 AND stock <= low_stock ORDER BY stock, name'),
      db.all(`SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.total) AS amount
        FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled'
        GROUP BY oi.name ORDER BY qty DESC LIMIT 5`),
      db.get(`SELECT COALESCE(SUM((stock + store_stock) * price),0) AS v, COALESCE(SUM(stock + store_stock),0) AS units,
        COALESCE(SUM(stock),0) AS online, COALESCE(SUM(store_stock),0) AS store FROM items`),
    ]);
    res.json({ today: { ...todayRow, paid: paidToday.v }, pending, allTime, lowStock: lowStock.map(itemOut), topItems, stockValue });
  });

  /* ----- categories ----- */
  admin.get('/categories', async (req, res) => {
    res.json(await db.all(`SELECT c.id, c.name, c.sort_order AS sortOrder,
      (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS itemCount
      FROM categories c ORDER BY c.sort_order, c.name`));
  });
  admin.post('/categories', async (req, res) => {
    const name = str(req.body.name, 60);
    if (!name) throw bad('Name is required');
    const info = await db.run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, toInt(req.body.sortOrder ?? 0, { field: 'Order', min: -1e9 })]);
    res.status(201).json({ id: info.lastInsertRowid });
  });
  admin.put('/categories/:id', async (req, res) => {
    const name = str(req.body.name, 60);
    if (!name) throw bad('Name is required');
    await db.run('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?', [name, toInt(req.body.sortOrder ?? 0, { field: 'Order', min: -1e9 }), Number(req.params.id)]);
    res.json({ ok: true });
  });
  admin.delete('/categories/:id', async (req, res) => {
    const id = Number(req.params.id);
    // Done explicitly rather than via foreign keys, which hosted SQLite may not enforce per connection.
    await db.client.batch([
      { sql: 'UPDATE items SET category_id = NULL WHERE category_id = ?', args: [id] },
      { sql: 'DELETE FROM discounts WHERE category_id = ?', args: [id] },
      { sql: 'DELETE FROM categories WHERE id = ?', args: [id] },
    ], 'write');
    res.json({ ok: true });
  });

  /* ----- items ----- */
  admin.get('/items', async (req, res) => {
    res.json((await db.all('SELECT * FROM items ORDER BY sort_order, name')).map(itemOut));
  });

  const readItem = (b) => {
    const name = str(b.name, 100);
    if (!name) throw bad('Name is required');
    return [
      name,
      str(b.description, 300),
      b.categoryId === '' || b.categoryId == null ? null : toInt(b.categoryId, { min: 1, field: 'Category' }),
      str(b.unit, 20) || 'box',
      toPaise(b.price, { field: 'Rate' }),
      toPaise(b.mrp, { allowNull: true, field: 'MRP' }),
      toInt(b.lowStock ?? 5, { field: 'Low-stock alert' }),
      str(b.image, 2000),
      b.active === undefined ? 1 : bool(b.active),
      toInt(b.sortOrder ?? 0, { field: 'Order', min: -1e9 }),
    ];
  };
  const getItem = async (id) => itemOut(await db.get('SELECT * FROM items WHERE id = ?', [id]));

  admin.post('/items', async (req, res) => {
    const b = req.body || {};
    const info = await db.run(`INSERT INTO items (name, description, category_id, unit, price, mrp, low_stock, image, active, sort_order, stock, store_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...readItem(b), toInt(b.stock ?? 0, { field: 'Online stock' }), toInt(b.storeStock ?? 0, { field: 'Store stock' })]);
    res.status(201).json(await getItem(info.lastInsertRowid));
  });

  /**
   * Stock edits are applied as a change relative to what the admin saw when they opened the form
   * (stockWas / storeStockWas). That way an online order placed while the form was open is not
   * silently overwritten when the admin saves.
   */
  admin.put('/items/:id', async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const fields = readItem(b);
    const stock = toInt(b.stock ?? 0, { field: 'Online stock' });
    const store = toInt(b.storeStock ?? 0, { field: 'Store stock' });
    const relative = b.stockWas !== undefined && b.storeStockWas !== undefined;
    const sql = relative
      ? `UPDATE items SET name=?, description=?, category_id=?, unit=?, price=?, mrp=?, low_stock=?, image=?, active=?, sort_order=?,
          stock = MAX(0, stock + ?), store_stock = MAX(0, store_stock + ?), updated_at=datetime('now') WHERE id=?`
      : `UPDATE items SET name=?, description=?, category_id=?, unit=?, price=?, mrp=?, low_stock=?, image=?, active=?, sort_order=?,
          stock = ?, store_stock = ?, updated_at=datetime('now') WHERE id=?`;
    const stockArgs = relative
      ? [stock - toInt(b.stockWas, { min: 0 }), store - toInt(b.storeStockWas, { min: 0 })]
      : [stock, store];
    const info = await db.run(sql, [...fields, ...stockArgs, id]);
    if (!info.changes) throw new HttpError(404, 'Item not found');
    res.json(await getItem(id));
  });

  /**
   * Quick inline edits from the inventory list. Any of:
   *  price, active, addStock (online ±n), addStoreStock (store ±n),
   *  moveToStore (n > 0 moves online -> store, n < 0 moves store -> online).
   */
  admin.patch('/items/:id', async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const row = await db.get('SELECT * FROM items WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'Item not found');
    const price = b.price !== undefined ? toPaise(b.price, { field: 'Rate' }) : row.price;
    const active = b.active !== undefined ? bool(b.active) : row.active;
    const addOnline = b.addStock !== undefined ? toInt(b.addStock, { min: -1e9, field: 'Stock change' }) : 0;
    const addStore = b.addStoreStock !== undefined ? toInt(b.addStoreStock, { min: -1e9, field: 'Store stock change' }) : 0;
    const move = b.moveToStore !== undefined ? toInt(b.moveToStore, { min: -1e9, field: 'Quantity to move' }) : 0;
    if (move) {
      // Moves must not create or destroy stock, so refuse rather than clamp.
      const r = await db.run(`UPDATE items SET stock = stock - ?, store_stock = store_stock + ?, updated_at=datetime('now')
        WHERE id = ? AND stock - ? >= 0 AND store_stock + ? >= 0`, [move, move, id, move, move]);
      if (!r.changes) throw bad(move > 0 ? `Only ${row.stock} in online stock to move` : `Only ${row.store_stock} in the store to move`);
    }
    await db.run(`UPDATE items SET price = ?, active = ?, stock = MAX(0, stock + ?), store_stock = MAX(0, store_stock + ?),
      updated_at = datetime('now') WHERE id = ?`, [price, active, addOnline, addStore, id]);
    res.json(await getItem(id));
  });

  admin.delete('/items/:id', async (req, res) => {
    await db.run('DELETE FROM items WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  // Change every rate (optionally in one category) by a percentage, e.g. +10 or -5.
  admin.post('/items/bulk-price', async (req, res) => {
    const pct = Number(req.body.percent);
    if (!Number.isFinite(pct) || pct <= -100 || pct > 1000) throw bad('Percent must be between -99 and 1000');
    const cat = req.body.categoryId ? Number(req.body.categoryId) : null;
    const roundTo = Math.max(1, Math.round(Number(req.body.roundTo) || 1)) * 100;
    const rows = await db.all(cat ? 'SELECT id, price FROM items WHERE category_id = ?' : 'SELECT id, price FROM items', cat ? [cat] : []);
    if (rows.length) {
      await db.client.batch(rows.map((r) => ({
        sql: "UPDATE items SET price = ?, updated_at = datetime('now') WHERE id = ?",
        args: [Math.max(roundTo, Math.round((r.price * (1 + pct / 100)) / roundTo) * roundTo), r.id],
      })), 'write');
    }
    res.json({ updated: rows.length });
  });

  /* ----- image upload (from camera or gallery; resized in the browser) ----- */
  admin.post('/upload', async (req, res) => {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String((req.body || {}).dataUrl || ''));
    if (!m) throw bad('Please upload a JPEG, PNG or WebP image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) throw bad('Image is too large (max 2 MB)');
    const id = `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
    await db.run('INSERT INTO images (id, mime, data) VALUES (?, ?, ?)', [id, `image/${m[1]}`, buf]);
    res.status(201).json({ url: `/img/${id}` });
  });

  /* ----- discounts ----- */
  admin.get('/discounts', async (req, res) => {
    res.json((await db.all('SELECT * FROM discounts ORDER BY active DESC, id DESC')).map(discountOut));
  });
  const readDiscount = (b) => {
    const name = str(b.name, 80);
    if (!name) throw bad('Name is required');
    const type = b.type === 'flat' ? 'flat' : 'percent';
    const value = type === 'percent' ? Number(b.value) : toPaise(b.value, { field: 'Amount' });
    if (type === 'percent' && !(value > 0 && value <= 100 && Number.isInteger(value))) throw bad('Percent must be a whole number from 1 to 100');
    if (type === 'flat' && !(value > 0)) throw bad('Amount must be more than 0');
    const startsAt = toDate(b.startsAt, 'Start');
    const endsAt = toDate(b.endsAt, 'End');
    if (startsAt && endsAt && endsAt < startsAt) throw bad('End must be after start');
    return [
      name, type, value,
      b.categoryId === '' || b.categoryId == null ? null : toInt(b.categoryId, { min: 1, field: 'Category' }),
      toPaise(b.minOrder || 0, { field: 'Minimum order' }),
      toPaise(b.maxDiscount, { allowNull: true, field: 'Max discount' }),
      str(b.code, 30).toUpperCase() || null,
      startsAt, endsAt,
      b.active === undefined ? 1 : bool(b.active),
    ];
  };
  admin.post('/discounts', async (req, res) => {
    const info = await db.run(`INSERT INTO discounts (name, type, value, category_id, min_order, max_discount, code, starts_at, ends_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, readDiscount(req.body || {}));
    res.status(201).json({ id: info.lastInsertRowid });
  });
  admin.put('/discounts/:id', async (req, res) => {
    await db.run(`UPDATE discounts SET name=?, type=?, value=?, category_id=?, min_order=?, max_discount=?, code=?, starts_at=?, ends_at=?, active=? WHERE id=?`,
      [...readDiscount(req.body || {}), Number(req.params.id)]);
    res.json({ ok: true });
  });
  admin.patch('/discounts/:id', async (req, res) => {
    await db.run('UPDATE discounts SET active = ? WHERE id = ?', [bool(req.body.active), Number(req.params.id)]);
    res.json({ ok: true });
  });
  admin.delete('/discounts/:id', async (req, res) => {
    await db.run('DELETE FROM discounts WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  /* ----- orders ----- */
  admin.get('/orders', async (req, res) => {
    const where = [];
    const args = [];
    if (['pending', 'paid', 'cancelled'].includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) { where.push(`date(created_at, ${LOCAL}) = ?`); args.push(req.query.date); }
    if (req.query.q) {
      where.push('(bill_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
      const q = `%${str(req.query.q, 50)}%`;
      args.push(q, q, q);
    }
    const rows = await db.all(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`, args);
    res.json(await Promise.all(rows.map((o) => orderOut(o, null, false))));
  });

  admin.get('/orders.csv', async (req, res) => {
    const rows = await db.all(`SELECT o.bill_no, datetime(o.created_at, ${LOCAL}) AS created, o.status, o.customer_name, o.customer_phone,
      oi.name, oi.qty, oi.price, oi.total, o.discount, o.tax, o.total AS bill_total
      FROM orders o JOIN order_items oi ON oi.order_id = o.id ORDER BY o.id DESC, oi.id`);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rupees = (p) => (p / 100).toFixed(2);
    const lines = [['Bill', 'Date', 'Status', 'Customer', 'Phone', 'Item', 'Qty', 'Rate', 'Line total', 'Bill discount', 'Bill tax', 'Bill total'].map(esc).join(',')];
    for (const r of rows) {
      lines.push([r.bill_no, r.created, r.status, r.customer_name, r.customer_phone, r.name, r.qty, rupees(r.price), rupees(r.total),
        rupees(r.discount), rupees(r.tax), rupees(r.bill_total)].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send('﻿' + lines.join('\n'));
  });

  admin.patch('/orders/:id', async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body.status;
    if (!['pending', 'paid', 'cancelled'].includes(status)) throw bad('Unknown status');
    await db.tx(async (t) => {
      const order = await t.get('SELECT * FROM orders WHERE id = ?', [id]);
      if (!order) throw new HttpError(404, 'Order not found');
      if (order.status === status) return;
      const lines = await t.all('SELECT item_id, qty FROM order_items WHERE order_id = ?', [id]);
      const adjust = (delta, itemId) => t.run('UPDATE items SET stock = MAX(0, stock + ?) WHERE id = ?', [delta, itemId]);
      // Cancelling returns stock to the shelf; un-cancelling takes it back.
      if (status === 'cancelled') for (const l of lines) await adjust(l.qty, l.item_id);
      if (order.status === 'cancelled') for (const l of lines) await adjust(-l.qty, l.item_id);
      await t.run("UPDATE orders SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE NULL END WHERE id = ?", [status, status, id]);
    });
    res.json({ ok: true });
  });

  /* ----- data safety: which database, counts, backup ----- */
  admin.get('/db-info', async (req, res) => {
    let where = 'Local file on this server';
    if (!dbUrl.startsWith('file:')) {
      try { where = new URL(dbUrl.replace(/^libsql:/, 'https:')).host; } catch { where = 'Hosted database'; }
    }
    const c = await db.get(`SELECT (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM categories) AS categories,
      (SELECT COUNT(*) FROM discounts) AS offers, (SELECT COUNT(*) FROM orders) AS bills, (SELECT COUNT(*) FROM images) AS photos`);
    res.json({ where, counts: c });
  });

  // Full download of the shop's data (everything except login secrets).
  admin.get('/backup.json', async (req, res) => {
    const [settings, categories, items, discounts, orders, orderItems, images] = await Promise.all([
      db.all("SELECT key, value FROM settings WHERE key NOT IN ('admin_password')"),
      db.all('SELECT * FROM categories'), db.all('SELECT * FROM items'), db.all('SELECT * FROM discounts'),
      db.all('SELECT * FROM orders'), db.all('SELECT * FROM order_items'),
      db.all('SELECT id, mime, data, created_at FROM images'),
    ]);
    const backup = {
      app: 'crackers-cart', version: 1, createdAt: new Date().toISOString(),
      settings, categories, items, discounts, orders, orderItems,
      images: images.map((i) => ({ ...i, data: Buffer.from(i.data).toString('base64') })),
    };
    const stamp = new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shop-backup-${stamp}.json"`);
    res.send(JSON.stringify(backup));
  });

  admin.get('/inventory.csv', async (req, res) => {
    const rows = await db.all(`SELECT i.name, c.name AS category, i.unit, i.price, i.mrp, i.stock, i.store_stock, i.active
      FROM items i LEFT JOIN categories c ON c.id = i.category_id ORDER BY c.sort_order, c.name, i.sort_order, i.name`);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rupees = (p) => (p == null ? '' : (p / 100).toFixed(2));
    const lines = [['Item', 'Category', 'Unit', 'Rate', 'MRP', 'Online stock', 'Store stock', 'Total stock', 'Total value', 'Visible online'].map(esc).join(',')];
    for (const r of rows) {
      const total = r.stock + r.store_stock;
      lines.push([r.name, r.category, r.unit, rupees(r.price), rupees(r.mrp), r.stock, r.store_stock, total, rupees(total * r.price), r.active ? 'Yes' : 'No'].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    res.send('\ufeff' + lines.join('\n'));
  });

  /* ----- settings ----- */
  admin.get('/settings', async (req, res) => {
    const s = await getSettings(db);
    res.json(Object.fromEntries(EDITABLE_SETTING_KEYS.map((k) => [k, s[k] ?? ''])));
  });
  admin.put('/settings', async (req, res) => {
    const b = req.body || {};
    if (b.tax_percent !== undefined && !(Number(b.tax_percent) >= 0 && Number(b.tax_percent) <= 100)) throw bad('Tax must be 0–100');
    if (b.min_order !== undefined && !(Number(b.min_order) >= 0)) throw bad('Minimum order must be 0 or more');
    if (b.upi_id && !/^[\w.\-]{2,}@[a-zA-Z][\w.\-]*$/.test(String(b.upi_id).trim())) throw bad('UPI ID looks wrong (expected something like name@bank)');
    const stmts = EDITABLE_SETTING_KEYS.filter((k) => b[k] !== undefined).map((k) => ({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [k, k === 'shop_open' ? String(bool(b[k])) : str(b[k], 1000)],
    }));
    if (stmts.length) await db.client.batch(stmts, 'write');
    res.json({ ok: true });
  });
  admin.post('/password', async (req, res) => {
    const { current, next } = req.body || {};
    if (!auth.verifyPassword(current, (await getSettings(db)).admin_password)) throw bad('Current password is wrong');
    if (!next || String(next).length < 6) throw bad('New password must be at least 6 characters');
    await db.client.batch([
      { sql: "UPDATE settings SET value = ? WHERE key = 'admin_password'", args: [auth.hashPassword(next)] },
      "UPDATE settings SET value = '0' WHERE key = 'password_is_default'",
    ], 'write');
    res.json({ ok: true });
  });

  /* ----- printable store QR ----- */
  admin.get('/store-qr', async (req, res) => {
    const s = await getSettings(db);
    const url = (s.site_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '') + '/';
    res.json({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 600, errorCorrectionLevel: 'M' }) });
  });

  /* ===== static (local/VPS; on Vercel the CDN serves /public directly) ===== */
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp, toPaise };
