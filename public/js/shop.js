(() => {
  let data = { items: [], categories: [], offers: [], settings: {} };
  let activeCat = 'all';
  let query = '';
  let byId = new Map();

  async function load() {
    try {
      data = await api('/api/catalog');
    } catch (e) {
      $('#grid').innerHTML = '<div class="empty">Could not load the catalog. <button class="btn btn-sm" onclick="location.reload()">Retry</button></div>';
      return;
    }
    byId = new Map(data.items.map((i) => [i.id, i]));
    pruneCart();
    const s = data.settings;
    document.title = s.shop_name || 'Shop';
    $('#shopName').textContent = s.shop_name || 'Crackers';
    $('#tagline').textContent = s.tagline || '';
    if (s.shop_open !== '1') { $('#closed').textContent = s.closed_message; $('#closed').classList.remove('hidden'); }
    const last = safeGet('cc_last_bill', null);
    if (last && last.id) {
      const lb = $('#lastBill');
      lb.href = `/bill?id=${encodeURIComponent(last.id)}&t=${encodeURIComponent(last.t)}`;
      lb.textContent = `View your last bill ${last.billNo || ''} →`;
      lb.classList.remove('hidden');
    }
    renderOffers();
    renderChips();
    render();
    updateBar();
  }

  // Drop cart entries for items that disappeared, and clamp to current stock.
  function pruneCart() {
    const c = Cart.get();
    let changed = false;
    for (const [id, q] of Object.entries(c)) {
      const it = byId.get(Number(id));
      if (!it || it.stock <= 0) { delete c[id]; changed = true; } else if (q > it.stock) { c[id] = it.stock; changed = true; }
    }
    if (changed) Cart.set(c);
  }

  function offerText(o) {
    const what = o.type === 'percent' ? `${o.value}% OFF` : `${money(o.value)} OFF`;
    const cat = o.categoryId ? data.categories.find((c) => c.id === o.categoryId) : null;
    const on = cat ? ` on ${cat.name}` : '';
    const min = o.minOrder > 0 ? ` above ${money(o.minOrder)}` : '';
    return `🎉 ${what}${on}${min}`;
  }
  function renderOffers() {
    $('#offers').innerHTML = data.offers.map((o) => `<div class="offer">${esc(offerText(o))}</div>`).join('');
  }

  function renderChips() {
    const cats = [{ id: 'all', name: 'All' }, ...data.categories.filter((c) => data.items.some((i) => i.categoryId === c.id))];
    $('#chips').innerHTML = cats.map((c) => `<button class="chip" data-cat="${c.id}" aria-pressed="${String(c.id) === String(activeCat)}">${esc(c.name)}</button>`).join('');
  }

  function cardHtml(it) {
    const q = Cart.qty(it.id);
    const sold = it.stock <= 0;
    const off = it.mrp && it.mrp > it.price ? Math.round((1 - it.price / it.mrp) * 100) : 0;
    let tag = '';
    if (sold) tag = '<span class="badge danger stock-tag">Sold out</span>';
    else if (it.stock <= 5) tag = `<span class="badge warn stock-tag">Only ${it.stock} left</span>`;
    const action = sold
      ? '<button class="add-btn" disabled>Sold out</button>'
      : q > 0 ? stepperHtml(it.id, q, it.stock) : `<button class="add-btn" data-add="${it.id}">Add</button>`;
    return `<article class="card product ${sold ? 'soldout' : ''}" data-id="${it.id}">
      <div class="thumb">${thumbHtml(it)}${tag}</div>
      <div class="info">
        <div class="name">${esc(it.name)}</div>
        ${it.description ? `<div class="desc">${esc(it.description)}</div>` : ''}
        <div class="price"><b class="num">${money(it.price)}</b><span class="muted small">/ ${esc(it.unit)}</span>
          ${off ? `<s class="num">${money(it.mrp)}</s><span class="off">${off}% off</span>` : ''}</div>
        <div class="actions">${action}</div>
      </div>
    </article>`;
  }

  function visibleItems() {
    const q = query.toLowerCase();
    return data.items.filter((i) =>
      (activeCat === 'all' || String(i.categoryId) === String(activeCat)) &&
      (!q || i.name.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q)));
  }

  function render() {
    const items = visibleItems();
    if (!items.length) {
      $('#grid').innerHTML = `<div class="empty">${data.items.length ? 'Nothing matches your search.' : 'No items yet. Please check back soon.'}</div>`;
      return;
    }
    // In-stock first; otherwise keep the admin's order.
    items.sort((a, b) => (b.stock > 0) - (a.stock > 0));
    $('#grid').innerHTML = items.map(cardHtml).join('');
  }

  function rerenderCard(id) {
    const el = $(`.product[data-id="${id}"]`);
    if (el) el.outerHTML = cardHtml(byId.get(id));
  }

  let quoteTimer;
  function updateBar() {
    const lines = Cart.lines().filter((l) => byId.has(l.itemId));
    const count = lines.reduce((s, l) => s + l.qty, 0);
    const subtotal = lines.reduce((s, l) => s + byId.get(l.itemId).price * l.qty, 0);
    $('#cartCount').textContent = count;
    $('#barCount').textContent = count;
    $('#barTotal').textContent = money(subtotal);
    $('#cartbar').classList.toggle('show', count > 0);
    // Ask the server for the offer nudge ("add ₹X more to get 10% off").
    clearTimeout(quoteTimer);
    if (!count) { $('#barNudge').textContent = ''; return; }
    quoteTimer = setTimeout(async () => {
      try {
        const qd = await api('/api/quote', { method: 'POST', body: { items: lines } });
        const parts = [];
        if (qd.discount > 0) parts.push(`You save ${money(qd.discount)}!`);
        if (qd.nextOffer) parts.push(`Add ${money(qd.nextOffer.addMore)} more for ${qd.nextOffer.label}`);
        $('#barNudge').textContent = parts.join(' · ');
      } catch { /* offline: ignore */ }
    }, 250);
  }

  function setQty(id, q) {
    Cart.setQty(id, q);
    rerenderCard(id);
    updateBar();
  }

  $('#grid').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (!add) return;
    setQty(Number(add.dataset.add), 1);
    if (navigator.vibrate) navigator.vibrate(10);
  });
  bindSteppers($('#grid'), setQty);

  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    activeCat = chip.dataset.cat;
    $$('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    render();
  });
  $('#q').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });

  // Coming back from checkout via the back button should show the latest cart.
  window.addEventListener('pageshow', (e) => { if (e.persisted) load(); });

  load();
})();
