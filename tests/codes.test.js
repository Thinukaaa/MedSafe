// Barcode parser checks: GS1 element strings + MedSafe label QR. Run: npm test
const assert = require('assert');
const Codes = require('../public/js/codes.js');
const GS = '\u001d';

// --- GS1: raw DataMatrix with leading FNC1 and GS separator after the variable batch field
let g = Codes.parseGs1(GS + '0109501101530003' + '17270331' + '10AB12C' + GS + '21SER999');
assert.strictEqual(g.gtin, '09501101530003');
assert.strictEqual(g.ean13, '9501101530003');
assert.strictEqual(g.expiry, '2027-03-31');
assert.strictEqual(g.batch, 'AB12C');
assert.strictEqual(g.serial, 'SER999');

// --- DD = 00 → month end ('YYYY-MM', calc uses the last day of the month)
g = Codes.parseGs1('010950110153000317280200' + '10LOT7');
assert.strictEqual(g.expiry, '2028-02');
assert.strictEqual(g.batch, 'LOT7');

// --- Symbology prefix ]d2, batch at the end without GS
g = Codes.parseGs1(']d201095011015300031726123110B-42');
assert.strictEqual(g.expiry, '2026-12-31');
assert.strictEqual(g.batch, 'B-42');

// --- Variable field followed by GS then a fixed field (order 10 before 17)
g = Codes.parseGs1('0109501101530003' + '10X1' + GS + '17270615' + '21S1');
assert.strictEqual(g.batch, 'X1');
assert.strictEqual(g.expiry, '2027-06-15');
assert.strictEqual(g.serial, 'S1');

// --- Human-readable form
g = Codes.parseGs1('(01)09501101530003(17)270331(10)AB12C(21)SER999');
assert.strictEqual(g.gtin, '09501101530003');
assert.strictEqual(g.expiry, '2027-03-31');
assert.strictEqual(g.batch, 'AB12C');
assert.strictEqual(g.serial, 'SER999');

// --- Not GS1
assert.strictEqual(Codes.parseGs1('2000000000015'), null);   // plain EAN-13
assert.strictEqual(Codes.parseGs1('MS1|A|B|2027-01|1||'), null);
assert.strictEqual(Codes.gs1Date('271332'), null);           // month 13

// --- MedSafe label QR round trip
const ms = Codes.buildMs1({ batchNo: 'DMN-001', ean: '2000000000046', expiry: '2027-08-15', qty: 40, supplier: 'Supplier A (DEMO)', shelf: 'A4' });
assert.strictEqual(ms, 'MS1|DMN-001|2000000000046|2027-08|40|Supplier A (DEMO)|A4');
assert.deepStrictEqual(Codes.parseMs1(ms), { batchNo: 'DMN-001', ean: '2000000000046', expiry: '2027-08', qty: 40, supplier: 'Supplier A (DEMO)', shelf: 'A4' });
assert.strictEqual(Codes.buildMs1({ batchNo: 'A|B', ean: '1', expiry: '2027-01', qty: 1 }).split('|').length, 7, 'pipes stripped');
assert.strictEqual(Codes.parseMs1('MS1|X|1|2027-13|4|s|A1'), null);
assert.strictEqual(Codes.parseMs1('MS1|X|1|2027-01|four|s|A1'), null);
assert.strictEqual(Codes.parseMs1('hello'), null);

console.log('All code tests passed ✔');
