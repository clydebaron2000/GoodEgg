// ══════════════════════════════════════════════════════════════
// The Good Egg — Google Apps Script Backend
// Paste this entire file into your Google Apps Script editor.
// Run setupSpreadsheet() once before deploying.
// Deploy as: Execute as Me | Access: Anyone (anonymous)
// ══════════════════════════════════════════════════════════════

var SHEET_STOCK        = 'stock';
var SHEET_PRICES       = 'prices';
var SHEET_ORDERS       = 'orders';
var SHEET_ACTIVITY     = 'activity';
var SHEET_CONFIG       = 'config';
var SHEET_SIZES        = 'sizes';
var SHEET_ADMINS       = 'admins';
var SHEET_FARMS        = 'farms';
var SHEET_STOCK_EVENTS = 'stock_events';
var SHEET_PRICE_EVENTS = 'price_events';
var PIN_KEY            = 'adminPinHash';  // legacy single-PIN config row, kept for migration
var EVENT_PAGE_SIZE    = 500;  // cap events returned by getState (most recent first)

var SIZE_LABELS = { small: 'Small', medium: 'Medium', large: 'Large', xl: 'XL', jumbo: 'Jumbo' };

// ── ROUTING ────────────────────────────────────────────────────

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || 'getState';
  try {
    if (action === 'getState') return jsonResponse(getState());
    return jsonResponse({ error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    // Admin actions: verify (adminId, pinHash) against the admins sheet.
    // On success we stamp data._admin with the resolved admin so downstream
    // handlers can attribute activity / event log entries to a real name.
    //
    // Backwards-compat: an OLDER client (pre-multi-admin) sends only
    // {pinHash}. We accept that too — match against any active admin's
    // pinHash, first hit wins. Lets the production deploy keep working
    // while feature branches share the same Apps Script backend.
    var adminActions = ['addStock', 'deductStock', 'savePrices',
                        'updateOrderStatus', 'deleteOrder', 'changePIN',
                        'addSize', 'deleteSize',
                        'addAdmin', 'deleteAdmin', 'renameAdmin',
                        'addFarm', 'renameFarm', 'setFarmActive', 'deleteFarm',
                        'addFarmSize', 'removeFarmSize'];
    if (adminActions.indexOf(action) !== -1) {
      var admin = verifyAdminLogin_(data.adminId, data.pinHash);
      if (!admin) admin = verifyLegacyLogin_(data.pinHash);
      if (!admin) return jsonResponse({ error: 'Invalid login', code: 'UNAUTHORIZED' });
      data._admin = admin;            // { id, name }
      data.actorName = admin.name;     // convenience for legacy callsites
    }

    switch (action) {
      case 'verifyPIN':         return jsonResponse(doVerifyPIN(data));
      case 'submitOrder':       return jsonResponse(submitOrder(data));
      case 'addStock':          return jsonResponse(addStock(data));
      case 'deductStock':       return jsonResponse(deductStock(data));
      case 'savePrices':        return jsonResponse(savePrices(data));
      case 'updateOrderStatus': return jsonResponse(updateOrderStatus(data));
      case 'deleteOrder':       return jsonResponse(deleteOrder(data));
      case 'changePIN':         return jsonResponse(changePIN(data));
      case 'addSize':           return jsonResponse(addSize(data));
      case 'deleteSize':        return jsonResponse(deleteSize(data));
      case 'addAdmin':          return jsonResponse(addAdmin(data));
      case 'deleteAdmin':       return jsonResponse(deleteAdmin(data));
      case 'renameAdmin':       return jsonResponse(renameAdmin(data));
      case 'addFarm':           return jsonResponse(addFarm(data));
      case 'renameFarm':        return jsonResponse(renameFarm(data));
      case 'setFarmActive':     return jsonResponse(setFarmActive(data));
      case 'deleteFarm':        return jsonResponse(deleteFarm(data));
      case 'addFarmSize':       return jsonResponse(addFarmSize(data));
      case 'removeFarmSize':    return jsonResponse(removeFarmSize(data));
      default:                  return jsonResponse({ error: 'Unknown action' });
    }
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ── GET STATE ──────────────────────────────────────────────────
// Returns all public data. PIN hash is never included.

function getState() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    admins:       readAdminsPublic(ss),   // safe-to-expose subset (no pinHash)
    farms:        readFarms(ss),          // all farms (no secrets); client shows active to customers
    sizes:        readSizes(ss),
    stock:        readStock(ss),
    prices:       readPrices(ss),
    orders:       readOrders(ss),
    activity:     readActivity(ss),
    stockEvents:  readStockEvents(ss),
    priceEvents:  readPriceEvents(ss),
    ts:           Date.now()
  };
}

// ── SIZES ──────────────────────────────────────────────────────

function readSizes(ss) {
  var sheet = ss.getSheetByName(SHEET_SIZES);
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var out  = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    out.push({
      key:       String(rows[i][0]),
      label:     String(rows[i][1] || rows[i][0]),
      sortOrder: Number(rows[i][2]) || 0
    });
  }
  out.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
  return out;
}

function addSize(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var key   = String(data.key || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    var label = String(data.label || '').trim() || key;
    if (!key) return { error: 'Size key is required' };

    var sizes = readSizes(ss);
    if (sizes.some(function (s) { return s.key === key; })) {
      return { error: 'Size "' + key + '" already exists' };
    }
    var nextOrder = sizes.reduce(function (m, s) { return Math.max(m, s.sortOrder); }, 0) + 1;

    ss.getSheetByName(SHEET_SIZES).appendRow([key, asText_(label), nextOrder]);
    // Seed the global price row. Stock rows are NOT seeded here: sizes are
    // opt-in per farm (a farm starts offering a size via addFarmSize, which
    // creates its (size, farm) stock row).
    ss.getSheetByName(SHEET_PRICES).appendRow([key, 0]);

    logActivity(ss, 'Added egg size: ' + label + ' (' + key + ')', data._admin && data._admin.name);
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

function deleteSize(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var key = String(data.key || '');
    if (!key) return { error: 'Size key is required' };

    // Capture details for the activity log before we wipe anything.
    var sizes = readSizes(ss);
    var size  = sizes.find(function (s) { return s.key === key; });
    if (!size) return { error: 'Size not found' };
    var label = size.label;

    // A size can have one stock row per farm now — delete them all and sum
    // the trays erased (bottom-up so indices stay valid as rows drop out).
    var stockSheet = ss.getSheetByName(SHEET_STOCK);
    var srows = stockSheet.getDataRange().getValues();
    var trays = 0;
    for (var s = srows.length - 1; s >= 1; s--) {
      if (srows[s][0] === key) {
        trays += Number(srows[s][1]) || 0;
        stockSheet.deleteRow(s + 1);
      }
    }
    var price = deleteRowByKey_(ss.getSheetByName(SHEET_PRICES), key, 1);
    deleteRowByKey_(ss.getSheetByName(SHEET_SIZES), key, 0);

    var msg = 'Deleted egg size: ' + label + ' (' + key + ')';
    if (trays > 0) msg += ' — erased ' + trays + ' tray' + plural(trays) + ' of stock';
    if (price > 0) msg += (trays > 0 ? ', priced' : ' — priced') + ' at ₱' + price + '/tray';
    logActivity(ss, msg, data._admin && data._admin.name);
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

// Helper: delete the first row in `sheet` whose column 0 == key; returns
// the value of column `valueCol` from that row before deletion (or 0 if
// no row matched / no value column needed).
function deleteRowByKey_(sheet, key, valueCol) {
  if (!sheet) return 0;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) {
      var value = valueCol >= 0 ? (Number(rows[i][valueCol]) || 0) : 0;
      sheet.deleteRow(i + 1);
      return value;
    }
  }
  return 0;
}

// ── ADMINS ─────────────────────────────────────────────────────
// Authoritative reader: returns every row including pinHash. Used only by
// the auth gate and write helpers.
function readAdmins(ss) {
  var sheet = ss.getSheetByName(SHEET_ADMINS);
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var out  = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    out.push({
      id:        String(rows[i][0]),
      name:      String(rows[i][1] || rows[i][0]),
      pinHash:   String(rows[i][2] || ''),
      createdAt: Number(rows[i][3]) || 0,
      active:    rows[i][4] === false ? false : true
    });
  }
  return out;
}

// Public list: only what the client should ever see (no pinHash, only active).
function readAdminsPublic(ss) {
  return readAdmins(ss)
    .filter(function (a) { return a.active; })
    .map(function (a) { return { id: a.id, name: a.name, createdAt: a.createdAt }; });
}

// Verify (adminId, pinHash) and return { id, name } if valid, else null.
function verifyAdminLogin_(adminId, pinHash) {
  if (!adminId || !pinHash) return null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var admin = readAdmins(ss).find(function (a) {
    return a.active && a.id === adminId;
  });
  if (!admin) return null;
  if (admin.pinHash !== pinHash) return null;
  return { id: admin.id, name: admin.name };
}

// Legacy login (pre-multi-admin clients): no adminId, just a pinHash.
// We accept it if it matches ANY active admin's stored pinHash. The first
// match wins for attribution. Lets the production deploy keep working
// while a feature branch shares the same Apps Script backend.
function verifyLegacyLogin_(pinHash) {
  if (!pinHash) return null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var admin = readAdmins(ss).find(function (a) {
    return a.active && a.pinHash === pinHash;
  });
  if (admin) return { id: admin.id, name: admin.name };
  // Older deployments may still only have the legacy config row before
  // migrate() has been re-run. Accept that too.
  var legacy = readConfig(ss, PIN_KEY);
  if (legacy && legacy === pinHash) return { id: '_legacy', name: 'Admin' };
  return null;
}

// Public endpoint called from the PIN screen. New clients send
// (adminId, pinHash); legacy clients send only pinHash. Returns
// { success: true, admin } on the new path, { success: true } on the
// legacy path so old clients still light up admin mode.
function doVerifyPIN(data) {
  var admin = verifyAdminLogin_(data.adminId, data.pinHash);
  if (admin) return { success: true, admin: admin };
  admin = verifyLegacyLogin_(data.pinHash);
  if (admin) return { success: true, admin: admin };  // new client field is harmless to old client
  return { success: false };
}

