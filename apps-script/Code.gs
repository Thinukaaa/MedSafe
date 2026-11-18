/**
 * MedSafe — Google Apps Script backend
 * ------------------------------------------------------------
 * Bind to a Google Sheet:  Sheet → Extensions → Apps Script
 * (or clasp: `clasp clone <scriptId>` then push this file + appsscript.json)
 *
 * Run setup() once, then Deploy → New deployment → Web app
 *   Execute as: Me   ·   Who has access: Anyone
 *
 * GET  ?action=list   → { batches, events }
 * GET  ?action=ping   → { ok, sheet, batches }
 * POST {action:'upsertBatches', batches:[...]}
 * POST {action:'deleteBatch', id}
 * POST {action:'addEvent', event, batch}
 * POST {action:'addEvents', events:[...]}
 * POST {action:'clearSample'}
 */

const SH_BATCHES = 'Batches';
const SH_EVENTS = 'Events';

const BATCH_COLS = ['id', 'name', 'strength', 'barcode', 'batchNo', 'expiry', 'qty', 'costPrice',
  'sellPrice', 'supplier', 'location', 'source', 'sample', 'createdAt', 'updatedAt'];
const EVENT_COLS = ['id', 'ts', 'batchId', 'name', 'batchNo', 'type', 'qty', 'unitCost', 'value',
  'daysToExpiry', 'note', 'sample'];

// Columns stored as plain text so Sheets does not turn them into dates/numbers
const TEXT_COLS = { batchNo: true, expiry: true, barcode: true, createdAt: true, updatedAt: true, ts: true };

// ---------------- Setup ----------------

function setup() {
  ensureSheet_(SH_BATCHES, BATCH_COLS);
  ensureSheet_(SH_EVENTS, EVENT_COLS);
}

function ensureSheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  cols.forEach(function (c, i) {
    if (TEXT_COLS[c]) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  });
  return sh;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('MedSafe').addItem('Set up sheets', 'setup').addToUi();
}

// ---------------- HTTP ----------------

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'list';
  try {
    if (action === 'ping') {
      return json_({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getName(), batches: readAll_(SH_BATCHES, BATCH_COLS).length });
    }
    if (action === 'list') {
      return json_({ batches: readAll_(SH_BATCHES, BATCH_COLS), events: readAll_(SH_EVENTS, EVENT_COLS), serverTime: new Date().toISOString() });
    }
    return json_({ error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (body.action) {
      case 'upsertBatches':
        (body.batches || []).forEach(function (b) { upsert_(SH_BATCHES, BATCH_COLS, b); });
        return json_({ ok: true });
      case 'deleteBatch':
        deleteWhere_(SH_BATCHES, function (r) { return r.id === body.id; });
        return json_({ ok: true });
      case 'addEvent':
        append_(SH_EVENTS, EVENT_COLS, body.event);
        if (body.batch) upsert_(SH_BATCHES, BATCH_COLS, body.batch);
        return json_({ ok: true });
      case 'addEvents':
        (body.events || []).forEach(function (ev) { append_(SH_EVENTS, EVENT_COLS, ev); });
        return json_({ ok: true });
      case 'clearSample':
        deleteWhere_(SH_BATCHES, isSample_);
        deleteWhere_(SH_EVENTS, isSample_);
        return json_({ ok: true });
      default:
        return json_({ error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------------- Sheet helpers ----------------

function sheet_(name, cols) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name) || ensureSheet_(name, cols);
}

function readAll_(name, cols) {
  const sh = sheet_(name, cols);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return values
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) {
      const o = {};
      cols.forEach(function (c, i) {
        let v = r[i];
        if (v instanceof Date) {
          // A date typed by hand into the sheet → back to text
          v = (c === 'expiry') ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v.toISOString();
        }
        o[c] = v;
      });
      return o;
    });
}

function toRow_(cols, obj) {
  return cols.map(function (c) {
    const v = obj[c];
    if (v === undefined || v === null) return '';
    if (TEXT_COLS[c]) return String(v);
    return v;
  });
}

function upsert_(name, cols, obj) {
  if (!obj || !obj.id) throw new Error('Missing id');
  const sh = sheet_(name, cols);
  const row = toRow_(cols, obj);
  const last = sh.getLastRow();
  if (last >= 2) {
    const ids = sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
    const i = ids.indexOf(String(obj.id));
    if (i !== -1) {
      sh.getRange(i + 2, 1, 1, cols.length).setValues([row]);
      return;
    }
  }
  append_(name, cols, obj);
}

function append_(name, cols, obj) {
  if (!obj || !obj.id) throw new Error('Missing id');
  const sh = sheet_(name, cols);
  const r = sh.getLastRow() + 1;
  cols.forEach(function (c, i) { if (TEXT_COLS[c]) sh.getRange(r, i + 1).setNumberFormat('@'); });
  sh.getRange(r, 1, 1, cols.length).setValues([toRow_(cols, obj)]);
}

function deleteWhere_(name, test) {
  const cols = name === SH_BATCHES ? BATCH_COLS : EVENT_COLS;
  const sh = sheet_(name, cols);
  const last = sh.getLastRow();
  if (last < 2) return;
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    const o = {};
    cols.forEach(function (c, j) { o[c] = values[i][j]; });
    if (test(o)) sh.deleteRow(i + 2);
  }
}

function isSample_(r) {
  return r.sample === true || String(r.sample).toUpperCase() === 'TRUE';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
