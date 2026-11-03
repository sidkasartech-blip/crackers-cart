'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBill } = require('../src/pricing');

const items = new Map([
  [1, { id: 1, name: 'Sparklers', unit: 'box', price: 10000, stock: 10, active: 1, category_id: 1 }],
  [2, { id: 2, name: 'Rocket', unit: 'box', price: 25000, stock: 2, active: 1, category_id: 2 }],
  [3, { id: 3, name: 'Hidden', unit: 'box', price: 5000, stock: 5, active: 0, category_id: 1 }],
]);
const d = (o) => ({ id: Math.random(), name: 'Offer', type: 'percent', value: 10, category_id: null, min_order: 0, max_discount: null, code: null, starts_at: null, ends_at: null, active: 1, ...o });

test('subtotal, merged lines and no discount', () => {
  const b = computeBill({ cart: [{ itemId: 1, qty: 2 }, { itemId: 1, qty: 1 }], items, discounts: [] });
  assert.equal(b.lines.length, 1);
  assert.equal(b.lines[0].qty, 3);
  assert.equal(b.subtotal, 30000);
  assert.equal(b.total, 30000);
  assert.deepEqual(b.errors, []);
});

test('flags out-of-stock and inactive items', () => {
  const b = computeBill({ cart: [{ itemId: 2, qty: 3 }, { itemId: 3, qty: 1 }, { itemId: 99, qty: 1 }], items, discounts: [] });
  assert.equal(b.errors.length, 3);
  assert.equal(b.errors.find((e) => e.itemId === 2).available, 2);
});

test('picks the single best automatic discount respecting min order', () => {
  const b = computeBill({
    cart: [{ itemId: 1, qty: 5 }], items,
    discounts: [d({ value: 5 }), d({ value: 20, min_order: 100000 }), d({ type: 'flat', value: 4000 })],
  });
  assert.equal(b.subtotal, 50000);
  assert.equal(b.discount, 4000);
  assert.equal(b.nextOffer.addMore, 50000);
});

test('coupon applies only with the code, case-insensitive', () => {
  const discounts = [d({ code: 'DIWALI', value: 15 })];
  assert.equal(computeBill({ cart: [{ itemId: 1, qty: 1 }], items, discounts }).discount, 0);
  const b = computeBill({ cart: [{ itemId: 1, qty: 1 }], items, discounts, coupon: ' diwali ' });
  assert.equal(b.discount, 1500);
  assert.equal(b.couponStatus, 'applied');
  assert.equal(computeBill({ cart: [{ itemId: 1, qty: 1 }], items, discounts, coupon: 'NOPE' }).couponStatus, 'invalid');
});

test('coupon min order and better automatic offer are reported', () => {
  const discounts = [d({ code: 'BIG', value: 5, min_order: 100000 })];
  assert.equal(computeBill({ cart: [{ itemId: 1, qty: 1 }], items, discounts, coupon: 'BIG' }).couponStatus, 'min_order');
  const b = computeBill({ cart: [{ itemId: 1, qty: 1 }], items, discounts: [d({ code: 'SMALL', value: 5 }), d({ value: 10 })], coupon: 'SMALL' });
  assert.equal(b.couponStatus, 'better_offer_applied');
  assert.equal(b.discount, 1000);
});

test('category discount, cap, and date window', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const cart = [{ itemId: 1, qty: 2 }, { itemId: 2, qty: 2 }];
  assert.equal(computeBill({ cart, items, now, discounts: [d({ category_id: 2, value: 10 })] }).discount, 5000);
  assert.equal(computeBill({ cart, items, now, discounts: [d({ value: 50, max_discount: 3000 })] }).discount, 3000);
  assert.equal(computeBill({ cart, items, now, discounts: [d({ ends_at: '2026-10-31T00:00:00Z' })] }).discount, 0);
  assert.equal(computeBill({ cart, items, now, discounts: [d({ starts_at: '2026-11-02T00:00:00Z' })] }).discount, 0);
  assert.equal(computeBill({ cart, items, now, discounts: [d({ active: 0 })] }).discount, 0);
});

test('tax on discounted amount and rounding to the rupee', () => {
  const b = computeBill({ cart: [{ itemId: 1, qty: 1 }], items, discounts: [d({ type: 'flat', value: 1050 })], taxPercent: 18 });
  // 100.00 - 10.50 = 89.50; tax 16.11; raw 105.61 -> 106
  assert.equal(b.tax, 1611);
  assert.equal(b.total, 10600);
  assert.equal(b.roundOff, 39);
});

test('delivery charge is added, and free above the threshold', () => {
  const cart = [{ itemId: 1, qty: 2 }]; // ₹200
  const base = computeBill({ cart, items, discounts: [] });
  assert.equal(base.deliveryCharge, 0);
  assert.equal(base.delivery, false);
  const paid = computeBill({ cart, items, discounts: [], delivery: { charge: 5000, freeAbove: 50000 } });
  assert.equal(paid.deliveryCharge, 5000);
  assert.equal(paid.total, 25000);
  assert.equal(paid.freeDeliveryAddMore, 30000);
  const free = computeBill({ cart: [{ itemId: 1, qty: 5 }], items, discounts: [], delivery: { charge: 5000, freeAbove: 50000 } });
  assert.equal(free.deliveryCharge, 0);
  assert.equal(free.total, 50000);
});
