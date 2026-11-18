/**
 * MedSafe — Google Apps Script backend
 * ------------------------------------------------------------
 * Bind to a Google Sheet:  Sheet → Extensions → Apps Script
 * (or clasp: `clasp clone <scriptId>` then push this file + appsscript.json)
 *
 * Run setup() once, then setupOwner('SHOP1', 'Your name', '123456') from the editor.
 * Deploy → New deployment → Web app · Execute as: Me · Who has access: Anyone
 *
 * Every call except login needs a token from action=login.
 * GET  ?action=ping&token=          → { ok, sheet, batches }
 * GET  ?action=list&token=          → { batches, events, settings }
 * POST {action:'login', shopId, pin} → { token, name, role }
 * POST {action:'logout', token}
 * POST {action:'upsertBatches', token, batches:[...]}
 * POST {action:'deleteBatch', token, id}                    (owner only)
 * POST {action:'addEvent', token, event, batch}
 * POST {action:'addEvents', token, events:[...]}
 * POST {action:'clearDemo', token}                          (owner only)
 */

const SH_BATCHES = 'Batches';
const SH_EVENTS = 'Events';
const SH_USERS = 'Users';

const BATCH_COLS = ['id', 'name', 'strength', 'form', 'barcode', 'batchNo', 'expiry', 'qty', 'costPrice',
  'costSource', 'sellPrice', 'mrp', 'mrpSource', 'supplier', 'location', 'source', 'demo', 'createdAt', 'updatedAt'];
const EVENT_COLS = ['id', 'ts', 'batchId', 'name', 'batchNo', 'type', 'qty', 'unitCost', 'value',
  'daysToExpiry', 'note', 'demo', 'by'];
const USER_COLS = ['shopId', 'name', 'role', 'pinHash', 'salt'];
const SH_SETTINGS = 'Settings';
const SETTINGS_COLS = ['key', 'value'];
const SETTING_KEYS = ['pharmacyName', 'criticalDays', 'warningDays', 'marginPct', 'returnWindowDays', 'business'];
// ASSUMPTION defaults until the owner changes them in the app (Settings)
const SETTING_DEFAULTS = { criticalDays: 30, warningDays: 90, marginPct: 16, returnWindowDays: 60 };
const TZ = 'Asia/Colombo';
const DAY_MS = 86400000;

// Columns stored as plain text so Sheets does not turn them into dates/numbers
const TEXT_COLS = { batchNo: true, expiry: true, barcode: true, createdAt: true, updatedAt: true, ts: true,
  shopId: true, pinHash: true, salt: true, key: true, value: true };

const TOKEN_TTL_S = 21600;          // CacheService maximum is 6 h; refreshed on every call…
const TOKEN_MAX_MS = 12 * 3600000;  // …but a token never lives longer than 12 h after login
const MAX_FAILS = 5;                // wrong PINs per shop before a 10-minute lock

// ---------------- Setup ----------------

function setup() {
  ensureSheet_(SH_BATCHES, BATCH_COLS);
  ensureSheet_(SH_EVENTS, EVENT_COLS);
  ensureSheet_(SH_USERS, USER_COLS);
  ensureSheet_(SH_SETTINGS, SETTINGS_COLS);
}

// ---------------- Settings (shared, owner edits) ----------------

function readSettings_() {
  const o = {};
  readAll_(SH_SETTINGS, SETTINGS_COLS).forEach(function (r) {
    if (SETTING_KEYS.indexOf(r.key) === -1) return;
    try { o[r.key] = JSON.parse(r.value); } catch (e) { o[r.key] = r.value; }
  });
  return o;
}

function writeSettings_(obj) {
  const sh = sheet_(SH_SETTINGS, SETTINGS_COLS);
  const last = sh.getLastRow();
  const keys = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  SETTING_KEYS.forEach(function (k) {
    if (obj[k] === undefined) return;
    const row = [k, JSON.stringify(obj[k])];
    const i = keys.indexOf(k);
    if (i !== -1) sh.getRange(i + 2, 1, 1, 2).setNumberFormat('@').setValues([row]);
    else { sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setNumberFormat('@').setValues([row]); keys.push(k); }
  });
}

