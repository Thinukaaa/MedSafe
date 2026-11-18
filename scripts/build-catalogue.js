// Builds public/data/catalogue.json from data/nmra_mrp_2023.csv.  Run: npm run build:data
// Prices are copied as-is from the NMRA gazette. Barcodes are DEMO in-store codes (GS1 RCN 200–299).
const fs = require('fs');
const path = require('path');
const Codes = require('../public/js/codes.js');

const SRC = path.join(__dirname, '..', 'data', 'nmra_mrp_2023.csv');
const OUT = path.join(__dirname, '..', 'public', 'data', 'catalogue.json');

/** Minimal CSV line parser (handles "quoted, fields" and "" escapes). */
function parseLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const lines = fs.readFileSync(SRC, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
const head = parseLine(lines[0]);
const col = function (name) { const i = head.indexOf(name); if (i === -1) throw new Error('Missing column ' + name); return i; };
const C = { item: col('item_no'), name: col('generic_name'), form: col('dosage_form'), strength: col('strength'), mrp: col('mrp_per_unit_lkr'), source: col('source') };

const products = lines.slice(1).map(function (line, i) {
  const r = parseLine(line);
  const row = i + 1;
  const mrp = Number(r[C.mrp]);
  if (!isFinite(mrp) || mrp <= 0) throw new Error('Bad MRP on CSV row ' + (row + 1));
  return {
    id: 'P' + String(row).padStart(3, '0'),
    row: row,
    itemNo: r[C.item],
    name: r[C.name],
    form: r[C.form],
    strength: r[C.strength],
    mrp: mrp,
    mrpUnit: 'Rs per unit',
    mrpSource: r[C.source],
    ean: Codes.demoEan(row)
  };
});

const out = {
  generatedFrom: 'data/nmra_mrp_2023.csv',
  priceSource: 'NMRA MRP Gazette Extraordinary No. 2336/53 (15 Jun 2023)',
  barcodeNote: 'DEMO in-store EAN-13 codes: "2" + "00" + row index + check digit, in the GS1 Restricted Circulation range 200–299 (in-store use only). Not real product barcodes.',
  count: products.length,
  products: products
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log('Wrote ' + products.length + ' products → ' + path.relative(process.cwd(), OUT));
