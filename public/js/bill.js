(() => {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const t = params.get('t') || '';
  let order = null;
  let pollTimer = null;

  function fmtDate(sqlUtc) {
    const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
    return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }

  /**
   * One button per UPI app, so the payment doesn't open whichever app the phone uses by default (often WhatsApp).
   * Android: an intent link names the exact app. iPhone: each app's own link scheme.
   */
  function upiAppButtons(uri) {
    const qs = uri.split('?')[1] || '';
    const android = /Android/i.test(navigator.userAgent);
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!android && !ios) return '';
    const apps = [
      { name: 'Google Pay', pkg: 'com.google.android.apps.nbu.paisa.user', ios: `gpay://upi/pay?${qs}` },
      { name: 'PhonePe', pkg: 'com.phonepe.app', ios: `phonepe://pay?${qs}` },
      { name: 'Paytm', pkg: 'net.one97.paytm', ios: `paytmmp://pay?${qs}` },
    ];
    const link = (a) => (android ? `intent://pay?${qs}#Intent;scheme=upi;package=${a.pkg};end` : a.ios);
    return `<div class="upi-apps no-print">
      ${apps.map((a) => `<a class="btn upi-app" href="${esc(link(a))}">${esc(a.name)}</a>`).join('')}
      <a class="btn upi-app" href="${esc(uri)}">Other UPI app</a>
    </div>`;
  }

  function upiBlock(o, { compact = false } = {}) {
    const apps = upiAppButtons(o.upiUri);
    return `${compact ? '' : `<div class="muted small">Scan this QR with any UPI app</div><div class="amount num">${money(o.total)}</div>`}
      <img class="qr" src="${o.upiQr}" alt="UPI payment QR code">
      <div class="small muted">UPI ID: <b>${esc(o.shop.upi_id)}</b>
        <button type="button" class="btn btn-sm btn-ghost no-print" id="copyUpi" style="min-height:30px;padding:0 10px">Copy</button></div>
      ${apps ? `<div class="small muted no-print" style="margin-top:14px">Or tap your app to pay ${money(o.total)}:</div>${apps}` : ''}`;
  }

  function payBlock(o) {
    if (o.status === 'paid') {
      const via = o.paidBy === 'cash' ? ' in cash' : o.paidBy === 'upi' ? ' by UPI' : '';
      return `<div class="pay"><span class="paid-stamp"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>PAID</span><p class="muted small" style="margin-bottom:0">Thank you for your payment${via}!</p></div>`;
    }
    if (o.status === 'cancelled') return '<div class="pay"><span class="badge danger">This bill was cancelled</span></div>';
    const where = o.fulfilment === 'delivery' ? 'when your order is delivered' : 'at the counter';
    const after = '<p class="small muted no-print" style="margin-top:12px">This bill turns to <b>PAID</b> once the shop confirms your payment.</p>';
    if (o.payPref === 'cash' || !o.upiQr) {
      return `<div class="pay">
        <div class="pay-cash">💵</div>
        <div class="muted small">Pay in cash ${where}</div>
        <div class="amount num">${money(o.total)}</div>
        ${o.upiQr ? `<details class="pay-alt no-print"><summary>Prefer to pay by UPI?</summary>${upiBlock(o, { compact: true })}</details>` : ''}
        ${after}
      </div>`;
    }
    return `<div class="pay">
      ${upiBlock(o)}
      ${o.shop.cash_enabled === '1' ? `<p class="small muted" style="margin-top:12px">Prefer cash? Pay ${money(o.total)} ${where}.</p>` : ''}
      ${after}
    </div>`;
  }

  function render(o) {
    const s = o.shop;
    const rows = [`<tr><td>Items total</td><td>${money(o.subtotal)}</td></tr>`];
    if (o.discount) rows.push(`<tr class="disc"><td>${esc(o.discountLabel)}</td><td>−${money(o.discount)}</td></tr>`);
    if (o.tax) rows.push(`<tr><td>Tax (${o.taxPercent}%)</td><td>${money(o.tax)}</td></tr>`);
    if (o.fulfilment === 'delivery') rows.push(`<tr><td>Delivery</td><td>${o.deliveryCharge ? money(o.deliveryCharge) : 'Free'}</td></tr>`);
    if (o.roundOff) rows.push(`<tr><td class="muted">Round off</td><td class="muted">${o.roundOff > 0 ? '+' : '−'}${money(Math.abs(o.roundOff))}</td></tr>`);
    if (o.adjustment) rows.push(`<tr class="${o.adjustment < 0 ? 'disc' : ''}"><td>Price adjustment</td><td>${o.adjustment < 0 ? '−' : '+'}${money(Math.abs(o.adjustment))}</td></tr>`);
    rows.push(`<tr class="grand"><td>Total</td><td>${money(o.total)}</td></tr>`);

    $('#bill').innerHTML = `
      <div class="bill-head">
        <h2>${esc(s.shop_name)}</h2>
        ${s.address ? `<div class="small muted">${esc(s.address)}</div>` : ''}
        ${s.phone ? `<div class="small muted">Ph: ${esc(s.phone)}</div>` : ''}
        ${s.gstin ? `<div class="small muted">GSTIN: ${esc(s.gstin)}</div>` : ''}
      </div>
      <div class="bill-meta">
        <div><div class="muted">Bill no.</div><b>${esc(o.billNo)}</b></div>
        <div style="text-align:right"><div class="muted">Date</div><b>${esc(fmtDate(o.createdAt))}</b></div>
        ${o.fulfilment !== 'delivery' && (o.customerName || o.customerPhone) ? `<div style="flex-basis:100%"><span class="muted">Customer:</span> ${esc(o.customerName)} ${esc(o.customerPhone)}</div>` : ''}
      </div>
      ${o.fulfilment === 'delivery' ? `<div class="deliver-box"><b>🚚 Home delivery</b>${esc(o.customerName)}${o.customerPhone ? ` · ${esc(o.customerPhone)}` : ''}<br>
        ${esc(o.deliveryAddress)}${o.deliveryKm != null ? ` <span class="muted">(about ${o.deliveryKm} km)</span>` : ''}${o.deliveryLandmark ? `<br><span class="muted">Landmark:</span> ${esc(o.deliveryLandmark)}` : ''}${o.deliveryPincode ? `<br><span class="muted">Pincode:</span> ${esc(o.deliveryPincode)}` : ''}</div>`
        : o.channel === 'counter' ? '<div class="deliver-box"><b>🧾 Bought at the shop counter</b></div>'
        : o.channel === 'store' ? '<div class="deliver-box"><b>🏪 Bought in the shop</b></div>'
        : (o.shop.delivery_enabled === '1' ? '<div class="deliver-box"><b>🏪 Pickup at store</b></div>' : '')}
      <table class="items">
        <thead><tr><th>Item</th><th class="r">Rate</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead>
        <tbody>${o.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${l.listPrice && l.listPrice !== l.price ? `<s class="muted small">${money(l.listPrice)}</s> ` : ''}${money(l.price)}</td><td class="r">${l.qty}</td><td class="r">${money(l.total)}</td></tr>`).join('')}</tbody>
      </table>
      <div class="totals-wrap"><table class="totals">${rows.join('')}</table></div>
      ${payBlock(o)}
      ${s.bill_footer ? `<div class="bill-foot">${esc(s.bill_footer)}</div>` : ''}`;

    const actions = ['<button class="btn" id="printBtn">Print / Save PDF</button>'];
    if (navigator.share) actions.unshift('<button class="btn" id="shareBtn">Share bill</button>');
    actions.push('<a class="btn btn-ghost" href="/">Shop again</a>');
    $('#actions').innerHTML = actions.join('');
    $('#printBtn').onclick = () => window.print();
    const cp = $('#copyUpi');
    if (cp) cp.onclick = () => navigator.clipboard.writeText(o.shop.upi_id).then(() => toast('UPI ID copied'), () => toast(o.shop.upi_id));
    const sb = $('#shareBtn');
    if (sb) sb.onclick = () => navigator.share({ title: `${s.shop_name} bill ${o.billNo}`, text: `Bill ${o.billNo}: ${money(o.total)}`, url: location.href }).catch(() => {});
    document.title = `Bill ${o.billNo}`;
  }

  async function load() {
    if (!id) { $('#bill').innerHTML = '<div class="empty">No bill selected.</div>'; return; }
    try {
      order = await api(`/api/orders/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`);
    } catch (e) {
      $('#bill').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    safeSet('cc_last_bill', { id, t, billNo: order.billNo });
    render(order);
    if (order.status === 'pending') startPolling();
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const { status, paidBy } = await api(`/api/orders/${encodeURIComponent(id)}/status?t=${encodeURIComponent(t)}`);
        if (status !== order.status) {
          order.status = status; order.paidBy = paidBy;
          render(order);
          if (status !== 'pending') clearInterval(pollTimer);
          if (status === 'paid' && navigator.vibrate) navigator.vibrate([30, 60, 30]);
        }
      } catch { /* keep trying */ }
    }, 5000);
  }

  load();
})();