function settings_() {
  const s = Object.assign({}, SETTING_DEFAULTS, readSettings_());
  ['criticalDays', 'warningDays', 'marginPct', 'returnWindowDays'].forEach(function (k) { s[k] = Number(s[k]); });
  return s;
}

// ---------------- Same formulas as public/js/calc.js (script time zone = Asia/Colombo) ----------------

function todayLocal_() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function parseExpiry_(v) {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(String(v || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return null;
  return m[3] ? new Date(y, mo, Number(m[3])) : new Date(y, mo + 1, 0);   // month only → last day
}

function enrich_(b, s, today) {
  const e = parseExpiry_(b.expiry);
  const days = e ? Math.round((e - today) / DAY_MS) : null;
  const status = days === null ? 'unknown' : days < 0 ? 'expired' : days <= s.criticalDays ? 'critical' : days <= s.warningDays ? 'warning' : 'ok';
  const qty = Number(b.qty) || 0;
  return Object.assign({}, b, { qty: qty, expiryDate: e, daysLeft: days, status: status, value: qty * (Number(b.costPrice) || 0), demo: isDemo_(b) });
}

function stockSummary_(s, today) {
  const list = readAll_(SH_BATCHES, BATCH_COLS).map(function (b) { return enrich_(b, s, today); }).filter(function (b) { return b.qty > 0; });
  const g = {};
  ['expired', 'critical', 'warning', 'ok', 'unknown'].forEach(function (k) { g[k] = { n: 0, units: 0, rs: 0 }; });
  list.forEach(function (b) { g[b.status].n++; g[b.status].units += b.qty; g[b.status].rs += b.value; });
  Object.keys(g).forEach(function (k) { g[k].rs = Math.round(g[k].rs * 100) / 100; });
  return { list: list, groups: g };
}

// ---------------- Morning email digest ----------------

/** Run once from the editor: daily 08:00 Sri Lanka time → sendDailyDigest(). */
function installDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyDigest').timeBased().atHour(8).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  Logger.log('Digest trigger installed: every day ~08:00 ' + TZ);
}

function rs_(n) { return 'Rs ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc_(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function d_(d) { return Utilities.formatDate(d, TZ, 'dd MMM yyyy'); }

/** Emails Script Property DIGEST_EMAIL: counts + Rs per status, top 10 sell-first, returns due this week, fridge yesterday. */
function sendDailyDigest() {
  const to = PropertiesService.getScriptProperties().getProperty('DIGEST_EMAIL');
  if (!to) throw new Error('Set Script Property DIGEST_EMAIL first');
  const s = settings_();
  const today = todayLocal_();
  const sum = stockSummary_(s, today);
  const g = sum.groups;
  const tag = function (b) { return b.demo ? ' <b style="color:#6D28D9">[DEMO]</b>' : ''; };
  const th = 'style="text-align:left;padding:6px 8px;border-bottom:1px solid #E2E8F0;font-size:12px;color:#475569"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #E2E8F0;font-size:13px"';

  let html = '<div style="font-family:Arial,sans-serif;color:#0F172A;max-width:640px">' +
    '<h2 style="color:#1D4ED8;margin:0 0 4px">MedSafe — morning digest</h2>' +
    '<p style="margin:0 0 16px;color:#475569">' + esc_(s.pharmacyName || 'Your pharmacy') + ' · as of ' +
    Utilities.formatDate(new Date(), TZ, 'dd MMM yyyy, HH:mm') + ' Sri Lanka time</p>';

  html += '<table style="border-collapse:collapse;width:100%"><tr><th ' + th + '>Status</th><th ' + th + '>Batches</th><th ' + th + '>Units</th><th ' + th + '>Value at cost</th></tr>' +
    [['Expired (remove now)', 'expired', '#B42318'], ['Critical · 0–' + s.criticalDays + ' days', 'critical', '#B45309'], ['Warning · ' + (s.criticalDays + 1) + '–' + s.warningDays + ' days', 'warning', '#8A5A00'], ['OK', 'ok', '#15803D']]
      .map(function (r) { return '<tr><td ' + td + '><b style="color:' + r[2] + '">' + r[0] + '</b></td><td ' + td + '>' + g[r[1]].n + '</td><td ' + td + '>' + g[r[1]].units + '</td><td ' + td + '>' + rs_(g[r[1]].rs) + '</td></tr>'; }).join('') +
    '</table>';

  const sell = sum.list.filter(function (b) { return b.status === 'critical' || b.status === 'warning'; })
    .sort(function (a, b) { return a.expiryDate - b.expiryDate; }).slice(0, 10);
  html += '<h3 style="margin:20px 0 6px">Sell first (top 10, earliest expiry)</h3>' + (sell.length ?
    '<table style="border-collapse:collapse;width:100%"><tr><th ' + th + '>Medicine</th><th ' + th + '>Batch · shelf</th><th ' + th + '>Days left</th><th ' + th + '>Qty</th><th ' + th + '>Rs</th></tr>' +
    sell.map(function (b) { return '<tr><td ' + td + '>' + esc_(b.name + ' ' + b.strength) + tag(b) + '</td><td ' + td + '>' + esc_(b.batchNo + ' · ' + (b.location || '—')) + '</td><td ' + td + '>' + b.daysLeft + '</td><td ' + td + '>' + b.qty + ' units</td><td ' + td + '>' + rs_(b.value) + '</td></tr>'; }).join('') +
    '</table>' : '<p>Nothing within ' + s.warningDays + ' days.</p>');

  const weekEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
  const due = sum.list.filter(function (b) { return b.status === 'critical' || b.status === 'warning'; }).map(function (b) {
    return Object.assign(b, { returnBy: new Date(b.expiryDate.getFullYear(), b.expiryDate.getMonth(), b.expiryDate.getDate() - s.returnWindowDays) });
  }).filter(function (b) { return b.returnBy >= today && b.returnBy <= weekEnd; })
    .sort(function (a, b) { return a.returnBy - b.returnBy || String(a.supplier).localeCompare(String(b.supplier)); });
  html += '<h3 style="margin:20px 0 6px">Supplier returns due this week</h3>' + (due.length ?
    '<ul style="padding-left:18px;margin:0">' + due.map(function (b) { return '<li><b>' + esc_(b.supplier || 'Supplier not recorded') + '</b>: ' + esc_(b.name + ' ' + b.strength + ', batch ' + b.batchNo + ', ' + b.qty + ' units') + tag(b) + ' — return by <b>' + d_(b.returnBy) + '</b></li>'; }).join('') + '</ul>' :
    '<p>None this week.</p>');

  html += fridgeDigestHtml_(today);

  html += '<p style="margin-top:20px;font-size:12px;color:#475569">Formulas: value = qty × cost price · status from days left = expiry − today (month-only expiry = last day of month) · return by = expiry − ' +
    s.returnWindowDays + ' days (ASSUMPTION). Rows marked [DEMO] are demo data.</p></div>';

  const subject = 'MedSafe ' + d_(today) + ': ' + g.expired.n + ' expired (' + rs_(g.expired.rs) + '), ' + g.critical.n + ' critical, ' + due.length + ' returns due';
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html });
}

