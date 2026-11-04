'use strict';
/**
 * New-order alerts to the shop owner's phone via a Telegram bot (free, instant, works with the app closed).
 * Setup: Settings → Order alerts. Never throws: a failed alert must not affect the customer's order.
 */

const API = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

async function telegram(token, method, body) {
  const res = await fetch(`${API()}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const why = data.description || `HTTP ${res.status}`;
    throw new Error(/unauthorized/i.test(why) ? 'The bot token is wrong' : /chat not found/i.test(why) ? 'Chat not found: send a message to your bot first' : why);
  }
  return data.result;
}

const h = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const rs = (p) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function orderMessage(o, lines, baseUrl) {
  const where = o.channel === 'store' ? '🏪 In the shop (in-store QR)'
    : o.fulfilment === 'delivery' ? `🚚 Home delivery${o.delivery_km != null ? ` · about ${o.delivery_km} km` : ''}${o.delivery_charge ? ` · delivery ${rs(o.delivery_charge)}` : ''}`
      : '🏪 Pickup at store';
  const out = [
    `🛒 <b>New order ${h(o.bill_no)}</b> · <b>${rs(o.total)}</b>`,
    where,
    `💳 ${o.pay_pref === 'cash' ? 'Will pay cash' : 'Will pay by UPI'}`,
  ];
  if (o.customer_name || o.customer_phone) out.push(`👤 ${h(o.customer_name)}${o.customer_phone ? ` · ${h(o.customer_phone)}` : ''}`);
  if (o.fulfilment === 'delivery') {
    out.push(`📍 ${h(o.delivery_address)}${o.delivery_landmark ? `, near ${h(o.delivery_landmark)}` : ''}${o.delivery_pincode ? ` · ${h(o.delivery_pincode)}` : ''}`);
    if (o.delivery_lat != null) out.push(`🧭 https://www.google.com/maps/dir/?api=1&destination=${o.delivery_lat},${o.delivery_lng}`);
  }
  out.push('');
  for (const l of lines) out.push(`• ${h(l.name)} × ${l.qty} = ${rs(l.total)}`);
  if (o.discount) out.push(`🎁 ${h(o.discount_label)}: −${rs(o.discount)}`);
  if (baseUrl) out.push('', `Open in admin: ${baseUrl}/admin#orders`);
  return out.join('\n');
}

/** Sends the new-order alert if Telegram is set up. Returns true/false; never throws. */
async function notifyNewOrder(db, settings, orderId, baseUrl) {
  const token = (settings.telegram_bot_token || '').trim();
  const chatId = (settings.telegram_chat_id || '').trim();
  if (!token || !chatId) return false;
  try {
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    const lines = await db.all('SELECT name, qty, total FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
    await telegram(token, 'sendMessage', { chat_id: chatId, text: orderMessage(o, lines, baseUrl), parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (err) {
    console.error('Order alert failed:', err.message);
    return false;
  }
}

module.exports = { telegram, notifyNewOrder, orderMessage };