// Insert a new admin row. Used by both addAdmin (API) and addAdminInteractive
// (editor helper). Returns { success, admin } or { error }.
function createAdmin_(ss, name, pinHash) {
  name = String(name || '').trim();
  if (!name) return { error: 'Name is required' };
  if (!/^[0-9a-f]{64}$/i.test(String(pinHash || ''))) {
    return { error: 'PIN hash must be a 64-char hex string' };
  }
  var existing = readAdmins(ss);
  var clash = existing.some(function (a) {
    return a.active && a.name.toLowerCase() === name.toLowerCase();
  });
  if (clash) return { error: 'An admin named "' + name + '" already exists' };

  var sheet = ss.getSheetByName(SHEET_ADMINS);
  if (!sheet) return { error: 'admins sheet not found — run migrate()' };
  var id = Utilities.getUuid();
  sheet.appendRow([id, asText_(name), String(pinHash), Date.now(), true]);
  return { success: true, admin: { id: id, name: name } };
}

function addAdmin(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var res = createAdmin_(ss, data.name, data.newPinHash);
  if (res.error) return res;
  logActivity(ss, 'Added admin: ' + res.admin.name, data._admin.name);
  return { success: true, admin: res.admin, state: getState() };
}

function deleteAdmin(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var targetId = String(data.targetId || '');
  if (!targetId) return { error: 'targetId required' };

  var admins = readAdmins(ss);
  var target = admins.find(function (a) { return a.id === targetId; });
  if (!target) return { error: 'Admin not found' };

  // Safety net: never let the active admin set drop to zero.
  var activeOthers = admins.filter(function (a) { return a.active && a.id !== targetId; });
  if (target.active && activeOthers.length === 0) {
    return { error: 'Cannot remove the last active admin' };
  }

  var sheet = ss.getSheetByName(SHEET_ADMINS);
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === targetId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  logActivity(ss, 'Removed admin: ' + target.name, data._admin.name);
  return { success: true, state: getState() };
}

function renameAdmin(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var targetId = String(data.targetId || '');
  var newName  = String(data.newName || '').trim();
  if (!targetId || !newName) return { error: 'targetId and newName required' };

  var admins = readAdmins(ss);
  var clash = admins.some(function (a) {
    return a.active && a.id !== targetId && a.name.toLowerCase() === newName.toLowerCase();
  });
  if (clash) return { error: 'An admin named "' + newName + '" already exists' };

  var sheet = ss.getSheetByName(SHEET_ADMINS);
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === targetId) {
      var oldName = rows[i][1];
      sheet.getRange(i + 1, 2).setValue(asText_(newName));
      logActivity(ss, 'Renamed admin: ' + oldName + ' → ' + newName, data._admin.name);
      return { success: true, state: getState() };
    }
  }
  return { error: 'Admin not found' };
}

// Changes the LOGGED-IN admin's own password. data._admin came from the
// auth gate in doPost.
//
// Two paths:
//   - Multi-admin login: update the admin's row in the admins sheet.
//   - Legacy login (id = '_legacy'): the caller doesn't yet know which
//     admin row they are, so we update the legacy config.adminPinHash.
function changePIN(data) {
  if (!data.newPinHash) return { error: 'No new password hash provided' };
  if (!/^[0-9a-f]{64}$/i.test(data.newPinHash)) return { error: 'Invalid password hash' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (data._admin.id === '_legacy') {
    writeConfig(ss, PIN_KEY, data.newPinHash);
    logActivity(ss, 'Legacy admin password changed', data._admin.name);
    return { success: true };
  }

  var sheet = ss.getSheetByName(SHEET_ADMINS);
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === data._admin.id) {
      sheet.getRange(i + 1, 3).setValue(data.newPinHash);
      logActivity(ss, data._admin.name + ' changed their password', data._admin.name);
      return { success: true };
    }
  }
  return { error: 'Admin record not found' };
}

// ── FARMS ──────────────────────────────────────────────────────
// Each farm holds its own stock (one (size, farm) row per offered size in
// the `stock` sheet). Orders draw from exactly one farm; prices are global.
// Mirrors the admins pattern: soft `active` flag, name uniqueness, and a
// guard against removing the last active farm out from under the shop.

function readFarms(ss) {
  var sheet = ss.getSheetByName(SHEET_FARMS);
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var out  = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    out.push({
      id:        String(rows[i][0]),
      name:      String(rows[i][1] || rows[i][0]),
      active:    rows[i][2] === false ? false : true,
      sortOrder: Number(rows[i][3]) || 0
    });
  }
  out.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
  return out;
}

// Look up a single farm record by id, or null.
function farmById_(ss, id) {
  if (!id) return null;
  var farms = readFarms(ss);
  for (var i = 0; i < farms.length; i++) {
    if (farms[i].id === String(id)) return farms[i];
  }
  return null;
}

// Display name for a farm id (falls back to the id, then a dash).
function farmName_(ss, id) {
  var f = farmById_(ss, id);
  return f ? f.name : (id || '—');
}

// Insert a new farm row. Shared by addFarm (API) and setup/migrate seeding.
function createFarm_(ss, name) {
  name = String(name || '').trim();
  if (!name) return { error: 'Farm name is required' };
  var sheet = ss.getSheetByName(SHEET_FARMS);
  if (!sheet) return { error: 'farms sheet not found — run migrate()' };
  var existing = readFarms(ss);
  var clash = existing.some(function (f) {
    return f.active && f.name.toLowerCase() === name.toLowerCase();
  });
  if (clash) return { error: 'A farm named "' + name + '" already exists' };
  var nextOrder = existing.reduce(function (m, f) { return Math.max(m, f.sortOrder); }, 0) + 1;
  var id = Utilities.getUuid();
  sheet.appendRow([id, asText_(name), true, nextOrder]);
  return { success: true, farm: { id: id, name: name } };
}

function addFarm(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var res = createFarm_(ss, data.name);
    if (res.error) return res;
    logActivity(ss, 'Added farm: ' + res.farm.name, data._admin && data._admin.name);
    return { success: true, farm: res.farm, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

function renameFarm(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var targetId = String(data.targetId || '');
    var newName  = String(data.newName || '').trim();
    if (!targetId || !newName) return { error: 'targetId and newName required' };
    var farms = readFarms(ss);
    var clash = farms.some(function (f) {
      return f.active && f.id !== targetId && f.name.toLowerCase() === newName.toLowerCase();
    });
    if (clash) return { error: 'A farm named "' + newName + '" already exists' };
    var sheet = ss.getSheetByName(SHEET_FARMS);
    var rows  = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === targetId) {
        var oldName = rows[i][1];
        sheet.getRange(i + 1, 2).setValue(asText_(newName));
        logActivity(ss, 'Renamed farm: ' + oldName + ' → ' + newName, data._admin && data._admin.name);
        return { success: true, state: getState() };
      }
    }
    return { error: 'Farm not found' };
  } finally {
    lock.releaseLock();
  }
}

function setFarmActive(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var targetId = String(data.targetId || '');
    var active   = data.active === true || String(data.active) === 'true';
    if (!targetId) return { error: 'targetId required' };
    var farms  = readFarms(ss);
    var target = farms.find(function (f) { return f.id === targetId; });
    if (!target) return { error: 'Farm not found' };
    // Don't deactivate the last active farm — the shop needs at least one.
    if (!active && target.active) {
      var activeOthers = farms.filter(function (f) { return f.active && f.id !== targetId; });
      if (activeOthers.length === 0) return { error: 'Cannot deactivate the last active farm' };
    }
    var sheet = ss.getSheetByName(SHEET_FARMS);
    var rows  = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === targetId) {
        sheet.getRange(i + 1, 3).setValue(active);
        logActivity(ss, (active ? 'Activated' : 'Deactivated') + ' farm: ' + target.name, data._admin && data._admin.name);
        return { success: true, state: getState() };
      }
    }
    return { error: 'Farm not found' };
  } finally {
    lock.releaseLock();
  }
}

function deleteFarm(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var targetId = String(data.targetId || '');
    if (!targetId) return { error: 'targetId required' };
    var farms  = readFarms(ss);
    var target = farms.find(function (f) { return f.id === targetId; });
    if (!target) return { error: 'Farm not found' };
    // Never let the active farm set drop to zero.
    var activeOthers = farms.filter(function (f) { return f.active && f.id !== targetId; });
    if (target.active && activeOthers.length === 0) {
      return { error: 'Cannot remove the last active farm' };
    }
    // Remove the farm row.
    var sheet = ss.getSheetByName(SHEET_FARMS);
    var rows  = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === targetId) { sheet.deleteRow(i + 1); break; }
    }
    // Remove that farm's stock rows (its offered sizes). Walk bottom-up so
    // deletions don't shift the indices of rows we haven't checked yet.
    var stock = ss.getSheetByName(SHEET_STOCK);
    var srows = stock.getDataRange().getValues();
    var erased = 0;
    for (var j = srows.length - 1; j >= 1; j--) {
      if (String(srows[j][2] || '') === targetId) { stock.deleteRow(j + 1); erased++; }
    }
    var msg = 'Deleted farm: ' + target.name;
    if (erased > 0) msg += ' — erased ' + erased + ' stock row' + plural(erased);
    logActivity(ss, msg, data._admin && data._admin.name);
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