/** Cold-chain section of the digest (filled in by the fridge module). */
function fridgeDigestHtml_(today) { return ''; }

/** Run from the editor: setupOwner('SHOP1', 'Nimal Perera', '482913') */
function setupOwner(shopId, name, pin) { return addUser_(shopId, name, pin, 'owner'); }

/** Run from the editor: addStaff('SHOP1', 'Kamala', '7351') */
function addStaff(shopId, name, pin) { return addUser_(shopId, name, pin, 'staff'); }

function addUser_(shopId, name, pin, role) {
  shopId = String(shopId || '').trim().toUpperCase();
  pin = String(pin || '');
  if (!shopId || !name) throw new Error('shopId and name are required');
  if (!/^\d{4,6}$/.test(pin)) throw new Error('PIN must be 4–6 digits');
  setup();
  const users = readAll_(SH_USERS, USER_COLS).filter(function (u) { return String(u.shopId).toUpperCase() === shopId; });
  if (users.some(function (u) { return hash_(u.salt, pin) === u.pinHash; })) {
    throw new Error('Another user of ' + shopId + ' already has this PIN — choose a different one');
  }
  const salt = Utilities.getUuid();
  append_(SH_USERS, USER_COLS, { shopId: shopId, name: name, role: role, pinHash: hash_(salt, pin), salt: salt });
  Logger.log('Added ' + role + ' ' + name + ' to shop ' + shopId);
  return 'ok';
}

