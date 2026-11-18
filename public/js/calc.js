/**
 * MedSafe — calculations
 * Every number on screen comes from a function in this file, and every
 * function has its formula written in FORMULAS below (shown in the UI).
 */
(function (root) {
  'use strict';

  const DAY_MS = 86400000;

  const FORMULAS = {
    daysToExpiry: 'Days left = expiry date − today (Sri Lanka time). If the box shows only month/year (e.g. 2027-03), the expiry date is taken as the LAST day of that month.',
    status: 'Expired: days left < 0 · Critical: 0 to {critical} days · Warning: {critical1} to {warning} days · OK: more than {warning} days',
    valueAtCost: 'Value at risk (Rs) = quantity on shelf (units) × cost price per unit (Rs), summed over the batches in this group.',
    totalStock: 'Total stock value (Rs) = Σ (quantity × cost price) for every batch with quantity > 0.',
    fefo: 'Sell-first order = FEFO (First-Expiry-First-Out): batches sorted by expiry date, earliest first.',
    recovered: 'Recovered (Rs) = Σ value of stock SOLD or RETURNED to supplier while it was within the warning window (0 to {warning} days left). This is stock that would likely have expired without the alert.',
    lost: 'Lost (Rs) = Σ value of stock DISPOSED as expired.',
    recoveryRate: 'Recovery rate = Recovered ÷ (Recovered + Lost) × 100.'
  };

  function pad(n) { return String(n).padStart(2, '0'); }

  /** Today's date at local midnight. */
  function today() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function toISODate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** Accepts 'YYYY-MM-DD' or 'YYYY-MM'. Month-only → last day of that month. */
  function parseExpiry(value) {
    if (!value) return null;
    const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(String(value).trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    if (mo < 0 || mo > 11) return null;
    if (m[3]) return new Date(y, mo, Number(m[3]));
    return new Date(y, mo + 1, 0);
  }

  function daysToExpiry(expiry, ref) {
    const e = parseExpiry(expiry);
    if (!e) return null;
    return Math.round((e - (ref || today())) / DAY_MS);
  }

  function status(days, settings) {
    if (days === null || days === undefined) return 'unknown';
    if (days < 0) return 'expired';
    if (days <= settings.criticalDays) return 'critical';
    if (days <= settings.warningDays) return 'warning';
    return 'ok';
  }

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function valueAtCost(batch) {
    return num(batch.qty) * num(batch.costPrice);
  }

  /** Adds days, status and value to each batch. */
  function enrich(batches, settings, ref) {
    return batches.map(function (b) {
      const days = daysToExpiry(b.expiry, ref);
      return Object.assign({}, b, {
        daysLeft: days,
        status: status(days, settings),
        value: valueAtCost(b),
        expiryDate: parseExpiry(b.expiry)
      });
    });
  }

  function emptyGroup() { return { batches: 0, units: 0, value: 0 }; }

  /** Totals per status group (only batches with stock on the shelf). */
  function summary(enriched) {
    const s = {
      expired: emptyGroup(), critical: emptyGroup(), warning: emptyGroup(),
      ok: emptyGroup(), unknown: emptyGroup(), total: emptyGroup()
    };
    enriched.forEach(function (b) {
      if (num(b.qty) <= 0) return;
      [s[b.status], s.total].forEach(function (g) {
        g.batches += 1;
        g.units += num(b.qty);
        g.value += b.value;
      });
    });
    return s;
  }

  /** FEFO: active batches sorted by expiry, earliest first. */
  function fefo(enriched) {
    return enriched
      .filter(function (b) { return num(b.qty) > 0 && b.expiryDate; })
      .sort(function (a, b) { return a.expiryDate - b.expiryDate; });
  }

  /** Business impact from the action log. */
  function impact(events, settings) {
    let recovered = 0, lost = 0, recoveredUnits = 0, lostUnits = 0;
    events.forEach(function (e) {
      const v = num(e.value);
      const d = e.daysToExpiry === '' || e.daysToExpiry === null ? null : Number(e.daysToExpiry);
      if ((e.type === 'SOLD' || e.type === 'RETURNED') && d !== null && d >= 0 && d <= settings.warningDays) {
        recovered += v; recoveredUnits += num(e.qty);
      } else if (e.type === 'DISPOSED') {
        lost += v; lostUnits += num(e.qty);
      }
    });
    const base = recovered + lost;
    return {
      recovered: recovered, lost: lost,
      recoveredUnits: recoveredUnits, lostUnits: lostUnits,
      rate: base > 0 ? (recovered / base) * 100 : null
    };
  }

  function formula(key, settings) {
    const s = settings || { criticalDays: 30, warningDays: 90 };
    return FORMULAS[key]
      .split('{critical}').join(s.criticalDays)
      .split('{critical1}').join(s.criticalDays + 1)
      .split('{warning}').join(s.warningDays);
  }

  const api = {
    FORMULAS, today, toISODate, parseExpiry, daysToExpiry, status,
    valueAtCost, enrich, summary, fefo, impact, formula
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(this);
