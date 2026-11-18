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
    returnWindowDays: 60,   // ASSUMPTION — ask each supplier
    business: { monthlyLoss: '', monthlyLossSource: '', sharePct: 50, shareSource: 'ASSUMPTION — replace with the measured recovery rate',
      packagePrice: '', priceSource: '', yearlySupport: '', supportSource: '' },
    apiUrl: (window.MS_CONFIG && window.MS_CONFIG.API_URL) || ''
  };
  // Settings shared through the Google Sheet (owner edits). apiUrl stays per browser.
  const SHARED_KEYS = ['pharmacyName', 'criticalDays', 'warningDays', 'marginPct', 'returnWindowDays', 'business'];
  const TITLES = {
    dashboard: 'Dashboard', add: 'Scan & add stock', stock: 'Stock', cold: 'Cold chain', more: 'More',
    log: 'Action log', settings: 'Settings', business: 'Business case', sources: 'Sources & assumptions'
  };
  const MORE_TABS = ['more', 'log', 'settings', 'business', 'sources'];
  const SYNC_MS = 60 * 1000;

  let settings = loadSettings();
  let session = loadSession();
  let store = null;
  const state = { batches: [], events: [], catalogue: [], lastSync: null, loaded: false, actionBatch: null, tab: 'dashboard' };

  // ---------------- Settings ----------------
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      return normaliseSettings(saved);
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function numOr(v, d) { return v !== '' && v !== null && v !== undefined && isFinite(Number(v)) ? Number(v) : d; }
  function normaliseSettings(saved) {
    const s = Object.assign({}, DEFAULTS, saved);
    s.business = Object.assign({}, DEFAULTS.business, (saved && saved.business) || {});
    s.criticalDays = Number(s.criticalDays) || DEFAULTS.criticalDays;
    s.warningDays = Number(s.warningDays) || DEFAULTS.warningDays;
    s.marginPct = numOr(s.marginPct, DEFAULTS.marginPct);
    s.returnWindowDays = numOr(s.returnWindowDays, DEFAULTS.returnWindowDays);
    return s;
  }
  function sharedSettings() {
    const o = {};
    SHARED_KEYS.forEach(function (k) { o[k] = settings[k]; });
    return o;
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
    $$('#settingsForm input, #settingsForm button, #loadSampleBtn, #clearSampleBtn, #bizForm input, #bizForm button').forEach(function (el) { el.disabled = !isOwner(); });
    $('#ownerOnlyNote').hidden = isOwner();
    $('#bizStaffNote').hidden = isOwner();
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
      if (d.settings && Object.keys(d.settings).length) {
        settings = normaliseSettings(Object.assign({}, settings, d.settings, { apiUrl: settings.apiUrl }));
        saveSettings(settings);
      }
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
    renderReturns(enriched);
    renderBusiness();
    renderSources();
  }

  // ---------------- Supplier returns ----------------
  let returnsText = '';
  function renderReturns(enriched) {
    const plan = Calc.returnPlan(enriched, settings);
    const asOf = new Date();
    let html = '';
    const lines = ['MedSafe — supplier returns (as of ' + fmtDateTime(asOf) + ' Sri Lanka time)', 'Return by = expiry − ' + settings.returnWindowDays + ' days (ASSUMPTION).'];
    plan.groups.forEach(function (g) {
      html += '<div class="ret-group"><h3><span>' + esc(g.supplier) + '</span><span>' + rs(g.value) + '</span></h3><ul>' +
        g.items.map(function (b) {
          return '<li><span>' + esc(b.name) + ' ' + esc(b.strength) + demoChip(b) + '<span class="sub muted"> · ' + esc(b.batchNo) + ' · ' + plural(b.qty, 'unit', 'units') + '</span></span>' +
            '<span class="when' + (b.daysToReturn <= 7 ? ' soon' : '') + '">by ' + fmtDate(b.returnBy) + '</span></li>';
        }).join('') + '</ul></div>';
      lines.push('', '*' + g.supplier + '* (' + rs(g.value) + ' at cost)');
      g.items.forEach(function (b) {
        lines.push('• ' + b.name + ' ' + b.strength + ' — batch ' + b.batchNo + ', ' + plural(b.qty, 'unit', 'units') + ', exp ' + fmtDate(b.expiryDate) + ' → return by ' + fmtDate(b.returnBy) + (b.demo ? ' [DEMO]' : ''));
      });
    });
    if (!plan.groups.length) html = '<p class="empty">No supplier returns due in the next ' + Math.max(0, settings.warningDays - settings.returnWindowDays) + ' days.</p>';
    if (plan.passed.batches) {
      html += '<p class="ret-passed">' + plural(plan.passed.batches, 'batch is', 'batches are') + ' past the return window (' + rs(plan.passed.value) + ') — sell first or ask the supplier.</p>';
    }
    $('#returnsBody').innerHTML = html;
    $('#copyReturnsBtn').hidden = !plan.groups.length;
    returnsText = lines.join('\n');
  }

  async function copyReturns() {
    try {
      await navigator.clipboard.writeText(returnsText);
    } catch (e) {
      const t = document.createElement('textarea');
      t.value = returnsText; document.body.appendChild(t); t.select();
      document.execCommand('copy'); t.remove();
    }
    toast('Copied — paste it into WhatsApp', 'ok');
  }

  // ---------------- Business case ----------------
  const BIZ_FIELDS = ['monthlyLoss', 'monthlyLossSource', 'sharePct', 'shareSource', 'packagePrice', 'priceSource', 'yearlySupport', 'supportSource'];
  function renderBusiness() {
    const b = settings.business;
    const f = $('#bizForm');
    if (!f.contains(document.activeElement)) BIZ_FIELDS.forEach(function (k) { f.elements[k].value = b[k] === undefined ? '' : b[k]; });
    const out = Calc.businessCase(b);
    $('#bYearlyLoss').textContent = out.yearlyLoss === null ? 'Enter monthly loss' : rs(out.yearlyLoss) + ' / year';
    $('#bYearlySaving').textContent = out.yearlySaving === null ? '—' : rs(out.yearlySaving) + ' / year';
    $('#bPayback').textContent = out.paybackMonths === null ? 'Enter price' : out.paybackMonths.toFixed(1) + ' months';
    $('#bNet3y').textContent = out.net3y === null ? '—' : rs(out.net3y);
    $('#bSources').textContent = 'Sources — monthly loss: ' + (b.monthlyLossSource || 'not given') + ' · share prevented: ' + (b.shareSource || 'not given') +
      ' · price: ' + (b.priceSource || 'not given') + ' · support: ' + (b.supportSource || 'not given') + '.';
    const im = Calc.impact(state.events, settings);
    $('#useRateBtn').disabled = !isOwner() || im.rate === null;
    $('#useRateHint').textContent = im.rate === null ? 'No actions recorded yet.' : 'Measured from the action log: ' + im.rate.toFixed(1) + ' %' + (state.events.some(function (e) { return e.demo === true || e.demo === 'TRUE'; }) ? ' (includes DEMO actions)' : '') + '.';
  }

  function onUseRate() {
    const im = Calc.impact(state.events, settings);
    if (im.rate === null) return;
    const f = $('#bizForm');
    f.elements.sharePct.value = Math.round(im.rate * 10) / 10;
    f.elements.shareSource.value = 'Measured recovery rate from the MedSafe action log (' + fmtDateTime(new Date()) + ')';
  }

  async function onBizSubmit(ev) {
    ev.preventDefault();
    if (!isOwner()) { toast('Only the owner can edit the business case', 'error'); return; }
    const f = ev.target;
    const b = {};
    BIZ_FIELDS.forEach(function (k) { b[k] = f.elements[k].value.trim(); });
    if (Number(b.sharePct) > 100 || Number(b.sharePct) < 0) { toast('Share prevented must be 0–100 %', 'error'); return; }
    settings = Object.assign({}, settings, { business: b });
    await persistSettings('Business case saved');
  }

  /** Save settings locally, and to the Google Sheet when live. */
  async function persistSettings(msg) {
    saveSettings(settings);
    if (store && store.mode === 'sheet') {
      setBusy(true);
      try { await store.saveSettings(sharedSettings()); } catch (e) { toast('Saved here, but not on the server: ' + e.message, 'error'); setBusy(false); render(); return; }
      setBusy(false);
    }
    toast(msg, 'ok');
    render();
  }

  // ---------------- Sources & assumptions ----------------
  function renderSources() {
    const b = settings.business;
    const src = [
      ['Medicine prices (MRP, Rs per unit)', 'NMRA — Maximum Retail Price Gazette Extraordinary No. 2336/53, 15 Jun 2023 (data/nmra_mrp_2023.csv → catalogue.json)', 'MRP on every product; cost when the invoice price is unknown'],
      ['Fridge safe range 2–8 °C', 'WHO vaccine / insulin storage range (refrigerated 2–8 °C)', 'Cold-chain status and minutes out of range'],
      ['DEMO barcodes (EAN-13 200…)', 'GS1 Restricted Circulation Numbers: prefixes 200–299 are for in-store use only', 'DEMO catalogue codes and printed DEMO labels — never real products'],
      ['GS1 DataMatrix fields', 'GS1 General Specifications — AI 01 GTIN, 17 expiry (DD 00 = month end), 10 batch, 21 serial', 'Reading real medicine packs'],
      ['Stock batches and actions', 'Entered by the pharmacy — each batch stores how it was entered and where the cost came from', 'Every dashboard number'],
      ['Monthly expired loss', b.monthlyLossSource || 'Stakeholder input — not entered yet', 'Business case'],
      ['Package price / support', [b.priceSource, b.supportSource].filter(Boolean).join(' · ') || 'Not entered yet', 'Business case']
    ];
    $('#sourcesBody').innerHTML = src.map(function (r) { return '<tr><td><strong>' + esc(r[0]) + '</strong></td><td>' + esc(r[1]) + '</td><td class="muted">' + esc(r[2]) + '</td></tr>'; }).join('');
    const asm = [
      ['Critical window', settings.criticalDays + ' days', 'Settings — ask the pharmacist'],
      ['Warning window', settings.warningDays + ' days', 'Settings — ask the pharmacist'],
      ['Pharmacy margin (cost = MRP × (1 − margin))', settings.marginPct + ' %', 'Settings — replace with the figure from the field visit'],
      ['Supplier return window', settings.returnWindowDays + ' days', 'Settings — ask each supplier'],
      ['Share of expired loss prevented', (b.sharePct === '' ? '—' : b.sharePct + ' %'), 'Business case — or press “use measured recovery rate”'],
      ['Box shows month/year only', 'Last day of that month', 'Fixed rule — stated in the “days left” formula'],
      ['DEMO pharmacy', '35 batches · 10 actions · 4 suppliers', 'Generated deterministically from the catalogue; clear before real data']
    ];
    $('#assumptionsBody').innerHTML = asm.map(function (r) { return '<tr><td><span class="chip asm">ASSUMPTION</span> ' + esc(r[0]) + '</td><td class="num"><strong>' + esc(r[1]) + '</strong></td><td class="muted">' + esc(r[2]) + '</td></tr>'; }).join('');
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
        '<p>Cost pre-filled as ' + rs(Calc.costFromMrp(p.mrp, settings.marginPct)) + ' = MRP × (1 − ' + settings.marginPct + '%) <span class="chip asm">ASSUMPTION</span> — replace with the invoice price if you have it.</p>' : '') +
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

  // ---------------- Scan router ----------------
  function productByEan(ean) {
    if (!ean) return null;
    return products().filter(function (x) { return x.ean && String(x.ean) === String(ean); })[0] || null;
  }
  function findBatch(batchNo, ean) {
    return state.batches.filter(function (b) {
      return String(b.batchNo).toUpperCase() === String(batchNo).toUpperCase() && (!ean || !b.barcode || String(b.barcode) === String(ean));
    })[0] || null;
  }
  function expiryParts(expiry) {
    const m = /^(\d{4}-\d{2})(?:-(\d{2}))?$/.exec(expiry || '');
    return m ? { expiry: m[1], expiryDay: m[2] ? String(Number(m[2])) : '' } : {};
  }

  /**
   * Route any scanned text:
   *  a) MedSafe label QR  MS1|batch|ean|YYYY-MM|qty|supplier|shelf → existing batch: quick actions; new: one-tap add
   *  b) GS1 DataMatrix / GS1-128 (AI 01, 17, 10, 21) → pre-filled batch form (or the batch if it exists)
   *  c) EAN-13 / other barcode → catalogue product → batch form
   */
  function onCode(raw) {
    const code = String(raw || '').trim();
    if (!code || !session) return;
    if ($('#actionDialog').open) $('#actionDialog').close();
    if ($('#labelDialog').open) $('#labelDialog').close();

    const ms = Codes.parseMs1(code);
    if (ms) { onMs1(ms); return; }

    const g = Codes.parseGs1(code);
    if (g) {
      const ean = g.ean13 || g.gtin;
      const existing = g.batch ? findBatch(g.batch, ean) : null;
      if (existing) { openAction(existing.id); toast('GS1 code: batch ' + g.batch + ' is already in stock', 'ok'); return; }
      const extra = Object.assign({ batchNo: g.batch, barcode: ean, source: 'Scanned barcode / label' }, expiryParts(g.expiry));
      showTab('add');
      pickProduct(productByEan(ean), extra);
      toast('GS1 code read: ' + [g.gtin && 'GTIN ' + g.gtin, g.batch && 'batch ' + g.batch, g.expiry && 'exp ' + g.expiry, g.serial && 'serial ' + g.serial].filter(Boolean).join(' · '), 'ok');
      return;
    }

    showTab('add');
    const p = productByEan(code);
    if (p) { pickProduct(p, { source: 'Scanned barcode / label' }); toast('Found: ' + p.name + ' ' + p.strength, 'ok'); return; }
    pickProduct(null, { barcode: code, source: 'Scanned barcode / label' });
    toast('New barcode ' + code + ' — enter the product details once', '');
  }

  let pendingLabel = null;
  function onMs1(ms) {
    const existing = findBatch(ms.batchNo, ms.ean);
    if (existing) { openAction(existing.id); toast('Label scanned: ' + existing.name + ' · ' + existing.batchNo, 'ok'); return; }
    const p = productByEan(ms.ean);
    const isDemo = /^DM[ON]-/.test(ms.batchNo);
    const cost = p && p.mrp ? Calc.costFromMrp(p.mrp, settings.marginPct) : '';
    const now = new Date().toISOString();
    pendingLabel = {
      id: newId('B'),
      name: p ? p.name : 'Unknown product (' + ms.ean + ')', strength: p ? p.strength : '', form: p ? p.form : '',
      barcode: ms.ean, batchNo: ms.batchNo, expiry: ms.expiry, qty: ms.qty,
      costPrice: cost, costSource: p && p.mrp ? DemoData.costSourceText(settings.marginPct) : '',
      sellPrice: p ? p.mrp : '', mrp: p ? p.mrp : '', mrpSource: p ? p.mrpSource : '',
      supplier: ms.supplier, location: ms.shelf, source: 'Scanned MedSafe label', demo: isDemo, createdAt: now, updatedAt: now
    };
    const b = pendingLabel;
    $('#labelBody').innerHTML =
      '<h3>' + esc(b.name) + ' <span class="muted">' + esc(b.strength) + '</span>' + demoChip(b) + '</h3>' +
      '<dl class="kv">' +
      '<dt>Batch</dt><dd>' + esc(b.batchNo) + '</dd>' +
      '<dt>Expiry</dt><dd>' + fmtDate(Calc.parseExpiry(b.expiry)) + ' (' + daysLabel(Calc.daysToExpiry(b.expiry)) + ')</dd>' +
      '<dt>Quantity</dt><dd>' + plural(b.qty, 'unit', 'units') + '</dd>' +
      '<dt>Supplier</dt><dd>' + esc(b.supplier || '—') + '</dd>' +
      '<dt>Shelf</dt><dd>' + esc(b.location || '—') + '</dd>' +
      (b.mrp ? '<dt>MRP</dt><dd>' + rs(b.mrp) + '/unit <span class="source-note">' + esc(b.mrpSource) + '</span></dd>' : '') +
      (cost !== '' ? '<dt>Cost</dt><dd>' + rs(cost) + '/unit <span class="chip asm">ASSUMPTION</span> <span class="source-note">MRP × (1 − ' + settings.marginPct + '%)</span></dd>' : '') +
      '</dl>';
    $('#labelAdd').disabled = !p;
    $('#labelDialog').showModal();
    $('#labelAdd').focus();
  }

  async function onLabelAdd() {
    if (!pendingLabel) return;
    const b = pendingLabel;
    if (await saveNewBatch(b)) { $('#labelDialog').close(); pendingLabel = null; }
  }

  function onLabelEdit() {
    const b = pendingLabel;
    $('#labelDialog').close();
    if (!b) return;
    showTab('add');
    pickProduct(productByEan(b.barcode), Object.assign({ batchNo: b.batchNo, qty: b.qty, supplier: b.supplier, location: b.location, barcode: b.barcode, source: 'Scanned barcode / label' }, expiryParts(b.expiry)));
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
    const batchNo = String(fd.get('batchNo')).trim();
    const batch = {
      id: newId('B'),
      name: String(fd.get('name')).trim(),
      strength: String(fd.get('strength') || '').trim(),
      form: String(fd.get('form') || '').trim(),
      barcode: String(fd.get('barcode') || '').trim(),
      batchNo: batchNo,
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
      demo: /^DM[ON]-/.test(batchNo),
      createdAt: now,
      updatedAt: now
    };
    if (await saveNewBatch(batch)) {
      f.reset();
      goStep(1);
      showTab('dashboard');
    }
  }

  /**
   * Entry checks before saving: qty < 0 blocks; duplicate (name + batch no.), expiry already passed
   * and cost 0 each ask for confirmation. Returns true to go ahead.
   */
  async function entryChecks(batch) {
    if (!(Number(batch.qty) >= 0)) { toast('Quantity cannot be negative', 'error'); return false; }
    const dup = state.batches.some(function (b) {
      return String(b.name).trim().toLowerCase() === batch.name.trim().toLowerCase() && String(b.batchNo).trim().toUpperCase() === batch.batchNo.trim().toUpperCase();
    });
    if (dup && !await ask(batch.name + ' batch ' + batch.batchNo + ' is already in stock. Add it again as a separate row?', 'Add anyway')) return false;
    const days = Calc.daysToExpiry(batch.expiry);
    if (days !== null && days < 0 && !await ask('This batch expired ' + plural(Math.abs(days), 'day', 'days') + ' ago. Record it anyway (e.g. to dispose of it)?', 'Record expired batch')) return false;
    if (!(Number(batch.costPrice) > 0) && !await ask('Cost price is Rs 0.00, so this batch will not count in any rupee total. Save anyway?', 'Save with Rs 0')) return false;
    return true;
  }

  /** Save a new batch (form or one-tap label). Returns true when saved. */
  async function saveNewBatch(batch) {
    if (!await entryChecks(batch)) return false;
    setBusy(true);
    try {
      await store.upsertBatch(batch);
      toast('Saved: ' + batch.name + ' (' + batch.batchNo + ') · ' + plural(batch.qty, 'unit', 'units'), 'ok');
      await refresh(true);
      return true;
    } catch (e) {
      if (e.unauthorized) { signOut('Session expired — please sign in again'); return false; }
      toast('Save failed: ' + e.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ---------------- Camera scanning (vendored html5-qrcode / ZXing) ----------------
  async function startScan() {
    const dlg = $('#scanDialog');
    $('#torchBtn').hidden = true;
    $('#scanError').textContent = '';
    dlg.showModal();
    try {
      await Scanner.open('scanRegion', function (text) {
        if (dlg.open) dlg.close();
        onCode(text);
      }, function (torch) { $('#torchBtn').hidden = !torch; });
    } catch (e) {
      $('#scanError').textContent = 'Camera not available: ' + (e && e.message ? e.message : e) + '. You can still search, type, or use a USB scanner.';
    }
  }
  function stopScan() {
    Scanner.close();
    const dlg = $('#scanDialog');
    if (dlg.open) dlg.close();
  }
  async function onTorch() {
    const on = await Scanner.toggleTorch();
    $('#torchBtn').setAttribute('aria-pressed', String(on));
    $('#torchBtn').textContent = on ? 'Torch off' : 'Torch on';
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
    f.elements.returnWindowDays.value = settings.returnWindowDays;
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
    const win = Number(f.elements.returnWindowDays.value);
    if (!(win >= 0)) { toast('Return window must be 0 days or more', 'error'); return; }
    const apiUrl = f.elements.apiUrl.value.trim();
    if (apiUrl && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(apiUrl)) {
      toast('API URL should look like https://script.google.com/macros/s/…/exec', 'error');
      return;
    }
    const modeChanged = apiUrl !== settings.apiUrl;
    settings = Object.assign({}, settings, { pharmacyName: f.elements.pharmacyName.value.trim(), criticalDays: c, warningDays: w, marginPct: margin, returnWindowDays: win, apiUrl: apiUrl });
    await persistSettings(modeChanged ? 'Saved — sign out and in again to use the new server' : 'Settings saved');
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
      const existing = new Set((await store.load()).events.map(function (e) { return e.id; }));
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
    $('#torchBtn').addEventListener('click', onTorch);
    $('#labelAdd').addEventListener('click', onLabelAdd);
    $('#labelEdit').addEventListener('click', onLabelEdit);
    $('#labelCancel').addEventListener('click', function () { $('#labelDialog').close(); pendingLabel = null; });
    // USB scanner: works on any screen once signed in (and inside the product search box)
    Scanner.listenUsb(function (code) { if (session && !$('#appRoot').hidden) onCode(code); },
      function (el) { return el.id === 'productSearch'; });

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

    $('#copyReturnsBtn').addEventListener('click', copyReturns);
    $('#bizForm').addEventListener('submit', onBizSubmit);
    $('#useRateBtn').addEventListener('click', onUseRate);

    // Auto-refresh every 60 s while the tab is visible (and straight away when it comes back)
    setInterval(function () {
      if (session && store && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) refresh(true);
    }, SYNC_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && session && store && state.lastSync && Date.now() - state.lastSync > SYNC_MS) refresh(true);
    });

    if (session) { store = makeSessionStore(); enterApp(); }
    else if (location.hash === '#demo') signIn('DEMO', '1234', '').then(enterApp);   // deep link for the panel
    else showScreen('start');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