// ---------------- Auth ----------------

function hash_(salt, pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + String(pin), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function login_(shopId, pin) {
  shopId = String(shopId || '').trim().toUpperCase();
  pin = String(pin || '');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + shopId;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) return { error: 'Too many wrong PINs. Try again in 10 minutes.' };
  const user = readAll_(SH_USERS, USER_COLS).filter(function (u) {
    return String(u.shopId).toUpperCase() === shopId && hash_(u.salt, pin) === u.pinHash;
  })[0];
  if (!user) {
    cache.put(failKey, String(fails + 1), 600);
    return { error: 'Wrong Shop ID or PIN' };
  }
  cache.remove(failKey);
  const token = Utilities.getUuid();
  const session = { shopId: shopId, name: user.name, role: user.role === 'owner' ? 'owner' : 'staff', exp: Date.now() + TOKEN_MAX_MS };
  cache.put('tok_' + token, JSON.stringify(session), TOKEN_TTL_S);
  return { token: token, name: session.name, role: session.role, shopId: shopId };
}

/** Returns the session for a token, or null. Refreshes the cache entry (sliding, max 12 h). */
function session_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('tok_' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (Date.now() > s.exp) { cache.remove('tok_' + token); return null; }
  cache.put('tok_' + token, raw, Math.min(TOKEN_TTL_S, Math.ceil((s.exp - Date.now()) / 1000)));
  return s;
}

const UNAUTHORIZED = { error: 'Unauthorized' };
const OWNER_ONLY = { error: 'Only the owner can do this' };

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
  const p = (e && e.parameter) || {};
  const action = p.action || 'list';
  try {
    if (!session_(p.token)) return json_(UNAUTHORIZED);
    if (action === 'ping') {
      return json_({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getName(), batches: readAll_(SH_BATCHES, BATCH_COLS).length });
    }
    if (action === 'list') {
      return json_({ batches: readAll_(SH_BATCHES, BATCH_COLS), events: readAll_(SH_EVENTS, EVENT_COLS), settings: readSettings_(), serverTime: new Date().toISOString() });
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
    if (body.action === 'login') return json_(login_(body.shopId, body.pin));
    const s = session_(body.token);
    if (!s) return json_(UNAUTHORIZED);
    const owner = s.role === 'owner';
    switch (body.action) {
      case 'logout':
        CacheService.getScriptCache().remove('tok_' + body.token);
        return json_({ ok: true });
      case 'upsertBatches':
        (body.batches || []).forEach(function (b) { upsert_(SH_BATCHES, BATCH_COLS, b); });
        return json_({ ok: true });
      case 'deleteBatch':
        if (!owner) return json_(OWNER_ONLY);
        deleteWhere_(SH_BATCHES, function (r) { return r.id === body.id; });
        return json_({ ok: true });
      case 'addEvent':
        body.event.by = s.name;
        append_(SH_EVENTS, EVENT_COLS, body.event);
        if (body.batch) upsert_(SH_BATCHES, BATCH_COLS, body.batch);
        return json_({ ok: true });
      case 'addEvents':
        (body.events || []).forEach(function (ev) { ev.by = s.name; append_(SH_EVENTS, EVENT_COLS, ev); });
        return json_({ ok: true });
      case 'saveSettings':
        if (!owner) return json_(OWNER_ONLY);
        writeSettings_(body.settings || {});
        return json_({ ok: true, settings: readSettings_() });
      case 'clearDemo':
        if (!owner) return json_(OWNER_ONLY);
        deleteWhere_(SH_BATCHES, isDemo_);
        deleteWhere_(SH_EVENTS, isDemo_);
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

function isDemo_(r) {
  return r.demo === true || String(r.demo).toUpperCase() === 'TRUE';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
