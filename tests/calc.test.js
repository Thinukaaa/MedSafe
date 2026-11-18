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

console.log('All calc tests passed ✔');
