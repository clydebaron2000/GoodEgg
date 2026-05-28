// ══════════════════════════════════════════════════════════════
// EggTrack — Google Apps Script Backend
// Paste this entire file into your Google Apps Script editor.
// Run setupSpreadsheet() once before deploying.
// Deploy as: Execute as Me | Access: Anyone (anonymous)
// ══════════════════════════════════════════════════════════════

var SHEET_STOCK        = 'stock';
var SHEET_PRICES       = 'prices';
var SHEET_ORDERS       = 'orders';
var SHEET_ACTIVITY     = 'activity';
var SHEET_CONFIG       = 'config';
var SHEET_STOCK_EVENTS = 'stock_events';
var SHEET_PRICE_EVENTS = 'price_events';
var PIN_KEY            = 'adminPinHash';
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
    stock:        readStock(ss),
    prices:       readPrices(ss),
    orders:       readOrders(ss),
    activity:     readActivity(ss),
    stockEvents:  readStockEvents(ss),
    priceEvents:  readPriceEvents(ss),
    ts:           Date.now()
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
    var trays = Number(data.trays);
    var before = 0, after = 0;
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === data.size) {
        before = Number(rows[i][1]) || 0;
        after  = before + trays;
        sheet.getRange(i + 1, 2).setValue(after);
        break;
      }
    }
    var label = sizeLabel(data.size);
    var note  = data.note ? ' — ' + data.note : '';
    logActivity(ss, '+' + trays + ' tray' + plural(trays) + ' ' + label + note);
    logStockEvent(ss, { size: data.size, delta: trays, reason: 'restock', before: before, after: after, note: data.note || '' });
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
    var before = 0, after = 0;
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === data.size) {
        before = Number(rows[i][1]) || 0;
        if (trays > before) {
          return { error: 'Not enough stock', code: 'INSUFFICIENT_STOCK' };
        }
        after = before - trays;
        sheet.getRange(i + 1, 2).setValue(after);
        break;
      }
    }
    logActivity(ss, '-' + trays + ' tray' + plural(trays) + ' ' + sizeLabel(data.size) + ' (sold)');
    logStockEvent(ss, { size: data.size, delta: -trays, reason: 'sold', before: before, after: after, note: data.note || '' });
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
        logPriceEvent(ss, { size: size, oldPrice: oldPrice, newPrice: newPrice });
        changes.push(sizeLabel(size) + ' ₱' + oldPrice + ' → ₱' + newPrice);
      }
    }
  }
  if (changes.length > 0) {
    var prefix = changes.length === 1 ? 'Price updated: ' : 'Prices updated: ';
    logActivity(ss, prefix + changes.join(', '));
  }
  return { success: true, state: getState() };
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
      unitPrice: rows[i][10] || null   // PHP/tray snapshotted at submit time
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
    // Lock in the current price as the order's unit price. Server-side so
    // a tampered client can't underreport revenue, and so later price
    // changes don't rewrite history.
    var currentPrices = readPrices(ss);
    var unitPrice     = Number(currentPrices[o.size]) || 0;
    sheet.appendRow([
      o.id, o.name, o.contact, o.address,
      o.size, o.trays, o.notes || '', 'pending', o.time,
      o.createdAt || Date.now(),
      unitPrice
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

// ── STRUCTURED EVENT LOGS ──────────────────────────────────────
// These are append-only tables intended for dashboards/analytics.
// The freeform `activity` sheet stays for human-readable display.

function logStockEvent(ss, data) {
  var sheet = ss.getSheetByName(SHEET_STOCK_EVENTS);
  if (!sheet) return;  // run setupSpreadsheet to create
  var ts    = Date.now();
  var label = Utilities.formatDate(new Date(ts), Session.getScriptTimeZone(), 'MMM d, h:mm a');
  sheet.appendRow([
    ts, label, data.size, data.delta, data.reason,
    data.before, data.after, data.note || '', 'admin'
  ]);
}

function logPriceEvent(ss, data) {
  var sheet = ss.getSheetByName(SHEET_PRICE_EVENTS);
  if (!sheet) return;
  var ts    = Date.now();
  var label = Utilities.formatDate(new Date(ts), Session.getScriptTimeZone(), 'MMM d, h:mm a');
  sheet.appendRow([
    ts, label, data.size, data.oldPrice, data.newPrice, 'admin'
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
      actor:     rows[i][8] || 'admin'
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
    orders.appendRow(['id','name','contact','address','size','trays','notes','status','time','createdAt','unitPrice']);
    orders.getRange('A1:K1').setFontWeight('bold');
  }

  // Stock events (structured restock/sale log)
  var stockEv = getOrCreate(ss, SHEET_STOCK_EVENTS);
  if (stockEv.getLastRow() === 0) {
    stockEv.appendRow(['createdAt','time','size','delta','reason','before','after','note','actor']);
    stockEv.getRange('A1:I1').setFontWeight('bold');
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

  applyTextFormats_(ss, []);  // freeform columns must not be parsed as formulas

  showResult_('✅ EggTrack setup complete!\n\nDefault admin PIN is: 1234\nChange it in the app after first login.');
}

function getOrCreate(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
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
  upgradeOrdersSchema_(ss, report);
  backfillUnitPrice_(ss, report);
  backfillStockEvents_(ss, report);
  migratePinToConfigSheet_(ss, report);
  applyTextFormats_(ss, report);

  var body = report.length
    ? report.join('\n')
    : 'Already up to date — nothing to migrate.';
  var msg = 'EggTrack migration complete.\n\n' + body +
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

// 1. Make sure every sheet exists with its current header.
function ensureAllSheets_(ss, report) {
  if (!ss.getSheetByName(SHEET_STOCK)) {
    var s = ss.insertSheet(SHEET_STOCK);
    s.appendRow(['size','trays']);
    ['small','medium','large','xl','jumbo'].forEach(function (k) { s.appendRow([k, 0]); });
    s.getRange('A1:B1').setFontWeight('bold');
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
    o.appendRow(['id','name','contact','address','size','trays','notes','status','time','createdAt','unitPrice']);
    o.getRange('A1:K1').setFontWeight('bold');
    report.push('• Created `orders` sheet');
  }
  if (!ss.getSheetByName(SHEET_ACTIVITY)) {
    var a = ss.insertSheet(SHEET_ACTIVITY);
    a.appendRow(['action','time']);
    a.getRange('A1:B1').setFontWeight('bold');
    report.push('• Created `activity` sheet');
  }
  if (!ss.getSheetByName(SHEET_CONFIG)) {
    var c = ss.insertSheet(SHEET_CONFIG);
    c.appendRow(['key','value']);
    c.getRange('A1:B1').setFontWeight('bold');
    report.push('• Created `config` sheet');
  }
  if (!ss.getSheetByName(SHEET_STOCK_EVENTS)) {
    var se = ss.insertSheet(SHEET_STOCK_EVENTS);
    se.appendRow(['createdAt','time','size','delta','reason','before','after','note','actor']);
    se.getRange('A1:I1').setFontWeight('bold');
    report.push('• Created `stock_events` sheet');
  }
  if (!ss.getSheetByName(SHEET_PRICE_EVENTS)) {
    var pe = ss.insertSheet(SHEET_PRICE_EVENTS);
    pe.appendRow(['createdAt','time','size','oldPrice','newPrice','actor']);
    pe.getRange('A1:F1').setFontWeight('bold');
    report.push('• Created `price_events` sheet');
  }
}

// 2. Add missing columns to an older `orders` sheet (createdAt, unitPrice).
function upgradeOrdersSchema_(ss, report) {
  var orders = ss.getSheetByName(SHEET_ORDERS);
  if (!orders) return;
  // Read enough columns to inspect headers J and K.
  var width   = Math.max(orders.getLastColumn(), 11);
  var headers = orders.getRange(1, 1, 1, width).getValues()[0];
  if (headers[9] !== 'createdAt') {
    orders.getRange(1, 10).setValue('createdAt').setFontWeight('bold');
    report.push('• Added `orders.createdAt` column');
  }
  if (headers[10] !== 'unitPrice') {
    orders.getRange(1, 11).setValue('unitPrice').setFontWeight('bold');
    report.push('• Added `orders.unitPrice` column');
  }
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
  var running = {};
  var stock   = readStock(ss);
  Object.keys(stock).forEach(function (k) { running[k] = Number(stock[k]) || 0; });
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

// 6. Force freeform text columns to "Plain text" number format. Without
// this, values that start with =, +, -, or @ get evaluated as formulas
// when written to the sheet — e.g. "+7 trays Medium" shows as #ERROR!.
// Idempotent and cheap: setting the format on a whole column is one op.
function applyTextFormats_(ss, report) {
  var textCols = [
    { sheet: SHEET_ACTIVITY,      ranges: ['A:A'] },                       // action
    { sheet: SHEET_ORDERS,        ranges: ['B:D', 'G:G', 'I:I'] },         // name, contact, address; notes; time
    { sheet: SHEET_STOCK_EVENTS,  ranges: ['B:B', 'E:E', 'H:H', 'I:I'] },  // time, reason, note, actor
    { sheet: SHEET_PRICE_EVENTS,  ranges: ['B:B', 'F:F'] },                // time, actor
    { sheet: SHEET_CONFIG,        ranges: ['B:B'] }                        // value (PIN hash etc. — pure strings)
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
// Code already auto-migrates on first verifyPIN call, but doing it here
// makes the move explicit and visible in the report.
function migratePinToConfigSheet_(ss, report) {
  if (readConfig(ss, PIN_KEY)) return;  // already there
  var legacy = PropertiesService.getScriptProperties().getProperty(PIN_KEY);
  writeConfig(ss, PIN_KEY, legacy || sha256Hex('1234'));
  report.push(
    '• Wrote `adminPinHash` to config sheet (' +
    (legacy ? 'migrated from Script Properties' : 'seeded with default PIN 1234') + ')'
  );
}