// A farm starts offering a size: create a (size, farm) stock row at 0 trays.
// Sizes are a shared catalog but managed per-farm: if `data.size` is a new key
// (no matching row in the `sizes` tab), it is created on the fly from
// `data.label` and seeded with a global price row at 0. Existing keys are just
// offered at this farm.
function addFarmSize(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss   = SpreadsheetApp.getActiveSpreadsheet();
    var farm = String(data.farm || '');
    var size = String(data.size || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    if (!farmById_(ss, farm)) return { error: 'Unknown farm', code: 'UNKNOWN_FARM' };
    if (!size) return { error: 'Size key is required' };

    var sizes  = readSizes(ss);
    var exists = sizes.some(function (s) { return s.key === size; });
    if (!exists) {
      // Create the size in the shared catalog: append to `sizes` + seed a
      // global price row. (Prices are global; this farm sets stock per size.)
      var label = String(data.label || '').trim() || (size.charAt(0).toUpperCase() + size.slice(1));
      var nextOrder = sizes.reduce(function (m, s) { return Math.max(m, s.sortOrder); }, 0) + 1;
      ss.getSheetByName(SHEET_SIZES).appendRow([size, asText_(label), nextOrder]);
      ss.getSheetByName(SHEET_PRICES).appendRow([size, 0]);
    }

    var sheet = ss.getSheetByName(SHEET_STOCK);
    var rows  = sheet.getDataRange().getValues();
    if (findStockRow_(rows, size, farm) !== -1) {
      return { error: 'Farm already offers that size' };
    }
    sheet.appendRow([size, 0, farm]);
    var verb = exists ? ' now offers ' : ' added new egg size ';
    logActivity(ss, farmName_(ss, farm) + verb + sizeMention_(size), data._admin && data._admin.name);
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

// A farm stops offering a size: delete its (size, farm) stock row.
function removeFarmSize(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss   = SpreadsheetApp.getActiveSpreadsheet();
    var farm = String(data.farm || '');
    var size = String(data.size || '');
    var sheet = ss.getSheetByName(SHEET_STOCK);
    var rows  = sheet.getDataRange().getValues();
    var rowIdx = findStockRow_(rows, size, farm);
    if (rowIdx === -1) return { error: 'Farm does not offer that size' };
    var trays = Number(rows[rowIdx - 1][1]) || 0;
    sheet.deleteRow(rowIdx);
    var msg = farmName_(ss, farm) + ' no longer offers ' + sizeMention_(size);
    if (trays > 0) msg += ' — erased ' + trays + ' tray' + plural(trays);
    logActivity(ss, msg, data._admin && data._admin.name);
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

// ── CONFIG (key/value sheet) ───────────────────────────────────

function readConfig(ss, key) {
  var sheet = ss.getSheetByName(SHEET_CONFIG);
  if (!sheet) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) return rows[i][1];
  }
  return null;
}

function writeConfig(ss, key, value) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName(SHEET_CONFIG);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_CONFIG);
      sheet.appendRow(['key', 'value']);
      sheet.getRange('A1:B1').setFontWeight('bold');
    }
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) {
        sheet.getRange(i + 1, 2).setValue(value);
        return;
      }
    }
    sheet.appendRow([key, value]);
  } finally {
    lock.releaseLock();
  }
}

// ── STOCK ──────────────────────────────────────────────────────

// Stock rows are [size, trays, farm]. Returns a nested map keyed by farm:
//   { farmId: { size: trays } }
// A (size, farm) row's existence means "this farm carries this size" — the
// tray count may legitimately be 0. Rows with a blank farm (only possible in
// the brief window before migrate() runs) group under '' and are ignored by
// the client, which only renders known farms.
function readStock(ss) {
  var rows  = ss.getSheetByName(SHEET_STOCK).getDataRange().getValues();
  var stock = {};
  for (var i = 1; i < rows.length; i++) {
    var size = rows[i][0];
    if (!size) continue;
    var farm = String(rows[i][2] || '');
    if (!stock[farm]) stock[farm] = {};
    stock[farm][size] = Number(rows[i][1]) || 0;
  }
  return stock;
}

// Find the 1-based sheet row index of the (size, farm) stock entry, or -1.
// `rows` is the already-read getValues() array (col 0 size, col 2 farm).
function findStockRow_(rows, size, farm) {
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === size && String(rows[i][2] || '') === String(farm)) return i + 1;
  }
  return -1;
}

function addStock(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_STOCK);
    var rows  = sheet.getDataRange().getValues();
    var trays = Number(data.trays);
    var farm  = String(data.farm || '');
    if (!farmById_(ss, farm)) return { error: 'Unknown farm', code: 'UNKNOWN_FARM' };

    var before = 0, after = 0;
    var rowIdx = findStockRow_(rows, data.size, farm);
    if (rowIdx === -1) {
      // First stock for this (farm, size) — the farm starts offering this size.
      after = trays;
      sheet.appendRow([data.size, after, farm]);
    } else {
      before = Number(rows[rowIdx - 1][1]) || 0;
      after  = before + trays;
      sheet.getRange(rowIdx, 2).setValue(after);
    }
    var note  = data.note ? ' — ' + data.note : '';
    var actor = data._admin && data._admin.name;
    logActivity(ss, '+' + trays + ' tray' + plural(trays) + ' ' + sizeMention_(data.size) + ' @ ' + farmName_(ss, farm) + note, actor);
    logStockEvent(ss, { size: data.size, delta: trays, reason: 'restock', before: before, after: after, note: data.note || '', farm: farm }, actor);
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

function deductStock(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_STOCK);
    var rows  = sheet.getDataRange().getValues();
    var trays = Number(data.trays);
    var farm  = String(data.farm || '');
    if (!farmById_(ss, farm)) return { error: 'Unknown farm', code: 'UNKNOWN_FARM' };

    var rowIdx = findStockRow_(rows, data.size, farm);
    if (rowIdx === -1) {
      return { error: 'Not enough stock', code: 'INSUFFICIENT_STOCK' };
    }
    var before = Number(rows[rowIdx - 1][1]) || 0;
    if (trays > before) {
      return { error: 'Not enough stock', code: 'INSUFFICIENT_STOCK' };
    }
    var after = before - trays;
    sheet.getRange(rowIdx, 2).setValue(after);

    var actor = data._admin && data._admin.name;
    logActivity(ss, '-' + trays + ' tray' + plural(trays) + ' ' + sizeMention_(data.size) + ' @ ' + farmName_(ss, farm) + ' (sold)', actor);
    logStockEvent(ss, { size: data.size, delta: -trays, reason: 'sold', before: before, after: after, note: data.note || '', farm: farm }, actor);
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

// ── PRICES ─────────────────────────────────────────────────────

function readPrices(ss) {
  var rows   = ss.getSheetByName(SHEET_PRICES).getDataRange().getValues();
  var prices = {};
  for (var i = 1; i < rows.length; i++) prices[rows[i][0]] = rows[i][1];
  return prices;
}

function savePrices(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss      = SpreadsheetApp.getActiveSpreadsheet();
    var sheet   = ss.getSheetByName(SHEET_PRICES);
    var rows    = sheet.getDataRange().getValues();
    var changes = [];
    for (var i = 1; i < rows.length; i++) {
      var size = rows[i][0];
      if (data.prices[size] !== undefined) {
        var oldPrice = Number(rows[i][1]) || 0;
        var newPrice = Number(data.prices[size]) || 0;
        if (oldPrice !== newPrice) {
          sheet.getRange(i + 1, 2).setValue(newPrice);
          logPriceEvent(ss, { size: size, oldPrice: oldPrice, newPrice: newPrice }, data._admin && data._admin.name);
          changes.push(sizeMention_(size) + ' ₱' + oldPrice + ' → ₱' + newPrice);
        }
      }
    }
    if (changes.length > 0) {
      var prefix = changes.length === 1 ? 'Price updated: ' : 'Prices updated: ';
      logActivity(ss, prefix + changes.join(', '), data._admin && data._admin.name);
    }
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

// ── ORDERS ─────────────────────────────────────────────────────

function readOrders(ss) {
  var rows   = ss.getSheetByName(SHEET_ORDERS).getDataRange().getValues();
  var orders = [];
  for (var i = 1; i < rows.length; i++) {
    orders.push({
      id:        rows[i][0],
      name:      rows[i][1],
      contact:   rows[i][2],
      address:   rows[i][3],
      size:      rows[i][4],
      trays:     rows[i][5],
      notes:     rows[i][6],
      status:    rows[i][7],
      time:      rows[i][8],
      createdAt: rows[i][9]  || null,  // epoch ms; null for pre-migration rows
      unitPrice: rows[i][10] || null,  // PHP/tray snapshotted at submit time
      farm:      rows[i][11] || null   // farm id the order draws from; null for pre-migration rows
    });
  }
  return orders;
}

function submitOrder(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_ORDERS);

    // ── Deduplication: if same client ID already exists, return success silently
    var existing = sheet.getDataRange().getValues();
    for (var i = 1; i < existing.length; i++) {
      if (existing[i][0] === data.order.id) {
        return { success: true, deduplicated: true, state: getState() };
      }
    }

    var o = data.order;
    // Every order draws from a specific farm. Validate it exists and is
    // active so a stale client can't pin an order to a removed farm.
    var farm = String(o.farm || '');
    var farmRec = farmById_(ss, farm);
    if (!farmRec || !farmRec.active) {
      return { success: false, code: 'UNKNOWN_FARM', error: 'That farm is no longer available. Please pick another.' };
    }
    // Lock in the current price as the order's unit price. Server-side so
    // a tampered client can't underreport revenue, and so later price
    // changes don't rewrite history. Prices are global (not per-farm).
    var currentPrices = readPrices(ss);
    var unitPrice     = Number(currentPrices[o.size]) || 0;
    var createdAt     = o.createdAt || Date.now();
    sheet.appendRow([
      o.id, asText_(o.name), asText_(o.contact), asText_(o.address),
      o.size, o.trays, asText_(o.notes || ''), 'pending', utcLabel_(createdAt),
      createdAt,
      unitPrice,
      farm
    ]);
    logActivity(ss, 'Order: ' + o.name + ' — ' + o.trays + ' tray' + plural(o.trays) + ' ' + sizeMention_(o.size) + ' @ ' + farmRec.name, 'customer');
    return { success: true, state: getState() };
  } finally {
    lock.releaseLock();
  }
}

function updateOrderStatus(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_ORDERS);
    var rows  = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === data.orderId) {
        sheet.getRange(i + 1, 8).setValue(data.status);
        logActivity(ss, 'Order ' + data.status + ': ' + rows[i][1], data._admin && data._admin.name);
        return { success: true, state: getState() };
      }
    }
    return { error: 'Order not found' };
  } finally {
    lock.releaseLock();
  }
}

