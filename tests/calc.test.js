// Quick checks for the formulas. Run: npm test
const assert = require('assert');
const Calc = require('../public/js/calc.js');

const S = { criticalDays: 30, warningDays: 90 };
const ref = new Date(2026, 10, 19); // 19 Nov 2026

// Month-only expiry → last day of month
assert.strictEqual(Calc.toISODate(Calc.parseExpiry('2027-02')), '2027-02-28');
assert.strictEqual(Calc.toISODate(Calc.parseExpiry('2028-02')), '2028-02-29');
assert.strictEqual(Calc.parseExpiry('bad'), null);

// Days left
assert.strictEqual(Calc.daysToExpiry('2026-11-19', ref), 0);
assert.strictEqual(Calc.daysToExpiry('2026-11-30', ref), 11);
assert.strictEqual(Calc.daysToExpiry('2026-11', ref), 11);
assert.strictEqual(Calc.daysToExpiry('2026-11-18', ref), -1);

// Status buckets
assert.strictEqual(Calc.status(-1, S), 'expired');
assert.strictEqual(Calc.status(0, S), 'critical');
assert.strictEqual(Calc.status(30, S), 'critical');
assert.strictEqual(Calc.status(31, S), 'warning');
assert.strictEqual(Calc.status(90, S), 'warning');
assert.strictEqual(Calc.status(91, S), 'ok');

// Summary + value
const batches = [
  { id: 'a', expiry: '2026-11-10', qty: 10, costPrice: 5 },   // expired, 50
  { id: 'b', expiry: '2026-12-01', qty: 4, costPrice: 25 },   // critical, 100
  { id: 'c', expiry: '2027-01-15', qty: 2, costPrice: 100 },  // warning, 200
  { id: 'd', expiry: '2028-01', qty: 1, costPrice: 1000 },    // ok, 1000
  { id: 'e', expiry: '2026-11-25', qty: 0, costPrice: 999 }   // sold out → ignored
];
const s = Calc.summary(Calc.enrich(batches, S, ref));
assert.strictEqual(s.expired.value, 50);
assert.strictEqual(s.critical.value, 100);
assert.strictEqual(s.warning.value, 200);
assert.strictEqual(s.total.value, 1350);
assert.strictEqual(s.total.batches, 4);

// FEFO order
const order = Calc.fefo(Calc.enrich(batches, S, ref)).map(function (b) { return b.id; });
assert.deepStrictEqual(order, ['a', 'b', 'c', 'd']);

// Impact
const im = Calc.impact([
  { type: 'SOLD', qty: 10, value: 100, daysToExpiry: 20 },     // recovered
  { type: 'RETURNED', qty: 5, value: 50, daysToExpiry: 90 },   // recovered (edge)
  { type: 'SOLD', qty: 5, value: 999, daysToExpiry: 200 },     // normal sale, not counted
  { type: 'DISPOSED', qty: 3, value: 50, daysToExpiry: -2 }    // lost
], S);
assert.strictEqual(im.recovered, 150);
assert.strictEqual(im.lost, 50);
assert.strictEqual(im.rate, 75);

// Supplier returns: returnBy = expiry − window; critical/warning only; grouped + sorted
const RS = { criticalDays: 30, warningDays: 90, returnWindowDays: 60 };
const rp = Calc.returnPlan(Calc.enrich([
  { id: 'r1', expiry: '2027-02-10', qty: 5, costPrice: 10, supplier: 'B' },   // 83 days → warning, return by 2026-12-12 (23 days)
  { id: 'r2', expiry: '2027-01-25', qty: 2, costPrice: 50, supplier: 'A' },   // 67 days → warning, return by 2026-11-26 (7 days)
  { id: 'r3', expiry: '2027-02-15', qty: 1, costPrice: 20, supplier: 'A' },   // 88 days → return by 2026-12-17
  { id: 'r4', expiry: '2026-12-01', qty: 3, costPrice: 10, supplier: 'B' },   // critical, return by 2026-10-02 → passed
  { id: 'r5', expiry: '2027-06-01', qty: 9, costPrice: 10, supplier: 'C' },   // ok → not listed
  { id: 'r6', expiry: '2027-01-20', qty: 0, costPrice: 10, supplier: 'C' }    // sold out → not listed
], RS, ref), RS, ref);
assert.deepStrictEqual(rp.groups.map(function (g) { return g.supplier; }), ['A', 'B']);
assert.deepStrictEqual(rp.groups[0].items.map(function (b) { return b.id; }), ['r2', 'r3']);
assert.strictEqual(Calc.toISODate(rp.groups[0].items[0].returnBy), '2026-11-26');
assert.strictEqual(rp.groups[0].items[0].daysToReturn, 7);
assert.strictEqual(rp.groups[0].value, 120);
assert.strictEqual(rp.passed.batches, 1);
assert.strictEqual(rp.passed.value, 30);
assert.ok(/60 days/.test(Calc.formula('returnBy', RS)) && /ASSUMPTION/.test(Calc.formula('returnBy', RS)));

// Business case
const bc = Calc.businessCase({ monthlyLoss: 10000, sharePct: 50, packagePrice: 30000, yearlySupport: 6000 });
assert.strictEqual(bc.yearlyLoss, 120000);
assert.strictEqual(bc.yearlySaving, 60000);
assert.strictEqual(bc.monthlySaving, 5000);
assert.strictEqual(bc.paybackMonths, 6);
assert.strictEqual(bc.net3y, 3 * 60000 - 30000 - 3 * 6000);
const bcEmpty = Calc.businessCase({ monthlyLoss: '', sharePct: 50, packagePrice: '' });
assert.strictEqual(bcEmpty.yearlyLoss, null);
assert.strictEqual(bcEmpty.paybackMonths, null);

console.log('All calc tests passed ✔');
