'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { getSettings, tx } = require('./db');
const { computeBill } = require('./pricing');
const auth = require('./auth');

const PUBLIC_SETTING_KEYS = [
  'shop_name', 'tagline', 'phone', 'address', 'gstin', 'tax_percent', 'bill_footer',
  'min_order', 'shop_open', 'closed_message',
];
const EDITABLE_SETTING_KEYS = [...PUBLIC_SETTING_KEYS, 'upi_id', 'upi_name', 'bill_prefix', 'site_url'];

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

function createApp(db, { uploadDir }) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '8mb' }));

  const loadPricingContext = () => {
    const items = new Map(db.prepare('SELECT * FROM items').all().map((r) => [r.id, r]));
    const discounts = db.prepare('SELECT * FROM discounts').all();
    const categoryNames = new Map(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.id, c.name]));
    return { items, discounts, categoryNames };
  };

  const quote = (body) => {
    const settings = getSettings(db);
    return computeBill({
      ...loadPricingContext(),
      cart: body.items,
      coupon: body.coupon,
      taxPercent: Number(settings.tax_percent) || 0,
    });
  };

  const orderOut = (order, settings, withLines = true) => {
    const out = {
      id: order.id, token: order.token, billNo: order.bill_no,
      customerName: order.customer_name, customerPhone: order.customer_phone,
      subtotal: order.subtotal, discount: order.discount, discountLabel: order.discount_label,
      tax: order.tax, taxPercent: order.tax_percent, roundOff: order.round_off, total: order.total,
      status: order.status, createdAt: order.created_at, paidAt: order.paid_at,
    };
    if (withLines) {
      out.lines = db.prepare('SELECT item_id AS itemId, name, unit, price, qty, total FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
    }
    if (settings) out.upiUri = upiUri(settings, order);
    return out;
  };

  /* ===== Public API ===== */

  app.get('/api/catalog', (req, res) => {
    const settings = getSettings(db);
    const pub = Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, settings[k]]));
    pub.upi_enabled = !!settings.upi_id;
    const now = Date.now();
    const offers = db.prepare('SELECT * FROM discounts WHERE active = 1 AND code IS NULL').all()
      .filter((d) => (!d.starts_at || new Date(d.starts_at).getTime() <= now) && (!d.ends_at || new Date(d.ends_at).getTime() >= now))
      .map(discountOut);
    res.json({
      settings: pub,
      categories: db.prepare('SELECT id, name FROM categories ORDER BY sort_order, name').all(),
      items: db.prepare('SELECT * FROM items WHERE active = 1 ORDER BY sort_order, name').all().map(itemOut)
        .map(({ lowStock, active, sortOrder, updatedAt, ...rest }) => rest),
      offers,
    });
  });

  app.post('/api/quote', (req, res) => {
    res.json(quote(req.body || {}));
  });

  app.post('/api/orders', (req, res) => {
    const body = req.body || {};
    const settings = getSettings(db);
    if (settings.shop_open !== '1') throw bad(settings.closed_message || 'Shop is closed');

    const order = tx(db, () => {
      const bill = quote(body);
      if (bill.errors.length) throw bad('Some items in your cart need attention', { errors: bill.errors });
      if (!bill.lines.length) throw bad('Your cart is empty');
      const minOrder = Number(settings.min_order) || 0;
      if (bill.subtotal < minOrder * 100) throw bad(`Minimum order is ₹${minOrder}`);

      const token = crypto.randomBytes(12).toString('hex');
      const info = db.prepare(`INSERT INTO orders
        (token, bill_no, customer_name, customer_phone, subtotal, discount, discount_label, tax, tax_percent, round_off, total)
        VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        token, str(body.customerName, 80), str(body.customerPhone, 20),
        bill.subtotal, bill.discount, bill.discountLabel, bill.tax, bill.taxPercent, bill.roundOff, bill.total,
      );
      const id = Number(info.lastInsertRowid);
      const billNo = `${settings.bill_prefix || ''}${String(id).padStart(5, '0')}`;
      db.prepare('UPDATE orders SET bill_no = ? WHERE id = ?').run(billNo, id);

      const addLine = db.prepare('INSERT INTO order_items (order_id, item_id, name, unit, price, qty, total) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const takeStock = db.prepare('UPDATE items SET stock = stock - ? WHERE id = ? AND stock >= ?');
      for (const l of bill.lines) {
        addLine.run(id, l.itemId, l.name, l.unit, l.price, l.qty, l.total);
        if (takeStock.run(l.qty, l.itemId, l.qty).changes !== 1) throw bad(`${l.name} just went out of stock`);
      }
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    });
    res.status(201).json({ id: order.id, token: order.token });
  });

  app.get('/api/orders/:id', async (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    const allowed = order && (req.query.t === order.token || auth.isAuthed(db, req));
    if (!allowed) throw new HttpError(404, 'Bill not found');
    const settings = getSettings(db);
    const out = orderOut(order, settings);
    out.upiQr = out.upiUri ? await QRCode.toDataURL(out.upiUri, { margin: 1, width: 360 }) : null;
    out.shop = Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, settings[k]]));
    out.shop.upi_id = settings.upi_id;
    res.json(out);
  });

  // Lightweight status poll so the bill page can flip to "Paid" when the admin confirms.
  app.get('/api/orders/:id/status', (req, res) => {
    const order = db.prepare('SELECT token, status FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order || order.token !== req.query.t) throw new HttpError(404, 'Bill not found');
    res.json({ status: order.status });
  });

  /* ===== Admin auth ===== */

  const loginAttempts = new Map();
  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip;
    const a = loginAttempts.get(ip) || { n: 0, until: 0 };
    if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
    if (!auth.verifyPassword((req.body || {}).password, getSettings(db).admin_password)) {
      a.n += 1;
      if (a.n >= 5) { a.n = 0; a.until = Date.now() + 60_000; }
      loginAttempts.set(ip, a);
      throw new HttpError(401, 'Wrong password');
    }
    loginAttempts.delete(ip);
    auth.createSession(db, res, req.secure);
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', (req, res) => { auth.destroySession(db, req, res); res.json({ ok: true }); });
  app.get('/api/admin/me', (req, res) => {
    res.json({ authed: auth.isAuthed(db, req), passwordIsDefault: getSettings(db).password_is_default === '1' });
  });

  const admin = express.Router();
  admin.use(auth.requireAdmin(db));
  app.use('/api/admin', admin);

  /* ----- dashboard ----- */
  admin.get('/dashboard', (req, res) => {
    const today = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales
      FROM orders WHERE status != 'cancelled' AND date(created_at, 'localtime') = date('now', 'localtime')`).get();
    const paidToday = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM orders
      WHERE status = 'paid' AND date(created_at, 'localtime') = date('now', 'localtime')`).get().v;
    const pending = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM orders WHERE status = 'pending'`).get();
    const allTime = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales FROM orders WHERE status = 'paid'`).get();
    const lowStock = db.prepare('SELECT * FROM items WHERE active = 1 AND stock <= low_stock ORDER BY stock, name').all().map(itemOut);
    const topItems = db.prepare(`SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.total) AS amount
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled'
      GROUP BY oi.name ORDER BY qty DESC LIMIT 5`).all();
    const stockValue = db.prepare('SELECT COALESCE(SUM(stock * price),0) AS v, COALESCE(SUM(stock),0) AS units FROM items WHERE active = 1').get();
    res.json({ today: { ...today, paid: paidToday }, pending, allTime, lowStock, topItems, stockValue });
  });

  /* ----- categories ----- */
  admin.get('/categories', (req, res) => {
    res.json(db.prepare(`SELECT c.id, c.name, c.sort_order AS sortOrder,
      (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS itemCount
      FROM categories c ORDER BY c.sort_order, c.name`).all());
  });
  admin.post('/categories', (req, res) => {
    const name = str(req.body.name, 60);
    if (!name) throw bad('Name is required');
    const info = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(name, toInt(req.body.sortOrder ?? 0, { field: 'Order' }));
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  admin.put('/categories/:id', (req, res) => {
    const name = str(req.body.name, 60);
    if (!name) throw bad('Name is required');
    db.prepare('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?').run(name, toInt(req.body.sortOrder ?? 0, { field: 'Order' }), Number(req.params.id));
    res.json({ ok: true });
  });
  admin.delete('/categories/:id', (req, res) => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  /* ----- items ----- */
  admin.get('/items', (req, res) => {
    res.json(db.prepare('SELECT * FROM items ORDER BY sort_order, name').all().map(itemOut));
  });

  const readItem = (b) => {
    const name = str(b.name, 100);
    if (!name) throw bad('Name is required');
    return {
      name,
      description: str(b.description, 300),
      category_id: b.categoryId === '' || b.categoryId == null ? null : toInt(b.categoryId, { min: 1, field: 'Category' }),
      unit: str(b.unit, 20) || 'box',
      price: toPaise(b.price, { field: 'Rate' }),
      mrp: toPaise(b.mrp, { allowNull: true, field: 'MRP' }),
      stock: toInt(b.stock ?? 0, { field: 'Stock' }),
      low_stock: toInt(b.lowStock ?? 5, { field: 'Low-stock alert' }),
      image: str(b.image, 2000),
      active: b.active === undefined ? 1 : bool(b.active),
      sort_order: toInt(b.sortOrder ?? 0, { field: 'Order', min: -1e9 }),
    };
  };

  admin.post('/items', (req, res) => {
    const it = readItem(req.body || {});
    const info = db.prepare(`INSERT INTO items (name, description, category_id, unit, price, mrp, stock, low_stock, image, active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      it.name, it.description, it.category_id, it.unit, it.price, it.mrp, it.stock, it.low_stock, it.image, it.active, it.sort_order);
    res.status(201).json(itemOut(db.prepare('SELECT * FROM items WHERE id = ?').get(Number(info.lastInsertRowid))));
  });

  admin.put('/items/:id', (req, res) => {
    const it = readItem(req.body || {});
    const info = db.prepare(`UPDATE items SET name=?, description=?, category_id=?, unit=?, price=?, mrp=?, stock=?, low_stock=?,
      image=?, active=?, sort_order=?, updated_at=datetime('now') WHERE id=?`).run(
      it.name, it.description, it.category_id, it.unit, it.price, it.mrp, it.stock, it.low_stock, it.image, it.active, it.sort_order,
      Number(req.params.id));
    if (!info.changes) throw new HttpError(404, 'Item not found');
    res.json(itemOut(db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id))));
  });

  // Quick inline edits from the inventory table: any of price, stock, addStock, active.
  admin.patch('/items/:id', (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Item not found');
    const price = b.price !== undefined ? toPaise(b.price, { field: 'Rate' }) : row.price;
    let stock = b.stock !== undefined ? toInt(b.stock, { field: 'Stock' }) : row.stock;
    if (b.addStock !== undefined) stock = Math.max(0, stock + toInt(b.addStock, { min: -1e9, field: 'Stock change' }));
    const active = b.active !== undefined ? bool(b.active) : row.active;
    db.prepare("UPDATE items SET price=?, stock=?, active=?, updated_at=datetime('now') WHERE id=?").run(price, stock, active, id);
    res.json(itemOut(db.prepare('SELECT * FROM items WHERE id = ?').get(id)));
  });

  admin.delete('/items/:id', (req, res) => {
    db.prepare('DELETE FROM items WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Change every rate (optionally in one category) by a percentage, e.g. +10 or -5.
  admin.post('/items/bulk-price', (req, res) => {
    const pct = Number(req.body.percent);
    if (!Number.isFinite(pct) || pct <= -100 || pct > 1000) throw bad('Percent must be between -99 and 1000');
    const cat = req.body.categoryId ? Number(req.body.categoryId) : null;
    const roundTo = Math.max(1, Math.round(Number(req.body.roundTo) || 1)) * 100;
    const rows = db.prepare(cat ? 'SELECT id, price FROM items WHERE category_id = ?' : 'SELECT id, price FROM items').all(...(cat ? [cat] : []));
    const upd = db.prepare("UPDATE items SET price = ?, updated_at = datetime('now') WHERE id = ?");
    tx(db, () => {
      for (const r of rows) upd.run(Math.max(roundTo, Math.round((r.price * (1 + pct / 100)) / roundTo) * roundTo), r.id);
    });
    res.json({ updated: rows.length });
  });

  /* ----- image upload (from camera or gallery; resized in the browser) ----- */
  admin.post('/upload', (req, res) => {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String((req.body || {}).dataUrl || ''));
    if (!m) throw bad('Please upload a JPEG, PNG or WebP image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) throw bad('Image is too large (max 5 MB)');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, name), buf);
    res.status(201).json({ url: `/uploads/${name}` });
  });

  /* ----- discounts ----- */
  admin.get('/discounts', (req, res) => {
    res.json(db.prepare('SELECT * FROM discounts ORDER BY active DESC, id DESC').all().map(discountOut));
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
    return {
      name, type, value,
      category_id: b.categoryId === '' || b.categoryId == null ? null : toInt(b.categoryId, { min: 1, field: 'Category' }),
      min_order: toPaise(b.minOrder || 0, { field: 'Minimum order' }),
      max_discount: toPaise(b.maxDiscount, { allowNull: true, field: 'Max discount' }),
      code: str(b.code, 30).toUpperCase() || null,
      starts_at: startsAt, ends_at: endsAt,
      active: b.active === undefined ? 1 : bool(b.active),
    };
  };
  admin.post('/discounts', (req, res) => {
    const d = readDiscount(req.body || {});
    const info = db.prepare(`INSERT INTO discounts (name, type, value, category_id, min_order, max_discount, code, starts_at, ends_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.name, d.type, d.value, d.category_id, d.min_order, d.max_discount, d.code, d.starts_at, d.ends_at, d.active);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  admin.put('/discounts/:id', (req, res) => {
    const d = readDiscount(req.body || {});
    db.prepare(`UPDATE discounts SET name=?, type=?, value=?, category_id=?, min_order=?, max_discount=?, code=?, starts_at=?, ends_at=?, active=? WHERE id=?`)
      .run(d.name, d.type, d.value, d.category_id, d.min_order, d.max_discount, d.code, d.starts_at, d.ends_at, d.active, Number(req.params.id));
    res.json({ ok: true });
  });
  admin.patch('/discounts/:id', (req, res) => {
    db.prepare('UPDATE discounts SET active = ? WHERE id = ?').run(bool(req.body.active), Number(req.params.id));
    res.json({ ok: true });
  });
  admin.delete('/discounts/:id', (req, res) => {
    db.prepare('DELETE FROM discounts WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  /* ----- orders ----- */
  admin.get('/orders', (req, res) => {
    const where = [];
    const args = [];
    if (['pending', 'paid', 'cancelled'].includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) { where.push("date(created_at, 'localtime') = ?"); args.push(req.query.date); }
    if (req.query.q) {
      where.push('(bill_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
      const q = `%${str(req.query.q, 50)}%`;
      args.push(q, q, q);
    }
    const rows = db.prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).all(...args);
    res.json(rows.map((o) => orderOut(o, null, false)));
  });

  admin.get('/orders.csv', (req, res) => {
    const rows = db.prepare(`SELECT o.bill_no, o.created_at, o.status, o.customer_name, o.customer_phone, oi.name, oi.qty, oi.price, oi.total,
      o.discount, o.tax, o.total AS bill_total FROM orders o JOIN order_items oi ON oi.order_id = o.id ORDER BY o.id DESC, oi.id`).all();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rupees = (p) => (p / 100).toFixed(2);
    const lines = [['Bill', 'Date (UTC)', 'Status', 'Customer', 'Phone', 'Item', 'Qty', 'Rate', 'Line total', 'Bill discount', 'Bill tax', 'Bill total'].map(esc).join(',')];
    for (const r of rows) {
      lines.push([r.bill_no, r.created_at, r.status, r.customer_name, r.customer_phone, r.name, r.qty, rupees(r.price), rupees(r.total),
        rupees(r.discount), rupees(r.tax), rupees(r.bill_total)].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send('﻿' + lines.join('\n'));
  });

  admin.patch('/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    const status = req.body.status;
    if (!['pending', 'paid', 'cancelled'].includes(status)) throw bad('Unknown status');
    tx(db, () => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!order) throw new HttpError(404, 'Order not found');
      if (order.status === status) return;
      const lines = db.prepare('SELECT item_id, qty FROM order_items WHERE order_id = ?').all(id);
      const adjust = db.prepare('UPDATE items SET stock = MAX(0, stock + ?) WHERE id = ?');
      // Cancelling returns stock to the shelf; un-cancelling takes it back.
      if (status === 'cancelled') for (const l of lines) adjust.run(l.qty, l.item_id);
      if (order.status === 'cancelled') for (const l of lines) adjust.run(-l.qty, l.item_id);
      db.prepare("UPDATE orders SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE NULL END WHERE id = ?").run(status, status, id);
    });
    res.json({ ok: true });
  });

  /* ----- settings ----- */
  admin.get('/settings', (req, res) => {
    const s = getSettings(db);
    res.json(Object.fromEntries(EDITABLE_SETTING_KEYS.map((k) => [k, s[k] ?? ''])));
  });
  admin.put('/settings', (req, res) => {
    const b = req.body || {};
    if (b.tax_percent !== undefined && !(Number(b.tax_percent) >= 0 && Number(b.tax_percent) <= 100)) throw bad('Tax must be 0–100');
    if (b.min_order !== undefined && !(Number(b.min_order) >= 0)) throw bad('Minimum order must be 0 or more');
    if (b.upi_id && !/^[\w.\-]{2,}@[a-zA-Z][\w.\-]*$/.test(String(b.upi_id).trim())) throw bad('UPI ID looks wrong (expected something like name@bank)');
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    tx(db, () => {
      for (const k of EDITABLE_SETTING_KEYS) if (b[k] !== undefined) up.run(k, k === 'shop_open' ? String(bool(b[k])) : str(b[k], 1000));
    });
    res.json({ ok: true });
  });
  admin.post('/password', (req, res) => {
    const { current, next } = req.body || {};
    if (!auth.verifyPassword(current, getSettings(db).admin_password)) throw bad('Current password is wrong');
    if (!next || String(next).length < 6) throw bad('New password must be at least 6 characters');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_password'").run(auth.hashPassword(next));
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'password_is_default'").run();
    res.json({ ok: true });
  });

  /* ----- printable store QR ----- */
  admin.get('/store-qr', async (req, res) => {
    const s = getSettings(db);
    const url = (s.site_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '') + '/';
    res.json({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 600, errorCorrectionLevel: 'M' }) });
  });

  /* ===== static ===== */
  app.use('/uploads', express.static(uploadDir, { maxAge: '30d', immutable: true }));
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
