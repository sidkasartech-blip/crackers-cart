(() => {
  const state = { categories: [], items: [], discounts: [], orders: [], tab: 'dashboard' };

  /* ---------- helpers ---------- */
  const rupees = (p) => (p == null ? '' : String(p / 100));
  const fmtTime = (sqlUtc) => new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const channelBadge = (c) => ({ counter: '<span class="badge">🧾 Counter</span> ', store: '<span class="badge">🏪 In store</span> ' }[c] || '');
  const catName = (id) => (state.categories.find((c) => c.id === id) || {}).name || '—';
  const statusBadge = (s) => `<span class="badge ${{ paid: 'ok', pending: 'warn', cancelled: 'danger' }[s]}">${{ paid: 'Paid', pending: 'Pending', cancelled: 'Cancelled' }[s]}</span>`;
  function catOptions(sel, allLabel) {
    return (allLabel ? `<option value="">${esc(allLabel)}</option>` : '') +
      state.categories.map((c) => `<option value="${c.id}" ${String(c.id) === String(sel) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
  }
  function showErr(el, msg) { el.textContent = msg || ''; el.classList.toggle('hidden', !msg); }

  /** Handles a <form method="dialog">: runs save() on the Save button and only closes on success. */
  function bindDialogForm(form, save, errEl) {
    form.addEventListener('submit', async (e) => {
      if (e.submitter && e.submitter.value !== 'save') return;
      e.preventDefault();
      const btn = e.submitter;
      if (btn) btn.disabled = true;
      showErr(errEl, '');
      try {
        await save();
        form.closest('dialog').close();
      } catch (err) {
        if (errEl) showErr(errEl, err.message); else toast(err.message, true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  /* ---------- auth ---------- */
  async function boot() {
    const me = await api('/api/admin/me');
    if (!me.authed) {
      $('#loginView').classList.remove('hidden');
      $('#appView').classList.add('hidden');
      $('#logoutBtn').classList.add('hidden');
      return;
    }
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    $('#logoutBtn').classList.remove('hidden');
    $('#pwWarn').classList.toggle('hidden', !me.passwordIsDefault);
    await loadCategories();
    const s = await api('/api/admin/settings');
    $('#upiWarn').classList.toggle('hidden', !!s.upi_id);
    api('/api/admin/db-info').then((d) => $('#dbWarn').classList.toggle('hidden', !d.perDeployment)).catch(() => {});
    const initial = (location.hash || '').slice(1);
    showTab($(`[data-tab="${initial}"]`) ? initial : 'dashboard');
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr($('#loginErr'), '');
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('#loginPw').value } });
      $('#loginPw').value = '';
      boot();
    } catch (err) { showErr($('#loginErr'), err.message); }
  });
  $('#logoutBtn').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); boot(); });

  // Any 401 mid-session sends us back to the login screen.
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason && e.reason.status === 401) { e.preventDefault(); boot(); }
    else if (e.reason && e.reason.message) { e.preventDefault(); toast(e.reason.message, true); }
  });

  /* ---------- tabs ---------- */
  const loaders = {
    dashboard: loadDashboard, items: loadItems, orders: loadOrders, discounts: loadDiscounts,
    categories: loadCategoriesTab, settings: loadSettings, qr: loadQr, counter: loadCounter,
  };
  function showTab(tab) {
    state.tab = tab;
    $$('.admin-nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
    history.replaceState(null, '', `#${tab}`);
    loaders[tab]();
  }
  $('.admin-nav').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); showTab(g.dataset.goto); } });

  /* ---------- dashboard ---------- */
  async function loadDashboard() {
    const d = await api('/api/admin/dashboard');
    const stat = (cls, icon, label, value, sub = '') => `<div class="card stat ${cls}"><div class="ic">${icon}</div><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    $('#stats').innerHTML = [
      stat('s1', '📈', "Today's sales", money(d.today.sales), `${d.today.orders} bills · 🌐 ${money(d.today.online)} online · 🏪 ${money(d.today.shop)} shop<br>paid: 📱 ${money(d.today.paidUpi)} UPI · 💵 ${money(d.today.paidCash)} cash`),
      stat('s2', '⏳', 'Awaiting payment', money(d.pending.v), `${d.pending.n} bills`),
      stat('s3', '💰', 'Total collected', money(d.allTime.sales), `${d.allTime.orders} paid bills`),
      stat('s4', '📦', 'Total stock', `${d.stockValue.units}`, `${d.stockValue.online} online · ${d.stockValue.store} in store · worth ${money(d.stockValue.v)}`),
    ].join('');
    $('#lowStock').innerHTML = d.lowStock.length
      ? '<thead><tr><th>Item</th><th class="r">Online</th><th class="r">Store</th><th></th></tr></thead><tbody>' + d.lowStock.map((i) => `<tr>
          <td>${esc(i.name)}</td><td class="r"><span class="badge ${i.stock ? 'warn' : 'danger'}">${i.stock}</span></td>
          <td class="r num">${i.storeStock}</td>
          <td class="r"><button class="btn btn-sm" data-restock="${i.id}">+ Restock</button></td></tr>`).join('') + '</tbody>'
      : '<tbody><tr><td class="muted">All items are well stocked.</td></tr></tbody>';
    $('#topItems').innerHTML = d.topItems.length
      ? '<thead><tr><th>Item</th><th class="r">Sold</th><th class="r">Amount</th></tr></thead><tbody>' +
        d.topItems.map((t) => `<tr><td>${esc(t.name)}</td><td class="r">${t.qty}</td><td class="r">${money(t.amount)}</td></tr>`).join('') + '</tbody>'
      : '<tbody><tr><td class="muted">No sales yet.</td></tr></tbody>';
  }
  $('#lowStock').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-restock]');
    if (!b) return;
    const n = prompt('How many units to add to online stock?', '10');
    if (!n || !(Number(n) > 0)) return;
    await api(`/api/admin/items/${b.dataset.restock}`, { method: 'PATCH', body: { addStock: Math.floor(Number(n)) } });
    toast('Stock updated');
    loadDashboard();
  });

  /* ---------- categories ---------- */
  async function loadCategories() {
    state.categories = await api('/api/admin/categories');
  }
  async function loadCategoriesTab() {
    await loadCategories();
    $('#catRows').innerHTML = state.categories.length ? state.categories.map((c) => `<tr data-id="${c.id}">
        <td><input class="input inline" style="width:100%;min-width:140px" value="${esc(c.name)}" data-field="name"></td>
        <td><input class="input inline" type="number" value="${c.sortOrder}" data-field="sortOrder" style="width:80px"></td>
        <td class="r">${c.itemCount}</td>
        <td class="r"><button class="btn btn-sm btn-ghost btn-danger" data-del-cat="${c.id}">Delete</button></td>
      </tr>`).join('') : '<tr><td class="muted" colspan="4">No categories yet.</td></tr>';
  }
  $('#catForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/admin/categories', { method: 'POST', body: { name: $('#catName').value, sortOrder: $('#catOrder').value || 0 } });
    $('#catName').value = '';
    toast('Category added');
    loadCategoriesTab();
  });
  $('#catRows').addEventListener('change', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    await api(`/api/admin/categories/${tr.dataset.id}`, {
      method: 'PUT', body: { name: $('[data-field=name]', tr).value, sortOrder: $('[data-field=sortOrder]', tr).value || 0 },
    });
    toast('Saved');
    loadCategories();
  });
  $('#catRows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-cat]');
    if (!b || !confirm('Delete this category? Items in it stay, but become uncategorised. Offers tied to it are removed.')) return;
    await api(`/api/admin/categories/${b.dataset.delCat}`, { method: 'DELETE' });
    loadCategoriesTab();
  });

  /* ---------- items ---------- */
  async function loadItems() {
    [state.items] = await Promise.all([api('/api/admin/items'), loadCategories()]);
    const sel = $('#itemCatFilter');
    const keep = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' + catOptions(keep);
    renderItems();
  }
  function filteredItems() {
    const q = $('#itemSearch').value.trim().toLowerCase();
    const c = $('#itemCatFilter').value;
    return state.items.filter((i) => (!q || i.name.toLowerCase().includes(q)) && (!c || String(i.categoryId) === c));
  }
  function stockBadge(i) {
    return `<span class="badge ${i.stock === 0 ? 'danger' : i.stock <= i.lowStock ? 'warn' : 'ok'}">${i.stock}</span>`;
  }
  function renderInvStats() {
    const t = state.items.reduce((a, i) => ({ online: a.online + i.stock, store: a.store + i.storeStock, value: a.value + i.totalStock * i.price }), { online: 0, store: 0, value: 0 });
    const stat = (cls, icon, label, value, sub = '') => `<div class="card stat ${cls}"><div class="ic">${icon}</div><div class="label">${label}</div><div class="value num">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    $('#invStats').innerHTML = [
      stat('s1', '🌐', 'Online stock', t.online, 'sold online first'),
      stat('s2', '🏪', 'Store stock', t.store, 'at the offline shop'),
      stat('s3', '📦', 'Total stock', t.online + t.store, `${state.items.length} items`),
      stat('s4', '💰', 'Total value', money(t.value), 'at current rates'),
    ].join('');
  }
  function renderItems() {
    renderInvStats();
    const items = filteredItems();
    if (!items.length) {
      const empty = `<div class="empty">${state.items.length ? 'No items match.' : 'No items yet. Tap “Add item” to create your first one.'}</div>`;
      $('#itemRows').innerHTML = `<tr><td colspan="10">${empty}</td></tr>`;
      $('#itemCards').innerHTML = empty;
      return;
    }
    $('#itemRows').innerHTML = items.map((i) => `<tr data-id="${i.id}">
        <td><div class="mini-thumb thumb">${thumbHtml(i)}</div></td>
        <td><b>${esc(i.name)}</b><div class="small muted">${esc(catName(i.categoryId))} · per ${esc(i.unit)}</div></td>
        <td class="r"><input class="input inline num" type="number" min="0" step="0.01" value="${rupees(i.price)}" data-quick="price" aria-label="Rate"></td>
        <td class="r">${stockBadge(i)}</td>
        <td class="r num">${i.storeStock}</td>
        <td class="r num"><b>${i.totalStock}</b></td>
        <td><input class="input inline num" type="number" step="1" placeholder="±0" data-quick="addStock" aria-label="Change online stock"></td>
        <td><input class="input inline num" type="number" step="1" placeholder="±0" data-quick="addStoreStock" aria-label="Change store stock"></td>
        <td><input type="checkbox" ${i.active ? 'checked' : ''} data-quick="active" aria-label="Visible in shop" class="toggle"></td>
        <td class="r"><button class="btn btn-sm" data-edit="${i.id}">Edit</button></td>
      </tr>`).join('');
    $('#itemCards').innerHTML = items.map((i) => `<div class="card inv-card" data-id="${i.id}">
        <div class="mini-thumb thumb">${thumbHtml(i)}</div>
        <div>
          <div style="display:flex;gap:8px;align-items:start"><b style="flex:1">${esc(i.name)}</b>${i.active ? '' : '<span class="badge">Hidden</span>'}</div>
          <div class="small muted">${esc(catName(i.categoryId))} · ₹${rupees(i.price)} / ${esc(i.unit)}</div>
          <div class="stock-split">
            <span>Online ${stockBadge(i)}</span><span>Store <span class="badge">${i.storeStock}</span></span><span>Total <b class="num">${i.totalStock}</b></span>
          </div>
          <div class="quick">
            <label class="small">Online <input class="input num" type="number" step="1" placeholder="±0" data-quick="addStock" aria-label="Change online stock"></label>
            <label class="small">Store <input class="input num" type="number" step="1" placeholder="±0" data-quick="addStoreStock" aria-label="Change store stock"></label>
            <button class="btn btn-sm" data-edit="${i.id}">Edit</button>
          </div>
        </div>
      </div>`).join('');
  }
  $('#itemSearch').addEventListener('input', renderItems);
  $('#itemCatFilter').addEventListener('change', renderItems);

  // Inline quick edits (rate, add stock, visibility) save on change.
  $('[data-panel="items"]').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-quick]');
    if (!input) return;
    const id = input.closest('[data-id]').dataset.id;
    const field = input.dataset.quick;
    const value = field === 'active' ? input.checked : input.value;
    if ((field === 'addStock' || field === 'addStoreStock') && !Number(value)) return;
    try {
      const updated = await api(`/api/admin/items/${id}`, { method: 'PATCH', body: { [field]: value } });
      state.items = state.items.map((i) => (i.id === updated.id ? updated : i));
      toast({
        addStock: `Online stock now ${updated.stock} (total ${updated.totalStock})`,
        addStoreStock: `Store stock now ${updated.storeStock} (total ${updated.totalStock})`,
        price: `Rate set to ${money(updated.price)}`,
      }[field] || (updated.active ? 'Now visible in shop' : 'Hidden from shop'));
      renderItems();
    } catch (err) { toast(err.message, true); renderItems(); }
  });
  $('[data-panel="items"]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) openItem(state.items.find((i) => i.id === Number(b.dataset.edit)));
  });
  $('#addItemBtn').addEventListener('click', () => openItem(null));

  /* item dialog */
  let editing = null;
  let image = '';
  function setPreview(url) {
    image = url || '';
    $('#imgPreview').innerHTML = image ? `<img src="${esc(image)}" alt="">` : '<div class="ph">📷</div>';
    $('#imgClear').classList.toggle('hidden', !image);
  }
  function openItem(item) {
    editing = item;
    const f = $('#itemForm');
    f.reset();
    $('#itemDlgTitle').textContent = item ? 'Edit item' : 'Add item';
    f.categoryId.innerHTML = '<option value="">No category</option>' + catOptions(item ? item.categoryId : $('#itemCatFilter').value);
    if (item) {
      f.name.value = item.name; f.description.value = item.description; f.unit.value = item.unit;
      f.price.value = rupees(item.price); f.mrp.value = rupees(item.mrp);
      f.stock.value = item.stock; f.storeStock.value = item.storeStock;
      f.lowStock.value = item.lowStock; f.sortOrder.value = item.sortOrder; f.active.checked = item.active;
    }
    $('#moveQty').value = '';
    updateStockTotal();
    $('#imgUrl').value = item && item.image && !item.image.startsWith('/img/') ? item.image : '';
    setPreview(item ? item.image : '');
    $('#itemDelete').classList.toggle('hidden', !item);
    showErr($('#itemErr'), '');
    $('#itemDlg').showModal();
  }

  function updateStockTotal() {
    const f = $('#itemForm');
    const on = Math.max(0, Math.floor(Number(f.stock.value) || 0));
    const st = Math.max(0, Math.floor(Number(f.storeStock.value) || 0));
    $('#stockTotal').innerHTML = `Total stock: <b class="num">${on + st}</b> <span class="muted">(${on} online + ${st} in store)</span>`;
  }
  $('#itemForm').stock.addEventListener('input', updateStockTotal);
  $('#itemForm').storeStock.addEventListener('input', updateStockTotal);
  // Moving only shifts numbers between the two fields; the total stays the same. Saved with the form.
  $('#itemForm').addEventListener('click', (e) => {
    const b = e.target.closest('[data-move]');
    if (!b) return;
    const f = $('#itemForm');
    const n = Math.floor(Number($('#moveQty').value) || 0);
    if (n <= 0) { toast('Enter how many to move', true); $('#moveQty').focus(); return; }
    const on = Math.floor(Number(f.stock.value) || 0);
    const st = Math.floor(Number(f.storeStock.value) || 0);
    if (b.dataset.move === 'toStore') {
      if (n > on) { toast(`Only ${on} in online stock`, true); return; }
      f.stock.value = on - n; f.storeStock.value = st + n;
    } else {
      if (n > st) { toast(`Only ${st} in the store`, true); return; }
      f.stock.value = on + n; f.storeStock.value = st - n;
    }
    $('#moveQty').value = '';
    updateStockTotal();
    toast(`Moved ${n}. Press Save to keep it.`);
  });

  /** Shrinks a photo in the browser so uploads are fast even on mobile data. */
  function resizeImage(file, max = 640) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      img.src = url;
    });
  }
  async function onPick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#itemSave').disabled = true;
    $('#imgPreview').innerHTML = '<div class="ph small">Uploading…</div>';
    try {
      const dataUrl = await resizeImage(file);
      const { url } = await api('/api/admin/upload', { method: 'POST', body: { dataUrl } });
      $('#imgUrl').value = '';
      setPreview(url);
    } catch (err) {
      setPreview(image);
      toast(err.message, true);
    } finally {
      $('#itemSave').disabled = false;
    }
  }
  $('#imgCamera').addEventListener('change', onPick);
  $('#imgFile').addEventListener('change', onPick);
  $('#imgUrl').addEventListener('change', (e) => setPreview(e.target.value.trim()));
  $('#imgClear').addEventListener('click', () => { $('#imgUrl').value = ''; setPreview(''); });

  bindDialogForm($('#itemForm'), async () => {
    const body = { ...formData($('#itemForm')), image };
    // Send what the stock was when the form opened, so the server applies only our change
    // and doesn't wipe out online orders that happened meanwhile.
    if (editing) Object.assign(body, { stockWas: editing.stock, storeStockWas: editing.storeStock });
    if (editing) await api(`/api/admin/items/${editing.id}`, { method: 'PUT', body });
    else await api('/api/admin/items', { method: 'POST', body });
    toast(editing ? 'Item updated' : 'Item added');
    loadItems();
  }, $('#itemErr'));
  $('#itemDelete').addEventListener('click', async () => {
    if (!editing || !confirm(`Delete “${editing.name}”? Past bills keep their copy. To just stop selling it, untick “Show in shop” instead.`)) return;
    await api(`/api/admin/items/${editing.id}`, { method: 'DELETE' });
    $('#itemDlg').close();
    toast('Item deleted');
    loadItems();
  });

  /* bulk price */
  $('#bulkPriceBtn').addEventListener('click', () => {
    const f = $('#bulkForm');
    f.reset();
    f.categoryId.innerHTML = catOptions('', 'All items');
    $('#bulkDlg').showModal();
  });
  bindDialogForm($('#bulkForm'), async () => {
    const b = formData($('#bulkForm'));
    const where = b.categoryId ? catName(Number(b.categoryId)) : 'all items';
    if (!confirm(`Change rates of ${where} by ${b.percent}%?`)) throw new Error('Cancelled');
    const r = await api('/api/admin/items/bulk-price', { method: 'POST', body: b });
    toast(`Updated ${r.updated} rates`);
    loadItems();
  });

  /* ---------- orders ---------- */
  async function loadOrders() {
    const qs = new URLSearchParams({ status: $('#orderStatus').value, channel: $('#orderChannel').value, date: $('#orderDate').value, q: $('#orderSearch').value.trim() });
    state.orders = await api(`/api/admin/orders?${qs}`);
    $('#orderRows').innerHTML = state.orders.length ? state.orders.map((o) => `<tr data-id="${o.id}">
        <td><b>${esc(o.billNo)}</b></td>
        <td class="small">${esc(fmtTime(o.createdAt))}</td>
        <td>${channelBadge(o.channel)}${o.fulfilment === 'delivery' ? '<span class="badge brand">🚚 Delivery</span> ' : ''}${esc(o.customerName || '—')}<div class="small muted">${esc(o.customerPhone)}</div></td>
        <td class="r num"><b>${money(o.total)}</b></td>
        <td>${statusBadge(o.status)}<div class="small muted">${o.status === 'paid' ? (o.paidBy === 'cash' ? '💵 Cash' : '📱 UPI') : (o.payPref === 'cash' ? 'chose 💵 cash' : 'chose 📱 UPI')}</div></td>
        <td class="r" style="white-space:nowrap">
          ${o.status === 'pending' ? `<button class="btn btn-sm btn-primary" data-status="paid" data-by="upi">UPI ✓</button> <button class="btn btn-sm" data-status="paid" data-by="cash">Cash ✓</button>` : ''}
          <button class="btn btn-sm" data-view="${o.id}">View</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="6"><div class="empty">No bills here.</div></td></tr>';
  }
  let orderSearchTimer;
  $('#orderSearch').addEventListener('input', () => { clearTimeout(orderSearchTimer); orderSearchTimer = setTimeout(loadOrders, 250); });
  $('#orderStatus').addEventListener('change', loadOrders);
  $('#orderChannel').addEventListener('change', loadOrders);
  $('#orderDate').addEventListener('change', loadOrders);

  async function setOrderStatus(id, status, paidBy) {
    if (status === 'cancelled' && !confirm('Cancel this bill? Its items go back into stock.')) return false;
    await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: { status, paidBy } });
    toast(status === 'paid' ? `Marked as paid by ${paidBy === 'cash' ? 'cash' : 'UPI'}` : status === 'cancelled' ? 'Bill cancelled, stock returned' : 'Marked as pending');
    return true;
  }
  $('#orderRows').addEventListener('click', async (e) => {
    const s = e.target.closest('[data-status]');
    if (s) { if (await setOrderStatus(s.closest('tr').dataset.id, s.dataset.status, s.dataset.by)) loadOrders(); return; }
    const v = e.target.closest('[data-view]');
    if (v) openOrder(Number(v.dataset.view));
  });

  async function openOrder(id) {
    const o = await api(`/api/orders/${id}`);
    $('#orderDlgTitle').innerHTML = `${esc(o.billNo)} ${statusBadge(o.status)} ${channelBadge(o.channel)}<span class="badge">${o.status === 'paid' ? (o.paidBy === 'cash' ? '💵 Paid in cash' : '📱 Paid by UPI') : (o.payPref === 'cash' ? '💵 Will pay cash' : '📱 Will pay by UPI')}</span>`;
    $('#orderDlgBody').innerHTML = `
      <div class="small muted" style="margin-bottom:8px">${esc(fmtTime(o.createdAt))}${o.customerName ? ' · ' + esc(o.customerName) : ''}${o.customerPhone ? ' · ' + esc(o.customerPhone) : ''}</div>
      ${o.fulfilment === 'delivery' ? `<div class="banner ok" style="margin:0 0 12px;font-weight:500"><b>🚚 Deliver to:</b> ${esc(o.customerName)}${o.customerPhone ? ` · <a href="tel:${esc(o.customerPhone)}">${esc(o.customerPhone)}</a>` : ''}<br>
        ${esc(o.deliveryAddress)}${o.deliveryLandmark ? `<br>Landmark: ${esc(o.deliveryLandmark)}` : ''}${o.deliveryPincode ? `<br>Pincode: ${esc(o.deliveryPincode)}` : ''}
        <br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([o.deliveryAddress, o.deliveryLandmark, o.deliveryPincode].filter(Boolean).join(', '))}" target="_blank" rel="noopener">Open in Maps ↗</a></div>`
        : '<div class="small" style="margin-bottom:8px">🏪 Pickup at store</div>'}
      <table class="data"><thead><tr><th>Item</th><th class="r">Rate</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>
        ${o.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${l.listPrice && l.listPrice !== l.price ? `<s class="muted small">${money(l.listPrice)}</s> ` : ''}${money(l.price)}</td><td class="r">${l.qty}</td><td class="r">${money(l.total)}</td></tr>`).join('')}
      </tbody></table>
      <table class="totals" style="margin-top:8px">
        <tr><td>Items total</td><td>${money(o.subtotal)}</td></tr>
        ${o.discount ? `<tr class="disc"><td>${esc(o.discountLabel)}</td><td>−${money(o.discount)}</td></tr>` : ''}
        ${o.tax ? `<tr><td>Tax (${o.taxPercent}%)</td><td>${money(o.tax)}</td></tr>` : ''}
        ${o.fulfilment === 'delivery' ? `<tr><td>Delivery</td><td>${o.deliveryCharge ? money(o.deliveryCharge) : 'Free'}</td></tr>` : ''}
        ${o.roundOff ? `<tr><td class="muted">Round off</td><td class="muted">${money(o.roundOff)}</td></tr>` : ''}
        ${o.adjustment ? `<tr class="${o.adjustment < 0 ? 'disc' : ''}"><td>Price adjustment</td><td>${o.adjustment < 0 ? '−' : '+'}${money(Math.abs(o.adjustment))}</td></tr>` : ''}
        <tr class="grand"><td>Total</td><td>${money(o.total)}</td></tr>
      </table>`;
    const btns = [];
    if (o.status !== 'paid') btns.push('<button type="button" class="btn btn-primary" data-s="paid" data-by="upi">Paid by UPI</button>', '<button type="button" class="btn btn-primary" data-s="paid" data-by="cash">Paid in cash</button>');
    if (o.status === 'paid') btns.push('<button type="button" class="btn" data-s="pending">Mark unpaid</button>');
    if (o.status !== 'cancelled') btns.push('<button type="button" class="btn btn-danger" data-s="cancelled">Cancel bill</button>');
    btns.push(`<a class="btn" href="/bill?id=${o.id}&t=${o.token}" target="_blank" rel="noopener">Open bill</a>`);
    $('#orderDlgFoot').innerHTML = btns.join('');
    $('#orderDlgFoot').onclick = async (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      if (await setOrderStatus(o.id, b.dataset.s, b.dataset.by)) { $('#orderDlg').close(); loadOrders(); }
    };
    $('#orderDlg').showModal();
  }

  /* ---------- discounts ---------- */
  async function loadDiscounts() {
    [state.discounts] = await Promise.all([api('/api/admin/discounts'), loadCategories()]);
    const now = Date.now();
    const when = (d) => {
      if (d.endsAt && new Date(d.endsAt).getTime() < now) return '<span class="badge">Ended</span>';
      if (d.startsAt && new Date(d.startsAt).getTime() > now) return `<span class="badge brand">From ${esc(fmtTime(d.startsAt.replace('T', ' ').slice(0, 19)))}</span>`;
      return d.endsAt ? `<span class="small">Until ${esc(fmtTime(d.endsAt.replace('T', ' ').slice(0, 19)))}</span>` : '<span class="small muted">Always</span>';
    };
    $('#discRows').innerHTML = state.discounts.length ? state.discounts.map((d) => `<tr data-id="${d.id}">
        <td><b>${esc(d.name)}</b>${d.code ? `<div><span class="badge brand">${esc(d.code)}</span></div>` : '<div class="small muted">Automatic</div>'}</td>
        <td>${d.type === 'percent' ? `${d.value}%` : money(d.value)}${d.maxDiscount ? `<div class="small muted">max ${money(d.maxDiscount)}</div>` : ''}</td>
        <td>${d.categoryId ? esc(catName(d.categoryId)) : 'Whole cart'}</td>
        <td>${d.minOrder ? money(d.minOrder) : '—'}</td>
        <td>${when(d)}</td>
        <td><input type="checkbox" ${d.active ? 'checked' : ''} data-toggle class="toggle" aria-label="Active"></td>
        <td class="r" style="white-space:nowrap"><button class="btn btn-sm" data-edit-disc>Edit</button> <button class="btn btn-sm btn-ghost btn-danger" data-del-disc>Delete</button></td>
      </tr>`).join('') : '<tr><td colspan="7"><div class="empty">No offers yet.</div></td></tr>';
  }
  $('#discRows').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-toggle]')) return;
    await api(`/api/admin/discounts/${e.target.closest('tr').dataset.id}`, { method: 'PATCH', body: { active: e.target.checked } });
    toast(e.target.checked ? 'Offer switched on' : 'Offer switched off');
  });
  $('#discRows').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const d = state.discounts.find((x) => x.id === Number(tr.dataset.id));
    if (e.target.closest('[data-edit-disc]')) openDisc(d);
    if (e.target.closest('[data-del-disc]') && confirm(`Delete offer “${d.name}”?`)) {
      await api(`/api/admin/discounts/${d.id}`, { method: 'DELETE' });
      loadDiscounts();
    }
  });
  let editingDisc = null;
  function syncDiscType() {
    const f = $('#discForm');
    $('#discValueLabel').textContent = f.type.value === 'percent' ? 'Percent (1–100)' : 'Amount (₹)';
  }
  function openDisc(d) {
    editingDisc = d;
    const f = $('#discForm');
    f.reset();
    $('#discDlgTitle').textContent = d ? 'Edit offer' : 'Add offer';
    f.categoryId.innerHTML = catOptions(d ? d.categoryId : '', 'Whole cart');
    if (d) {
      f.name.value = d.name; f.type.value = d.type; f.value.value = d.type === 'percent' ? d.value : rupees(d.value);
      f.code.value = d.code || ''; f.minOrder.value = rupees(d.minOrder) || 0; f.maxDiscount.value = rupees(d.maxDiscount);
      f.startsAt.value = toLocalInput(d.startsAt); f.endsAt.value = toLocalInput(d.endsAt); f.active.checked = d.active;
    }
    syncDiscType();
    showErr($('#discErr'), '');
    $('#discDlg').showModal();
  }
  $('#discForm').type.addEventListener('change', syncDiscType);
  $('#addDiscBtn').addEventListener('click', () => openDisc(null));
  bindDialogForm($('#discForm'), async () => {
    const b = formData($('#discForm'));
    // datetime-local is in the admin's local time; send it as an absolute instant.
    b.startsAt = b.startsAt ? new Date(b.startsAt).toISOString() : '';
    b.endsAt = b.endsAt ? new Date(b.endsAt).toISOString() : '';
    if (editingDisc) await api(`/api/admin/discounts/${editingDisc.id}`, { method: 'PUT', body: b });
    else await api('/api/admin/discounts', { method: 'POST', body: b });
    toast('Offer saved');
    loadDiscounts();
  }, $('#discErr'));

  /* ---------- settings ---------- */
  async function loadDbInfo() {
    try {
      const d = await api('/api/admin/db-info');
      const c = d.counts;
      $('#dbInfo').innerHTML = `${d.perDeployment ? `<div class="banner danger" style="margin-top:0">This database was created for one deployment only. The next deployment will switch to a new, empty one. Set <b>SHOP_DATABASE_URL</b> and <b>SHOP_DATABASE_AUTH_TOKEN</b> in Vercel to your permanent database.</div>` : ''}
        <div>Database: <b>${esc(d.where)}</b> <span class="muted">(from ${esc(d.source)})</span></div>
        <div class="muted">${c.items} items · ${c.categories} categories · ${c.offers} offers · ${c.bills} bills · ${c.photos} photos</div>`;
    } catch (e) { $('#dbInfo').textContent = e.message; }
    loadSnapshots();
  }
  async function loadSnapshots() {
    const list = await api('/api/admin/backups');
    $('#snapRows').innerHTML = list.length
      ? '<thead><tr><th>When</th><th>Why</th><th>Contents</th><th></th></tr></thead><tbody>' + list.map((b) => `<tr>
          <td class="small" style="white-space:nowrap">${esc(fmtTime(b.createdAt))}</td>
          <td>${esc(b.reason)}</td><td class="small muted">${esc(b.summary)}</td>
          <td class="r"><a class="btn btn-sm" href="/api/admin/backups/${b.id}.json">Download</a></td></tr>`).join('') + '</tbody>'
      : '<tbody><tr><td class="muted">No snapshots yet. One is taken automatically once you have items.</td></tr></tbody>';
  }
  $('#snapNow').addEventListener('click', async () => {
    const r = await api('/api/admin/backups', { method: 'POST' });
    toast(r.id ? 'Snapshot saved' : 'Nothing to save yet');
    loadSnapshots();
  });
  async function loadSettings() {
    loadDbInfo();
    const s = await api('/api/admin/settings');
    const f = $('#settingsForm');
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') el.checked = s[el.name] === '1'; else el.value = s[el.name] ?? '';
    }
  }
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/settings', { method: 'PUT', body: formData(e.target) });
      $('#upiWarn').classList.toggle('hidden', !!e.target.upi_id.value.trim());
      toast('Settings saved');
    } catch (err) { toast(err.message, true); }
  });
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/password', { method: 'POST', body: formData(e.target) });
      e.target.reset();
      $('#pwWarn').classList.add('hidden');
      toast('Password changed');
    } catch (err) { toast(err.message, true); }
  });

  /* ---------- store QR ---------- */
  async function loadQr() {
    const [q, s] = await Promise.all([api('/api/admin/store-qr'), api('/api/admin/settings')]);
    $('#qrShop').textContent = s.shop_name;
    $('#qrImg').src = q.qr;
    $('#qrUrl').textContent = q.url;
    $('#qrDownload').href = q.qr;
    $('#qrShop2').textContent = s.shop_name;
    $('#qrImg2').src = q.storeQr;
    $('#qrUrl2').textContent = q.storeUrl;
    $('#qrDownload2').href = q.storeQr;
  }
  // Print just the chosen poster.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-print]');
    if (!b) return;
    document.body.dataset.printOnly = b.dataset.print;
    window.print();
  });
  window.addEventListener('afterprint', () => { delete document.body.dataset.printOnly; });

  /* ---------- counter billing ---------- */
  const CTR_KEY = 'cc_counter_v1';
  const ctr = { items: [], byId: new Map(), lines: safeGet(CTR_KEY, []) || [], quote: null, busy: false, finalTotal: null };
  const ctrSave = () => safeSet(CTR_KEY, ctr.lines);
  async function loadCounter() {
    ctr.items = (await api('/api/admin/items')).filter((i) => i.active || i.totalStock > 0);
    ctr.byId = new Map(ctr.items.map((i) => [i.id, i]));
    // Number items the same way as the rate card (by category, then display order) so "#12" can be typed.
    await loadCategories();
    const order = state.categories.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id).map((c) => c.id); // same order as the rate card
    const sorted = ctr.items.slice().sort((a, b) => {
      const ca = order.indexOf(a.categoryId); const cb = order.indexOf(b.categoryId);
      return (ca < 0 ? 1e9 : ca) - (cb < 0 ? 1e9 : cb) || a.sortOrder - b.sortOrder || a.id - b.id;
    });
    sorted.forEach((it, i) => { it.no = i + 1; });
    ctr.items = sorted;
    renderCtrResults();
    renderCtrBill();
  }
  function renderCtrResults() {
    const q = $('#ctrSearch').value.trim().toLowerCase();
    const num = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
    const list = ctr.items.filter((i) => !q || (num !== null ? i.no === num : i.name.toLowerCase().includes(q))).slice(0, 40);
    $('#ctrResults').innerHTML = list.length ? list.map((i) => `<button type="button" class="ctr-item" data-add="${i.id}" ${i.totalStock <= 0 ? 'disabled' : ''}>
        <span class="mini-thumb thumb">${thumbHtml(i)}</span>
        <span class="ctr-item-name"><b>${esc(i.name)}</b><small>#${i.no} · Store ${i.storeStock} · Online ${i.stock}</small></span>
        <span class="ctr-item-price">${money(i.price)}</span>
      </button>`).join('') : '<div class="empty">No items match.</div>';
  }
  async function renderCtrBill() {
    ctr.lines = ctr.lines.filter((l) => ctr.byId.has(l.itemId) && l.qty > 0);
    ctrSave();
    if (!ctr.lines.length) {
      $('#ctrLines').innerHTML = '<div class="muted small" style="padding:8px 0 12px">Search and tap items to add them.</div>';
      $('#ctrTotals').innerHTML = '';
      $$('.ctr-actions button').forEach((b) => { b.disabled = true; });
      return;
    }
    $('#ctrLines').innerHTML = ctr.lines.map((l) => {
      const it = ctr.byId.get(l.itemId);
      const rate = l.price ?? it.price;
      const changed = l.price != null && l.price !== it.price;
      return `<div class="ctr-line">
        <div class="ctr-line-name"><b>${esc(it.name)}</b>
          <label class="ctr-rate${changed ? ' changed' : ''}">₹<input class="input num" type="number" inputmode="decimal" min="0" step="1"
            value="${rate / 100}" data-rate="${it.id}" aria-label="Rate for ${esc(it.name)}"> × ${l.qty}
            ${changed ? `<s>${money(it.price)}</s>` : ''}</label></div>
        ${stepperHtml(it.id, l.qty, it.totalStock)}
        <b class="num ctr-line-total">${money(rate * l.qty)}</b>
      </div>`;
    }).join('');
    try {
      ctr.quote = await api('/api/admin/counter/quote', { method: 'POST', body: { items: ctr.lines, finalTotal: ctr.finalTotal } });
    } catch (e) { toast(e.message, true); return; }
    const q = ctr.quote;
    const rows = [];
    if (q.listSubtotal !== q.subtotal) rows.push(`<tr><td class="muted">At list rates</td><td class="muted">${money(q.listSubtotal)}</td></tr>`);
    rows.push(`<tr><td>Items total</td><td>${money(q.subtotal)}</td></tr>`);
    if (q.discount) rows.push(`<tr class="disc"><td>${esc(q.discountLabel)}</td><td>−${money(q.discount)}</td></tr>`);
    if (q.tax) rows.push(`<tr><td>Tax (${q.taxPercent}%)</td><td>${money(q.tax)}</td></tr>`);
    if (q.roundOff) rows.push(`<tr><td class="muted">Round off</td><td class="muted">${q.roundOff > 0 ? '+' : '−'}${money(Math.abs(q.roundOff))}</td></tr>`);
    if (q.adjustment) rows.push(`<tr class="${q.adjustment < 0 ? 'disc' : ''}"><td>Agreed amount</td><td>${q.adjustment < 0 ? '−' : '+'}${money(Math.abs(q.adjustment))}</td></tr>`);
    rows.push(`<tr class="grand"><td>Total</td><td>${money(q.total)}</td></tr>`);
    if (q.listSubtotal - q.subtotal - (q.adjustment || 0) > 0) rows.push(`<tr><td colspan="2" class="small muted">Customer saves ${money(q.listSubtotal - q.subtotal - (q.adjustment || 0))} vs list rates${q.discount ? ', plus the offer' : ''}</td></tr>`);
    if (q.errors.length) rows.push(`<tr><td colspan="2" style="color:var(--danger);font-weight:700">${q.errors.map((e) => esc(e.message)).join('<br>')}</td></tr>`);
    $('#ctrTotals').innerHTML = rows.join('');
    $$('.ctr-actions button').forEach((b) => { b.disabled = q.errors.length > 0 || ctr.busy; });
  }
  function ctrAdd(id, delta = 1) {
    const it = ctr.byId.get(id);
    const l = ctr.lines.find((x) => x.itemId === id);
    const next = Math.max(0, (l ? l.qty : 0) + delta);
    if (next > it.totalStock) { toast(`Only ${it.totalStock} in stock`, true); return; }
    if (l) l.qty = next; else ctr.lines.push({ itemId: id, qty: next });
    renderCtrBill();
  }
  $('#ctrResults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    ctrAdd(Number(b.dataset.add));
    if (navigator.vibrate) navigator.vibrate(10);
  });
  $('#ctrSearch').addEventListener('input', renderCtrResults);
  $('#ctrSearch').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = $('#ctrResults [data-add]:not([disabled])');
    if (first) { ctrAdd(Number(first.dataset.add)); $('#ctrSearch').select(); }
  });
  bindSteppers($('#ctrLines'), (id, qty) => {
    const l = ctr.lines.find((x) => x.itemId === id);
    if (l) l.qty = qty;
    renderCtrBill();
  });
  $('#ctrClear').addEventListener('click', () => {
    if (ctr.lines.length && !confirm('Clear this bill?')) return;
    ctr.lines = []; $('#ctrName').value = ''; $('#ctrPhone').value = '';
    ctr.finalTotal = null; $('#ctrFinal').value = '';
    renderCtrBill();
  });
  // Agreed rate for one line (empty = back to the list rate).
  $('#ctrLines').addEventListener('change', (e) => {
    const input = e.target.closest('[data-rate]');
    if (!input) return;
    const id = Number(input.dataset.rate);
    const l = ctr.lines.find((x) => x.itemId === id);
    const it = ctr.byId.get(id);
    const v = input.value.trim();
    if (!l) return;
    if (v === '' || !(Number(v) >= 0)) delete l.price;
    else {
      const p = Math.round(Number(v) * 100);
      if (p === it.price) delete l.price; else l.price = p;
    }
    renderCtrBill();
  });
  // Agreed final amount for the whole bill (empty = use the calculated total).
  $('#ctrFinal').addEventListener('change', () => {
    const v = $('#ctrFinal').value.trim();
    ctr.finalTotal = v === '' || !(Number(v) >= 0) ? null : Math.round(Number(v) * 100);
    if (ctr.finalTotal === null) $('#ctrFinal').value = '';
    renderCtrBill();
  });
  $('.ctr-actions').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pay]');
    if (!b || ctr.busy || !ctr.lines.length) return;
    const pay = b.dataset.pay;
    ctr.busy = true;
    $$('.ctr-actions button').forEach((x) => { x.disabled = true; });
    // Open the bill window now (before the await) so phones don't block it as a pop-up.
    const win = pay === 'qr' ? window.open('', '_blank') : null;
    try {
      const r = await api('/api/admin/counter/bills', {
        method: 'POST',
        body: { items: ctr.lines, finalTotal: ctr.finalTotal, customerName: $('#ctrName').value, customerPhone: $('#ctrPhone').value, paidBy: pay === 'qr' ? undefined : pay },
      });
      const url = `/bill?id=${r.id}&t=${r.token}`;
      if (win) win.location = url;
      toast(pay === 'qr' ? `Bill ${r.billNo} created: customer can scan the QR` : `Bill ${r.billNo} · ${money(r.total)} paid by ${pay === 'cash' ? 'cash' : 'UPI'}`);
      ctr.lines = []; $('#ctrName').value = ''; $('#ctrPhone').value = '';
      ctr.finalTotal = null; $('#ctrFinal').value = '';
      await loadCounter();
      $('#ctrSearch').value = ''; renderCtrResults();
    } catch (err) {
      if (win) win.close();
      toast(err.message, true);
      await loadCounter();
    } finally {
      ctr.busy = false;
      renderCtrBill();
    }
  });

  boot();
})();
