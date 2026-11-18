/**
 * MedSafe — app (UI + events)
 */
(function () {
  'use strict';

  const $ = function (s, el) { return (el || document).querySelector(s); };
  const $$ = function (s, el) { return Array.from((el || document).querySelectorAll(s)); };

  const LS_SETTINGS = 'ms_settings_v1';
  const DEFAULTS = {
    pharmacyName: '',
    criticalDays: 30,
    warningDays: 90,
    apiUrl: (window.MS_CONFIG && window.MS_CONFIG.API_URL) || ''
  };

  let settings = loadSettings();
  let store = window.makeStore(settings.apiUrl);
  const state = { batches: [], events: [], lastSync: null, actionBatch: null };

  // ---------------- Helpers ----------------
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      const s = Object.assign({}, DEFAULTS, saved);
      s.criticalDays = Number(s.criticalDays) || DEFAULTS.criticalDays;
      s.warningDays = Number(s.warningDays) || DEFAULTS.warningDays;
      return s;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }

  function saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function rs(n) {
    return 'Rs ' + Number(n || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function int(n) { return Number(n || 0).toLocaleString('en-LK'); }
  function batchesTxt(n) { return n + (n === 1 ? ' batch' : ' batches'); }

  function fmtDate(d) {
    if (!d) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function newId(prefix) {
    const r = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
    return prefix + '-' + Date.now().toString(36) + '-' + r;
  }

  function daysLabel(d) {
    if (d === null || d === undefined) return '—';
    if (d < 0) return Math.abs(d) + ' days ago';
    if (d === 0) return 'Today';
    return d + ' days';
  }

  const STATUS_TEXT = { expired: 'Expired', critical: 'Critical', warning: 'Warning', ok: 'OK', unknown: 'No date' };

  function statusChip(s) { return '<span class="chip ' + s + '">' + STATUS_TEXT[s] + '</span>'; }
  function sampleChip(b) { return b.sample ? ' <span class="chip sample">SAMPLE</span>' : ''; }

  let toastTimer;
  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 3500);
  }

  function setBusy(on) { document.body.classList.toggle('busy', !!on); }

  // ---------------- Data ----------------
  async function refresh(silent) {
    setBusy(true);
    try {
      const d = await store.load();
      state.batches = d.batches.map(normaliseBatch);
      state.events = d.events;
      state.lastSync = new Date();
      render();
      if (!silent) toast('Data loaded', 'ok');
    } catch (e) {
      console.error(e);
      toast('Could not load data: ' + e.message, 'error');
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
      sample: b.sample === true || b.sample === 'TRUE' || b.sample === 'true'
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
  }

  function renderHeader() {
    $('#pharmacyName').textContent = settings.pharmacyName || 'Pharmacy expiry tracker';
    const badge = $('#modeBadge');
    badge.textContent = store.label;
    badge.className = 'mode-badge ' + store.mode;
    $('#asOf').textContent = state.lastSync
      ? 'Data as of ' + state.lastSync.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' (Sri Lanka time)'
      : 'Not loaded';
    $('#kCriticalTitle').textContent = 'Critical · 0–' + settings.criticalDays + ' days';
    $('#kWarningTitle').textContent = 'Warning · ' + (settings.criticalDays + 1) + '–' + settings.warningDays + ' days';
  }

  function renderFormulas() {
    $$('[data-formula]').forEach(function (p) {
      p.textContent = Calc.formula(p.getAttribute('data-formula'), settings);
    });
  }

  function renderDashboard(enriched) {
    const s = Calc.summary(enriched);

    $('#kExpiredVal').textContent = rs(s.expired.value);
    $('#kExpiredSub').textContent = batchesTxt(s.expired.batches) + ' · ' + int(s.expired.units) + ' units';
    $('#kCriticalVal').textContent = rs(s.critical.value);
    $('#kCriticalSub').textContent = batchesTxt(s.critical.batches) + ' · ' + int(s.critical.units) + ' units';
    $('#kWarningVal').textContent = rs(s.warning.value);
    $('#kWarningSub').textContent = batchesTxt(s.warning.batches) + ' · ' + int(s.warning.units) + ' units';
    $('#kTotalVal').textContent = rs(s.total.value);
    $('#kTotalSub').textContent = batchesTxt(s.total.batches) + ' · ' + int(s.total.units) + ' units';

    // 10-second headline
    const h = $('#headline');
    if (!state.batches.length) {
      h.className = 'headline empty';
      h.innerHTML = 'No stock recorded yet. Go to <strong>+ Add stock</strong>, or load sample data in Settings to try it.';
    } else if (s.expired.batches) {
      h.className = 'headline bad';
      h.innerHTML = '<strong>' + s.expired.batches + ' expired batch' + (s.expired.batches > 1 ? 'es' : '') + '</strong> still on the shelf (' + rs(s.expired.value) + '). Remove now for patient safety.';
    } else if (s.critical.batches) {
      h.className = 'headline warn';
      h.innerHTML = '<strong>' + rs(s.critical.value) + '</strong> of stock expires within ' + settings.criticalDays + ' days. Sell first or return to supplier.';
    } else {
      h.className = 'headline good';
      h.innerHTML = 'All good. Nothing expires in the next ' + settings.criticalDays + ' days.';
    }
    if (state.batches.some(function (b) { return b.sample; })) {
      h.innerHTML += ' <span class="chip sample">SAMPLE DATA LOADED</span>';
    }

    // FEFO list: everything not OK, earliest first (max 12)
    const list = Calc.fefo(enriched).filter(function (b) { return b.status !== 'ok'; }).slice(0, 12);
    $('#fefoBody').innerHTML = list.length ? list.map(function (b) {
      return '<tr class="row-' + b.status + '">' +
        '<td><strong>' + esc(b.name) + '</strong><br><span class="muted">' + esc(b.strength) + '</span>' + sampleChip(b) + '</td>' +
        '<td class="nowrap">' + esc(b.batchNo) + '</td>' +
        '<td>' + esc(b.location) + '</td>' +
        '<td>' + fmtDate(b.expiryDate) + '</td>' +
        '<td class="num">' + statusChip(b.status) + '<br>' + daysLabel(b.daysLeft) + '</td>' +
        '<td class="num">' + int(b.qty) + '</td>' +
        '<td class="num">' + rs(b.value) + '</td>' +
        '<td><button class="btn small" data-act="' + esc(b.id) + '">Action</button></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="8" class="muted center">Nothing near expiry within ' + settings.warningDays + ' days.</td></tr>';

    // Impact
    const im = Calc.impact(state.events, settings);
    $('#iRecovered').textContent = rs(im.recovered);
    $('#iRecoveredSub').textContent = int(im.recoveredUnits) + ' units sold or returned in time';
    $('#iLost').textContent = rs(im.lost);
    $('#iLostSub').textContent = int(im.lostUnits) + ' units disposed';
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

    $('#stockBody').innerHTML = rows.length ? rows.map(function (b) {
      const closed = b.qty <= 0;
      return '<tr class="' + (closed ? 'closed' : 'row-' + b.status) + '">' +
        '<td><strong>' + esc(b.name) + '</strong><br><span class="muted">' + esc(b.strength) + '</span>' + sampleChip(b) + '</td>' +
        '<td class="nowrap">' + esc(b.batchNo) + '</td>' +
        '<td>' + esc(b.location) + '</td>' +
        '<td>' + fmtDate(b.expiryDate) + '</td>' +
        '<td class="num">' + (closed ? '<span class="chip closed">Closed</span>' : statusChip(b.status)) + '<br>' + daysLabel(b.daysLeft) + '</td>' +
        '<td class="num">' + int(b.qty) + '</td>' +
        '<td class="num">' + rs(b.costPrice) + '</td>' +
        '<td class="num">' + rs(b.value) + '</td>' +
        '<td class="muted">' + esc(b.source) + '</td>' +
        '<td><button class="btn small" data-act="' + esc(b.id) + '">Action</button></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="10" class="muted center">No batches match.</td></tr>';
  }

  function renderLog() {
    const rows = state.events.slice().sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    const label = { SOLD: 'Sold', RETURNED: 'Returned to supplier', DISPOSED: 'Disposed (expired)', ADJUST: 'Count correction' };
    $('#logBody').innerHTML = rows.length ? rows.map(function (e) {
      const sample = (e.sample === true || e.sample === 'TRUE' || e.sample === 'true') ? ' <span class="chip sample">SAMPLE</span>' : '';
      return '<tr>' +
        '<td>' + fmtDateTime(e.ts) + '</td>' +
        '<td>' + esc(e.name) + sample + '</td>' +
        '<td>' + esc(e.batchNo) + '</td>' +
        '<td>' + esc(label[e.type] || e.type) + '</td>' +
        '<td class="num">' + int(e.qty) + '</td>' +
        '<td class="num">' + rs(e.value) + '</td>' +
        '<td class="num">' + daysLabel(e.daysToExpiry === '' ? null : Number(e.daysToExpiry)) + '</td>' +
        '<td class="muted">' + esc(e.note) + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="8" class="muted center">No actions recorded yet.</td></tr>';
  }

  // ---------------- Tabs ----------------
  function showTab(name) {
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    $$('.panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
    if (name === 'settings') fillSettingsForm();
  }

  // ---------------- Add stock ----------------
  async function onAddSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const fd = new FormData(f);
    const expiry = String(fd.get('expiry') || '');
    if (!Calc.parseExpiry(expiry)) { toast('Please enter a valid expiry month', 'error'); return; }
    const now = new Date().toISOString();
    const batch = {
      id: newId('B'),
      name: String(fd.get('name')).trim(),
      strength: String(fd.get('strength') || '').trim(),
      barcode: String(fd.get('barcode') || '').trim(),
      batchNo: String(fd.get('batchNo')).trim(),
      expiry: expiry,
      qty: Number(fd.get('qty')),
      costPrice: Number(fd.get('costPrice')),
      sellPrice: fd.get('sellPrice') === '' ? '' : Number(fd.get('sellPrice')),
      supplier: String(fd.get('supplier') || '').trim(),
      location: String(fd.get('location') || '').trim(),
      source: String(fd.get('source')),
      sample: false,
      createdAt: now,
      updatedAt: now
    };
    setBusy(true);
    try {
      await store.upsertBatch(batch);
      toast('Saved: ' + batch.name + ' (' + batch.batchNo + ')', 'ok');
      f.reset();
      await refresh(true);
      showTab('dashboard');
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // Auto-fill from an earlier batch with the same barcode
  function onBarcodeChange() {
    const code = $('#barcodeInput').value.trim();
    if (!code) return;
    const prev = state.batches.slice().reverse().find(function (b) { return String(b.barcode) === code; });
    if (!prev) return;
    const f = $('#addForm');
    ['name', 'strength', 'costPrice', 'sellPrice', 'supplier', 'location'].forEach(function (k) {
      if (f.elements[k] && !f.elements[k].value) f.elements[k].value = prev[k];
    });
    toast('Filled from earlier batch of ' + prev.name + ' — check the price is still correct', 'ok');
  }

  // ---------------- Barcode camera (Chrome on Android/macOS) ----------------
  let scanStream = null, scanning = false;
  async function startScan() {
    const dlg = $('#scanDialog');
    try {
      const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'upc_a', 'upc_e', 'qr_code'] });
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
          if (codes.length) {
            $('#barcodeInput').value = codes[0].rawValue;
            stopScan();
            onBarcodeChange();
            return;
          }
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
  function openAction(id) {
    const b = state.batches.find(function (x) { return x.id === id; });
    if (!b) return;
    state.actionBatch = b;
    const days = Calc.daysToExpiry(b.expiry);
    $('#actionTitle').textContent = b.name + ' · ' + b.batchNo;
    $('#actionInfo').textContent = 'On shelf: ' + int(b.qty) + ' units · Cost ' + rs(b.costPrice) + '/unit · Expiry ' +
      fmtDate(Calc.parseExpiry(b.expiry)) + ' (' + daysLabel(days) + ')';
    const f = $('#actionForm');
    f.reset();
    f.elements.type.value = days !== null && days < 0 ? 'DISPOSED' : 'SOLD';
    f.elements.qty.max = b.qty;
    updateQtyLabel();
    $('#actionDialog').showModal();
  }

  function updateQtyLabel() {
    const f = $('#actionForm');
    const adj = f.elements.type.value === 'ADJUST';
    $('#qtyLabel').textContent = adj ? 'New counted quantity on shelf (units)' : 'Quantity (units)';
    if (adj) f.elements.qty.removeAttribute('max');
    else if (state.actionBatch) f.elements.qty.max = state.actionBatch.qty;
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
      sample: !!b.sample
    };
    const updated = Object.assign({}, b, { qty: newQty, updatedAt: event.ts });
    setBusy(true);
    try {
      await store.addEvent(event, updated);
      $('#actionDialog').close();
      toast('Recorded', 'ok');
      await refresh(true);
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteBatch() {
    const b = state.actionBatch;
    if (!b) return;
    if (!window.confirm('Delete batch ' + b.batchNo + ' of ' + b.name + '? Use this only for typing mistakes.')) return;
    setBusy(true);
    try {
      await store.deleteBatch(b.id);
      $('#actionDialog').close();
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
      'Cost per unit (Rs)', 'Sell per unit (Rs)', 'Value at cost (Rs)', 'Supplier', 'Shelf', 'Source', 'Sample'];
    const lines = [head].concat(enriched.map(function (b) {
      return [b.name, b.strength, b.barcode, b.batchNo, b.expiry, b.daysLeft, b.status, b.qty,
        b.costPrice, b.sellPrice, b.value.toFixed(2), b.supplier, b.location, b.source, b.sample ? 'SAMPLE' : ''];
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
    f.elements.apiUrl.value = settings.apiUrl;
  }

  async function onSettingsSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const c = Number(f.elements.criticalDays.value);
    const w = Number(f.elements.warningDays.value);
    if (!(c > 0 && w > c)) { toast('Warning window must be longer than the critical window', 'error'); return; }
    const apiUrl = f.elements.apiUrl.value.trim();
    if (apiUrl && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(apiUrl)) {
      toast('API URL should look like https://script.google.com/macros/s/…/exec', 'error');
      return;
    }
    const modeChanged = apiUrl !== settings.apiUrl;
    settings = { pharmacyName: f.elements.pharmacyName.value.trim(), criticalDays: c, warningDays: w, apiUrl: apiUrl };
    saveSettings(settings);
    if (modeChanged) store = window.makeStore(settings.apiUrl);
    toast('Settings saved', 'ok');
    await refresh(true);
  }

  async function onTestApi() {
    const url = $('#settingsForm').elements.apiUrl.value.trim();
    if (!url) { toast('No URL entered — app is in local mode', 'error'); return; }
    setBusy(true);
    try {
      const r = await window.makeStore(url).ping();
      toast('Connected: ' + (r.sheet || 'Google Sheet') + ' (' + (r.batches || 0) + ' batches)', 'ok');
    } catch (e) {
      toast('Connection failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onLoadSample() {
    if (!window.confirm('Load 8 SAMPLE batches? They are clearly marked and can be removed later.')) return;
    const d = window.SampleData.build();
    setBusy(true);
    try {
      await store.upsertBatches(d.batches);
      const existing = new Set(state.events.map(function (e) { return e.id; }));
      const newEvents = d.events.filter(function (e) { return !existing.has(e.id); });
      if (newEvents.length) await store.addEvents(newEvents);
      toast('Sample data loaded', 'ok');
      await refresh(true);
      showTab('dashboard');
    } catch (e) {
      toast('Could not load sample: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onClearSample() {
    if (!window.confirm('Remove all SAMPLE batches and SAMPLE actions?')) return;
    setBusy(true);
    try {
      await store.clearSample();
      toast('Sample data removed', 'ok');
      await refresh(true);
    } catch (e) {
      toast('Could not remove sample: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- Wire up ----------------
  function init() {
    $$('.tab').forEach(function (t) { t.addEventListener('click', function () { showTab(t.dataset.tab); }); });
    $('#refreshBtn').addEventListener('click', function () { refresh(false); });
    $('#addForm').addEventListener('submit', onAddSubmit);
    $('#barcodeInput').addEventListener('change', onBarcodeChange);
    $('#search').addEventListener('input', render);
    $('#statusFilter').addEventListener('change', render);
    $('#exportBtn').addEventListener('click', exportCsv);
    $('#settingsForm').addEventListener('submit', onSettingsSubmit);
    $('#testApiBtn').addEventListener('click', onTestApi);
    $('#loadSampleBtn').addEventListener('click', onLoadSample);
    $('#clearSampleBtn').addEventListener('click', onClearSample);
    $('#actionForm').addEventListener('submit', onActionSubmit);
    $('#actionForm').elements.type.addEventListener('change', updateQtyLabel);
    $('#actionCancel').addEventListener('click', function () { $('#actionDialog').close(); });
    $('#deleteBatchBtn').addEventListener('click', onDeleteBatch);
    $('#scanClose').addEventListener('click', stopScan);
    $('#scanDialog').addEventListener('cancel', stopScan);

    // "Action" buttons in tables
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-act]');
      if (btn) openAction(btn.getAttribute('data-act'));
    });

    // Camera scan only where the browser supports it (needs https or localhost)
    if ('BarcodeDetector' in window && navigator.mediaDevices && window.isSecureContext) {
      $('#scanBtn').hidden = false;
      $('#scanBtn').addEventListener('click', startScan);
    }

    // Re-check day counts after midnight / every 5 minutes
    setInterval(function () { render(); }, 5 * 60 * 1000);

    refresh(true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
