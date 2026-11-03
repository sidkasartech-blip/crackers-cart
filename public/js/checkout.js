(() => {
  let catalog = null;
  let byId = new Map();
  let lastQuote = null;
  let coupon = safeGet(COUPON_KEY, '') || '';
  const CUSTOMER_KEY = 'cc_customer_v1'; // remembers name/phone/address on this phone for next time
  let fulfilment = 'pickup';
  let payment = 'upi';
  const deliveryOn = () => catalog && catalog.settings.delivery_enabled === '1' && !AT_STORE;

  const COUPON_MSG = {
    applied: ['ok', 'Coupon applied!'],
    better_offer_applied: ['ok', 'A better offer is already applied for you.'],
    invalid: ['danger', 'This code is not valid right now.'],
    min_order: ['danger', 'Add more items to use this code.'],
    not_applicable: ['danger', 'This code does not apply to items in your cart.'],
  };

  async function init() {
    try {
      catalog = await api(catalogUrl());
    } catch {
      $('#lines').innerHTML = '<div class="empty">Could not load. Please check your connection and refresh.</div>';
      $('#checkout').classList.remove('hidden');
      return;
    }
    byId = new Map(catalog.items.map((i) => [i.id, i]));
    if (catalog.settings.shop_open !== '1') {
      $('#closed').textContent = catalog.settings.closed_message;
      $('#closed').classList.remove('hidden');
      $('#placeBtn').disabled = true;
    }
    $('#coupon').value = coupon;
    setupFulfilment();
    refresh();
  }

  function setupFulfilment() {
    const saved = safeGet(CUSTOMER_KEY, {}) || {};
    $('#custName').value = saved.name || '';
    $('#custPhone').value = saved.phone || '';
    $('#delAddress').value = saved.address || '';
    $('#delLandmark').value = saved.landmark || '';
    $('#delPincode').value = saved.pincode || '';
    if (catalog.settings.cash_enabled === '1') {
      $('#payWrap').classList.remove('hidden');
      if (saved.payment === 'cash') { payment = 'cash'; $('input[name=pay][value=cash]').checked = true; }
      applyPaymentUi();
    }
    if (!deliveryOn() || AT_STORE) return;
    const s = catalog.settings;
    const charge = Math.round((Number(s.delivery_charge) || 0) * 100);
    const freeAbove = Math.round((Number(s.delivery_free_above) || 0) * 100);
    $('#deliveryPrice').textContent = !charge ? 'Free delivery'
      : freeAbove ? `${money(charge)} · free above ${money(freeAbove)}` : `${money(charge)} delivery charge`;
    $('#deliveryNote').textContent = s.delivery_note || '';
    $('#fulfilWrap').classList.remove('hidden');
    if (saved.fulfilment === 'delivery') {
      fulfilment = 'delivery';
      $('input[name=fulfil][value=delivery]').checked = true;
    }
    applyFulfilmentUi();
  }

  function applyPaymentUi() {
    $('#cashLabel').textContent = fulfilment === 'delivery' ? 'Cash on delivery' : 'Pay at the counter';
    $('#payHint').textContent = payment === 'cash'
      ? (fulfilment === 'delivery' ? 'Pay in cash when your order is delivered' : 'Pay in cash at the counter')
      : 'Pay securely with any UPI app on the next screen';
  }
  $$('input[name=pay]').forEach((r) => r.addEventListener('change', () => {
    payment = $('input[name=pay]:checked').value;
    applyPaymentUi();
  }));

  function applyFulfilmentUi() {
    applyPaymentUi();
    const d = fulfilment === 'delivery';
    $('#addressFields').classList.toggle('hidden', !d);
    $$('#checkout .req').forEach((el) => el.classList.toggle('hidden', !d));
    $('#detailsTitle').innerHTML = d ? 'Delivery details' : 'Your details <span class="opt">(optional)</span>';
  }

  $$('input[name=fulfil]').forEach((r) => r.addEventListener('change', () => {
    fulfilment = $('input[name=fulfil]:checked').value;
    applyFulfilmentUi();
    refresh();
  }));

  /** Returns an error message, or '' when the delivery details look complete. */
  function deliveryProblem() {
    if (fulfilment !== 'delivery') return '';
    const phone = $('#custPhone').value.replace(/[\s-]/g, '');
    if (!$('#custName').value.trim()) return 'Please enter your name for delivery.';
    if (!/^(\+?91|0)?[6-9]\d{9}$/.test(phone)) return 'Please enter a valid 10-digit mobile number.';
    if ($('#delAddress').value.trim().length < 10) return 'Please enter your full delivery address.';
    const pin = $('#delPincode').value.trim();
    if (pin && !/^\d{6}$/.test(pin)) return 'Pincode should be 6 digits.';
    return '';
  }

  async function refresh() {
    const lines = Cart.lines();
    if (!lines.length) {
      $('#empty').classList.remove('hidden');
      $('#checkout').classList.add('hidden');
      return;
    }
    $('#empty').classList.add('hidden');
    $('#checkout').classList.remove('hidden');
    try {
      lastQuote = await api('/api/quote', { method: 'POST', body: { items: lines, coupon, fulfilment, channel: AT_STORE ? 'store' : 'online' } });
    } catch (e) {
      toast(e.message, true);
      return;
    }
    render(lastQuote);
  }

  function render(q) {
    const errs = new Map(q.errors.map((e) => [e.itemId, e]));
    // Items that vanished from the catalog still need a row so the customer can remove them.
    const missing = q.errors.filter((e) => !q.lines.some((l) => l.itemId === e.itemId));
    $('#lines').innerHTML = q.lines.map((l) => {
      const it = byId.get(l.itemId) || {};
      const err = errs.get(l.itemId);
      const max = Math.max(it.stock ?? l.qty, l.qty);
      return `<div class="line">
        <div class="thumb">${thumbHtml(l)}</div>
        <div class="meta">
          <div class="name">${esc(l.name)}</div>
          <div class="muted small num">${money(l.price)} / ${esc(l.unit)}</div>
          ${err ? `<div class="err">${esc(err.message)}</div>` : ''}
        </div>
        <div class="right">
          <b class="num">${money(l.total)}</b>
          ${stepperHtml(l.itemId, l.qty, max)}
        </div>
      </div>`;
    }).join('') + missing.map((e) => `<div class="line">
        <div class="thumb"><div class="ph">?</div></div>
        <div class="meta"><div class="err">${esc(e.message)}</div></div>
        <div class="right"><button class="btn btn-sm btn-danger" data-remove="${e.itemId}">Remove</button></div>
      </div>`).join('');

    const rows = [`<tr><td>Items total</td><td>${money(q.subtotal)}</td></tr>`];
    if (q.discount) rows.push(`<tr class="disc"><td>${esc(q.discountLabel)}</td><td>−${money(q.discount)}</td></tr>`);
    if (q.tax) rows.push(`<tr><td>Tax (${q.taxPercent}%)</td><td>${money(q.tax)}</td></tr>`);
    if (q.delivery) rows.push(`<tr><td>Delivery</td><td>${q.deliveryCharge ? money(q.deliveryCharge) : '<span style="color:var(--ok)">Free</span>'}</td></tr>`);
    if (q.roundOff) rows.push(`<tr><td class="muted">Round off</td><td class="muted">${q.roundOff > 0 ? '+' : '−'}${money(Math.abs(q.roundOff))}</td></tr>`);
    rows.push(`<tr class="grand"><td>To pay</td><td>${money(q.total)}</td></tr>`);
    $('#totals').innerHTML = rows.join('');

    $('#nudge').textContent = [
      q.nextOffer && `Add ${money(q.nextOffer.addMore)} more to get ${q.nextOffer.label}`,
      q.freeDeliveryAddMore > 0 && `Add ${money(q.freeDeliveryAddMore)} more for free delivery`,
    ].filter(Boolean).join(' · ');

    const msg = $('#couponMsg');
    const m = q.couponStatus && COUPON_MSG[q.couponStatus];
    msg.textContent = m ? m[1] : '';
    msg.style.color = m ? `var(--${m[0]})` : '';

    const minOrder = Number(catalog.settings.min_order) * 100 || 0;
    const err = q.errors.length ? 'Please fix the highlighted items.'
      : q.subtotal < minOrder ? `Minimum order is ${money(minOrder)}.` : '';
    $('#formErr').textContent = err;
    $('#formErr').classList.toggle('hidden', !err);
    $('#placeBtn').disabled = !!err || catalog.settings.shop_open !== '1';
    $('#placeBtn').textContent = `Generate bill · ${money(q.total)}`;
  }

  bindSteppers($('#lines'), (id, qty) => { Cart.setQty(id, qty); refresh(); });
  $('#lines').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { Cart.setQty(Number(rm.dataset.remove), 0); refresh(); }
  });

  function applyCoupon() {
    coupon = $('#coupon').value.trim().toUpperCase();
    $('#coupon').value = coupon;
    safeSet(COUPON_KEY, coupon);
    refresh();
  }
  $('#applyCoupon').addEventListener('click', applyCoupon);
  $('#coupon').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); } });

  $('#placeBtn').addEventListener('click', async () => {
    const problem = deliveryProblem();
    if (problem) {
      toast(problem, true);
      const empty = [$('#custName'), $('#custPhone'), $('#delAddress')].find((el) => !el.value.trim()) || $('#custPhone');
      empty.focus();
      return;
    }
    const btn = $('#placeBtn');
    btn.disabled = true;
    btn.textContent = 'Generating bill…';
    const details = {
      customerName: $('#custName').value.trim(), customerPhone: $('#custPhone').value.trim(),
      deliveryAddress: $('#delAddress').value.trim(), deliveryLandmark: $('#delLandmark').value.trim(), deliveryPincode: $('#delPincode').value.trim(),
    };
    try {
      const res = await api('/api/orders', { method: 'POST', body: { items: Cart.lines(), coupon, fulfilment, payment, channel: AT_STORE ? 'store' : 'online', ...details } });
      safeSet(CUSTOMER_KEY, { name: details.customerName, phone: details.customerPhone, address: details.deliveryAddress,
        landmark: details.deliveryLandmark, pincode: details.deliveryPincode, fulfilment, payment });
      Cart.clear();
      location.replace(`/bill?id=${res.id}&t=${res.token}`);
    } catch (e) {
      toast(e.message, true);
      // Stock may have changed under us; re-quote so the customer sees what to fix.
      catalog = await api(catalogUrl()).catch(() => catalog);
      byId = new Map(catalog.items.map((i) => [i.id, i]));
      refresh();
    }
  });

  init();
})();
