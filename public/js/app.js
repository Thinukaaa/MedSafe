/**
 * MedSafe — app (UI + events)
 */
(function () {
  'use strict';

  const $ = function (s, el) { return (el || document).querySelector(s); };
  const $$ = function (s, el) { return Array.from((el || document).querySelectorAll(s)); };

  const LS_SETTINGS = 'ms_settings_v1';
  const SS_SESSION = 'ms_session_v1';
  const TZ = 'Asia/Colombo';
  const DEFAULTS = {
    pharmacyName: '',
    criticalDays: 30,
    warningDays: 90,
    marginPct: 16,          // ASSUMPTION — replace with the figure from the field visit
    apiUrl: (window.MS_CONFIG && window.MS_CONFIG.API_URL) || ''
  };
  const TITLES = {
    dashboard: 'Dashboard', add: 'Scan & add stock', stock: 'Stock', cold: 'Cold chain', more: 'More',
    log: 'Action log', settings: 'Settings'
  };
  const MORE_TABS = ['more', 'log', 'settings'];

  let settings = loadSettings();
  let session = loadSession();
  let store = null;
  const state = { batches: [], events: [], catalogue: [], lastSync: null, loaded: false, actionBatch: null, tab: 'dashboard' };

  // ---------------- Settings ----------------
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      const s = Object.assign({}, DEFAULTS, saved);
      s.criticalDays = Number(s.criticalDays) || DEFAULTS.criticalDays;
      s.warningDays = Number(s.warningDays) || DEFAULTS.warningDays;
      s.marginPct = isFinite(Number(s.marginPct)) && s.marginPct !== '' ? Number(s.marginPct) : DEFAULTS.marginPct;
      return s;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }

  // ---------------- Session (token in sessionStorage) ----------------
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SS_SESSION) || 'null'); } catch (e) { return null; }
  }
  function isOwner() { return !!session && session.role === 'owner'; }
  function isDemoMode() { return !!session && session.mode === 'local'; }
  function makeSessionStore() {
    return window.makeStore(session && session.mode === 'sheet' ? session.apiUrl : '', function () { return session && session.token; });
  }

  async function signIn(shopId, pin, apiUrl) {
    const id = String(shopId || '').trim().toUpperCase();
    const local = id === 'DEMO' || id === 'DEMO-STAFF';
    const url = local ? '' : String(apiUrl || settings.apiUrl || '').trim();
    if (!local && !url) throw new Error('No server set. Open "Server" and paste the Apps Script URL, or use DEMO / 1234.');
    const r = await window.makeStore(url, function () { return ''; }).login(id, pin);
    if (!r || !r.token) throw new Error((r && r.error) || 'Sign-in failed');
    session = { token: r.token, name: r.name, role: r.role, shopId: r.shopId || id, mode: local ? 'local' : 'sheet', apiUrl: url };
    sessionStorage.setItem(SS_SESSION, JSON.stringify(session));
    if (!local && url !== settings.apiUrl) { settings.apiUrl = url; saveSettings(settings); }
    store = makeSessionStore();
  }

  async function signOut(message) {
    try { if (store) await store.logout(); } catch (e) { /* token may already be gone */ }
    session = null;
    store = null;
    sessionStorage.removeItem(SS_SESSION);
    state.batches = []; state.events = []; state.lastSync = null; state.loaded = false;
    showScreen('start');
    if (message) toast(message, 'error');
  }

  function showScreen(name) {
    $('#startScreen').hidden = name !== 'start';
    $('#loginScreen').hidden = name !== 'login';
    $('#appRoot').hidden = name !== 'app';
    document.body.classList.toggle('demo-mode', name === 'app' && isDemoMode());
    if (name === 'login') {
      $('#loginForm').elements.apiUrl.value = settings.apiUrl || '';
      $('#loginForm').elements.shopId.focus();
    }
  }

  async function onLoginSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    $('#loginError').textContent = '';
    try {
      await signIn(f.elements.shopId.value, f.elements.pin.value, f.elements.apiUrl.value);
      f.elements.pin.value = '';
      enterApp();
    } catch (e) {
      $('#loginError').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function enterApp() {
    showScreen('app');
    applyRole();
    showTab('dashboard');
    if (!state.catalogue.length) loadCatalogue();
    refresh(true);
  }

  /** Staff cannot delete batches, change settings or edit the business case (the server checks too). */
  function applyRole() {
    document.body.classList.toggle('role-staff', !isOwner());
    $('#whoami').textContent = 'Signed in as ' + session.name + ' (' + session.role + ')';
    $('#deleteBatchBtn').hidden = !isOwner();
    $$('#settingsForm input, #settingsForm button, #loadSampleBtn, #clearSampleBtn').forEach(function (el) { el.disabled = !isOwner(); });
    $('#ownerOnlyNote').hidden = isOwner();
  }

  // ---------------- Helpers ----------------
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function rs(n) {
    return 'Rs ' + Number(n || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function int(n) { return Number(n || 0).toLocaleString('en-LK'); }
  function plural(n, one, many) { return int(n) + ' ' + (n === 1 ? one : many); }
  function fmtDate(d) {
    if (!d) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  /** "HH:MM" in Sri Lanka time. */
  function slTime(d) { return d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); }

  let idSeq = 0;
  /** Unique id from the clock + a counter (no random numbers). */
  function newId(prefix) {
    idSeq += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + idSeq.toString(36) + '-' + (session ? session.shopId : 'X');
  }
  function daysLabel(d) {
    if (d === null || d === undefined) return '—';
    if (d < 0) return plural(Math.abs(d), 'day', 'days') + ' ago';
    if (d === 0) return 'Today';
    return plural(d, 'day', 'days') + ' left';
  }

  const STATUS_TEXT = { expired: 'Expired', critical: 'Critical', warning: 'Warning', ok: 'OK', unknown: 'No date' };
  function statusChip(s) { return '<span class="chip ' + s + '">' + STATUS_TEXT[s] + '</span>'; }
  function demoChip(x) { return x.demo ? ' <span class="chip demo">DEMO</span>' : ''; }

  let toastTimer;
  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 3500);
  }

  /** Friendly confirm dialog → Promise<boolean>. */
  function ask(message, okText) {
    return new Promise(function (resolve) {
      const dlg = $('#askDialog');
      $('#askText').textContent = message;
      $('#askOk').textContent = okText || 'Continue';
      function done(v) {
        $('#askOk').onclick = null; $('#askCancel').onclick = null; dlg.oncancel = null;
        if (dlg.open) dlg.close();
        resolve(v);
      }
      $('#askOk').onclick = function () { done(true); };
      $('#askCancel').onclick = function () { done(false); };
      dlg.oncancel = function () { done(false); };
      dlg.showModal();
      $('#askOk').focus();
    });
  }

  function setBusy(on) { document.body.classList.toggle('busy', !!on); }

  // ---------------- Data ----------------
  async function refresh(silent) {
    if (!store) return;
    setBusy(true);
    try {
      const d = await store.load();
      state.batches = d.batches.map(normaliseBatch);
      state.events = d.events;
      state.lastSync = new Date();
      state.loaded = true;
      render();
      if (!silent) toast('Up to date', 'ok');
    } catch (e) {
      console.error(e);
      if (e.unauthorized) { signOut('Session expired — please sign in again'); return; }
      toast('Could not load data: ' + e.message, 'error');
      state.loaded = true;
      render();
    } finally {
      setBusy(false);
    }
  }

  function normaliseBatch(b) {
    return Object.assign({}, b, {
      qty: Number(b.qty) || 0,
      costPrice: Number(b.costPrice) || 0,
      sellPrice: b.sellPrice === '' || b.sellPrice === null || b.sellPrice === undefined ? '' : Number(b.sellPrice),
      demo: b.demo === true || b.demo === 'TRUE' || b.demo === 'true'
    });
  }

  // ---------------- Render ----------------
  function render() {
    renderHeader();
    renderFormulas();
    const enriched = Calc.enrich(state.batches, settings);
    renderDashboard(enriched);
    renderStock(enriched);
    renderLog();
    renderSuppliers();
  }

  function renderHeader() {
    $('#pharmacyName').textContent = settings.pharmacyName || (isDemoMode() ? 'DEMO pharmacy' : 'Shop ' + session.shopId);
    const badge = $('#modeBadge');
    badge.textContent = isDemoMode() ? 'DEMO' : 'Live · Google Sheet';
    badge.className = 'mode-badge ' + store.mode;
    $('#asOf').textContent = state.lastSync ? 'Last synced ' + slTime(state.lastSync) + ' Sri Lanka time' : 'Not synced yet';
    $('#kCriticalTitle').textContent = 'Critical · 0–' + settings.criticalDays + ' days';
    $('#kWarningTitle').textContent = 'Warning · ' + (settings.criticalDays + 1) + '–' + settings.warningDays + ' days';
  }

  function renderFormulas() {
    $$('[data-formula]').forEach(function (p) {
      p.textContent = Calc.formula(p.getAttribute('data-formula'), settings);
    });
  }

  function setKpi(key, g) {
    $('#k' + key + 'Val').textContent = rs(g.value);
    $('#k' + key + 'Sub').textContent = plural(g.batches, 'batch', 'batches') + ' · ' + plural(g.units, 'unit', 'units');
  }

  /** One batch row (used by Sell-first and Stock lists). */
  function itemHtml(b, opts) {
    const closed = b.qty <= 0;
    const meta = ['Batch ' + esc(b.batchNo), b.location ? 'Shelf ' + esc(b.location) : '', b.supplier ? esc(b.supplier) : '']
      .filter(Boolean).join(' · ');
    return '<button type="button" class="item ' + (closed ? 'closed' : 'row-' + b.status) + '" data-act="' + esc(b.id) + '">' +
      '<span><strong>' + esc(b.name) + '</strong> <span class="muted">' + esc(b.strength) + '</span>' + demoChip(b) +
        '<span class="sub">' + meta + '</span></span>' +
      '<span class="col-exp">' + (closed ? '<span class="chip closed">Closed</span>' : statusChip(b.status)) +
        '<span class="sub">' + daysLabel(b.daysLeft) + ' · ' + fmtDate(b.expiryDate) + '</span></span>' +
      '<span class="col-qty num">' + plural(b.qty, 'unit', 'units') + (opts && opts.cost ? '<span class="sub">' + rs(b.costPrice) + '/unit</span>' : '') + '</span>' +
      '<span class="col-val num"><strong>' + rs(b.value) + '</strong><span class="sub">at cost</span></span>' +
      '</button>';
  }

  function emptyState(title, text, buttons) {
    return '<div class="empty-state"><strong>' + esc(title) + '</strong>' + esc(text) +
      (buttons ? '<div class="actions">' + buttons + '</div>' : '') + '</div>';
  }

  function renderDashboard(enriched) {
    const s = Calc.summary(enriched);
    setKpi('Expired', s.expired);
    setKpi('Critical', s.critical);
    setKpi('Warning', s.warning);
    setKpi('Total', s.total);

    // 10-second headline: one sentence
    const h = $('#headline');
    if (!state.batches.length) {
      h.className = 'headline empty';
      h.textContent = 'No stock recorded yet — scan your first box to start.';
    } else if (s.expired.batches) {
      h.className = 'headline bad';
      h.innerHTML = '<strong>' + plural(s.expired.batches, 'expired batch', 'expired batches') + '</strong> still on the shelf (' + rs(s.expired.value) + ') — remove now for patient safety.';
    } else if (s.critical.batches) {
      h.className = 'headline warn';
      h.innerHTML = '<strong>' + rs(s.critical.value) + '</strong> of stock expires within ' + settings.criticalDays + ' days — sell it first or return it.';
    } else {
      h.className = 'headline good';
      h.textContent = 'All good — nothing expires in the next ' + settings.criticalDays + ' days.';
    }
    if (state.batches.some(function (b) { return b.demo; })) h.innerHTML += ' <span class="chip demo">DEMO DATA</span>';

    // Sell-first: expired first (remove), then critical/warning by expiry (FEFO)
    const ordered = Calc.fefo(enriched);
    const expired = ordered.filter(function (b) { return b.status === 'expired'; });
    const sell = ordered.filter(function (b) { return b.status === 'critical' || b.status === 'warning'; }).slice(0, 10);
    let html = '';
    if (expired.length) html += '<p class="list-label bad">Remove from shelf — do not sell</p>' + expired.map(itemHtml).join('');
    if (sell.length) html += '<p class="list-label">Sell these first</p>' + sell.map(itemHtml).join('');
    if (!html) {
      html = state.batches.length
        ? emptyState('Nothing to rush', 'No batch expires within ' + settings.warningDays + ' days.')
        : emptyState('No stock yet', 'Scan a box or load the demo pharmacy to see how it works.',
          '<button class="btn primary" data-goto="add">Scan a box</button>' + (isOwner() ? '<button class="btn ghost" data-cmd="loadDemo">Load demo pharmacy</button>' : ''));
    }
    $('#fefoList').innerHTML = html;

    // Impact
    const im = Calc.impact(state.events, settings);
    $('#iRecovered').textContent = rs(im.recovered);
    $('#iRecoveredSub').textContent = plural(im.recoveredUnits, 'unit', 'units') + ' sold or returned in time';
    $('#iLost').textContent = rs(im.lost);
    $('#iLostSub').textContent = plural(im.lostUnits, 'unit', 'units') + ' disposed';
    $('#iRate').textContent = im.rate === null ? 'No actions yet' : im.rate.toFixed(1) + ' %';
  }

  function renderStock(enriched) {
    const q = $('#search').value.trim().toLowerCase();
    const f = $('#statusFilter').value;
    const rows = enriched
      .filter(function (b) {
        if (f === 'empty') return b.qty <= 0;
        if (f && (b.status !== f || b.qty <= 0)) return false;
        if (!q) return true;
        return [b.name, b.strength, b.batchNo, b.location, b.supplier, b.barcode].join(' ').toLowerCase().indexOf(q) !== -1;
      })
      .sort(function (a, b) { return (a.expiryDate || 0) - (b.expiryDate || 0); });
    $('#stockList').innerHTML = rows.length
      ? rows.map(function (b) { return itemHtml(b, { cost: true }); }).join('')
      : (state.batches.length ? emptyState('No match', 'Try another name, batch or shelf.') :
        emptyState('No stock yet', 'Scan your first box to start.', '<button class="btn primary" data-goto="add">Scan a box</button>'));
  }

  function renderLog() {
    const rows = state.events.slice().sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    const label = { SOLD: 'Sold', RETURNED: 'Returned to supplier', DISPOSED: 'Disposed (expired)', ADJUST: 'Count correction' };
    $('#logBody').innerHTML = rows.length ? rows.map(function (e) {
      const demo = (e.demo === true || e.demo === 'TRUE' || e.demo === 'true') ? ' <span class="chip demo">DEMO</span>' : '';
      return '<tr>' +
        '<td class="nowrap">' + fmtDateTime(e.ts) + '</td>' +
        '<td>' + esc(e.name) + demo + '</td>' +
        '<td>' + esc(e.batchNo) + '</td>' +
        '<td>' + esc(label[e.type] || e.type) + '</td>' +
        '<td class="num">' + int(e.qty) + '</td>' +
        '<td class="num">' + rs(e.value) + '</td>' +
        '<td class="num">' + daysLabel(e.daysToExpiry === '' ? null : Number(e.daysToExpiry)) + '</td>' +
        '<td class="muted">' + esc([e.by, e.note].filter(Boolean).join(' · ')) + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="8" class="muted center">No actions recorded yet.</td></tr>';
  }

  function renderSuppliers() {
    const names = {};
    state.batches.forEach(function (b) { if (b.supplier) names[b.supplier] = true; });
    $('#supplierList').innerHTML = Object.keys(names).sort().map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
  }

  // ---------------- Navigation ----------------
  function showTab(name) {
    state.tab = name;
    const navKey = MORE_TABS.indexOf(name) !== -1 ? 'more' : name;
    $$('.nav-item').forEach(function (t) {
      const on = t.dataset.tab === navKey;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    $$('.panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
    $('#pageTitle').textContent = TITLES[name] || 'MedSafe';
    if (name === 'settings') fillSettingsForm();
    if (name === 'add' && $('#addStep2').hidden) setTimeout(function () { $('#productSearch').focus(); }, 50);
    window.scrollTo(0, 0);
  }

  // ---------------- Add stock: step 1 (find product) ----------------
  /** Catalogue products + products already seen in stock (for items not in the catalogue). */
  function products() {
    const seen = {};
    const list = state.catalogue.slice();
    list.forEach(function (p) { seen[(p.name + '|' + p.strength).toLowerCase()] = true; });
    state.batches.forEach(function (b) {
      const k = (b.name + '|' + b.strength).toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      list.push({ id: '', name: b.name, strength: b.strength, form: b.form || '', ean: b.barcode || '', mrp: b.mrp || '', mrpSource: b.mrpSource || '', fromStock: b });
    });
    return list;
  }

  let comboItems = [], comboIndex = -1;
  function onProductInput() {
    const q = $('#productSearch').value.trim().toLowerCase();
    const list = $('#productList');
    if (q.length < 2) { closeCombo(); return; }
    const words = q.split(/\s+/);
    comboItems = products().filter(function (p) {
      const hay = (p.name + ' ' + p.strength + ' ' + p.form + ' ' + p.ean).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    }).slice(0, 8);
    comboIndex = comboItems.length ? 0 : -1;
    list.innerHTML = comboItems.length ? comboItems.map(function (p, i) {
      return '<li role="option" id="opt-' + i + '" data-i="' + i + '" aria-selected="' + (i === comboIndex) + '"><span><strong>' + esc(p.name) + '</strong> ' + esc(p.strength) +
        '<br><span class="sub">' + esc(p.form || 'From your stock') + '</span></span>' +
        '<span class="sub">' + (p.mrp ? 'MRP ' + rs(p.mrp) : '') + '</span></li>';
    }).join('') : '<li class="sub" aria-disabled="true">No match — use “Enter details manually”.</li>';
    list.hidden = false;
    $('#productSearch').setAttribute('aria-expanded', 'true');
    syncComboActive();
  }
  function syncComboActive() {
    $$('#productList [role=option]').forEach(function (li, i) { li.setAttribute('aria-selected', String(i === comboIndex)); });
    $('#productSearch').setAttribute('aria-activedescendant', comboIndex >= 0 ? 'opt-' + comboIndex : '');
  }
  function closeCombo() {
    $('#productList').hidden = true;
    $('#productSearch').setAttribute('aria-expanded', 'false');
    comboItems = []; comboIndex = -1;
  }
  function onProductKey(e) {
    if ($('#productList').hidden || !comboItems.length) return;
    if (e.key === 'ArrowDown') { comboIndex = (comboIndex + 1) % comboItems.length; syncComboActive(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { comboIndex = (comboIndex - 1 + comboItems.length) % comboItems.length; syncComboActive(); e.preventDefault(); }
    else if (e.key === 'Enter' && comboIndex >= 0) { e.preventDefault(); pickProduct(comboItems[comboIndex]); }
    else if (e.key === 'Escape') closeCombo();
  }

  function pickProduct(p, extra) {
    closeCombo();
    $('#productSearch').value = '';
    const f = $('#addForm');
    f.reset();
    const prev = p && p.fromStock;
    if (p) {
      f.elements.productId.value = p.id || '';
      f.elements.name.value = p.name;
      f.elements.strength.value = p.strength + (p.form ? ' · ' + p.form : '');
      f.elements.form.value = p.form || '';
      f.elements.barcode.value = p.ean || '';
      f.elements.mrp.value = p.mrp || '';
      f.elements.mrpSource.value = p.mrpSource || '';
      if (p.mrp) {
        f.elements.sellPrice.value = p.mrp;
        f.elements.costPrice.value = Calc.costFromMrp(p.mrp, settings.marginPct);
        setCostSource(DemoData.costSourceText(settings.marginPct));
      }
      if (prev) {
        ['costPrice', 'sellPrice', 'supplier', 'location'].forEach(function (k) { if (prev[k] !== '' && prev[k] !== undefined) f.elements[k].value = prev[k]; });
        if (prev.costSource) setCostSource(prev.costSource);
      }
    }
    Object.keys(extra || {}).forEach(function (k) { if (f.elements[k] && extra[k] !== undefined && extra[k] !== '') f.elements[k].value = extra[k]; });
    renderProductCard(p);
    goStep(2);
  }

  /** Select a cost source, adding it as an option if it is not one of the fixed choices (e.g. the ASSUMPTION text). */
  function setCostSource(text) {
    const sel = $('#addForm').elements.costSource;
    if (!Array.from(sel.options).some(function (o) { return o.value === text; })) {
      const o = document.createElement('option');
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.value = text;
  }

  async function loadCatalogue() {
    try {
      const res = await fetch('data/catalogue.json', { cache: 'no-cache' });
      const c = await res.json();
      state.catalogue = c.products || [];
    } catch (e) {
      console.error(e);
      toast('Medicine catalogue could not be loaded — search will only show your own stock', 'error');
    }
  }

  function renderProductCard(p) {
    const card = $('#productCard');
    if (!p) { card.innerHTML = '<h3>New product</h3><p>Type the details from the box label.</p>'; return; }
    card.innerHTML = '<h3>' + esc(p.name) + ' <span class="muted">' + esc(p.strength) + '</span></h3>' +
      '<p>' + esc(p.form || '') + (p.ean ? ' · Barcode ' + esc(p.ean) : '') + '</p>' +
      (p.mrp ? '<p><strong>MRP ' + rs(p.mrp) + ' per unit</strong> — source: ' + esc(p.mrpSource) + '</p>' +
        '<p>Cost pre-filled as ' + rs(Calc.costFromMrp(p.mrp, settings.marginPct)) + ' = MRP × (1 − ' + settings.marginPct + '%) <span class="chip assumption">ASSUMPTION</span> — replace with the invoice price if you have it.</p>' : '') +
      (p.ean && /^2/.test(p.ean) ? '<p>Barcode is a DEMO in-store code (GS1 range 200–299).</p>' : '') +
      (p.fromStock ? '<p>Prices copied from your last batch — check they are still correct.</p>' : '');
  }

  function goStep(n) {
    $('#addStep1').hidden = n !== 1;
    $('#addStep2').hidden = n !== 2;
    $('#stepDot1').className = n === 1 ? 'active' : 'done';
    $('#stepDot2').className = n === 2 ? 'active' : '';
    if (n === 2) {
      const f = $('#addForm');
      const first = !f.elements.name.value ? f.elements.name : (!f.elements.batchNo.value ? f.elements.batchNo : (!f.elements.expiry.value ? f.elements.expiry : f.elements.qty));
      setTimeout(function () { first.focus(); }, 50);
    }
  }

  /** Look up a scanned code: catalogue EAN first, then earlier batches with the same barcode. */
  function onCode(raw) {
    const code = String(raw || '').trim();
    if (!code) return;
    showTab('add');
    const p = products().filter(function (x) { return x.ean && String(x.ean) === code; })[0];
    if (p) { pickProduct(p); toast('Found: ' + p.name + ' ' + p.strength, 'ok'); return; }
    pickProduct(null, { barcode: code });
    toast('New barcode — enter the product details once', '');
  }

  // ---------------- Add stock: step 2 (save) ----------------
  async function onAddSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const fd = new FormData(f);
    const month = String(fd.get('expiry') || '');
    const day = String(fd.get('expiryDay') || '').trim();
    const expiry = day ? month + '-' + day.padStart(2, '0') : month;
    if (!Calc.parseExpiry(expiry)) { toast('Please enter a valid expiry month (and day)', 'error'); return; }
    const now = new Date().toISOString();
    const batch = {
      id: newId('B'),
      name: String(fd.get('name')).trim(),
      strength: String(fd.get('strength') || '').trim(),
      form: String(fd.get('form') || '').trim(),
      barcode: String(fd.get('barcode') || '').trim(),
      batchNo: String(fd.get('batchNo')).trim(),
      expiry: expiry,
      qty: Number(fd.get('qty')),
      costPrice: Number(fd.get('costPrice')),
      costSource: String(fd.get('costSource') || ''),
      sellPrice: fd.get('sellPrice') === '' ? '' : Number(fd.get('sellPrice')),
      mrp: fd.get('mrp') === '' ? '' : Number(fd.get('mrp')),
      mrpSource: String(fd.get('mrpSource') || ''),
      supplier: String(fd.get('supplier') || '').trim(),
      location: String(fd.get('location') || '').trim(),
      source: String(fd.get('source')),
      demo: false,
      createdAt: now,
      updatedAt: now
    };
    setBusy(true);
    try {
      await store.upsertBatch(batch);
      toast('Saved: ' + batch.name + ' (' + batch.batchNo + ')', 'ok');
      f.reset();
      goStep(1);
      await refresh(true);
      showTab('dashboard');
    } catch (e) {
      if (e.unauthorized) { signOut('Session expired — please sign in again'); return; }
      toast('Save failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- Barcode camera (BarcodeDetector) ----------------
  let scanStream = null, scanning = false;
  async function startScan() {
    const dlg = $('#scanDialog');
    try {
      if (!('BarcodeDetector' in window)) throw new Error('this browser has no barcode reader — type or search instead');
      const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'qr_code', 'data_matrix'] });
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = $('#scanVideo');
      video.srcObject = scanStream;
      await video.play();
      dlg.showModal();
      scanning = true;
      const loop = async function () {
        if (!scanning) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) { stopScan(); onCode(codes[0].rawValue); return; }
        } catch (e) { /* keep trying */ }
        requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {
      stopScan();
      toast('Camera scan not available: ' + e.message, 'error');
    }
  }
  function stopScan() {
    scanning = false;
    if (scanStream) scanStream.getTracks().forEach(function (t) { t.stop(); });
    scanStream = null;
    const dlg = $('#scanDialog');
    if (dlg.open) dlg.close();
  }

  // ---------------- Actions (sold / returned / disposed) ----------------
  function openAction(id, type) {
    const b = state.batches.find(function (x) { return x.id === id; });
    if (!b) return;
    state.actionBatch = b;
    const days = Calc.daysToExpiry(b.expiry);
    $('#actionTitle').textContent = b.name + ' · ' + b.batchNo;
    $('#actionInfo').textContent = 'On shelf: ' + plural(b.qty, 'unit', 'units') + ' · Cost ' + rs(b.costPrice) + '/unit · Expiry ' +
      fmtDate(Calc.parseExpiry(b.expiry)) + ' (' + daysLabel(days) + ')' + (b.demo ? ' · DEMO' : '');
    const f = $('#actionForm');
    f.reset();
    f.elements.type.value = type || (days !== null && days < 0 ? 'DISPOSED' : 'SOLD');
    f.elements.qty.value = 1;
    updateQtyLabel();
    $('#actionDialog').showModal();
  }

  function updateQtyLabel() {
    const f = $('#actionForm');
    const adj = f.elements.type.value === 'ADJUST';
    $('#qtyLabel').textContent = adj ? 'New counted quantity on shelf (units)' : 'Quantity (units)';
    if (adj) { f.elements.qty.removeAttribute('max'); if (state.actionBatch) f.elements.qty.value = state.actionBatch.qty; }
    else if (state.actionBatch) f.elements.qty.max = state.actionBatch.qty;
  }

  function onStep(e) {
    const btn = e.target.closest('[data-step]');
    if (!btn) return;
    const input = $('#actionForm').elements.qty;
    const max = input.max === '' ? Infinity : Number(input.max);
    input.value = Math.max(0, Math.min(max, (Number(input.value) || 0) + Number(btn.dataset.step)));
  }

  async function onActionSubmit(ev) {
    ev.preventDefault();
    const b = state.actionBatch;
    if (!b) return;
    const f = ev.target;
    const type = f.elements.type.value;
    const qtyIn = Number(f.elements.qty.value);
    if (!(qtyIn >= 0)) { toast('Enter a quantity', 'error'); return; }

    let moved, newQty;
    if (type === 'ADJUST') {
      newQty = qtyIn;
      moved = b.qty - qtyIn;            // positive = units missing
    } else {
      if (qtyIn > b.qty) { toast('Only ' + b.qty + ' units on the shelf', 'error'); return; }
      moved = qtyIn;
      newQty = b.qty - qtyIn;
    }
    const days = Calc.daysToExpiry(b.expiry);
    const event = {
      id: newId('E'),
      ts: new Date().toISOString(),
      batchId: b.id, name: b.name, batchNo: b.batchNo,
      type: type,
      qty: moved,
      unitCost: b.costPrice,
      value: Math.round(moved * b.costPrice * 100) / 100,
      daysToExpiry: days,
      note: String(f.elements.note.value || '').trim(),
      demo: !!b.demo,
      by: session.name
    };
    const updated = Object.assign({}, b, { qty: newQty, updatedAt: event.ts });
    setBusy(true);
    try {
      await store.addEvent(event, updated);
      $('#actionDialog').close();
      toast('Recorded: ' + plural(Math.abs(moved), 'unit', 'units') + ' · ' + rs(Math.abs(event.value)), 'ok');
      await refresh(true);
    } catch (e) {
      if (e.unauthorized) { signOut('Session expired — please sign in again'); return; }
      toast('Save failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteBatch() {
    const b = state.actionBatch;
    if (!b || !isOwner()) return;
    $('#actionDialog').close();
    if (!await ask('Delete batch ' + b.batchNo + ' of ' + b.name + '? Use this only for typing mistakes.', 'Delete batch')) return;
    setBusy(true);
    try {
      await store.deleteBatch(b.id);
      toast('Batch deleted', 'ok');
      await refresh(true);
    } catch (e) {
      toast('Delete failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- CSV export ----------------
  function exportCsv() {
    const enriched = Calc.enrich(state.batches, settings);
    const head = ['Medicine', 'Strength', 'Barcode', 'Batch', 'Expiry', 'Days left', 'Status', 'Qty (units)',
      'Cost per unit (Rs)', 'Cost source', 'Sell per unit (Rs)', 'MRP (Rs)', 'MRP source', 'Value at cost (Rs)', 'Supplier', 'Shelf', 'Entry source', 'Demo'];
    const lines = [head].concat(enriched.map(function (b) {
      return [b.name, b.strength, b.barcode, b.batchNo, b.expiry, b.daysLeft, b.status, b.qty,
        b.costPrice, b.costSource, b.sellPrice, b.mrp, b.mrpSource, b.value.toFixed(2), b.supplier, b.location, b.source, b.demo ? 'DEMO' : ''];
    }));
    const csv = lines.map(function (r) {
      return r.map(function (c) { return '"' + String(c === null || c === undefined ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'medsafe-stock-' + Calc.toISODate(new Date()) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------- Settings ----------------
  function fillSettingsForm() {
    const f = $('#settingsForm');
    f.elements.pharmacyName.value = settings.pharmacyName;
    f.elements.criticalDays.value = settings.criticalDays;
    f.elements.warningDays.value = settings.warningDays;
    f.elements.marginPct.value = settings.marginPct;
    f.elements.apiUrl.value = settings.apiUrl;
  }

  async function onSettingsSubmit(ev) {
    ev.preventDefault();
    if (!isOwner()) { toast('Only the owner can change settings', 'error'); return; }
    const f = ev.target;
    const c = Number(f.elements.criticalDays.value);
    const w = Number(f.elements.warningDays.value);
    if (!(c > 0 && w > c)) { toast('Warning window must be longer than the critical window', 'error'); return; }
    const margin = Number(f.elements.marginPct.value);
    if (!(margin >= 0 && margin < 100)) { toast('Margin must be between 0 and 99 %', 'error'); return; }
    const apiUrl = f.elements.apiUrl.value.trim();
    if (apiUrl && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(apiUrl)) {
      toast('API URL should look like https://script.google.com/macros/s/…/exec', 'error');
      return;
    }
    const modeChanged = apiUrl !== settings.apiUrl;
    settings = Object.assign({}, settings, { pharmacyName: f.elements.pharmacyName.value.trim(), criticalDays: c, warningDays: w, marginPct: margin, apiUrl: apiUrl });
    saveSettings(settings);
    toast(modeChanged ? 'Saved — sign out and in again to use the new server' : 'Settings saved', 'ok');
    render();
  }

  async function onTestApi() {
    const url = $('#settingsForm').elements.apiUrl.value.trim();
    if (!url) { toast('No URL entered — the DEMO pharmacy runs in this browser', 'error'); return; }
    setBusy(true);
    try {
      const r = await window.makeStore(url, function () { return session && session.mode === 'sheet' ? session.token : ''; }).ping();
      toast('Connected: ' + (r.sheet || 'Google Sheet') + ' (' + (r.batches || 0) + ' batches)', 'ok');
    } catch (e) {
      toast('Connection failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onLoadDemo() {
    if (!isOwner()) return;
    if (!state.catalogue.length) await loadCatalogue();
    if (!await ask('Load the DEMO pharmacy? 35 DEMO batches + 10 DEMO actions, built from real NMRA prices. Every demo row is marked DEMO and can be cleared later.', 'Load demo')) return;
    const d = DemoData.build(state.catalogue, { marginPct: settings.marginPct });
    setBusy(true);
    try {
      await store.upsertBatches(d.batches);
      const existing = new Set(state.events.map(function (e) { return e.id; }));
      const newEvents = d.events.filter(function (e) { return !existing.has(e.id); });
      if (newEvents.length) await store.addEvents(newEvents);
      toast('Demo pharmacy loaded', 'ok');
      await refresh(true);
      showTab('dashboard');
    } catch (e) {
      toast('Could not load demo: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onClearDemo() {
    if (!isOwner()) return;
    if (!await ask('Remove all DEMO batches and DEMO actions?', 'Clear demo data')) return;
    setBusy(true);
    try {
      await store.clearDemo();
      toast('Demo data removed', 'ok');
      await refresh(true);
    } catch (e) {
      toast('Could not remove demo data: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- Wire up ----------------
  function init() {
    $('#goSignIn').addEventListener('click', function () { showScreen('login'); });
    $('#goDemo').addEventListener('click', async function () {
      try { await signIn('DEMO', '1234', ''); enterApp(); } catch (e) { toast(e.message, 'error'); }
    });
    $('#loginBack').addEventListener('click', function () { showScreen('start'); });
    $('#loginForm').addEventListener('submit', onLoginSubmit);
    $('#logoutBtn').addEventListener('click', function () { signOut(); });

    $$('.nav-item').forEach(function (t) { t.addEventListener('click', function () { showTab(t.dataset.tab); }); });
    $('#refreshBtn').addEventListener('click', function () { refresh(false); });

    $('#productSearch').addEventListener('input', onProductInput);
    $('#productSearch').addEventListener('keydown', onProductKey);
    $('#productList').addEventListener('mousedown', function (e) {
      const li = e.target.closest('[data-i]');
      if (li) { e.preventDefault(); pickProduct(comboItems[Number(li.dataset.i)]); }
    });
    $('#productSearch').addEventListener('blur', function () { setTimeout(closeCombo, 150); });
    $('#manualBtn').addEventListener('click', function () { pickProduct(null); });
    $('#addBack').addEventListener('click', function () { goStep(1); });
    $('#addForm').addEventListener('submit', onAddSubmit);
    $('#scanBtn').addEventListener('click', startScan);
    $('#scanClose').addEventListener('click', stopScan);
    $('#scanDialog').addEventListener('cancel', stopScan);

    $('#search').addEventListener('input', render);
    $('#statusFilter').addEventListener('change', render);
    $('#exportBtn').addEventListener('click', exportCsv);
    $('#settingsForm').addEventListener('submit', onSettingsSubmit);
    $('#testApiBtn').addEventListener('click', onTestApi);
    $('#loadSampleBtn').addEventListener('click', onLoadDemo);
    $('#clearSampleBtn').addEventListener('click', onClearDemo);
    $('#actionForm').addEventListener('submit', onActionSubmit);
    $('#actionType').addEventListener('change', updateQtyLabel);
    $('#actionForm').addEventListener('click', onStep);
    $('#actionCancel').addEventListener('click', function () { $('#actionDialog').close(); });
    $('#deleteBatchBtn').addEventListener('click', onDeleteBatch);

    // Delegated: batch rows, "go to" links and commands
    document.addEventListener('click', function (e) {
      const row = e.target.closest('[data-act]');
      if (row) { openAction(row.getAttribute('data-act')); return; }
      const go = e.target.closest('[data-goto]');
      if (go) { showTab(go.getAttribute('data-goto')); return; }
      const cmd = e.target.closest('[data-cmd]');
      if (cmd && cmd.dataset.cmd === 'loadDemo') onLoadDemo();
    });

    // Re-check day counts after midnight / every 5 minutes
    setInterval(function () { if (session && state.loaded) render(); }, 5 * 60 * 1000);

    if (session) { store = makeSessionStore(); enterApp(); }
    else if (location.hash === '#demo') signIn('DEMO', '1234', '').then(enterApp);   // deep link for the panel
    else showScreen('start');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
