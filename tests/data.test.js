// Catalogue + DEMO data checks. Run: npm test
const assert = require('assert');
const Calc = require('../public/js/calc.js');
const Codes = require('../public/js/codes.js');
global.Calc = Calc; global.Codes = Codes;
const Demo = require('../public/js/demo-data.js');
const cat = require('../public/data/catalogue.json');

// EAN-13 check digit (known real code: 4006381333931)
assert.strictEqual(Codes.checkDigit('400638133393'), '1');
assert.ok(Codes.isValidEan13('4006381333931'));
assert.ok(!Codes.isValidEan13('4006381333932'));

// DEMO barcodes: "2" + "00" + row index (9 digits) + check digit, RCN range 200–299
assert.strictEqual(Codes.demoEan(1), '2000000000015');
assert.ok(cat.products.length >= 50);
const eans = cat.products.map(function (p) { return p.ean; });
assert.strictEqual(new Set(eans).size, eans.length, 'EANs are unique');
cat.products.forEach(function (p, i) {
  assert.ok(Codes.isValidEan13(p.ean), p.ean);
  assert.ok(/^2[0-9]{2}/.test(p.ean) && Number(p.ean.slice(0, 3)) <= 299, 'RCN 200–299');
  assert.strictEqual(p.ean, Codes.demoEan(i + 1));
  assert.ok(p.mrp > 0 && /2336\/53/.test(p.mrpSource), 'MRP + source');
});

// Cost from MRP with the assumed margin
assert.strictEqual(Calc.costFromMrp(100, 16), 84);
assert.strictEqual(Calc.costFromMrp(59.59, 16), 50.06);
assert.ok(/ASSUMPTION/.test(Calc.formula('costFromMrp', { marginPct: 16 })));

// DEMO pharmacy is deterministic and fully labelled
const today = new Date(2026, 10, 19);
const a = Demo.build(cat, { marginPct: 16, today: today });
const b = Demo.build(cat, { marginPct: 16, today: today });
assert.deepStrictEqual(a, b, 'same inputs → same demo data');
assert.strictEqual(a.batches.length, 35);
assert.strictEqual(a.events.length, 10);
assert.ok(a.batches.every(function (x) { return x.demo === true && /^ASSUMPTION/.test(x.costSource); }));
assert.ok(a.events.every(function (x) { return x.demo === true; }));
assert.strictEqual(new Set(a.batches.map(function (x) { return x.name + x.strength + x.form; })).size, 35, 'distinct products');
assert.strictEqual(a.batches[0].expiry, '2026-10-30');            // offset −20 days
assert.strictEqual(a.batches[2].expiry, '2026-11-26');            // offset +7 days
assert.strictEqual(new Set(a.batches.map(function (x) { return x.supplier; })).size, 4);
const st = Calc.summary(Calc.enrich(a.batches, Calc.DEFAULT_SETTINGS, today));
assert.ok(st.expired.batches > 0 && st.critical.batches > 0 && st.warning.batches > 0 && st.ok.batches > 0, 'every status has examples');

// New-delivery label batches are not in stock
const nd = Demo.newDeliveries(cat, { today: today });
assert.strictEqual(nd.length, 8);
assert.ok(nd.every(function (x) { return !a.batches.some(function (y) { return y.batchNo === x.batchNo; }); }));

// DEMO fridge: deterministic, 24 h of 5-min readings, exactly one labelled 20-minute excursion
const now = new Date(Date.UTC(2026, 10, 19, 3, 0));   // 08:30 Sri Lanka time
const fr = Demo.fridgeReadings(now);
assert.deepStrictEqual(fr, Demo.fridgeReadings(now));
assert.strictEqual(fr.length, 288);
assert.ok(fr.every(function (r) { return r.demo === true; }));
const fst = Calc.fridgeStats(fr, now);
assert.strictEqual(fst.outOfRangeMin, 20);
assert.strictEqual(fst.excursions, 1);
assert.strictEqual(fst.status, 'safe');
assert.ok(fr.some(function (r) { return /DEMO excursion/.test(r.note); }));

console.log('All data tests passed ✔');
