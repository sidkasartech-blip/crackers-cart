'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { getSettings } = require('./db');
const { computeBill, specialDiscount, totalsFor } = require('./pricing');
const auth = require('./auth');
const { telegram, notifyNewOrder } = require('./notify');
const backups = require('./backup');

const PUBLIC_SETTING_KEYS = [
  'shop_name', 'tagline', 'phone', 'address', 'gstin', 'tax_percent', 'bill_footer',
  'min_order', 'shop_open', 'closed_message',
  'delivery_enabled', 'delivery_charge', 'delivery_free_above', 'delivery_note', 'cash_enabled',
  'delivery_min_order', 'shop_lat', 'shop_lng', 'delivery_slabs', 'whatsapp',
];
const EDITABLE_SETTING_KEYS = [...PUBLIC_SETTING_KEYS, 'online_sells_store_stock', 'upi_id', 'upi_name', 'bill_prefix', 'site_url',
  'telegram_bot_token', 'telegram_chat_id'];
const SECRET_MASK = '••••••';

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

function createApp(db, { dbUrl = '', dbSource = '' } = {}) {
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

  const wantsDelivery = (body, settings) => body.fulfilment === 'delivery' && settings.delivery_enabled === '1';
  const parseSlabs = (raw) => {
    try {
      const s = JSON.parse(raw || '[]');
      return Array.isArray(s) ? s.filter((x) => x && Number(x.km) > 0).sort((a, b) => a.km - b.km) : [];
    } catch { return []; }
  };
  const coord = (v, max) => {
    const n = Number(v);
    return v !== '' && v != null && Number.isFinite(n) && Math.abs(n) <= max ? n : null;
  };
  // Straight-line distance × 1.3 ≈ road distance in a city (no paid map service needed).
  const ROAD_FACTOR = 1.3;
  const kmBetween = (a, b) => {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h)) * ROAD_FACTOR;
  };
  /**
   * Delivery charge. Without a shop location (or distance bands) everyone pays the flat delivery charge.
   * With them: distance from the shop to the customer's map pin picks the band; beyond the last band = no delivery.
   * Returns { charge (paise), problem (message or ''), km, lat, lng }.
   */
  const deliveryFor = (settings, latIn, lngIn) => {
    const flat = Math.round((Number(settings.delivery_charge) || 0) * 100);
    const shop = { lat: coord(settings.shop_lat, 90), lng: coord(settings.shop_lng, 180) };
    const slabs = parseSlabs(settings.delivery_slabs);
    if (shop.lat === null || shop.lng === null || !slabs.length) return { charge: flat, problem: '' };
    const r6 = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6); // ~10 cm; avoids long float tails
    const lat = r6(coord(latIn, 90)); const lng = r6(coord(lngIn, 180));
    if (lat === null || lng === null) {
      return { charge: 0, problem: 'Mark your delivery location on the map to see the delivery charge.', needLocation: true };
    }
    const km = Math.round(kmBetween(shop, { lat, lng }) * 10) / 10;
    const slab = slabs.find((s) => km <= Number(s.km));
    if (!slab) {
      const max = slabs[slabs.length - 1].km;
      return { charge: 0, km, lat, lng, problem: `Sorry, we deliver within ${max} km. Your location is about ${km} km away. Please choose pickup at store.` };
    }
    return { charge: Math.round((Number(slab.charge) || 0) * 100), problem: '', km, lat, lng };
  };
  // What the online shop can sell: online stock, plus offline-store stock when that setting is on.
  const sharesStore = (settings) => settings.online_sells_store_stock === '1';
  // In the shop (in-store QR or counter) everything on hand can be sold, whatever the online setting.
  const sellable = (row, settings, channel = 'online') =>
    row.stock + (channel !== 'online' || sharesStore(settings) ? (row.store_stock || 0) : 0);
  const channelOf = (v) => (v === 'store' || v === 'counter' ? v : 'online');
  const paiseOrNull = (v, field) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 1e9) throw bad(`${field} must be 0 or more`);
    return n;
  };
  /** { type: 'percent' | 'flat', value } from the admin screens; flat value in paise. null = use the automatic offer. */
  const readDiscountOverride = (o) => {
    if (!o || o.value === '' || o.value == null) return null;
    const type = o.type === 'flat' ? 'flat' : 'percent';
    const value = Number(o.value);
    if (!Number.isFinite(value) || value < 0) throw bad('Discount must be 0 or more');
    if (type === 'percent' && value > 100) throw bad('Discount can be at most 100%');
    return { type, value };
  };
  const quote = async (body, settings, q = db, channel = channelOf(body.channel)) => {
    const ctx = await loadPricingContext(q);
    ctx.items = new Map([...ctx.items].map(([id, r]) => [id, { ...r, stock: sellable(r, settings, channel) }]));
    const counter = channel === 'counter';
    // Counter only (staff): an agreed rate per item. Customers' own bills always use the listed rate.
    if (counter) {
      for (const l of Array.isArray(body.items) ? body.items : []) {
        const r = ctx.items.get(Number(l.itemId));
        const p = paiseOrNull(l.price, 'Rate');
        if (r && p !== null && p !== r.price) ctx.items.set(r.id, { ...r, list_price: r.price, price: p });
      }
    }
    const zone = wantsDelivery(body, settings) ? deliveryFor(settings, body.deliveryLat, body.deliveryLng) : null;
    const bill = computeBill({
      ...ctx,
      cart: body.items,
      coupon: body.coupon,
      taxPercent: Number(settings.tax_percent) || 0,
      delivery: zone ? { charge: zone.charge, freeAbove: Math.round((Number(settings.delivery_free_above) || 0) * 100) } : null,
      // Counter only (staff): a discount set by hand instead of the automatic offer.
      discountOverride: counter ? readDiscountOverride(body.discountOverride) : null,
    });
    // Why home delivery can't go ahead yet (shown at checkout; refused when placing the order).
    bill.deliveryProblem = '';
    if (zone) {
      const minDelivery = Math.round((Number(settings.delivery_min_order) || 0) * 100);
      if (zone.problem) bill.deliveryProblem = zone.problem;
      else if (minDelivery && bill.subtotal < minDelivery) {
        bill.deliveryProblem = `Home delivery is for orders of ₹${minDelivery / 100} or more. Add ₹${(minDelivery - bill.subtotal) / 100} more, or choose pickup at store.`;
      }
      bill.deliveryNeedsLocation = !!zone.needLocation;
      bill.deliveryKm = zone.km ?? null;
      bill.deliveryLat = zone.lat ?? null;
      bill.deliveryLng = zone.lng ?? null;
    }
    // Counter only: an agreed final amount; the difference is shown on the bill as an adjustment.
    const finalTotal = counter ? paiseOrNull(body.finalTotal, 'Final amount') : null;
    bill.adjustment = 0;
    if (finalTotal !== null && bill.lines.length) {
      bill.adjustment = finalTotal - bill.total;
      bill.total = finalTotal;
    }
    bill.listSubtotal = bill.lines.reduce((s, l) => s + l.listPrice * l.qty, 0);
    return bill;
  };

  const orderOut = async (order, settings, withLines = true) => {
    const out = {
      id: order.id, token: order.token, billNo: order.bill_no,
      customerName: order.customer_name, customerPhone: order.customer_phone,
      subtotal: order.subtotal, discount: order.discount, discountLabel: order.discount_label,
      tax: order.tax, taxPercent: order.tax_percent, roundOff: order.round_off, total: order.total,
      status: order.status, createdAt: order.created_at, paidAt: order.paid_at,
      fulfilment: order.fulfilment || 'pickup', deliveryAddress: order.delivery_address || '',
      deliveryLandmark: order.delivery_landmark || '', deliveryPincode: order.delivery_pincode || '',
      deliveryCharge: order.delivery_charge || 0,
      payPref: order.pay_pref || 'upi', paidBy: order.paid_by || '', channel: order.channel || 'online',
      adjustment: order.adjustment || 0,
      deliveryLat: order.delivery_lat ?? null, deliveryLng: order.delivery_lng ?? null, deliveryKm: order.delivery_km ?? null,
    };
    if (withLines) {
      out.lines = (await db.all('SELECT item_id AS itemId, name, unit, price, qty, total, list_price FROM order_items WHERE order_id = ? ORDER BY id', [order.id]))
        .map(({ list_price: lp, ...l }) => ({ ...l, listPrice: lp || l.price }));
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
      items: items.map((r) => ({ ...r, stock: sellable(r, settings, req.query.at === 'store' ? 'store' : 'online') })).map(itemOut)
        .map(({ lowStock, active, sortOrder, updatedAt, storeStock, totalStock, mrp, ...rest }) => rest),
      offers,
    });
  });

  app.post('/api/quote', async (req, res) => {
    res.json(await quote(req.body || {}, await getSettings(db)));
  });

  /**
   * Creates a bill and takes the stock, all in one transaction.
   * channel 'online': online stock first, then store stock (if the setting allows).
   * channel 'store' / 'counter': the boxes leave the shop shelf, so store stock first, then online.
   */
  async function createOrder(body, settings, channel, { paidBy = null } = {}) {
    const counter = channel === 'counter';
    if (!counter && body.fulfilment === 'delivery' && settings.delivery_enabled !== '1') throw bad('Home delivery is not available right now. Please choose pickup.');
    const delivery = !counter && wantsDelivery(body, settings);
    const payPref = paidBy || (body.payment === 'cash' && (counter || settings.cash_enabled === '1') ? 'cash' : 'upi');
    const name = str(body.customerName, 80);
    const phone = str(body.customerPhone, 20);
    const address = str(body.deliveryAddress, 500);
    const landmark = str(body.deliveryLandmark, 120);
    const pincode = str(body.deliveryPincode, 10);
    if (delivery) {
      if (!name) throw bad('Please enter your name for delivery');
      if (!/^(\+?91|0)?[6-9]\d{9}$/.test(phone.replace(/[\s-]/g, ''))) throw bad('Please enter a valid 10-digit mobile number for delivery');
      if (address.length < 10) throw bad('Please enter your full delivery address');
      if (pincode && !/^\d{6}$/.test(pincode)) throw bad('Pincode should be 6 digits');
    }

    return db.tx(async (t) => {
      const bill = await quote({ ...body, fulfilment: delivery ? 'delivery' : 'pickup' }, settings, t, channel);
      if (bill.errors.length) throw bad('Some items need attention', { errors: bill.errors });
      if (!bill.lines.length) throw bad(counter ? 'Add at least one item' : 'Your cart is empty');
      const minOrder = Number(settings.min_order) || 0;
      if (!counter && bill.subtotal < minOrder * 100) throw bad(`Minimum order is ₹${minOrder}`);
      if (delivery && bill.deliveryProblem) throw bad(bill.deliveryProblem);

      const token = crypto.randomBytes(12).toString('hex');
      const info = await t.run(`INSERT INTO orders
        (token, bill_no, customer_name, customer_phone, subtotal, discount, discount_label, tax, tax_percent, round_off, total,
         fulfilment, delivery_address, delivery_landmark, delivery_pincode, delivery_charge, pay_pref, channel,
         status, paid_by, adjustment, delivery_lat, delivery_lng, delivery_km, paid_at)
        VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${paidBy ? "datetime('now')" : 'NULL'})`, [
        token, name, phone,
        bill.subtotal, bill.discount, bill.discountLabel, bill.tax, bill.taxPercent, bill.roundOff, bill.total,
        delivery ? 'delivery' : 'pickup', delivery ? address : '', delivery ? landmark : '', delivery ? pincode : '', bill.deliveryCharge, payPref, channel,
        paidBy ? 'paid' : 'pending', paidBy || '', bill.adjustment || 0,
        delivery ? bill.deliveryLat ?? null : null, delivery ? bill.deliveryLng ?? null : null, delivery ? bill.deliveryKm ?? null : null,
      ]);
      const id = info.lastInsertRowid;
      const billNo = `${settings.bill_prefix || ''}${String(id).padStart(5, '0')}`;
      await t.run('UPDATE orders SET bill_no = ? WHERE id = ?', [billNo, id]);

      const storeFirst = channel !== 'online';
      for (const l of bill.lines) {
        const row = await t.get('SELECT stock, store_stock FROM items WHERE id = ?', [l.itemId]);
        let fromOnline;
        let fromStore;
        if (storeFirst) {
          fromStore = Math.min(l.qty, Math.max(0, row.store_stock));
          fromOnline = l.qty - fromStore;
        } else {
          fromOnline = Math.min(l.qty, Math.max(0, row.stock));
          fromStore = l.qty - fromOnline;
          if (fromStore > 0 && !sharesStore(settings)) throw bad(`${l.name} just went out of stock`);
        }
        const taken = await t.run('UPDATE items SET stock = stock - ?, store_stock = store_stock - ? WHERE id = ? AND stock >= ? AND store_stock >= ?',
          [fromOnline, fromStore, l.itemId, fromOnline, fromStore]);
        if (taken.changes !== 1) throw bad(`${l.name} just went out of stock`);
        await t.run('INSERT INTO order_items (order_id, item_id, name, unit, price, qty, total, from_online, from_store, list_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, l.itemId, l.name, l.unit, l.price, l.qty, l.total, fromOnline, fromStore, l.listPrice !== l.price ? l.listPrice : 0]);
      }
      return { id, token, billNo, total: bill.total };
    });
  }

  const siteBase = (req, settings) => (settings.site_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  app.post('/api/orders', async (req, res) => {
    const body = req.body || {};
    const settings = await getSettings(db);
    if (settings.shop_open !== '1') throw bad(settings.closed_message || 'Shop is closed');
    // Customers can only create 'online' or 'store' (in-store QR) bills; 'counter' is staff-only.
    const channel = body.channel === 'store' ? 'store' : 'online';
    const { id, token } = await createOrder(body, settings, channel);
    await notifyNewOrder(db, settings, id, siteBase(req, settings));
    res.status(201).json({ id, token });
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
    const order = await db.get('SELECT token, status, paid_by, total FROM orders WHERE id = ?', [Number(req.params.id)]);
    if (!order || order.token !== req.query.t) throw new HttpError(404, 'Bill not found');
    res.set('Cache-Control', 'no-store');
    res.json({ status: order.status, paidBy: order.paid_by || '', total: order.total });
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
  // A daily snapshot is taken the first time the admin panel is used each day.
  admin.get('/dashboard', async (req, res, next) => { await backups.ensureDaily(db).catch((e) => console.error('daily backup failed', e)); next(); });
  const snapshotBefore = (label) => async (req, res, next) => { await backups.snapshot(db, label(req)); next(); };
  app.use('/api/admin', admin);

  /* ----- change the discount on an unpaid bill ----- */
  // body: { type: 'percent' | 'flat', value } (flat in paise), or { type: 'auto' } to go back to what the bill had from offers.
  admin.patch('/orders/:id/discount', async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    await db.tx(async (t) => {
      const o = await t.get('SELECT * FROM orders WHERE id = ?', [id]);
      if (!o) throw new HttpError(404, 'Bill not found');
      if (o.status !== 'pending') throw bad(o.status === 'paid' ? 'This bill is already paid. Mark it unpaid first to change the discount.' : 'This bill is cancelled.');
      let discount = 0;
      let label = '';
      if (b.type === 'none') { discount = 0; label = ''; } else {
        const special = specialDiscount(readDiscountOverride(b), o.subtotal);
        if (!special) throw bad('Enter the discount');
        discount = special.amount; label = special.label;
      }
      const { tax, roundOff, total } = totalsFor({ subtotal: o.subtotal, discount, taxPercent: o.tax_percent, deliveryCharge: o.delivery_charge || 0 });
      // An earlier 'agreed final amount' no longer applies once the discount is changed.
      await t.run('UPDATE orders SET discount = ?, discount_label = ?, tax = ?, round_off = ?, total = ?, adjustment = 0 WHERE id = ?',
        [discount, label, tax, roundOff, total, id]);
    });
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
    res.json(await orderOut(o, await getSettings(db)));
  });

  /* ----- order alerts ----- */
  // New customer orders (not counter bills) after a given bill id; used by the admin panel's live alerts.
  admin.get('/orders/new', async (req, res) => {
    // No 'after' = just tell me the latest id (first check when the page opens).
    const hasAfter = req.query.after !== undefined && req.query.after !== '';
    const rows = hasAfter
      ? await db.all("SELECT * FROM orders WHERE id > ? AND channel != 'counter' ORDER BY id LIMIT 20", [Number(req.query.after) || 0])
      : [];
    const last = await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM orders');
    res.json({ lastId: last.id, orders: await Promise.all(rows.map((o) => orderOut(o, null, false))) });
  });
  // Finds the chat ID after the owner has sent any message to their bot.
  admin.post('/telegram/find-chat', async (req, res) => {
    const s = await getSettings(db);
    const token = (req.body && req.body.token && !String(req.body.token).startsWith(SECRET_MASK) ? String(req.body.token) : s.telegram_bot_token || '').trim();
    if (!token) throw bad('Paste the bot token first');
    let updates;
    try { updates = await telegram(token, 'getUpdates', { limit: 20 }); } catch (e) { throw bad(e.message); }
    const chats = [];
    for (const u of updates || []) {
      const c = (u.message || u.channel_post || {}).chat;
      if (c && !chats.some((x) => x.id === c.id)) chats.push({ id: String(c.id), name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' });
    }
    if (!chats.length) throw bad('No messages yet. Open your bot in Telegram, press Start (or send "hi"), then try again.');
    res.json({ chats });
  });
  admin.post('/telegram/test', async (req, res) => {
    const s = await getSettings(db);
    if (!s.telegram_bot_token || !s.telegram_chat_id) throw bad('Save the bot token and chat ID first');
    try {
      await telegram(s.telegram_bot_token, 'sendMessage', { chat_id: s.telegram_chat_id, text: `✅ ${s.shop_name}: order alerts are working. You'll get a message here for every new order.` });
    } catch (e) { throw bad(e.message); }
    res.json({ ok: true });
  });

  /* ----- counter billing (store staff) ----- */
  admin.post('/counter/quote', async (req, res) => {
    res.json(await quote(req.body || {}, await getSettings(db), db, 'counter'));
  });
  // paidBy: 'cash' | 'upi' marks it paid now; omit to leave it pending (e.g. customer is scanning the UPI QR).
  admin.post('/counter/bills', async (req, res) => {
    const body = req.body || {};
    const paidBy = ['cash', 'upi'].includes(body.paidBy) ? body.paidBy : null;
    const out = await createOrder(body, await getSettings(db), 'counter', { paidBy });
    res.status(201).json(out);
  });

  /* ----- dashboard ----- */
  admin.get('/dashboard', async (req, res) => {
    const today = `date(created_at, ${LOCAL}) = date('now', ${LOCAL})`;
    const [todayRow, paidToday, pending, allTime, lowStock, topItems, stockValue] = await Promise.all([
      db.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales,
        COALESCE(SUM(CASE WHEN channel = 'online' THEN total END),0) AS online,
        COALESCE(SUM(CASE WHEN channel != 'online' THEN total END),0) AS shop
        FROM orders WHERE status != 'cancelled' AND ${today}`),
      db.get(`SELECT COALESCE(SUM(total),0) AS v, COALESCE(SUM(CASE WHEN paid_by = 'cash' THEN total END),0) AS cash,
        COALESCE(SUM(CASE WHEN paid_by != 'cash' THEN total END),0) AS upi FROM orders WHERE status = 'paid' AND ${today}`),
      db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM orders WHERE status = 'pending'`),
      db.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales FROM orders WHERE status = 'paid'`),
      db.all(`SELECT * FROM items WHERE active = 1 AND stock + ${(await getSettings(db)).online_sells_store_stock === '1' ? 'store_stock' : 0} <= low_stock ORDER BY stock, name`),
      db.all(`SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.total) AS amount
        FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled'
        GROUP BY oi.name ORDER BY qty DESC LIMIT 5`),
      db.get(`SELECT COALESCE(SUM((stock + store_stock) * price),0) AS v, COALESCE(SUM(stock + store_stock),0) AS units,
        COALESCE(SUM(stock),0) AS online, COALESCE(SUM(store_stock),0) AS store FROM items`),
    ]);
    res.json({ today: { ...todayRow, paid: paidToday.v, paidCash: paidToday.cash, paidUpi: paidToday.upi }, pending, allTime, lowStock: lowStock.map(itemOut), topItems, stockValue });
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
  admin.delete('/categories/:id', snapshotBefore((r) => `Before deleting category #${r.params.id}`), async (req, res) => {
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

  admin.delete('/items/:id', snapshotBefore((r) => `Before deleting item #${r.params.id}`), async (req, res) => {
    await db.run('DELETE FROM items WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  // Change every rate (optionally in one category) by a percentage, e.g. +10 or -5.
  admin.post('/items/bulk-price', snapshotBefore(() => 'Before bulk rate change'), async (req, res) => {
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
  admin.delete('/discounts/:id', snapshotBefore((r) => `Before deleting offer #${r.params.id}`), async (req, res) => {
    await db.run('DELETE FROM discounts WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  /* ----- orders ----- */
  admin.get('/orders', async (req, res) => {
    const where = [];
    const args = [];
    if (['pending', 'paid', 'cancelled'].includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
    if (['online', 'store', 'counter'].includes(req.query.channel)) { where.push('channel = ?'); args.push(req.query.channel); }
    if (req.query.channel === 'shop') where.push("channel != 'online'");
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
      o.fulfilment, o.delivery_address, o.delivery_landmark, o.delivery_pincode, o.delivery_charge, o.pay_pref, o.paid_by, o.channel, o.adjustment, o.delivery_km, o.delivery_lat, o.delivery_lng,
      oi.name, oi.qty, oi.price, oi.list_price, oi.total, o.discount, o.tax, o.total AS bill_total
      FROM orders o JOIN order_items oi ON oi.order_id = o.id ORDER BY o.id DESC, oi.id`);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rupees = (p) => (p / 100).toFixed(2);
    const lines = [['Bill', 'Date', 'Sold', 'Status', 'Paid by', 'Customer', 'Phone', 'Pickup/Delivery', 'Delivery address', 'Landmark', 'Pincode', 'Distance km', 'Map pin', 'Item', 'Qty', 'Rate', 'List rate', 'Line total',
      'Bill discount', 'Bill tax', 'Delivery charge', 'Bill adjustment', 'Bill total'].map(esc).join(',')];
    for (const r of rows) {
      lines.push([r.bill_no, r.created, { online: 'Online', store: 'In store (self)', counter: 'Counter' }[r.channel] || 'Online', r.status, r.status === 'paid' ? (r.paid_by === 'cash' ? 'Cash' : 'UPI') : `(chose ${r.pay_pref === 'cash' ? 'cash' : 'UPI'})`, r.customer_name, r.customer_phone, r.fulfilment === 'delivery' ? 'Delivery' : 'Pickup',
        r.delivery_address, r.delivery_landmark, r.delivery_pincode, r.delivery_km ?? '', r.delivery_lat != null ? `${r.delivery_lat},${r.delivery_lng}` : '', r.name, r.qty, rupees(r.price), rupees(r.list_price || r.price), rupees(r.total),
        rupees(r.discount), rupees(r.tax), rupees(r.delivery_charge || 0), rupees(r.adjustment || 0), rupees(r.bill_total)].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send('﻿' + lines.join('\n'));
  });

  admin.patch('/orders/:id', async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body.status;
    if (!['pending', 'paid', 'cancelled'].includes(status)) throw bad('Unknown status');
    const paidBy = ['upi', 'cash'].includes(req.body.paidBy) ? req.body.paidBy : null;
    await db.tx(async (t) => {
      const order = await t.get('SELECT * FROM orders WHERE id = ?', [id]);
      if (!order) throw new HttpError(404, 'Order not found');
      if (order.status === status && !(status === 'paid' && paidBy && paidBy !== order.paid_by)) return;
      if (order.status === status) { await t.run('UPDATE orders SET paid_by = ? WHERE id = ?', [paidBy, id]); return; }
      const lines = await t.all('SELECT item_id, qty, from_online, from_store FROM order_items WHERE order_id = ?', [id]);
      // Put stock back where it came from (older bills without that record count as online).
      const adjust = (sign, l) => {
        const tracked = l.from_online + l.from_store === l.qty;
        const online = tracked ? l.from_online : l.qty;
        const store = tracked ? l.from_store : 0;
        return t.run('UPDATE items SET stock = MAX(0, stock + ?), store_stock = MAX(0, store_stock + ?) WHERE id = ?', [sign * online, sign * store, l.item_id]);
      };
      // Cancelling returns stock to the shelf; un-cancelling takes it back.
      if (status === 'cancelled') for (const l of lines) await adjust(1, l);
      if (order.status === 'cancelled') for (const l of lines) await adjust(-1, l);
      await t.run(`UPDATE orders SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE NULL END,
        paid_by = CASE WHEN ? = 'paid' THEN ? ELSE '' END WHERE id = ?`, [status, status, status, paidBy || order.pay_pref || 'upi', id]);
    });
    res.json({ ok: true });
  });

  /* ----- data safety: which database, counts, backup ----- */
  admin.get('/db-info', async (req, res) => {
    let where = 'Local file on this server';
    if (!dbUrl.startsWith('file:')) {
      try { where = new URL(dbUrl.replace(/^libsql:/, 'https:')).host; } catch { where = 'Hosted database'; }
    }
    // Databases named "dpl-..." are created per deployment by the Vercel integration and get replaced on the next deploy.
    const perDeployment = /^dpl-/i.test(where);
    const c = await db.get(`SELECT (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM categories) AS categories,
      (SELECT COUNT(*) FROM discounts) AS offers, (SELECT COUNT(*) FROM orders) AS bills, (SELECT COUNT(*) FROM images) AS photos,
      (SELECT COUNT(*) FROM backups) AS snapshots, (SELECT MAX(created_at) FROM backups) AS lastSnapshot`);
    res.json({ where, source: dbSource, perDeployment, counts: c });
  });

  // Full download of the shop's data (everything except login secrets).
  admin.get('/backup.json', async (req, res) => {
    const backup = await backups.collect(db, { images: true });
    const stamp = new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shop-backup-${stamp}.json"`);
    res.send(JSON.stringify(backup));
  });

  // Automatic snapshots: list, take one now, download one.
  admin.get('/backups', async (req, res) => {
    res.json(await db.all('SELECT id, created_at AS createdAt, reason, summary, LENGTH(data) AS size FROM backups ORDER BY id DESC'));
  });
  admin.post('/backups', async (req, res) => {
    const id = await backups.snapshot(db, 'Manual');
    res.status(201).json({ id });
  });
  admin.get('/backups/:id.json', async (req, res) => {
    const row = await db.get('SELECT created_at, data FROM backups WHERE id = ?', [Number(req.params.id)]);
    if (!row) throw new HttpError(404, 'Backup not found');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shop-snapshot-${req.params.id}.json"`);
    res.send(row.data);
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
    const out = Object.fromEntries(EDITABLE_SETTING_KEYS.map((k) => [k, s[k] ?? '']));
    if (out.telegram_bot_token) out.telegram_bot_token = SECRET_MASK + out.telegram_bot_token.slice(-4);
    res.json(out);
  });
  admin.put('/settings', async (req, res) => {
    const b = req.body || {};
    if (typeof b.telegram_bot_token === 'string' && b.telegram_bot_token.startsWith(SECRET_MASK)) delete b.telegram_bot_token; // unchanged
    if (b.whatsapp && !/^\+?[\d\s-]{10,16}$/.test(String(b.whatsapp).trim())) throw bad('WhatsApp number looks wrong (10-digit mobile)');
    if (b.telegram_chat_id && !/^-?\d{3,20}$/.test(String(b.telegram_chat_id).trim())) throw bad('Telegram chat ID should be a number');
    if (b.tax_percent !== undefined && !(Number(b.tax_percent) >= 0 && Number(b.tax_percent) <= 100)) throw bad('Tax must be 0–100');
    if (b.min_order !== undefined && !(Number(b.min_order) >= 0)) throw bad('Minimum order must be 0 or more');
    if (b.delivery_charge !== undefined && !(Number(b.delivery_charge) >= 0)) throw bad('Delivery charge must be 0 or more');
    if (b.delivery_free_above !== undefined && !(Number(b.delivery_free_above) >= 0)) throw bad('Free delivery amount must be 0 or more');
    if (b.delivery_min_order !== undefined && !(Number(b.delivery_min_order) >= 0)) throw bad('Minimum order for delivery must be 0 or more');
    for (const [k, max] of [['shop_lat', 90], ['shop_lng', 180]]) {
      if (b[k] !== undefined && b[k] !== '' && coord(b[k], max) === null) throw bad('Shop location looks wrong. Paste it like 18.5204, 73.8567');
    }
    if (b.delivery_slabs !== undefined) {
      // Accept a JSON list (or array) of { km, charge }; store a clean, sorted copy.
      let slabs;
      try { slabs = typeof b.delivery_slabs === 'string' ? JSON.parse(b.delivery_slabs || '[]') : b.delivery_slabs; } catch { throw bad('Distance charges could not be read'); }
      if (!Array.isArray(slabs)) throw bad('Distance charges could not be read');
      slabs = slabs.map((x) => ({ km: Number(x.km), charge: Number(x.charge) }));
      if (slabs.some((x) => !(x.km > 0 && x.km <= 100))) throw bad('Each distance must be between 0 and 100 km');
      if (slabs.some((x) => !(x.charge >= 0))) throw bad('Each charge must be 0 or more');
      slabs.sort((x, y) => x.km - y.km);
      if (slabs.some((x, i) => i && x.km === slabs[i - 1].km)) throw bad('The same distance is listed twice');
      b.delivery_slabs = JSON.stringify(slabs);
    }
    if (b.upi_id && !/^[\w.\-]{2,}@[a-zA-Z][\w.\-]*$/.test(String(b.upi_id).trim())) throw bad('UPI ID looks wrong (expected something like name@bank)');
    const stmts = EDITABLE_SETTING_KEYS.filter((k) => b[k] !== undefined).map((k) => ({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [k, ['shop_open', 'delivery_enabled', 'online_sells_store_stock', 'cash_enabled'].includes(k) ? String(bool(b[k])) : str(b[k], 1000)],
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
    const storeUrl = `${url}?at=store`;
    res.json({
      url, qr: await QRCode.toDataURL(url, { margin: 1, width: 600, errorCorrectionLevel: 'M' }),
      storeUrl, storeQr: await QRCode.toDataURL(storeUrl, { margin: 1, width: 600, errorCorrectionLevel: 'M' }),
    });
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
