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

// Columns stored as plain text so Sheets does not turn them into dates/numbers
const TEXT_COLS = { batchNo: true, expiry: true, barcode: true, createdAt: true, updatedAt: true, ts: true,
  shopId: true, pinHash: true, salt: true };

const TOKEN_TTL_S = 21600;          // CacheService maximum is 6 h; refreshed on every call…
const TOKEN_MAX_MS = 12 * 3600000;  // …but a token never lives longer than 12 h after login
const MAX_FAILS = 5;                // wrong PINs per shop before a 10-minute lock

// ---------------- Setup ----------------

function setup() {
  ensureSheet_(SH_BATCHES, BATCH_COLS);
  ensureSheet_(SH_EVENTS, EVENT_COLS);
  ensureSheet_(SH_USERS, USER_COLS);
}

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