function deleteOrder(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_ORDERS);
    var rows  = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === data.orderId) {
        // Snapshot the row before deletion so the activity log preserves
        // a full record of what was wiped.
        var deleted = {
          id:        rows[i][0],
          name:      rows[i][1],
          contact:   rows[i][2],
          address:   rows[i][3],
          size:      rows[i][4],
          trays:     rows[i][5],
          notes:     rows[i][6],
          status:    rows[i][7],
          time:      rows[i][8],
          createdAt: rows[i][9],
          unitPrice: rows[i][10]
        };
        sheet.deleteRow(i + 1);
        logActivity(ss, describeDeletedOrder_(deleted), data._admin && data._admin.name);
        return { success: true, state: getState() };
      }
    }
    return { error: 'Order not found' };
  } finally {
    lock.releaseLock();
  }
}

// Format a deleted-order activity log entry that preserves everything
// useful for audit/recovery in a single readable line. Mirrors the
// client-side formatter in index.html.
function describeDeletedOrder_(o) {
  var unit  = Number(o.unitPrice) || 0;
  var trays = Number(o.trays) || 0;
  var total = unit * trays;
  var loc   = [o.contact, o.address].filter(function (s) { return s; }).join(', ');
  var parts = [
    'Deleted [' + (o.status || 'unknown') + '] order:',
    o.name + (loc ? ' (' + loc + ')' : ''),
    '— ' + trays + ' tray' + plural(trays) + ' ' + sizeMention_(o.size) +
      ' @ ₱' + unit + ' = ₱' + total,
    '— placed ' + (o.time || 'unknown time')
  ];
  if (o.notes) parts.push('— notes: "' + o.notes + '"');
  return parts.join(' ');
}

// ── ACTIVITY ───────────────────────────────────────────────────

function readActivity(ss) {
  var rows = ss.getSheetByName(SHEET_ACTIVITY).getDataRange().getValues();
  var log  = [];
  for (var i = 1; i < rows.length; i++) {
    log.push({
      action:    rows[i][0],
      time:      rows[i][1],            // legacy pre-formatted string (script TZ)
      createdAt: rows[i][2] || null,    // epoch ms; null for pre-migration rows
      actor:     rows[i][3] || null     // admin name; null for pre-migration rows
    });
  }
  return log;
}

// Append a row to the freeform activity log. `actor` defaults to 'system'
// when called from non-admin code paths (migrate, setupSpreadsheet) so the
// row is still attributable.
function logActivity(ss, action, actor) {
  var ts = Date.now();
  ss.getSheetByName(SHEET_ACTIVITY).appendRow([
    asText_(action), utcLabel_(ts), ts, asText_(actor || 'system')
  ]);
}

// All sheet "time" strings are written in UTC so anyone opening the Sheet
// directly sees a consistent, unambiguous timestamp regardless of their
// timezone. The UI converts to local via formatTime(createdAt) on the client.
function utcLabel_(ts) {
  return Utilities.formatDate(new Date(ts), 'UTC', 'MMM d, h:mm a') + ' UTC';
}

// Escape strings that start with a Sheets formula starter (=, +, -, @) so
// setValue/appendRow don't interpret them as formulas. Sheets strips the
// leading apostrophe when reading the cell, so roundtripping is clean.
// Other values pass through unchanged.
function asText_(v) {
  if (v == null) return v;
  var s = String(v);
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}

// ── STRUCTURED EVENT LOGS ──────────────────────────────────────
// These are append-only tables intended for dashboards/analytics.
// The freeform `activity` sheet stays for human-readable display.

function logStockEvent(ss, data, actor) {
  var sheet = ss.getSheetByName(SHEET_STOCK_EVENTS);
  if (!sheet) return;  // run setupSpreadsheet to create
  var ts = Date.now();
  sheet.appendRow([
    ts, utcLabel_(ts), data.size, data.delta, data.reason,
    data.before, data.after, asText_(data.note || ''), asText_(actor || 'admin'),
    data.farm || ''
  ]);
}

function logPriceEvent(ss, data, actor) {
  var sheet = ss.getSheetByName(SHEET_PRICE_EVENTS);
  if (!sheet) return;
  var ts = Date.now();
  sheet.appendRow([
    ts, utcLabel_(ts), data.size, data.oldPrice, data.newPrice, asText_(actor || 'admin')
  ]);
}

function readStockEvents(ss) {
  var sheet = ss.getSheetByName(SHEET_STOCK_EVENTS);
  if (!sheet) return [];
  var rows  = sheet.getDataRange().getValues();
  var out   = [];
  // Cap to the last EVENT_PAGE_SIZE rows to keep payload reasonable.
  var start = Math.max(1, rows.length - EVENT_PAGE_SIZE);
  for (var i = start; i < rows.length; i++) {
    out.push({
      createdAt: rows[i][0],
      time:      rows[i][1],
      size:      rows[i][2],
      delta:     Number(rows[i][3]) || 0,
      reason:    rows[i][4],
      before:    Number(rows[i][5]) || 0,
      after:     Number(rows[i][6]) || 0,
      note:      rows[i][7] || '',
      actor:     rows[i][8] || 'admin',
      farm:      rows[i][9] || null
    });
  }
  return out;
}

function readPriceEvents(ss) {
  var sheet = ss.getSheetByName(SHEET_PRICE_EVENTS);
  if (!sheet) return [];
  var rows  = sheet.getDataRange().getValues();
  var out   = [];
  var start = Math.max(1, rows.length - EVENT_PAGE_SIZE);
  for (var i = start; i < rows.length; i++) {
    out.push({
      createdAt: rows[i][0],
      time:      rows[i][1],
      size:      rows[i][2],
      oldPrice:  Number(rows[i][3]) || 0,
      newPrice:  Number(rows[i][4]) || 0,
      actor:     rows[i][5] || 'admin'
    });
  }
  return out;
}

// ── HELPERS ────────────────────────────────────────────────────

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sha256Hex(input) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

// Display label for a size key. Source of truth is the `sizes` sheet —
// custom sizes added via addSize() get the label the operator typed
// instead of the raw key. Falls back to the hardcoded SIZE_LABELS map
// (covers pre-migration sheets) and finally to the raw key.
function sizeLabel(size) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SIZES);
    if (sheet) {
      var rows = sheet.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        if (rows[i][0] === size && rows[i][1]) return String(rows[i][1]);
      }
    }
  } catch (e) { /* fall through to defaults */ }
  return SIZE_LABELS[size] || size;
}

// Formatted size mention for activity log messages.
// Returns: size "Extra Large"
// Quoted so operators can scan log lines and tell where the size name
// starts and ends — useful for sizes whose labels contain spaces.
function sizeMention_(size) {
  return 'size "' + sizeLabel(size) + '"';
}

function plural(n) {
  return Number(n) !== 1 ? 's' : '';
}

// ── ONE-TIME SETUP ─────────────────────────────────────────────
// Run this function manually once from the Apps Script editor
// before you deploy the web app.

function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Farms (id, name, active, sortOrder). Seeded with one default farm so a
  // fresh install has somewhere to hold stock and route orders.
  var farms = getOrCreate(ss, SHEET_FARMS);
  var defaultFarmId;
  if (farms.getLastRow() === 0) {
    farms.appendRow(['id', 'name', 'active', 'sortOrder']);
    defaultFarmId = Utilities.getUuid();
    farms.appendRow([defaultFarmId, asText_('Main Farm'), true, 1]);
    farms.getRange('A1:D1').setFontWeight('bold');
  } else {
    var frows = farms.getDataRange().getValues();
    defaultFarmId = frows.length > 1 ? String(frows[1][0]) : Utilities.getUuid();
  }

  // Stock [size, trays, farm]. Seed the default farm offering all sizes at 0.
  var stock = getOrCreate(ss, SHEET_STOCK);
  if (stock.getLastRow() === 0) {
    stock.appendRow(['size', 'trays', 'farm']);
    ['small','medium','large','xl','jumbo'].forEach(function (s) {
      stock.appendRow([s, 0, defaultFarmId]);
    });
    stock.getRange('A1:C1').setFontWeight('bold');
  }

  // Prices
  var prices = getOrCreate(ss, SHEET_PRICES);
  if (prices.getLastRow() === 0) {
    prices.appendRow(['size', 'perTray']);
    [['small',120],['medium',140],['large',160],['xl',175],['jumbo',180]].forEach(function (r) {
      prices.appendRow(r);
    });
    prices.getRange('A1:B1').setFontWeight('bold');
  }

  // Orders
  var orders = getOrCreate(ss, SHEET_ORDERS);
  if (orders.getLastRow() === 0) {
    orders.appendRow(['id','name','contact','address','size','trays','notes','status','time','createdAt','unitPrice','farm']);
    orders.getRange('A1:L1').setFontWeight('bold');
  }

  // Sizes (key → label + sort order). The canonical list of egg sizes.
  var sizes = getOrCreate(ss, SHEET_SIZES);
  if (sizes.getLastRow() === 0) {
    sizes.appendRow(['key','label','sortOrder']);
    [['small','Small',1],['medium','Medium',2],['large','Large',3],['xl','XL',4],['jumbo','Jumbo',5]]
      .forEach(function (r) { sizes.appendRow(r); });
    sizes.getRange('A1:C1').setFontWeight('bold');
  }

  // Admins (id, name, pinHash, createdAt, active). Seeded with a default
  // admin (PIN 1234) so a fresh install can still log in.
  var admins = getOrCreate(ss, SHEET_ADMINS);
  if (admins.getLastRow() === 0) {
    admins.appendRow(['id','name','pinHash','createdAt','active']);
    admins.appendRow([Utilities.getUuid(), asText_('Admin'), sha256Hex('1234'), Date.now(), true]);
    admins.getRange('A1:E1').setFontWeight('bold');
  }

  // Stock events (structured restock/sale log)
  var stockEv = getOrCreate(ss, SHEET_STOCK_EVENTS);
  if (stockEv.getLastRow() === 0) {
    stockEv.appendRow(['createdAt','time','size','delta','reason','before','after','note','actor','farm']);
    stockEv.getRange('A1:J1').setFontWeight('bold');
  }

  // Price events (structured price change log)
  var priceEv = getOrCreate(ss, SHEET_PRICE_EVENTS);
  if (priceEv.getLastRow() === 0) {
    priceEv.appendRow(['createdAt','time','size','oldPrice','newPrice','actor']);
    priceEv.getRange('A1:F1').setFontWeight('bold');
  }

  // Activity
  var activity = getOrCreate(ss, SHEET_ACTIVITY);
  if (activity.getLastRow() === 0) {
    activity.appendRow(['action','time','createdAt']);
    activity.getRange('A1:C1').setFontWeight('bold');
  }

  // Config (admin PIN hash + future key/value settings)
  var config = getOrCreate(ss, SHEET_CONFIG);
  if (config.getLastRow() === 0) {
    config.appendRow(['key', 'value']);
    config.getRange('A1:B1').setFontWeight('bold');
  }
  if (!readConfig(ss, PIN_KEY)) {
    // Migrate from legacy Script Properties if a PIN was stored there;
    // otherwise seed the default PIN 1234.
    var legacy = PropertiesService.getScriptProperties().getProperty(PIN_KEY);
    writeConfig(ss, PIN_KEY, legacy || sha256Hex('1234'));
  }

  applyTextFormats_(ss, []);  // freeform columns must not be parsed as formulas

  showResult_('✅ The Good Egg setup complete!\n\nDefault admin PIN is: 1234\nChange it in the app after first login.');
}

