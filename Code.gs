// ══════════════════════════════════════════════════════════════
// EggTrack — Google Apps Script Backend
// Paste this entire file into your Google Apps Script editor.
// Run setupSpreadsheet() once before deploying.
// Deploy as: Execute as Me | Access: Anyone (anonymous)
// ══════════════════════════════════════════════════════════════

var SHEET_STOCK    = 'stock';
var SHEET_PRICES   = 'prices';
var SHEET_ORDERS   = 'orders';
var SHEET_ACTIVITY = 'activity';
var SHEET_CONFIG   = 'config';
var PIN_KEY        = 'adminPinHash';

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

    // Admin actions require valid PIN hash
    var adminActions = ['addStock', 'deductStock', 'savePrices',
                        'updateOrderStatus', 'deleteOrder', 'changePIN'];
    if (adminActions.indexOf(action) !== -1) {
      if (!verifyPIN(data.pinHash)) {
        return jsonResponse({ error: 'Invalid PIN', code: 'UNAUTHORIZED' });
      }
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
    stock:    readStock(ss),
    prices:   readPrices(ss),
    orders:   readOrders(ss),
    activity: readActivity(ss),
    ts:       Date.now()
  };
}

// ── PIN ────────────────────────────────────────────────────────

function verifyPIN(submittedHash) {
  if (!submittedHash) return false;
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var stored = readConfig(ss, PIN_KEY);
  if (!stored) {
    // First run / migration: pull from legacy Script Properties if present,
    // otherwise default to PIN 1234. Persist the result to the config sheet.
    var legacy = PropertiesService.getScriptProperties().getProperty(PIN_KEY);
    stored = legacy || sha256Hex('1234');
    writeConfig(ss, PIN_KEY, stored);
  }
  return submittedHash === stored;
}

function doVerifyPIN(data) {
  return { success: verifyPIN(data.pinHash) };
}

function changePIN(data) {
  if (!data.newPinHash) return { error: 'No new PIN hash provided' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  writeConfig(ss, PIN_KEY, data.newPinHash);
  logActivity(ss, 'Admin PIN changed');
  return { success: true };
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

function readStock(ss) {
  var rows  = ss.getSheetByName(SHEET_STOCK).getDataRange().getValues();
  var stock = {};
  for (var i = 1; i < rows.length; i++) stock[rows[i][0]] = rows[i][1];
  return stock;
}

function addStock(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_STOCK);
    var rows  = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === data.size) {
        sheet.getRange(i + 1, 2).setValue(rows[i][1] + Number(data.trays));
        break;
      }
    }
    var label = sizeLabel(data.size);
    var note  = data.note ? ' — ' + data.note : '';
    logActivity(ss, '+' + data.trays + ' tray' + plural(data.trays) + ' ' + label + note);
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
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === data.size) {
        var current = rows[i][1];
        if (Number(data.trays) > current) {
          return { error: 'Not enough stock', code: 'INSUFFICIENT_STOCK' };
        }
        sheet.getRange(i + 1, 2).setValue(current - Number(data.trays));
        break;
      }
    }
    logActivity(ss, '-' + data.trays + ' tray' + plural(data.trays) + ' ' + sizeLabel(data.size) + ' (sold)');
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
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PRICES);
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var size = rows[i][0];
    if (data.prices[size] !== undefined) {
      sheet.getRange(i + 1, 2).setValue(Number(data.prices[size]));
    }
  }
  logActivity(ss, 'Prices updated');
  return { success: true, state: getState() };
}

// ── ORDERS ─────────────────────────────────────────────────────

function readOrders(ss) {
  var rows   = ss.getSheetByName(SHEET_ORDERS).getDataRange().getValues();
  var orders = [];
  for (var i = 1; i < rows.length; i++) {
    orders.push({
      id:      rows[i][0],
      name:    rows[i][1],
      contact: rows[i][2],
      address: rows[i][3],
      size:    rows[i][4],
      trays:   rows[i][5],
      notes:   rows[i][6],
      status:  rows[i][7],
      time:    rows[i][8]
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
    sheet.appendRow([
      o.id, o.name, o.contact, o.address,
      o.size, o.trays, o.notes || '', 'pending', o.time
    ]);
    logActivity(ss, 'Order: ' + o.name + ' — ' + o.trays + ' tray' + plural(o.trays) + ' ' + sizeLabel(o.size));
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
        logActivity(ss, 'Order ' + data.status + ': ' + rows[i][1]);
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
        sheet.deleteRow(i + 1);
        return { success: true, state: getState() };
      }
    }
    return { error: 'Order not found' };
  } finally {
    lock.releaseLock();
  }
}

// ── ACTIVITY ───────────────────────────────────────────────────

function readActivity(ss) {
  var rows = ss.getSheetByName(SHEET_ACTIVITY).getDataRange().getValues();
  var log  = [];
  for (var i = 1; i < rows.length; i++) {
    log.push({ action: rows[i][0], time: rows[i][1] });
  }
  return log;
}

function logActivity(ss, action) {
  var time  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, h:mm a');
  ss.getSheetByName(SHEET_ACTIVITY).appendRow([action, time]);
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

function sizeLabel(size) {
  return SIZE_LABELS[size] || size;
}

function plural(n) {
  return Number(n) !== 1 ? 's' : '';
}

// ── ONE-TIME SETUP ─────────────────────────────────────────────
// Run this function manually once from the Apps Script editor
// before you deploy the web app.

function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Stock
  var stock = getOrCreate(ss, SHEET_STOCK);
  if (stock.getLastRow() === 0) {
    stock.appendRow(['size', 'trays']);
    ['small','medium','large','xl','jumbo'].forEach(function (s) {
      stock.appendRow([s, 0]);
    });
    stock.getRange('A1:B1').setFontWeight('bold');
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
    orders.appendRow(['id','name','contact','address','size','trays','notes','status','time']);
    orders.getRange('A1:I1').setFontWeight('bold');
  }

  // Activity
  var activity = getOrCreate(ss, SHEET_ACTIVITY);
  if (activity.getLastRow() === 0) {
    activity.appendRow(['action','time']);
    activity.getRange('A1:B1').setFontWeight('bold');
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

  SpreadsheetApp.getUi().alert('✅ EggTrack setup complete!\n\nDefault admin PIN is: 1234\nChange it in the app after first login.');
}

function getOrCreate(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
