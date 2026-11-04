'use strict';
/**
 * Pure bill calculation. All money is integer paise.
 *
 * Rules (kept deliberately simple for customers to understand):
 *  - Only ONE discount applies per bill: the one that saves the customer the most.
 *  - Automatic offers (no code) apply on their own; coupon offers apply only when the code is entered.
 *  - A discount can target the whole cart or a single category.
 *  - Tax (if configured) is charged on the amount after discount; total is rounded to the nearest rupee.
 */

function isLive(d, now) {
  if (!d.active) return false;
  const t = now.getTime();
  if (d.starts_at && new Date(d.starts_at).getTime() > t) return false;
  if (d.ends_at && new Date(d.ends_at).getTime() < t) return false;
  return true;
}

function discountAmount(d, lines, subtotal) {
  const base = d.category_id == null
    ? subtotal
    : lines.filter((l) => l.category_id === d.category_id).reduce((s, l) => s + l.total, 0);
  if (base <= 0) return 0;
  let amt = d.type === 'percent' ? Math.round((base * d.value) / 100) : Math.min(d.value, base);
  if (d.max_discount != null && d.max_discount > 0) amt = Math.min(amt, d.max_discount);
  return Math.max(0, amt);
}

function describeDiscount(d, categoryName) {
  const what = d.type === 'percent' ? `${d.value}% off` : `₹${(d.value / 100).toFixed(0)} off`;
  const on = d.category_id != null && categoryName ? ` on ${categoryName}` : '';
  return `${d.name} (${what}${on})`;
}

/**
 * @param {object} p
 * @param {Array<{itemId:number, qty:number}>} p.cart
 * @param {Map<number, object>} p.items        item rows by id
 * @param {Array<object>} p.discounts          discount rows
 * @param {Map<number,string>} [p.categoryNames]
 * @param {number} [p.taxPercent]
 * @param {string} [p.coupon]
 * @param {Date} [p.now]
 */
/**
 * A discount the shop sets by hand (counter or editing an unpaid bill): replaces the automatic offer.
 * override: { type: 'percent' | 'flat', value } (flat in paise). Returns { amount, label } or null.
 */
function specialDiscount(override, subtotal) {
  if (!override) return null;
  const v = Number(override.value);
  if (!Number.isFinite(v) || v < 0) return null;
  if (override.type === 'percent') {
    const pct = Math.min(100, v);
    return { amount: Math.round((subtotal * pct) / 100), label: `Special discount (${+pct.toFixed(2)}%)` };
  }
  return { amount: Math.min(Math.round(v), subtotal), label: 'Special discount' };
}

/** Tax, rounding and total for a given items total, discount and delivery charge (all paise). */
function totalsFor({ subtotal, discount, taxPercent = 0, deliveryCharge = 0 }) {
  const taxable = subtotal - discount;
  const tax = Math.round((taxable * (Number(taxPercent) || 0)) / 100);
  const raw = taxable + tax + deliveryCharge;
  const total = Math.round(raw / 100) * 100;
  return { tax, roundOff: total - raw, total };
}

function computeBill({ cart, items, discounts, categoryNames = new Map(), taxPercent = 0, coupon = '', now = new Date(), delivery = null, discountOverride = null }) {
  const errors = [];
  const lines = [];
  const merged = new Map();
  for (const c of Array.isArray(cart) ? cart : []) {
    const id = Number(c.itemId);
    const qty = Math.floor(Number(c.qty));
    if (!Number.isInteger(id) || !(qty > 0)) continue;
    merged.set(id, (merged.get(id) || 0) + qty);
  }

  for (const [id, qty] of merged) {
    const item = items.get(id);
    if (!item || !item.active) {
      errors.push({ itemId: id, message: 'This item is no longer available' });
      continue;
    }
    if (qty > item.stock) {
      errors.push({
        itemId: id,
        available: item.stock,
        message: item.stock > 0 ? `Only ${item.stock} left of ${item.name}` : `${item.name} is sold out`,
      });
    }
    lines.push({
      itemId: id,
      name: item.name,
      unit: item.unit,
      image: item.image,
      category_id: item.category_id,
      price: item.price,
      listPrice: item.list_price ?? item.price, // differs only when staff agreed a different rate at the counter
      qty,
      total: item.price * qty,
    });
  }

  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const code = String(coupon || '').trim().toUpperCase();
  const live = discounts.filter((d) => isLive(d, now));

  const couponMatches = code ? live.filter((d) => d.code && d.code.trim().toUpperCase() === code) : [];
  const candidates = live.filter((d) => !d.code).concat(couponMatches);

  let best = null;
  let couponBest = 0;
  for (const d of candidates) {
    if (subtotal < d.min_order) continue;
    const amount = discountAmount(d, lines, subtotal);
    if (d.code) couponBest = Math.max(couponBest, amount);
    if (amount > 0 && (!best || amount > best.amount)) best = { d, amount };
  }

  let couponStatus = null;
  if (code) {
    if (!couponMatches.length) couponStatus = 'invalid';
    else if (!couponMatches.some((d) => subtotal >= d.min_order)) couponStatus = 'min_order';
    else if (couponBest <= 0) couponStatus = 'not_applicable';
    else couponStatus = best && best.d.code ? 'applied' : 'better_offer_applied';
  }

  // Nudge: the cheapest-to-unlock automatic offer that would beat the current one.
  let nextOffer = null;
  for (const d of live) {
    if (d.code || subtotal >= d.min_order) continue;
    const gap = d.min_order - subtotal;
    if (!nextOffer || gap < nextOffer.addMore) {
      nextOffer = { addMore: gap, label: describeDiscount(d, categoryNames.get(d.category_id)) };
    }
  }

  const special = specialDiscount(discountOverride, subtotal);
  const offerAmount = best ? best.amount : 0;
  const discount = special ? special.amount : offerAmount;
  // Home delivery: flat charge, free once the items total reaches freeAbove (if set).
  const freeAbove = delivery && delivery.freeAbove > 0 ? delivery.freeAbove : 0;
  const deliveryCharge = delivery ? (freeAbove && subtotal >= freeAbove ? 0 : Math.max(0, delivery.charge || 0)) : 0;
  const { tax, roundOff, total } = totalsFor({ subtotal, discount, taxPercent, deliveryCharge });

  return {
    lines,
    errors,
    subtotal,
    discount,
    discountLabel: special ? special.label : best ? describeDiscount(best.d, categoryNames.get(best.d.category_id)) : '',
    discountId: special ? null : best ? best.d.id : null,
    special: !!special,
    // What the automatic offer would have given (so staff can see it while setting their own).
    autoDiscount: offerAmount,
    autoDiscountLabel: best ? describeDiscount(best.d, categoryNames.get(best.d.category_id)) : '',
    couponStatus,
    taxPercent: Number(taxPercent) || 0,
    tax,
    delivery: !!delivery,
    deliveryCharge,
    freeDeliveryAddMore: delivery && freeAbove && deliveryCharge > 0 ? freeAbove - subtotal : 0,
    roundOff,
    total,
    nextOffer,
  };
}

module.exports = { computeBill, isLive, describeDiscount, specialDiscount, totalsFor };
