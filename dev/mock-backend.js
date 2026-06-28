/* ════════════════════════════════════════════════════════════════
 * The Good Egg — LOCAL MOCK BACKEND (dev only)
 *
 * Lets you click through the whole app — including the multi-farm flows —
 * with NO Google account, NO Apps Script deploy, and NO real Sheet. It
 * keeps an in-memory DB and reimplements the Code.gs handlers the client
 * calls, mirroring the multi-farm rules (per-farm stock, farm validation on
 * submit, INSUFFICIENT_STOCK, last-active-farm guards).
 *
 * HOW TO USE
 *   1. Serve the repo:   python3 -m http.server 8765
 *   2. Open:             http://localhost:8765/index.html?mock=1
 *   3. A "MOCK BACKEND" badge appears. Click around as a customer; tap
 *      "Admin" and enter ANY 4-digit PIN (e.g. 1234) to enter admin mode.
 *
 * State is in-memory only: reload the page to reset. `window.__mockReset()`
 * also reseeds. This file is loaded ONLY when ?mock=1 is present, so it has
 * zero effect on production.
 * ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var uuid  = function () {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  };
  var nowLabel = function () { return new Date().toUTCString(); };

  // Stable seed farm ids so links/refreshes stay coherent within a session.
  var F1 = 'farm-sunrise-0000-0000-000000000001';
  var F2 = 'farm-riverside-000-0000-000000000002';
  var F3 = 'farm-oldcoop-0000-0000-000000000003';

  var DB;
  function seed() {
    DB = {
      admins: [{ id: 'admin-1', name: 'Owner', createdAt: Date.now() }],
      farms: [
        { id: F1, name: 'Sunrise Farm',   active: true,  sortOrder: 1 },
        { id: F2, name: 'Riverside Farm', active: true,  sortOrder: 2 },
        { id: F3, name: 'Old Coop',       active: false, sortOrder: 3 }
      ],
      sizes: [
        { key: 'small',  label: 'Small',  sortOrder: 1 },
        { key: 'medium', label: 'Medium', sortOrder: 2 },
        { key: 'large',  label: 'Large',  sortOrder: 3 },
        { key: 'xl',     label: 'XL',     sortOrder: 4 },
        { key: 'jumbo',  label: 'Jumbo',  sortOrder: 5 }
      ],
      // Per-farm stock. Sunrise and Riverside offer DIFFERENT sizes on purpose,
      // and Large is split across both so you can see cross-farm totals.
      stock: {
        'farm-sunrise-0000-0000-000000000001':   { small: 24, large: 10 },
        'farm-riverside-000-0000-000000000002':   { medium: 15, large: 6, xl: 8 },
        'farm-oldcoop-0000-0000-000000000003':    { jumbo: 5 }
      },
      prices: { small: 120, medium: 140, large: 160, xl: 175, jumbo: 180 },
      orders: [
        { id: uuid(), name: 'Maria Santos', contact: '09171234567', address: 'Brgy. Obrero',
          size: 'large', trays: 2, notes: '', status: 'pending', time: nowLabel(),
          createdAt: Date.now() - 3600e3, unitPrice: 160, farm: F2 }
      ],
      activity: [{ action: 'Mock backend seeded', time: nowLabel(), createdAt: Date.now(), actor: 'system' }],
      stockEvents: [],
      priceEvents: []
    };
  }
  seed();

  // ── helpers mirroring Code.gs ──────────────────────────────────
  function farmById(id) { return DB.farms.find(function (f) { return f.id === id; }) || null; }
  function activeFarms() { return DB.farms.filter(function (f) { return f.active; }); }
  function log(action, actor) { DB.activity.push({ action: action, time: nowLabel(), createdAt: Date.now(), actor: actor || 'admin' }); }
  function state() {
    return clone({
      admins: DB.admins, farms: DB.farms, sizes: DB.sizes, stock: DB.stock,
      prices: DB.prices, orders: DB.orders, activity: DB.activity,
      stockEvents: DB.stockEvents, priceEvents: DB.priceEvents, ts: Date.now()
    });
  }
  var ok = function () { return { success: true, state: state() }; };

  // ── handlers ───────────────────────────────────────────────────
  var handlers = {
    verifyPIN: function (d) {
      // Local harness: accept any non-empty PIN. Resolve the requested admin
      // (multi-admin UI) or default to the first.
      if (!d.pinHash) return { success: false };
      var admin = (d.adminId && DB.admins.find(function (a) { return a.id === d.adminId; })) || DB.admins[0];
      return { success: true, admin: { id: admin.id, name: admin.name } };
    },

    submitOrder: function (d) {
      var o = d.order;
      if (DB.orders.some(function (r) { return r.id === o.id; })) {
        return { success: true, deduplicated: true, state: state() };
      }
      var farm = farmById(o.farm);
      if (!farm || !farm.active) {
        return { success: false, code: 'UNKNOWN_FARM', error: 'That farm is no longer available. Please pick another.' };
      }
      var unit = Number(DB.prices[o.size]) || 0;
      if (unit <= 0) {
        return { success: false, code: 'UNPRICED', error: o.size + ' is not priced yet — please pick another size.' };
      }
      // Per-(farm,size) soft reservation — don't oversell against pending orders.
      var pending = DB.orders.reduce(function (s, r) {
        return (r.status === 'pending' && r.size === o.size && r.farm === o.farm) ? s + (Number(r.trays) || 0) : s;
      }, 0);
      var onHand = (DB.stock[o.farm] && Number(DB.stock[o.farm][o.size])) || 0;
      var available = onHand - pending;
      if ((Number(o.trays) || 0) > available) {
        var left = Math.max(0, available);
        return { success: false, code: 'INSUFFICIENT_STOCK',
                 error: 'Sorry, only ' + left + ' tray(s) of ' + o.size + ' left at ' + farm.name + ' right now.' };
      }
      DB.orders.push({
        id: o.id, name: o.name, contact: o.contact, address: o.address,
        size: o.size, trays: o.trays, notes: o.notes || '', status: 'pending',
        time: nowLabel(), createdAt: o.createdAt || Date.now(), unitPrice: unit, farm: o.farm
      });
      log('Order: ' + o.name + ' — ' + o.trays + ' tray(s) ' + o.size + ' @ ' + farm.name, 'customer');
      return ok();
    },

    addStock: function (d) {
      var farm = farmById(d.farm);
      if (!farm) return { error: 'Unknown farm', code: 'UNKNOWN_FARM' };
      if (!DB.stock[d.farm]) DB.stock[d.farm] = {};
      DB.stock[d.farm][d.size] = (Number(DB.stock[d.farm][d.size]) || 0) + Number(d.trays);
      log('+' + d.trays + ' tray(s) ' + d.size + ' @ ' + farm.name + (d.note ? ' — ' + d.note : ''), d.actorName);
      return ok();
    },

    deductStock: function (d) {
      var farm = farmById(d.farm);
      if (!farm) return { error: 'Unknown farm', code: 'UNKNOWN_FARM' };
      var have = (DB.stock[d.farm] && Number(DB.stock[d.farm][d.size])) || 0;
      if (!DB.stock[d.farm] || DB.stock[d.farm][d.size] === undefined || Number(d.trays) > have) {
        return { error: 'Not enough stock', code: 'INSUFFICIENT_STOCK' };
      }
      DB.stock[d.farm][d.size] = have - Number(d.trays);
      log('-' + d.trays + ' tray(s) ' + d.size + ' @ ' + farm.name + ' (sold)', d.actorName);
      return ok();
    },

    savePrices: function (d) {
      Object.keys(d.prices || {}).forEach(function (k) {
        if (DB.prices[k] !== undefined) DB.prices[k] = Number(d.prices[k]) || 0;
      });
      log('Prices updated', d.actorName);
      return ok();
    },

    updateOrderStatus: function (d) {
      var o = DB.orders.find(function (r) { return r.id === d.orderId; });
      if (!o) return { error: 'Order not found' };
      o.status = d.status;
      log('Order ' + d.status + ': ' + o.name, d.actorName);
      return ok();
    },

    deleteOrder: function (d) {
      DB.orders = DB.orders.filter(function (r) { return r.id !== d.orderId; });
      log('Deleted order', d.actorName);
      return ok();
    },

    addSize: function (d) {
      var key = String(d.key || '').toLowerCase();
      if (DB.sizes.some(function (s) { return s.key === key; })) return { error: 'Size "' + key + '" already exists' };
      var next = DB.sizes.reduce(function (m, s) { return Math.max(m, s.sortOrder); }, 0) + 1;
      DB.sizes.push({ key: key, label: d.label || key, sortOrder: next });
      DB.prices[key] = 0;  // global price seeded; NO stock (opt-in per farm)
      log('Added egg size: ' + (d.label || key) + ' (' + key + ')', d.actorName);
      return ok();
    },

    deleteSize: function (d) {
      DB.sizes = DB.sizes.filter(function (s) { return s.key !== d.key; });
      delete DB.prices[d.key];
      Object.keys(DB.stock).forEach(function (f) { delete DB.stock[f][d.key]; });
      log('Deleted egg size: ' + d.key, d.actorName);
      return ok();
    },

    addFarm: function (d) {
      var name = String(d.name || '').trim();
      if (!name) return { error: 'Farm name is required' };
      if (DB.farms.some(function (f) { return f.active && f.name.toLowerCase() === name.toLowerCase(); })) {
        return { error: 'A farm named "' + name + '" already exists' };
      }
      var next = DB.farms.reduce(function (m, f) { return Math.max(m, f.sortOrder); }, 0) + 1;
      var farm = { id: uuid(), name: name, active: true, sortOrder: next };
      DB.farms.push(farm);
      DB.stock[farm.id] = {};
      log('Added farm: ' + name, d.actorName);
      return { success: true, farm: { id: farm.id, name: name }, state: state() };
    },

    renameFarm: function (d) {
      var f = farmById(d.targetId);
      if (!f) return { error: 'Farm not found' };
      if (DB.farms.some(function (x) { return x.active && x.id !== d.targetId && x.name.toLowerCase() === String(d.newName).toLowerCase(); })) {
        return { error: 'A farm named "' + d.newName + '" already exists' };
      }
      var old = f.name; f.name = String(d.newName).trim();
      log('Renamed farm: ' + old + ' → ' + f.name, d.actorName);
      return ok();
    },

    setFarmActive: function (d) {
      var f = farmById(d.targetId);
      if (!f) return { error: 'Farm not found' };
      var active = d.active === true || String(d.active) === 'true';
      if (!active && f.active && activeFarms().filter(function (x) { return x.id !== f.id; }).length === 0) {
        return { error: 'Cannot deactivate the last active farm' };
      }
      f.active = active;
      log((active ? 'Activated' : 'Deactivated') + ' farm: ' + f.name, d.actorName);
      return ok();
    },

    deleteFarm: function (d) {
      var f = farmById(d.targetId);
      if (!f) return { error: 'Farm not found' };
      if (f.active && activeFarms().filter(function (x) { return x.id !== f.id; }).length === 0) {
        return { error: 'Cannot remove the last active farm' };
      }
      var refs = DB.orders.filter(function (o) { return o.farm === d.targetId; }).length;
      if (refs > 0) {
        return { error: 'This farm has ' + refs + ' order(s) — deactivate it instead of deleting to keep order history.' };
      }
      DB.farms = DB.farms.filter(function (x) { return x.id !== d.targetId; });
      delete DB.stock[d.targetId];
      log('Deleted farm: ' + f.name, d.actorName);
      return ok();
    },

    addFarmSize: function (d) {
      if (!farmById(d.farm)) return { error: 'Unknown farm', code: 'UNKNOWN_FARM' };
      var size = String(d.size || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
      if (!size) return { error: 'Size key is required' };
      var exists = DB.sizes.some(function (s) { return s.key === size; });
      if (!exists) {
        // Create in the shared catalog + seed a global price (mirrors Code.gs).
        var label = String(d.label || '').trim() || (size.charAt(0).toUpperCase() + size.slice(1));
        var next = DB.sizes.reduce(function (m, s) { return Math.max(m, s.sortOrder); }, 0) + 1;
        DB.sizes.push({ key: size, label: label, sortOrder: next });
        DB.prices[size] = 0;
      }
      if (!DB.stock[d.farm]) DB.stock[d.farm] = {};
      if (DB.stock[d.farm][size] !== undefined) return { error: 'Farm already offers that size' };
      DB.stock[d.farm][size] = 0;
      log(farmById(d.farm).name + (exists ? ' now offers ' : ' added new egg size ') + size, d.actorName);
      return ok();
    },

    removeFarmSize: function (d) {
      if (!DB.stock[d.farm] || DB.stock[d.farm][d.size] === undefined) return { error: 'Farm does not offer that size' };
      delete DB.stock[d.farm][d.size];
      log((farmById(d.farm) ? farmById(d.farm).name : d.farm) + ' no longer offers ' + d.size, d.actorName);
      return ok();
    },

    addAdmin: function (d) {
      var admin = { id: uuid(), name: String(d.name).trim(), createdAt: Date.now() };
      DB.admins.push(admin);
      log('Added admin: ' + admin.name, d.actorName);
      return { success: true, admin: admin, state: state() };
    },
    deleteAdmin: function (d) {
      if (DB.admins.length === 1) return { error: 'Cannot remove the last active admin' };
      DB.admins = DB.admins.filter(function (a) { return a.id !== d.targetId; });
      return ok();
    },
    renameAdmin: function (d) {
      var a = DB.admins.find(function (x) { return x.id === d.targetId; });
      if (a) a.name = String(d.newName).trim();
      return ok();
    },
    changePIN: function () { return { success: true }; }
  };

  // ── install: route the app's network calls into the in-memory DB ──
  function respond(obj) {
    // Simulate a little latency so loading states are visible.
    return new Promise(function (res) { setTimeout(function () { res(obj); }, 120); });
  }
  window.__MOCK_BACKEND__ = {
    callScript: function (payload) {
      var h = handlers[payload && payload.action];
      return respond(h ? h(payload) : { error: 'Unknown action: ' + (payload && payload.action) });
    },
    fetchState: function () { return respond(state()); }
  };
  window.__mockReset = function () { seed(); if (window.loadState) window.loadState(); console.log('[mock] reseeded'); };
  window.installMockBackend = function () { /* presence of __MOCK_BACKEND__ is the switch */ };

  // Visible banner so it's obvious you're on the mock, not the real backend.
  document.addEventListener('DOMContentLoaded', addBadge);
  if (document.readyState !== 'loading') addBadge();
  function addBadge() {
    if (document.getElementById('mock-badge')) return;
    var b = document.createElement('div');
    b.id = 'mock-badge';
    b.textContent = 'MOCK BACKEND — data resets on reload';
    b.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#8B5A3C;color:#FFFCF5;' +
      'font:600 11px system-ui,sans-serif;text-align:center;padding:4px;letter-spacing:.04em;';
    document.body.appendChild(b);
  }

  console.log('%c[mock] backend active', 'color:#8B5A3C;font-weight:bold');
  console.log('[mock] admin PIN: any value works (try 1234). window.__mockReset() to reseed.');
})();
