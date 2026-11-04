/* Shared helpers for every page. */
const CART_KEY = 'cc_cart_v1';
/** "In the shop" mode, from the in-store QR (?at=store). Remembered for this browser tab session. */
const AT_STORE = (() => {
  try {
    const p = new URLSearchParams(location.search).get('at');
    if (p === 'store') sessionStorage.setItem('cc_at', 'store');
    if (p === 'online') sessionStorage.removeItem('cc_at');
    return sessionStorage.getItem('cc_at') === 'store';
  } catch { return new URLSearchParams(location.search).get('at') === 'store'; }
})();
const catalogUrl = () => (AT_STORE ? '/api/catalog?at=store' : '/api/catalog');
const COUPON_KEY = 'cc_coupon_v1';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** paise -> "₹1,234" (decimals only when needed) */
function money(paise) {
  const r = (paise || 0) / 100;
  return '₹' + r.toLocaleString('en-IN', { minimumFractionDigits: r % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function safeGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/** Cart is a plain { [itemId]: qty } map kept in localStorage. */
const Cart = {
  get() { return safeGet(CART_KEY, {}); },
  set(c) { safeSet(CART_KEY, c); },
  qty(id) { return this.get()[id] || 0; },
  setQty(id, qty) {
    const c = this.get();
    if (qty > 0) c[id] = qty; else delete c[id];
    this.set(c);
    return c;
  },
  clear() { this.set({}); safeSet(COUPON_KEY, ''); },
  lines() { return Object.entries(this.get()).map(([itemId, qty]) => ({ itemId: Number(itemId), qty })); },
  count() { return Object.values(this.get()).reduce((s, q) => s + q, 0); },
};

/** WhatsApp / call links for the shop (Indian numbers: adds 91 when a 10-digit number is given). */
function shopContact(s, message = '') {
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const intl = (d) => (d.length === 10 ? `91${d}` : d.replace(/^0+/, ''));
  const phone = digits(s.phone);
  const wa = digits(s.whatsapp) || phone;
  return {
    call: phone ? `tel:+${intl(phone)}` : '',
    whatsapp: wa ? `https://wa.me/${intl(wa)}${message ? `?text=${encodeURIComponent(message)}` : ''}` : '',
    phoneText: s.phone || '',
  };
}
function contactButtons(s, message, { label = 'Questions? Contact the shop' } = {}) {
  const c = shopContact(s, message);
  if (!c.call && !c.whatsapp) return '';
  return `<div class="contact-box no-print">
    <div class="small muted">${esc(label)}</div>
    <div class="contact-btns">
      ${c.whatsapp ? `<a class="btn wa" href="${esc(c.whatsapp)}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
      ${c.call ? `<a class="btn" href="${esc(c.call)}">📞 Call ${esc(c.phoneText)}</a>` : ''}
    </div>
  </div>`;
}

function thumbHtml(item) {
  if (item.image) return `<img src="${esc(item.image)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'🎆'}))">`;
  const initials = String(item.name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<div class="ph">${esc(initials)}</div>`;
}

let toastTimer;
function toast(msg, isErr = false) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/** Small stepper: returns HTML; wire up with bindSteppers(root, onChange). */
function stepperHtml(id, qty, max) {
  return `<div class="stepper" data-id="${id}" data-max="${max}">
    <button type="button" data-d="-1" aria-label="Decrease">−</button>
    <input type="number" inputmode="numeric" min="0" max="${max}" value="${qty}" aria-label="Quantity">
    <button type="button" data-d="1" aria-label="Increase" ${qty >= max ? 'disabled' : ''}>+</button>
  </div>`;
}
function bindSteppers(root, onChange) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.stepper button');
    if (!b) return;
    const st = b.closest('.stepper');
    const input = $('input', st);
    const max = Number(st.dataset.max);
    const next = Math.max(0, Math.min(max, (Number(input.value) || 0) + Number(b.dataset.d)));
    if (Number(b.dataset.d) > 0 && next === Number(input.value)) toast(`Only ${max} in stock`);
    onChange(Number(st.dataset.id), next);
  });
  root.addEventListener('change', (e) => {
    const input = e.target.closest('.stepper input');
    if (!input) return;
    const st = input.closest('.stepper');
    const max = Number(st.dataset.max);
    let q = Math.max(0, Math.floor(Number(input.value) || 0));
    if (q > max) { q = max; toast(`Only ${max} in stock`); }
    onChange(Number(st.dataset.id), q);
  });
}

/* Keep sticky bars (search, admin tabs) snug under the header, whatever its height. */
(function trackTopbar() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const set = () => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(bar);
})();
