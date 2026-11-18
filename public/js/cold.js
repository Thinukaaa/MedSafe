/**
 * MedSafe — cold-chain view (fridge temperature). Pure rendering; data comes from app.js.
 * 24 h SVG line chart with the 2–8 °C band shaded — no chart library.
 */
(function (root) {
  'use strict';

  const TZ = 'Asia/Colombo';
  const LABEL = { safe: 'Safe 2–8 °C', warm: 'Too warm', cold: 'Too cold', offline: 'Device offline', none: 'No readings' };
  const CHIP = { safe: 'ok', warm: 'expired', cold: 'critical', offline: 'unknown', none: 'unknown' };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hm(d) { return new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); }
  function c1(n) { return n === null || n === undefined ? '—' : Number(n).toFixed(1) + ' °C'; }
  function ago(min) { return min === null ? '' : min < 1 ? 'just now' : min < 60 ? min + ' min ago' : Math.floor(min / 60) + ' h ' + (min % 60) + ' min ago'; }

  /** 24 h line chart. Points outside 2–8 °C are drawn red. */
  function chart(st, now) {
    const W = 720, H = 240, L = 40, R = 12, T = 12, B = 30;
    const end = now.getTime(), start = end - 24 * 3600000;
    const lo = Math.min(0, Math.floor(st.min === null ? 0 : st.min) - 1);
    const hi = Math.max(12, Math.ceil(st.max === null ? 12 : st.max) + 1);
    const x = function (t) { return L + (t - start) / (end - start) * (W - L - R); };
    const y = function (c) { return T + (hi - c) / (hi - lo) * (H - T - B); };
    let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Fridge temperature over the last 24 hours: min ' +
      c1(st.min) + ', max ' + c1(st.max) + ', ' + st.outOfRangeMin + ' minutes outside 2 to 8 °C">';
    svg += '<rect x="' + L + '" y="' + y(8) + '" width="' + (W - L - R) + '" height="' + (y(2) - y(8)) + '" class="band"/>';
    for (let c = Math.ceil(lo / 2) * 2; c <= hi; c += 2) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(c) + '" y2="' + y(c) + '" class="grid' + (c === 2 || c === 8 ? ' limit' : '') + '"/>' +
        '<text x="' + (L - 6) + '" y="' + (y(c) + 4) + '" class="ax" text-anchor="end">' + c + '°</text>';
    }
    for (let h = 0; h <= 24; h += 4) {
      const t = start + h * 3600000;
      svg += '<text x="' + x(t) + '" y="' + (H - 8) + '" class="ax" text-anchor="' + (h === 0 ? 'start' : h === 24 ? 'end' : 'middle') + '">' + (h === 24 ? 'now' : hm(t)) + '</text>';
    }
    let d = '', prev = null;
    st.points.forEach(function (p) {
      d += (prev && p.t - prev.t <= 10 * 60000 ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.c).toFixed(1);
      prev = p;
    });
    svg += '<path d="' + d + '" class="line"/>';
    st.points.forEach(function (p) {
      if (p.c > 8 || p.c < 2) svg += '<circle cx="' + x(p.t).toFixed(1) + '" cy="' + y(p.c).toFixed(1) + '" r="3.5" class="bad"><title>' + hm(p.t) + ' · ' + c1(p.c) + (p.note ? ' · ' + esc(p.note) : '') + '</title></circle>';
    });
    const ex = st.points.filter(function (p) { return p.note; })[0];
    if (ex) svg += '<text x="' + Math.max(L + 4, Math.min(x(ex.t) + 14, W - 260)) + '" y="' + Math.max(T + 10, y(ex.c) - 18) + '" class="note">' + esc(ex.note) + '</text>';
    return svg + '</svg>';
  }

  /** Full Cold chain tab. */
  function render(el, readings, now, opts) {
    const st = Calc.fridgeStats(readings, now);
    const demo = opts && opts.demo ? ' <span class="chip demo">DEMO</span>' : '';
    const device = readings.length ? readings[readings.length - 1].deviceId : '';
    if (st.status === 'none') {
      el.innerHTML = '<article class="card narrow"><div class="empty-state"><strong>No fridge readings in the last 24 h</strong>' +
        'Connect the MedSafe ESP32 sensor (hardware/medsafe_device) — it posts a reading every 60 s.</div></article>';
      return st;
    }
    el.innerHTML =
      '<div class="cold-grid">' +
        '<article class="card cold-now ' + st.status + '"><div class="pad">' +
          '<p class="muted">Fridge now' + demo + (device ? ' · ' + esc(device) : '') + '</p>' +
          '<p class="temp">' + c1(st.last.tempC) + '</p>' +
          '<p><span class="chip ' + CHIP[st.status] + '">' + LABEL[st.status] + '</span></p>' +
          '<p class="muted">Last reading ' + hm(st.last.ts) + ' Sri Lanka time (' + ago(st.minutesSinceLast) + ')</p>' +
          (st.status === 'offline' ? '<p class="ret-passed">Device offline — no reading for ' + st.minutesSinceLast + ' minutes. Check power and Wi-Fi.</p>' : '') +
        '</div></article>' +
        '<article class="card"><div class="pad cold-stats">' +
          '<div><span class="label">24 h min</span><strong>' + c1(st.min) + '</strong></div>' +
          '<div><span class="label">24 h max</span><strong>' + c1(st.max) + '</strong></div>' +
          '<div><span class="label">Out of range (24 h)</span><strong class="' + (st.outOfRangeMin ? 'bad-text' : '') + '">' + st.outOfRangeMin + ' min</strong><span class="sub muted">' + st.excursions + (st.excursions === 1 ? ' excursion' : ' excursions') + '</span></div>' +
        '</div></article>' +
      '</div>' +
      '<article class="card"><div class="card-head"><h2>Last 24 hours</h2><span class="hint">Shaded = safe 2–8 °C · as of ' + hm(now) + ' Sri Lanka time</span></div>' +
        '<div class="pad chart-wrap">' + chart(st, now) + '</div>' +
        '<details class="foot"><summary>How is this calculated?</summary><p>' + esc(Calc.formula('fridgeStatus')) + '</p><p>' + esc(Calc.formula('outOfRange')) + '</p></details>' +
        '<p class="source-note pad-x">Source: 2–8 °C — WHO vaccine/insulin storage range. Readings: ' + (opts && opts.demo ? 'DEMO pattern (deterministic), not a real fridge.' : 'MedSafe ESP32 + DS18B20 sensor, every 60 s.') + '</p>' +
      '</article>';
    return st;
  }

  /** Small dashboard card. */
  function mini(el, readings, now, opts) {
    const st = Calc.fridgeStats(readings, now);
    if (st.status === 'none') { el.innerHTML = '<p class="empty">No fridge readings in the last 24 h.</p>'; return st; }
    el.innerHTML = '<div class="cold-mini-row"><span class="temp-sm">' + c1(st.last.tempC) + '</span>' +
      '<span class="chip ' + CHIP[st.status] + '">' + LABEL[st.status] + '</span>' + (opts && opts.demo ? '<span class="chip demo">DEMO</span>' : '') + '</div>' +
      '<p class="muted">' + st.outOfRangeMin + ' min out of range in 24 h · last reading ' + hm(st.last.ts) + ' Sri Lanka time</p>';
    return st;
  }

  root.Cold = { render: render, mini: mini, LABEL: LABEL };
})(this);