function getOrCreate(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// ── DASHBOARD ──────────────────────────────────────────────────
// Idempotent: run this whenever you want the dashboard rebuilt.
// Wipes and re-creates a `Dashboard` tab with KPIs and aggregation tables
// driven by formulas — so the tab stays live as new orders/events land.
// After the function finishes, add charts via Insert → Chart on each of
// the aggregation tables (table ranges are labelled).

var SHEET_DASHBOARD = 'Dashboard';

function buildDashboard() {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var sheet     = ss.getSheetByName(SHEET_DASHBOARD);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(SHEET_DASHBOARD, 0);  // place at the very left

  // Row pointers; keep mutable so blocks can grow without manual re-numbering.
  var row = 1;

  // ── Title row
  sheet.getRange(row, 1, 1, 8).merge()
    .setValue('🥚 The Good Egg — Dashboard')
    .setFontSize(20).setFontWeight('bold')
    .setBackground('#6B4226').setFontColor('#FFFCF5')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setRowHeight(row, 40);
  row += 1;

  sheet.getRange(row, 1, 1, 8).merge()
    .setFormula('="Updated " & TEXT(NOW(), "MMM d, yyyy HH:mm") & " UTC"')
    .setFontStyle('italic').setFontSize(10).setFontColor('#6B4F3F')
    .setHorizontalAlignment('center');
  row += 2;

  // ── Headline KPI cards (two rows of 4)
  // We pull today's UTC midnight as an epoch ms (Sheets serial date math).
  // const TODAY_MS = (INT(NOW()) - DATE(1970,1,1)) * 86400000
  // const MONTH_START_MS = (DATE(YEAR(NOW()), MONTH(NOW()), 1) - DATE(1970,1,1)) * 86400000
  var todayMs       = '((INT(NOW())-DATE(1970,1,1))*86400000)';
  var monthStartMs  = '((DATE(YEAR(NOW()),MONTH(NOW()),1)-DATE(1970,1,1))*86400000)';

  var kpis = [
    // [label, formula, suffix (optional)]
    ['Trays in stock',  '=SUMPRODUCT(stock!B2:B)',                                                                 ''],
    ['Eggs in stock',   '=SUMPRODUCT(stock!B2:B)*30',                                                              ''],
    ['Inventory value', '=SUMPRODUCT(IFERROR(VLOOKUP(stock!A2:A,prices!A:B,2,FALSE),0)*stock!B2:B)',               '₱'],
    ['Out of stock',    '=COUNTIF(stock!B2:B,0)',                                                                  ''],
    ['Orders today',    '=COUNTIFS(orders!J2:J,">=" & ' + todayMs + ')',                                            ''],
    ['Pending orders',  '=COUNTIF(orders!H2:H,"pending")',                                                          ''],
    ['Revenue today',   '=SUMPRODUCT((orders!H2:H="done")*(orders!J2:J>=' + todayMs + ')*orders!F2:F*IFERROR(orders!K2:K,0))', '₱'],
    ['Revenue MTD',     '=SUMPRODUCT((orders!H2:H="done")*(orders!J2:J>=' + monthStartMs + ')*orders!F2:F*IFERROR(orders!K2:K,0))', '₱']
  ];

  var kpiStart = row;
  for (var i = 0; i < kpis.length; i++) {
    var col = (i % 4) * 2 + 1;  // 2-wide cards
    var r   = row + Math.floor(i / 4) * 3;
    sheet.getRange(r, col, 1, 2).merge()
      .setValue(kpis[i][0])
      .setBackground('#F5E6D3').setFontWeight('bold').setFontSize(11)
      .setFontColor('#6B4F3F').setHorizontalAlignment('center');
    var valueCell = sheet.getRange(r + 1, col, 1, 2).merge();
    valueCell.setFormula(kpis[i][1])
      .setFontSize(18).setFontWeight('bold').setFontColor('#3D1F0E')
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    if (kpis[i][2] === '₱') valueCell.setNumberFormat('"₱"#,##0');
    else                    valueCell.setNumberFormat('#,##0');
    sheet.setRowHeight(r + 1, 38);
  }
  row = kpiStart + 6 + 1;  // 2 rows of cards × 3 lines each = 6, +1 spacer

  // ── Section: Stock by size (table + chart source)
  sectionHeader_(sheet, row, 'Current stock by size');
  row += 1;
  var stockHeaderRow = row;
  sheet.getRange(row, 1, 1, 5).setValues([['Size','Trays','Eggs','₱/tray','Value']])
    .setFontWeight('bold').setBackground('#F5E6D3').setFontColor('#6B4F3F');
  row += 1;
  // One row per size, driven by the sizes sheet (cols A=key, B=label) and
  // ordered as the sizes sheet is. Stock is now per-farm ([size,trays,farm]),
  // so a size can span several rows — SUMIF aggregates trays across all farms
  // for each size. Prices are global. Bounded to the 10 rows reserved below.
  sheet.getRange(row, 1).setFormula(
    '=IFERROR(ARRAY_CONSTRAIN(ARRAYFORMULA({' +
        'sizes!B2:B11,' +
        'SUMIF(stock!A:A,sizes!A2:A11,stock!B:B),' +
        'SUMIF(stock!A:A,sizes!A2:A11,stock!B:B)*30,' +
        'IFERROR(VLOOKUP(sizes!A2:A11,prices!A:B,2,FALSE),0),' +
        'SUMIF(stock!A:A,sizes!A2:A11,stock!B:B)*IFERROR(VLOOKUP(sizes!A2:A11,prices!A:B,2,FALSE),0)' +
      '}),10,5),"")'
  );
  // Reserve 10 rows for the table; format the value column as currency.
  sheet.getRange(row, 4, 10, 1).setNumberFormat('"₱"#,##0');
  sheet.getRange(row, 5, 10, 1).setNumberFormat('"₱"#,##0');
  var stockTableEnd = row + 9;
  row = stockTableEnd + 2;

  // ── Section: Daily net flow (last 30 days)
  sectionHeader_(sheet, row, 'Daily restocked vs sold (last 30 days)');
  row += 1;
  sheet.getRange(row, 1, 1, 4).setValues([['Date','Restocked (trays)','Sold (trays)','Net']])
    .setFontWeight('bold').setBackground('#F5E6D3').setFontColor('#6B4F3F');
  row += 1;
  var flowStart = row;
  // 30 rows, each row = today-i, summing stock_events deltas in that UTC day.
  for (var d = 0; d < 30; d++) {
    var dateCell = '(TODAY()-' + d + ')';
    var dayStart = '((' + dateCell + '-DATE(1970,1,1))*86400000)';
    var dayEnd   = '((' + dateCell + '+1-DATE(1970,1,1))*86400000)';
    sheet.getRange(flowStart + d, 1).setFormula('=' + dateCell).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(flowStart + d, 2).setFormula(
      '=SUMIFS(stock_events!D:D,stock_events!A:A,">=" & ' + dayStart + ',stock_events!A:A,"<" & ' + dayEnd + ',stock_events!E:E,"restock")'
    );
    sheet.getRange(flowStart + d, 3).setFormula(
      '=-SUMIFS(stock_events!D:D,stock_events!A:A,">=" & ' + dayStart + ',stock_events!A:A,"<" & ' + dayEnd + ',stock_events!E:E,"sold")'
    );
    sheet.getRange(flowStart + d, 4).setFormula(
      '=B' + (flowStart + d) + '-C' + (flowStart + d)
    );
  }
  row = flowStart + 30 + 1;

  // ── Section: Daily revenue (last 30 days)
  sectionHeader_(sheet, row, 'Daily revenue from completed orders (last 30 days)');
  row += 1;
  sheet.getRange(row, 1, 1, 3).setValues([['Date','Orders','Revenue']])
    .setFontWeight('bold').setBackground('#F5E6D3').setFontColor('#6B4F3F');
  row += 1;
  var revStart = row;
  for (var d2 = 0; d2 < 30; d2++) {
    var dateCell2 = '(TODAY()-' + d2 + ')';
    var dayStart2 = '((' + dateCell2 + '-DATE(1970,1,1))*86400000)';
    var dayEnd2   = '((' + dateCell2 + '+1-DATE(1970,1,1))*86400000)';
    sheet.getRange(revStart + d2, 1).setFormula('=' + dateCell2).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(revStart + d2, 2).setFormula(
      '=COUNTIFS(orders!H:H,"done",orders!J:J,">=" & ' + dayStart2 + ',orders!J:J,"<" & ' + dayEnd2 + ')'
    );
    sheet.getRange(revStart + d2, 3).setFormula(
      '=SUMPRODUCT((orders!H2:H="done")*(orders!J2:J>=' + dayStart2 + ')*(orders!J2:J<' + dayEnd2 + ')*orders!F2:F*IFERROR(orders!K2:K,0))'
    ).setNumberFormat('"₱"#,##0');
  }
  row = revStart + 30 + 1;

  // ── Section: Revenue per size (all-time, completed orders)
  sectionHeader_(sheet, row, 'Revenue per size (completed orders, all-time)');
  row += 1;
  sheet.getRange(row, 1, 1, 3).setValues([['Size','Trays sold','Revenue']])
    .setFontWeight('bold').setBackground('#F5E6D3').setFontColor('#6B4F3F');
  row += 1;
  // QUERY aggregates by size for status=done. Column A holds the raw size
  // key; admins can correlate with the "Current stock by size" section
  // above (which has the label). LIMIT 10 matches the reserved row count
  // so the QUERY can't overflow into the next section's header.
  sheet.getRange(row, 1).setFormula(
    "=IFERROR(QUERY(orders!E2:K,\"SELECT E, SUM(F), SUM(F*K) WHERE H = 'done' GROUP BY E ORDER BY SUM(F*K) DESC LIMIT 10 LABEL E '', SUM(F) '', SUM(F*K) ''\",0),\"\")"
  );
  sheet.getRange(row, 3, 10, 1).setNumberFormat('"₱"#,##0');
  var revBySizeEnd = row + 9;
  row = revBySizeEnd + 2;

  // ── Section: Top customers (completed orders, all-time)
  sectionHeader_(sheet, row, 'Top customers by revenue (completed orders, all-time)');
  row += 1;
  sheet.getRange(row, 1, 1, 4).setValues([['Name','Orders','Total trays','Total revenue']])
    .setFontWeight('bold').setBackground('#F5E6D3').setFontColor('#6B4F3F');
  row += 1;
  sheet.getRange(row, 1).setFormula(
    "=IFERROR(QUERY(orders!B2:K,\"SELECT B, COUNT(F), SUM(F), SUM(F*K) WHERE H = 'done' GROUP BY B ORDER BY SUM(F*K) DESC LIMIT 10 LABEL B '', COUNT(F) '', SUM(F) '', SUM(F*K) ''\",0),\"\")"
  );
  sheet.getRange(row, 4, 10, 1).setNumberFormat('"₱"#,##0');
  var topCustEnd = row + 9;
  row = topCustEnd + 2;

  // ── Section: Order pipeline status counts
  sectionHeader_(sheet, row, 'Order pipeline');
  row += 1;
  sheet.getRange(row, 1, 1, 3).setValues([['Status','Orders','Trays']])
    .setFontWeight('bold').setBackground('#F5E6D3').setFontColor('#6B4F3F');
  row += 1;
  ['pending','confirmed','done'].forEach(function (status, idx) {
    sheet.getRange(row + idx, 1).setValue(status);
    sheet.getRange(row + idx, 2).setFormula('=COUNTIF(orders!H:H,"' + status + '")');
    sheet.getRange(row + idx, 3).setFormula('=SUMIF(orders!H:H,"' + status + '",orders!F:F)');
  });
  row += 4;

  // ── Section: Price history (all events, newest first)
  sectionHeader_(sheet, row, 'Recent price changes');
  row += 1;
  sheet.getRange(row, 1, 1, 5).setValues([['When','Size','Old (₱)','New (₱)','Δ']])
    .setFontWeight('bold').setBackground('#F5E6D3').setFontColor('#6B4F3F');
  row += 1;
  sheet.getRange(row, 1).setFormula(
    "=IFERROR(QUERY(price_events!B2:E,\"SELECT B, C, D, E ORDER BY B DESC LIMIT 20 LABEL B '', C '', D '', E ''\",0),\"\")"
  );
  sheet.getRange(row, 5).setFormula('=ARRAYFORMULA(IF(LEN(D' + row + ':D),D' + row + ':D-C' + row + ':C,""))');
  sheet.getRange(row, 3, 20, 3).setNumberFormat('"₱"#,##0');
  row += 22;

  // ── Column widths
  for (var c = 1; c <= 8; c++) sheet.setColumnWidth(c, c === 1 ? 140 : 120);
  sheet.setFrozenRows(2);
  sheet.setHiddenGridlines(true);

  showResult_(
    'Dashboard built.\n\n' +
    'Open the "Dashboard" tab. To add charts, click anywhere inside a ' +
    'table and choose Insert → Chart. Suggested chart types per table:\n\n' +
    '• Stock by size → column chart\n' +
    '• Daily restocked vs sold → stacked column\n' +
    '• Daily revenue → line chart\n' +
    '• Revenue per size → pie chart\n' +
    '• Top customers → bar chart\n\n' +
    'Re-run buildDashboard() any time to refresh layout (data is live).'
  );
}

function sectionHeader_(sheet, row, label) {
  sheet.getRange(row, 1, 1, 8).merge()
    .setValue(label)
    .setFontWeight('bold').setFontSize(13).setFontColor('#FFFCF5')
    .setBackground('#8B5A3C')
    .setHorizontalAlignment('left').setVerticalAlignment('middle');
  sheet.setRowHeight(row, 28);
}

// ── MIGRATION ──────────────────────────────────────────────────
// Idempotent upgrade path for existing deployments. Safe to re-run.
// Creates any missing sheets, adds any missing columns, and backfills
// data where it's possible to reconstruct (orders.unitPrice from
// current prices, stock_events from the activity log).
//
// Run manually from the Apps Script editor whenever Code.gs is updated.

function migrate() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = [];

  ensureAllSheets_(ss, report);
  seedInitialFarm_(ss, report);
  upgradeActivitySchema_(ss, report);
  upgradeStockSchema_(ss, report);
  upgradeStockEventsSchema_(ss, report);
  upgradeOrdersSchema_(ss, report);
  seedSizesSheet_(ss, report);
  seedInitialAdmin_(ss, report);
  backfillUnitPrice_(ss, report);
  backfillStockEvents_(ss, report);
  migratePinToConfigSheet_(ss, report);
  applyTextFormats_(ss, report);
  recoverMangledCells_(ss, report);

  var body = report.length
    ? report.join('\n')
    : 'Already up to date — nothing to migrate.';
  var msg = 'The Good Egg migration complete.\n\n' + body +
            '\n\nThis function is idempotent — re-run it any time after a Code.gs update.';
  showResult_(msg);
}

