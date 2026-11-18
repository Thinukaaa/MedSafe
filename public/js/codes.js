/**
 * MedSafe — barcode helpers (pure functions, no DOM; used by the app, labels page, build script and tests)
 *   EAN-13 check digit + DEMO in-store codes (GS1 Restricted Circulation Number range 200–299)
 *   GS1 element strings (DataMatrix / GS1-128): AI 01 GTIN, 17 expiry, 10 batch, 21 serial
 *   MedSafe batch label QR: MS1|<batchNo>|<ean13>|<expiry YYYY-MM>|<qty>|<supplier>|<shelf>
 */
(function (root) {
  'use strict';

  const GS = '\u001d';

  /** GS1 check digit for the first 12 (EAN-13) or 13 (GTIN-14) digits. */
  function checkDigit(body) {
    const d = String(body).split('').map(Number);
    let sum = 0;
    for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
    return String((10 - (sum % 10)) % 10);
  }

  function isValidEan13(code) {
    const s = String(code || '');
    return /^\d{13}$/.test(s) && checkDigit(s.slice(0, 12)) === s[12];
  }

  /**
   * DEMO in-store EAN-13 for catalogue row n (1-based): "2" + "00" + 9-digit row index + check digit.
   * Prefix 2xx = GS1 Restricted Circulation (in-store use only) — never a real retail product code.
   */
  function demoEan(rowIndex) {
    const body = '2' + '00' + String(rowIndex).padStart(9, '0');
    return body + checkDigit(body);
  }

  // ---------------- GS1 element strings ----------------
  // Fixed-length AIs (digits after the AI) and variable-length AIs (max length, end at GS or end of data)
  const FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2, '7003': 10 };
  const VARIABLE = { '10': 20, '21': 20, '22': 20, '30': 8, '37': 8, '240': 30, '241': 30, '250': 30, '400': 30,
    '710': 20, '711': 20, '712': 20, '713': 20, '714': 20, '715': 20 };

  function aiAt(s, i) {
    for (let len = 2; len <= 4; len++) {
      const ai = s.substr(i, len);
      if (FIXED[ai] !== undefined || VARIABLE[ai] !== undefined) return ai;
    }
    return null;
  }

  /** GS1 YYMMDD → 'YYYY-MM-DD', or 'YYYY-MM' when DD = 00 (= last day of that month). */
  function gs1Date(yymmdd) {
    if (!/^\d{6}$/.test(yymmdd)) return null;
    const y = 2000 + Number(yymmdd.slice(0, 2));
    const m = yymmdd.slice(2, 4);
    const d = yymmdd.slice(4, 6);
    if (Number(m) < 1 || Number(m) > 12) return null;
    return d === '00' ? y + '-' + m : y + '-' + m + '-' + d;
  }

  function looksGs1(raw) {
    const s = String(raw || '');
    return /^\](d2|C1|Q3|e0|J1)/.test(s) || s[0] === GS || /^\(\d{2,4}\)/.test(s) || /^01\d{14}/.test(s);
  }

  /**
   * Parse a GS1 element string. Accepts symbology prefixes (]d2, ]C1, ]Q3), a leading FNC1/GS,
   * GS (\u001d) separators after variable fields, and the human-readable "(01)…(17)…" form.
   * Returns { gtin, ean13, expiry, batch, serial, ais } or null.
   */
  function parseGs1(raw) {
    if (!looksGs1(raw)) return null;
    let s = String(raw).replace(/^\](d2|C1|Q3|e0|J1)/, '');
    const ais = {};
    if (/^\(\d{2,4}\)/.test(s)) {
      const re = /\((\d{2,4})\)([^(]*)/g;
      let m;
      while ((m = re.exec(s))) ais[m[1]] = m[2].replace(new RegExp(GS, 'g'), '').trim();
    } else {
      s = s.replace(/^\u001d+/, '');
      let i = 0;
      while (i < s.length) {
        if (s[i] === GS) { i++; continue; }
        const ai = aiAt(s, i);
        if (!ai) break;                         // unknown AI → keep what we have
        i += ai.length;
        if (FIXED[ai] !== undefined) {
          ais[ai] = s.substr(i, FIXED[ai]);
          i += FIXED[ai];
        } else {
          let end = s.indexOf(GS, i);
          if (end === -1) end = s.length;
          end = Math.min(end, i + VARIABLE[ai]);
          ais[ai] = s.slice(i, end);
          i = end;
        }
      }
    }
    if (!ais['01'] && !ais['10'] && !ais['17']) return null;
    const gtin = ais['01'] || '';
    return {
      gtin: gtin,
      ean13: /^0\d{13}$/.test(gtin) ? gtin.slice(1) : '',
      expiry: ais['17'] ? gs1Date(ais['17']) : null,
      batch: ais['10'] || '',
      serial: ais['21'] || '',
      ais: ais
    };
  }

  // ---------------- MedSafe label QR (MS1) ----------------
  function clean(v) { return String(v === undefined || v === null ? '' : v).replace(/[|\r\n]/g, ' ').trim(); }

  function buildMs1(b) {
    return ['MS1', clean(b.batchNo), clean(b.ean), clean(b.expiry).slice(0, 7), Number(b.qty) || 0, clean(b.supplier), clean(b.shelf)].join('|');
  }

  /** 'MS1|batch|ean|YYYY-MM|qty|supplier|shelf' → object, or null if not a valid MedSafe label. */
  function parseMs1(raw) {
    const p = String(raw || '').trim().split('|');
    if (p[0] !== 'MS1' || p.length !== 7) return null;
    if (!p[1] || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p[3]) || !/^\d+$/.test(p[4])) return null;
    return { batchNo: p[1], ean: p[2], expiry: p[3], qty: Number(p[4]), supplier: p[5], shelf: p[6] };
  }

  const api = { GS, checkDigit, isValidEan13, demoEan, gs1Date, looksGs1, parseGs1, buildMs1, parseMs1 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Codes = api;
})(this);
