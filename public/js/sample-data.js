/**
 * MedSafe — SAMPLE data (for testing only)
 * Every row is flagged sample:true and shows a "SAMPLE" badge in the app.
 * Prices and quantities here are NOT real — replace them with field-visit data.
 * Expiry dates are set relative to today so every status group has an example.
 */
(function (root) {
  'use strict';

  function isoFromToday(days) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return root.Calc.toISODate(d);
  }

  function build() {
    const rows = [
      ['Paracetamol', '500 mg tablet', 'PCM-2411', -12, 200, 2.5, 4, 'Shelf A1'],
      ['Amoxicillin', '250 mg capsule', 'AMX-0925', 14, 120, 9, 14, 'Shelf B2'],
      ['Cetirizine', '10 mg tablet', 'CTZ-1102', 26, 150, 3, 5, 'Shelf A3'],
      ['ORS sachet', '20.5 g', 'ORS-0711', 58, 60, 18, 28, 'Counter'],
      ['Omeprazole', '20 mg capsule', 'OMP-3301', 84, 90, 7, 12, 'Shelf B1'],
      ['Metformin', '500 mg tablet', 'MTF-5520', 160, 300, 3.5, 6, 'Shelf C2'],
      ['Salbutamol inhaler', '100 mcg', 'SAL-8812', 290, 8, 650, 900, 'Fridge door'],
      ['Vitamin C', '500 mg tablet', 'VTC-1190', 420, 250, 4, 7, 'Shelf D1']
    ];
    const batches = rows.map(function (r, i) {
      return {
        id: 'SAMPLE-' + (i + 1),
        name: r[0], strength: r[1], barcode: '', batchNo: r[2],
        expiry: isoFromToday(r[3]), qty: r[4], costPrice: r[5], sellPrice: r[6],
        supplier: 'Sample supplier', location: r[7],
        source: 'DEMO (not real data)', demo: true,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
    });
    const events = [
      { id: 'SAMPLE-E1', ts: new Date().toISOString(), batchId: 'SAMPLE-2', name: 'Amoxicillin', batchNo: 'AMX-0925',
        type: 'RETURNED', qty: 40, unitCost: 9, value: 360, daysToExpiry: 20, note: 'Sample event', demo: true },
      { id: 'SAMPLE-E2', ts: new Date().toISOString(), batchId: 'SAMPLE-3', name: 'Cetirizine', batchNo: 'CTZ-1102',
        type: 'SOLD', qty: 50, unitCost: 3, value: 150, daysToExpiry: 30, note: 'Sample event', demo: true },
      { id: 'SAMPLE-E3', ts: new Date().toISOString(), batchId: 'SAMPLE-1', name: 'Paracetamol', batchNo: 'PCM-2411',
        type: 'DISPOSED', qty: 100, unitCost: 2.5, value: 250, daysToExpiry: -5, note: 'Sample event', demo: true }
    ];
    return { batches: batches, events: events };
  }

  root.SampleData = { build: build };
})(this);