// Show a result either as a UI alert (when the sheet is open in a tab and
// the script is running in that session) or as a Logger entry (when run
// headlessly, e.g. via clasp or a trigger). Avoids the
// "Cannot call SpreadsheetApp.getUi() from this context" error.
function showResult_(msg) {
  Logger.log(msg);
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    // No UI session; Logger output is the record. View → Executions.
  }
}

// ── ONBOARDING ─────────────────────────────────────────────────
// Run from the Apps Script editor (Run dropdown → addAdminInteractive)
// to add a new admin without touching the sheet directly. Prompts for
// a display name and a 4-digit PIN, hashes the PIN, and writes a row.
//
// REQUIRES a live Sheet UI session — the Google Sheet must be open in a
// browser tab on the SAME account. If you're hitting
// "Cannot call SpreadsheetApp.getUi() from this context",
// either (a) open the Sheet in a tab first then re-run, or
//        (b) use addAdminQuick() below (no UI required).
function addAdminInteractive() {
  var ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    // No UI session available — fall back to a Logger-only error so the
    // operator sees a useful message instead of just the stack trace.
    Logger.log(
      'addAdminInteractive needs the Sheet open in a browser tab. ' +
      'Either open the Sheet (Extensions → Apps Script → run again from there), ' +
      'or use addAdminQuick() — edit the NAME and PIN constants at the top of ' +
      'the function and click Run. No UI needed.'
    );
    throw new Error(
      'No UI session. Open the Sheet in a tab and re-run, or use addAdminQuick() instead.'
    );
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName(SHEET_ADMINS)) {
    ui.alert('admins sheet not found. Run migrate() first, then try again.');
    return;
  }

  var nameResp = ui.prompt(
    'Add an admin',
    'Username for the new admin (anything you want — pick something the team will recognize, e.g. "sara"):',
    ui.ButtonSet.OK_CANCEL
  );
  if (nameResp.getSelectedButton() !== ui.Button.OK) return;
  var name = nameResp.getResponseText().trim();
  if (!name) { ui.alert('Username is required.'); return; }

  var pinResp = ui.prompt(
    'Add an admin',
    'Choose a numeric password for ' + name + ' (4–8 digits):',
    ui.ButtonSet.OK_CANCEL
  );
  if (pinResp.getSelectedButton() !== ui.Button.OK) return;
  var pin = pinResp.getResponseText().trim();
  if (!/^\d{4,8}$/.test(pin)) {
    ui.alert('Password must be 4–8 digits, numeric only (0–9).');
    return;
  }

  var result = createAdmin_(ss, name, sha256Hex(pin));
  if (result.error) {
    ui.alert('Could not add admin: ' + result.error);
    return;
  }
  logActivity(ss, 'Added admin: ' + name + ' (via Apps Script editor)', 'system');
  ui.alert(
    '✅ Added "' + name + '" with password ' + pin + '.\n\n' +
    'They sign in by picking "' + name + '" on the sign-in screen and entering that password. ' +
    'They can change their own password once signed in.'
  );
}

