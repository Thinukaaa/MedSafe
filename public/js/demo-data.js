/**
 * MedSafe — DEMO pharmacy (deterministic, no random numbers)
 * Products and MRPs are REAL (NMRA gazette, via catalogue.json).
 * Stock, batch numbers, suppliers, shelves and actions are DEMO and flagged demo:true everywhere.
 * Cost price = MRP × (1 − assumed margin) — an ASSUMPTION shown in Settings.
 */
(function (root) {
  'use strict';

  const Calc = root.Calc || (typeof require === 'function' ? require('./calc.js') : null);
  const Codes = root.Codes || (typeof require === 'function' ? require('./codes.js') : null);

  const N_BATCHES = 35;
  const OFFSETS = [-20, -3, 7, 15, 24, 38, 55, 72, 88, 120, 200, 400];   // days from today, cycled
  const QTYS = [12, 30, 6, 48, 20, 100, 15, 60, 24, 10, 36, 8, 90, 18];   // units on shelf, cycled
  const SUPPLIERS = ['Supplier A (DEMO)', 'Supplier B (DEMO)', 'Supplier C (DEMO)', 'Supplier D (DEMO)'];
  const ROWS = ['A', 'B', 'C', 'D'];
  // [batch index k, action, qty, days ago]
  const EVENTS = [
    [0, 'DISPOSED', 4, 2], [12, 'DISPOSED', 6, 1], [2, 'SOLD', 10, 3], [3, 'SOLD', 12, 4], [4, 'RETURNED', 20, 6],
    [5, 'SOLD', 24, 2], [15, 'SOLD', 6, 5], [6, 'RETURNED', 30, 8], [16, 'SOLD', 15, 1], [17, 'RETURNED', 8, 3]
  ];
  // Extra label-only batches (NOT in demo stock) so a live scan shows the "new delivery → Add to stock" flow
  const NEW_DELIVERIES = [[3, 270, 40], [11, 300, 24], [19, 330, 60], [26, 360, 30], [33, 390, 20], [40, 420, 50], [46, 240, 10], [50, 450, 36]];

  function pad(n, w) { return String(n).padStart(w, '0'); }

  function addDays(base, days) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    d.setDate(d.getDate() + days);
    return d;
  }

  /** k-th distinct catalogue index, stepping by 7 (coprime with most catalogue sizes; collisions skipped). */
  function productIndexes(n, count) {
    const used = {}, out = [];
    for (let k = 0, i = 0; out.length < Math.min(count, n); k++, i = (k * 7) % n) {
      let j = i;
      while (used[j]) j = (j + 1) % n;
      used[j] = true;
      out.push(j);
    }
    return out;
  }

  function costSourceText(marginPct) { return 'ASSUMPTION: MRP minus margin (' + marginPct + '%)'; }

  /**
   * build(catalogue, { marginPct, today }) → { batches, events }
   * Same catalogue + same day → same data, every time.
   */
  function build(catalogue, opts) {
    const products = (catalogue && catalogue.products) || catalogue || [];
    if (!products.length) throw new Error('Catalogue not loaded');
    const o = opts || {};
    const margin = o.marginPct === undefined ? 16 : Number(o.marginPct);
    const today = o.today || Calc.today();
    const nowIso = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0).toISOString();
    const idx = productIndexes(products.length, N_BATCHES);

    const batches = idx.map(function (pi, k) {
      const p = products[pi];
      return {
        id: 'DEMO-B' + pad(k + 1, 2),
        name: p.name, strength: p.strength, form: p.form, barcode: p.ean,
        batchNo: 'DMO-' + pad(k + 1, 3),
        expiry: Calc.toISODate(addDays(today, OFFSETS[k % OFFSETS.length])),
        qty: QTYS[k % QTYS.length],
        costPrice: Calc.costFromMrp(p.mrp, margin),
        costSource: costSourceText(margin),
        sellPrice: p.mrp, mrp: p.mrp, mrpSource: p.mrpSource,
        supplier: SUPPLIERS[k % SUPPLIERS.length],
        location: ROWS[Math.floor(k / 4) % 4] + ((k % 4) + 1),
        source: 'DEMO (generated from catalogue)',
        demo: true, createdAt: nowIso, updatedAt: nowIso
      };
    });

    const events = EVENTS.map(function (e, i) {
      const b = batches[e[0]];
      const when = new Date(today.getFullYear(), today.getMonth(), today.getDate() - e[3], 10, i * 7);
      const offset = OFFSETS[e[0] % OFFSETS.length];
      return {
        id: 'DEMO-E' + pad(i + 1, 2), ts: when.toISOString(), batchId: b.id, name: b.name, batchNo: b.batchNo,
        type: e[1], qty: e[2], unitCost: b.costPrice, value: Math.round(e[2] * b.costPrice * 100) / 100,
        daysToExpiry: offset + e[3], note: 'DEMO action', demo: true, by: 'Demo Owner'
      };
    });

    return { batches: batches, events: events };
  }

  /** Label-only DEMO batches for the printable sheet (not loaded as stock). */
  function newDeliveries(catalogue, opts) {
    const products = (catalogue && catalogue.products) || catalogue || [];
    const today = (opts && opts.today) || Calc.today();
    return NEW_DELIVERIES.filter(function (d) { return products[d[0]]; }).map(function (d, i) {
      const p = products[d[0]];
      return {
        name: p.name, strength: p.strength, form: p.form, barcode: p.ean,
        batchNo: 'DMN-' + pad(i + 1, 3),
        expiry: Calc.toISODate(addDays(today, d[1])).slice(0, 7),
        qty: d[2], supplier: SUPPLIERS[i % SUPPLIERS.length], location: ROWS[i % 4] + '4', newDelivery: true
      };
    });
  }

  const api = { build: build, newDeliveries: newDeliveries, costSourceText: costSourceText, SUPPLIERS: SUPPLIERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DemoData = api;
})(this);
