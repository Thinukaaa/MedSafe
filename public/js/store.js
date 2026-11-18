/**
 * MedSafe — data store
 * Two interchangeable stores with the same methods:
 *   LocalStore → saves in this browser (localStorage). Works offline.
 *   SheetStore → saves in a Google Sheet via the Apps Script Web App.
 */
(function (root) {
  'use strict';

  const LS_DATA = 'ms_data_v1';

  // ---------------- Local (browser) ----------------
  function LocalStore() {
    function read() {
      try {
        const d = JSON.parse(localStorage.getItem(LS_DATA) || '{}');
        return { batches: d.batches || [], events: d.events || [] };
      } catch (e) {
        return { batches: [], events: [] };
      }
    }
    function write(d) { localStorage.setItem(LS_DATA, JSON.stringify(d)); }

    return {
      mode: 'local',
      label: 'Local mode · saved in this browser only',
      async load() { return read(); },
      async upsertBatches(list) {
        const d = read();
        list.forEach(function (b) {
          const i = d.batches.findIndex(function (x) { return x.id === b.id; });
          if (i === -1) d.batches.push(b); else d.batches[i] = b;
        });
        write(d);
      },
      async upsertBatch(b) { return this.upsertBatches([b]); },
      async deleteBatch(id) {
        const d = read();
        d.batches = d.batches.filter(function (b) { return b.id !== id; });
        write(d);
      },
      async addEvent(ev, batch) {
        const d = read();
        d.events.push(ev);
        const i = d.batches.findIndex(function (x) { return x.id === batch.id; });
        if (i !== -1) d.batches[i] = batch;
        write(d);
      },
      async addEvents(list) {
        const d = read();
        d.events = d.events.concat(list);
        write(d);
      },
      async clearSample() {
        const d = read();
        d.batches = d.batches.filter(function (b) { return !b.sample; });
        d.events = d.events.filter(function (e) { return !e.sample; });
        write(d);
      },
      async ping() { return { ok: true, mode: 'local' }; }
    };
  }

  // ---------------- Google Sheet (Apps Script) ----------------
  function SheetStore(url) {
    async function get(action) {
      const res = await fetch(url + '?action=' + encodeURIComponent(action), { method: 'GET' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    }
    async function post(action, payload) {
      // text/plain avoids a CORS preflight, which Apps Script does not answer.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action }, payload || {}))
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    }

    return {
      mode: 'sheet',
      label: 'Live · Google Sheet',
      async load() {
        const d = await get('list');
        return { batches: d.batches || [], events: d.events || [] };
      },
      async upsertBatches(list) { return post('upsertBatches', { batches: list }); },
      async upsertBatch(b) { return post('upsertBatches', { batches: [b] }); },
      async deleteBatch(id) { return post('deleteBatch', { id: id }); },
      async addEvent(ev, batch) { return post('addEvent', { event: ev, batch: batch }); },
      async addEvents(list) { return post('addEvents', { events: list }); },
      async clearSample() { return post('clearSample', {}); },
      async ping() { return get('ping'); }
    };
  }

  root.makeStore = function (apiUrl) {
    const url = String(apiUrl || '').trim();
    return url ? SheetStore(url) : LocalStore();
  };
})(this);