// ── NO-UI ONBOARDING ──────────────────────────────────────────
// Same intent as addAdminInteractive(), but doesn't need a Sheet UI
// session. Edit NAME and PIN to your values, then click ▶ Run.
// Output goes to View → Executions → Logs.
//
// Useful when the editor is open as its own tab (script.google.com)
// without the Sheet open in another tab — addAdminInteractive() can't
// attach prompts in that context.
function addAdminQuick() {
  // ╔══════════════════════════════════════════════════════════════╗
  // ║ Edit these two values before running:                        ║
  var NAME = 'Sara';     // username (anything you want — pick something the team recognises)
  var PIN  = '4729';     // 4–8 digit numeric password
  // ╚══════════════════════════════════════════════════════════════╝

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEET_ADMINS)) {
    Logger.log('❌ admins sheet not found. Run migrate() first, then try again.');
    return;
  }
  if (!NAME || !NAME.trim()) {
    Logger.log('❌ NAME is empty. Edit the function body and set NAME to the new admin\'s username.');
    return;
  }
  if (!/^\d{4,8}$/.test(PIN)) {
    Logger.log('❌ PIN "' + PIN + '" is invalid — must be 4–8 digits, numeric only (0–9).');
    return;
  }

  var result = createAdmin_(ss, NAME.trim(), sha256Hex(PIN));
  if (result.error) {
    Logger.log('❌ Could not add admin: ' + result.error);
    return;
  }
  logActivity(ss, 'Added admin: ' + NAME + ' (via Apps Script editor)', 'system');
  Logger.log('✅ Added admin "' + NAME + '" with password ' + PIN);
  Logger.log('They sign in by picking "' + NAME + '" on the sign-in screen and entering ' + PIN + '.');
  Logger.log('They can change their own password once signed in.');
}

// Quick utility to list current admins from the editor — handy for
// "who has access?" audits without opening the sheet tab.
function listAdmins() {
  var admins = readAdmins(SpreadsheetApp.getActiveSpreadsheet());
  if (!admins.length) {
    showResult_('No admins configured. Run migrate() or addAdminInteractive().');
    return;
  }
  var lines = admins.map(function (a) {
    return (a.active ? '✅' : '⊝') + ' ' + a.name +
           '  (id: ' + a.id.slice(0, 8) + '…, created ' +
           Utilities.formatDate(new Date(a.createdAt || 0), 'UTC', 'yyyy-MM-dd') + ')';
  });
  showResult_('Current admins:\n\n' + lines.join('\n'));
}

// Ensure the farms sheet exists with at least one farm; return the id of
// the first (default) farm. Idempotent — used by setup/migrate to anchor
// stock rows and order routing to a real farm.
function ensureDefaultFarm_(ss) {
  var sheet = ss.getSheetByName(SHEET_FARMS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_FARMS);
    sheet.appendRow(['id','name','active','sortOrder']);
    sheet.getRange('A1:D1').setFontWeight('bold');
  }
  if (sheet.getLastRow() < 2) {
    var id = Utilities.getUuid();
    sheet.appendRow([id, asText_('Main Farm'), true, 1]);
    return id;
  }
  return String(sheet.getRange(2, 1).getValue());
}

// 1. Make sure every sheet exists with its current header.
function ensureAllSheets_(ss, report) {
  if (!ss.getSheetByName(SHEET_STOCK)) {
    var farmId = ensureDefaultFarm_(ss);
    var s = ss.insertSheet(SHEET_STOCK);
    s.appendRow(['size','trays','farm']);
    ['small','medium','large','xl','jumbo'].forEach(function (k) { s.appendRow([k, 0, farmId]); });
    s.getRange('A1:C1').setFontWeight('bold');
    report.push('• Created `stock` sheet');
  }
  if (!ss.getSheetByName(SHEET_PRICES)) {
    var p = ss.insertSheet(SHEET_PRICES);
    p.appendRow(['size','perTray']);
    [['small',120],['medium',140],['large',160],['xl',175],['jumbo',180]]
      .forEach(function (r) { p.appendRow(r); });
    p.getRange('A1:B1').setFontWeight('bold');
    report.push('• Created `prices` sheet');
  }
  if (!ss.getSheetByName(SHEET_ORDERS)) {
    var o = ss.insertSheet(SHEET_ORDERS);
    o.appendRow(['id','name','contact','address','size','trays','notes','status','time','createdAt','unitPrice','farm']);
    o.getRange('A1:L1').setFontWeight('bold');
    report.push('• Created `orders` sheet');
  }
  if (!ss.getSheetByName(SHEET_ACTIVITY)) {
    var a = ss.insertSheet(SHEET_ACTIVITY);
    a.appendRow(['action','time','createdAt']);
    a.getRange('A1:C1').setFontWeight('bold');
    report.push('• Created `activity` sheet');
  }
  if (!ss.getSheetByName(SHEET_CONFIG)) {
    var c = ss.insertSheet(SHEET_CONFIG);
    c.appendRow(['key','value']);
    c.getRange('A1:B1').setFontWeight('bold');
    report.push('• Created `config` sheet');
  }
  if (!ss.getSheetByName(SHEET_SIZES)) {
    var sz = ss.insertSheet(SHEET_SIZES);
    sz.appendRow(['key','label','sortOrder']);
    sz.getRange('A1:C1').setFontWeight('bold');
    report.push('• Created `sizes` sheet');
  }
  if (!ss.getSheetByName(SHEET_ADMINS)) {
    var ad = ss.insertSheet(SHEET_ADMINS);
    ad.appendRow(['id','name','pinHash','createdAt','active']);
    ad.getRange('A1:E1').setFontWeight('bold');
    report.push('• Created `admins` sheet');
  }
  if (!ss.getSheetByName(SHEET_FARMS)) {
    ensureDefaultFarm_(ss);  // creates the sheet + a default "Main Farm"
    report.push('• Created `farms` sheet with a default farm "Main Farm"');
  }
  if (!ss.getSheetByName(SHEET_STOCK_EVENTS)) {
    var se = ss.insertSheet(SHEET_STOCK_EVENTS);
    se.appendRow(['createdAt','time','size','delta','reason','before','after','note','actor','farm']);
    se.getRange('A1:J1').setFontWeight('bold');
    report.push('• Created `stock_events` sheet');
  }
  if (!ss.getSheetByName(SHEET_PRICE_EVENTS)) {
    var pe = ss.insertSheet(SHEET_PRICE_EVENTS);
    pe.appendRow(['createdAt','time','size','oldPrice','newPrice','actor']);
    pe.getRange('A1:F1').setFontWeight('bold');
    report.push('• Created `price_events` sheet');
  }
}

// 2a. Add createdAt + actor to an older activity sheet.
function upgradeActivitySchema_(ss, report) {
  var act = ss.getSheetByName(SHEET_ACTIVITY);
  if (!act) return;
  var width   = Math.max(act.getLastColumn(), 4);
  var headers = act.getRange(1, 1, 1, width).getValues()[0];
  if (headers[2] !== 'createdAt') {
    act.getRange(1, 3).setValue('createdAt').setFontWeight('bold');
    report.push('• Added `activity.createdAt` column (old rows stay client-formatted from their `time` string until new entries land)');
  }
  if (headers[3] !== 'actor') {
    act.getRange(1, 4).setValue('actor').setFontWeight('bold');
    report.push('• Added `activity.actor` column (old rows show no attribution; new rows record which admin or "customer")');
  }
}

// 2c. Promote the legacy single PIN (config.adminPinHash or a fresh
// default) into the admins sheet as a row named "Admin". Idempotent —
// only runs if the admins sheet has no data rows yet.
function seedInitialAdmin_(ss, report) {
  var sheet = ss.getSheetByName(SHEET_ADMINS);
  if (!sheet) return;
  if (sheet.getLastRow() > 1) return;  // already has admins

  var legacyHash = readConfig(ss, PIN_KEY);
  var hash       = legacyHash || sha256Hex('1234');
  sheet.appendRow([Utilities.getUuid(), asText_('Admin'), hash, Date.now(), true]);
  report.push(legacyHash
    ? '• Promoted existing PIN to admins sheet as "Admin" — same PIN, you can now rename them and add more admins'
    : '• Seeded default admin "Admin" with PIN 1234 — change it after first login');
}

// 2. Add missing columns to an older `orders` sheet (createdAt, unitPrice, farm).
function upgradeOrdersSchema_(ss, report) {
  var orders = ss.getSheetByName(SHEET_ORDERS);
  if (!orders) return;
  // Read enough columns to inspect headers J, K and L.
  var width   = Math.max(orders.getLastColumn(), 12);
  var headers = orders.getRange(1, 1, 1, width).getValues()[0];
  if (headers[9] !== 'createdAt') {
    orders.getRange(1, 10).setValue('createdAt').setFontWeight('bold');
    report.push('• Added `orders.createdAt` column');
  }
  if (headers[10] !== 'unitPrice') {
    orders.getRange(1, 11).setValue('unitPrice').setFontWeight('bold');
    report.push('• Added `orders.unitPrice` column');
  }
  if (headers[11] !== 'farm') {
    orders.getRange(1, 12).setValue('farm').setFontWeight('bold');
    // Backfill existing orders to the default farm so history is coherent.
    var last = orders.getLastRow();
    if (last >= 2) {
      var farmId = ensureDefaultFarm_(ss);
      var col = orders.getRange(2, 12, last - 1, 1).getValues();
      var n = 0;
      for (var i = 0; i < col.length; i++) {
        if (!col[i][0]) { col[i][0] = farmId; n++; }
      }
      orders.getRange(2, 12, last - 1, 1).setValues(col);
      report.push('• Added `orders.farm` column and assigned ' + n + ' existing order' + (n === 1 ? '' : 's') + ' to "Main Farm"');
    } else {
      report.push('• Added `orders.farm` column');
    }
  }
}

// 2d. Add the `farm` column to an older 2-column stock sheet and assign every
// existing (size) row to the default farm. Converts [size,trays] → [size,trays,farm].
function upgradeStockSchema_(ss, report) {
  var stock = ss.getSheetByName(SHEET_STOCK);
  if (!stock) return;
  var width   = Math.max(stock.getLastColumn(), 3);
  var headers = stock.getRange(1, 1, 1, width).getValues()[0];
  if (headers[2] === 'farm') return;  // already migrated
  var farmId = ensureDefaultFarm_(ss);
  stock.getRange(1, 3).setValue('farm').setFontWeight('bold');
  var last = stock.getLastRow();
  if (last >= 2) {
    var col = stock.getRange(2, 3, last - 1, 1).getValues();
    var n = 0;
    for (var i = 0; i < col.length; i++) {
      if (!col[i][0]) { col[i][0] = farmId; n++; }
    }
    stock.getRange(2, 3, last - 1, 1).setValues(col);
    report.push('• Added `stock.farm` column and assigned ' + n + ' existing row' + (n === 1 ? '' : 's') + ' to "Main Farm"');
  } else {
    report.push('• Added `stock.farm` column');
  }
}

// 2e. Add the `farm` column to an older stock_events sheet. Old events keep a
// blank farm (we can't reconstruct which farm a historical sale came from).
function upgradeStockEventsSchema_(ss, report) {
  var se = ss.getSheetByName(SHEET_STOCK_EVENTS);
  if (!se) return;
  var width   = Math.max(se.getLastColumn(), 10);
  var headers = se.getRange(1, 1, 1, width).getValues()[0];
  if (headers[9] !== 'farm') {
    se.getRange(1, 10).setValue('farm').setFontWeight('bold');
    report.push('• Added `stock_events.farm` column (historical events show no farm)');
  }
}

// 2f. Ensure the farms sheet has a default farm. Reports only on first creation.
function seedInitialFarm_(ss, report) {
  var sheet  = ss.getSheetByName(SHEET_FARMS);
  var existed = sheet && sheet.getLastRow() > 1;
  ensureDefaultFarm_(ss);
  if (!existed) {
    report.push('• Seeded default farm "Main Farm" — rename it and add more in the admin Farms panel');
  }
}

// 2b. Populate the sizes sheet from whichever keys exist in stock/prices.
// Idempotent: skipped if the sizes sheet already has rows. Default labels
// are used for the original 5 keys; anything else gets a capitalized fallback.
function seedSizesSheet_(ss, report) {
  var sheet = ss.getSheetByName(SHEET_SIZES);
  if (!sheet || sheet.getLastRow() > 1) return;

  var keys = {};
  [SHEET_STOCK, SHEET_PRICES].forEach(function (name) {
    var s = ss.getSheetByName(name);
    if (!s) return;
    var rows = s.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0]) keys[rows[i][0]] = true;
    }
  });

  var DEFAULT_LABELS = { small:'Small', medium:'Medium', large:'Large', xl:'XL', jumbo:'Jumbo' };
  var DEFAULT_ORDER  = ['small','medium','large','xl','jumbo'];

  var order = 1;
  var added = 0;
  DEFAULT_ORDER.forEach(function (k) {
    if (keys[k]) {
      sheet.appendRow([k, asText_(DEFAULT_LABELS[k]), order++]);
      delete keys[k];
      added++;
    }
  });
  // Any custom sizes that aren't in the default list keep their order
  Object.keys(keys).forEach(function (k) {
    var label = DEFAULT_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1));
    sheet.appendRow([k, asText_(label), order++]);
    added++;
  });
  if (added) report.push('• Seeded `sizes` sheet with ' + added + ' size' + (added === 1 ? '' : 's') + ' from existing stock/prices');
}

// 3. For any order without a unitPrice, fill it in from current prices.
// Better than null for revenue math, even if an old price would be more
// accurate (we can't recover that).
function backfillUnitPrice_(ss, report) {
  var orders = ss.getSheetByName(SHEET_ORDERS);
  if (!orders || orders.getLastRow() < 2) return;
  var prices = readPrices(ss);
  var rows   = orders.getRange(2, 1, orders.getLastRow() - 1, 11).getValues();
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][10]) {  // unitPrice empty
      var p = Number(prices[rows[i][4]]) || 0;
      if (p > 0) {
        orders.getRange(i + 2, 11).setValue(p);
        n++;
      }
    }
  }
  if (n) report.push('• Backfilled `unitPrice` on ' + n + ' existing order' + (n === 1 ? '' : 's') + ' (using current prices)');
}

// 4. Reconstruct stock_events from the freeform activity log. Only runs
// once — if stock_events already has data, we assume it's authoritative.
// before/after are computed by walking backward from current stock; if
// the activity log is incomplete those numbers will be off by a constant,
// but the deltas are always correct.
function backfillStockEvents_(ss, report) {
  var stockEv = ss.getSheetByName(SHEET_STOCK_EVENTS);
  if (!stockEv || stockEv.getLastRow() > 1) return;
  var act = ss.getSheetByName(SHEET_ACTIVITY);
  if (!act || act.getLastRow() < 2) return;

  var arows = act.getDataRange().getValues();
  // Matches "+10 trays Large — note" or "-3 trays Medium (sold)"
  var re = /^([+-])(\d+)\s+trays?\s+(Small|Medium|Large|XL|Jumbo)(?:\s+\(sold\))?(?:\s+—\s+(.*))?\s*$/;
  var parsed = [];
  for (var i = 1; i < arows.length; i++) {
    var text = String(arows[i][0]);
    var m = text.match(re);
    if (!m) continue;
    parsed.push({
      time:  arows[i][1],
      size:  m[3].toLowerCase(),
      delta: (m[1] === '+' ? 1 : -1) * Number(m[2]),
      reason:(m[1] === '+') ? 'restock' : 'sold',
      note:  m[4] || ''
    });
  }
  if (!parsed.length) return;

  // Walk backward to assign before/after using current stock as the anchor.
  // Stock is per-farm now ({farm:{size:trays}}); this backfill reconstructs
  // pre-multi-farm history (one farm), so anchor to the per-size total across
  // all farms. Reconstructed events carry no farm (it can't be recovered).
  var running = {};
  var stock   = readStock(ss);
  Object.keys(stock).forEach(function (farm) {
    Object.keys(stock[farm]).forEach(function (size) {
      running[size] = (running[size] || 0) + (Number(stock[farm][size]) || 0);
    });
  });
  for (var j = parsed.length - 1; j >= 0; j--) {
    var ev = parsed[j];
    if (running[ev.size] === undefined) running[ev.size] = 0;
    ev.after  = running[ev.size];
    ev.before = ev.after - ev.delta;
    running[ev.size] = ev.before;
  }

  // Append. createdAt = 0 marks the event as backfilled (no precise
  // timestamp; sheet row order preserves chronology).
  parsed.forEach(function (e) {
    stockEv.appendRow([0, e.time, e.size, e.delta, e.reason, e.before, e.after, e.note, 'admin']);
  });
  report.push(
    '• Backfilled ' + parsed.length + ' `stock_events` from activity log ' +
    '(createdAt = 0 marks them as historical — they appear under "All time" but not in N-day filters)'
  );
}

// 7. Walk the freeform string columns and find any cell that's stored as
// a formula (= it was a string like "+7 trays Medium" that Sheets
// silently turned into "=+7 trays Medium"). Rewrite each as plain text
// using the leading-apostrophe escape, which Sheets strips on read.
// Idempotent: a cell with no formula is skipped.
function recoverMangledCells_(ss, report) {
  // sheet name → 1-indexed columns that hold freeform user/system text
  var targets = [
    { name: SHEET_ACTIVITY,     cols: [1] },              // action
    { name: SHEET_ORDERS,       cols: [2, 3, 4, 7] },     // name, contact, address, notes
    { name: SHEET_STOCK_EVENTS, cols: [8] }               // note
  ];
  var fixed = 0;
  targets.forEach(function (t) {
    var sheet = ss.getSheetByName(t.name);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    t.cols.forEach(function (col) {
      var range    = sheet.getRange(2, col, lastRow - 1, 1);
      var formulas = range.getFormulas();
      for (var i = 0; i < formulas.length; i++) {
        var f = formulas[i][0];
        if (!f) continue;                       // empty / plain text → leave alone
        var original = f.replace(/^=/, '');      // strip the implicit "="
        sheet.getRange(i + 2, col).setValue("'" + original);
        fixed++;
      }
    });
  });
  if (fixed) report.push('• Recovered ' + fixed + ' broken cell' + (fixed === 1 ? '' : 's') + ' that were stored as formulas');
}

// 6. Force freeform text columns to "Plain text" number format. Without
// this, values that start with =, +, -, or @ get evaluated as formulas
// when written to the sheet — e.g. "+7 trays Medium" shows as #ERROR!.
// Idempotent and cheap: setting the format on a whole column is one op.
function applyTextFormats_(ss, report) {
  var textCols = [
    { sheet: SHEET_ACTIVITY,      ranges: ['A:A'] },                            // action
    { sheet: SHEET_ORDERS,        ranges: ['B:D', 'G:G', 'I:I', 'L:L'] },       // name, contact, address; notes; time; farm id
    { sheet: SHEET_STOCK,         ranges: ['C:C'] },                            // farm id
    { sheet: SHEET_STOCK_EVENTS,  ranges: ['B:B', 'E:E', 'H:H', 'I:I', 'J:J'] },// time, reason, note, actor, farm id
    { sheet: SHEET_PRICE_EVENTS,  ranges: ['B:B', 'F:F'] },                     // time, actor
    { sheet: SHEET_CONFIG,        ranges: ['B:B'] },                            // value (PIN hash etc. — pure strings)
    { sheet: SHEET_SIZES,         ranges: ['B:B'] },                            // label (freeform)
    { sheet: SHEET_ADMINS,        ranges: ['B:B'] },                            // name (freeform)
    { sheet: SHEET_FARMS,         ranges: ['B:B'] }                             // name (freeform)
  ];
  var touched = 0;
  textCols.forEach(function (entry) {
    var sheet = ss.getSheetByName(entry.sheet);
    if (!sheet) return;
    entry.ranges.forEach(function (a1) {
      sheet.getRange(a1).setNumberFormat('@');
    });
    touched++;
  });
  if (touched) report.push('• Set plain-text format on freeform columns in ' + touched + ' sheet' + (touched === 1 ? '' : 's'));
}

// 5. Move admin PIN out of Script Properties into the config sheet.
// Historically the legacy single-PIN flow read from config.adminPinHash.
// Multi-admin auth no longer reads it, but we preserve the row for one
// more migrate cycle so seedInitialAdmin_ can promote it to the admins
// sheet on first multi-admin migration.
function migratePinToConfigSheet_(ss, report) {
  if (readConfig(ss, PIN_KEY)) return;  // already there
  var legacy = PropertiesService.getScriptProperties().getProperty(PIN_KEY);
  writeConfig(ss, PIN_KEY, legacy || sha256Hex('1234'));
  report.push(
    '• Wrote `adminPinHash` to config sheet (' +
    (legacy ? 'migrated from Script Properties' : 'seeded with default PIN 1234') + ')'
  );
}
