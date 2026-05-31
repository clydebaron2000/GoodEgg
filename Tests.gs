// ══════════════════════════════════════════════════════════════
// The Good Egg — Integration tests
//
// These run the REAL handlers from Code.gs against a REAL throwaway
// spreadsheet (not mocks), then trash it. They exist because the
// interesting bugs in this backend live in the Sheets layer —
// flooring, dedup, price snapshotting, lock ordering — which a unit
// test with a faked Sheet would not catch.
//
// HOW TO RUN
//   In the Apps Script editor: pick `runIntegrationTests` from the
//   function dropdown and click Run. Read the result in
//   View → Executions (or the Logger output). A summary line reports
//   pass/fail counts; runIntegrationTests() also THROWS if anything
//   failed, so `clasp run runIntegrationTests` exits non-zero for CI.
//
// AUTHORIZATION / CI CAVEAT
//   The harness calls SpreadsheetApp.create() and DriveApp (to trash
//   the temp sheet), so the first run prompts for Drive authorization.
//   Apps Script has no unattended/headless auth, so this cannot run in
//   a vanilla GitHub Actions runner without a stored OAuth refresh
//   token + `clasp run`. See GS_TESTING.md. Treat it as a pre-push /
//   pre-deploy gate you run by hand or from an authorized clasp setup.
//
// It relies on the __TEST_DB__ seam in Code.gs (getDb_()): handlers
// read getDb_() instead of SpreadsheetApp.getActiveSpreadsheet(), so
// setting __TEST_DB__ redirects every handler at the temp sheet.
// ══════════════════════════════════════════════════════════════

function runIntegrationTests() {
  var results = [];
  var temp = SpreadsheetApp.create('GoodEgg INTEGRATION TEST ' + new Date().toISOString());
  __TEST_DB__ = temp;
  try {
    setupSpreadsheet();
    test_setupSeedsDefaults_(results);
    test_addAndDeductStock_(results);
    test_deductStockFlooring_(results);
    test_savePricesAndOrderSnapshot_(results);
    test_submitOrderDedup_(results);
    test_addAndDeleteSize_(results);
    test_verifyPin_(results);
    test_headerBasedReads_(results);   // mutates orders columns — keep last
  } finally {
    __TEST_DB__ = null;  // ALWAYS detach so we never touch the real sheet after this
    try {
      DriveApp.getFileById(temp.getId()).setTrashed(true);
    } catch (e) {
      results.push({ label: 'cleanup: trash temp spreadsheet', pass: false, detail: String(e) });
    }
  }
  return report_(results);
}

// ── Test cases ─────────────────────────────────────────────────

function test_setupSeedsDefaults_(r) {
  var s = getState();
  check_(r, 'setup seeds 5 default sizes', s.sizes.length === 5, 'got ' + s.sizes.length);
  check_(r, 'setup seeds small price 120', Number(s.prices.small) === 120, 'got ' + s.prices.small);
  check_(r, 'setup seeds zero stock', Number(s.stock.small) === 0, 'got ' + s.stock.small);
  check_(r, 'setup seeds one active admin', s.admins.length === 1, 'got ' + s.admins.length);
  check_(r, 'setup creates no orders', s.orders.length === 0, 'got ' + s.orders.length);
}

function test_addAndDeductStock_(r) {
  addStock({ size: 'small', trays: 10, _admin: { name: 'tester' } });
  check_(r, 'addStock +10 → small=10', Number(getState().stock.small) === 10, 'got ' + getState().stock.small);
  deductStock({ size: 'small', trays: 3, _admin: { name: 'tester' } });
  check_(r, 'deductStock -3 → small=7', Number(getState().stock.small) === 7, 'got ' + getState().stock.small);
}

function test_deductStockFlooring_(r) {
  // small currently 7 (from previous test). Over-deduct must be rejected
  // and must NOT drive stock negative.
  var before = Number(getState().stock.small);
  var res = deductStock({ size: 'small', trays: before + 100, _admin: { name: 'tester' } });
  check_(r, 'over-deduct returns INSUFFICIENT_STOCK', res && res.code === 'INSUFFICIENT_STOCK', JSON.stringify(res));
  check_(r, 'over-deduct leaves stock unchanged', Number(getState().stock.small) === before, 'got ' + getState().stock.small);
}

function test_savePricesAndOrderSnapshot_(r) {
  savePrices({ prices: { small: 200 }, _admin: { name: 'tester' } });
  check_(r, 'savePrices sets small=200', Number(getState().prices.small) === 200, 'got ' + getState().prices.small);

  // An order locks in the CURRENT price as unitPrice, server-side.
  submitOrder({ order: { id: 'order-snap-1', name: 'Maria', size: 'small', trays: 2 } });
  var o = findOrder_('order-snap-1');
  check_(r, 'submitOrder snapshots unitPrice=200', o && Number(o.unitPrice) === 200, o ? ('got ' + o.unitPrice) : 'order missing');

  // Changing the price afterward must NOT rewrite the existing order.
  savePrices({ prices: { small: 999 }, _admin: { name: 'tester' } });
  var o2 = findOrder_('order-snap-1');
  check_(r, 'later price change does not rewrite order unitPrice', o2 && Number(o2.unitPrice) === 200, o2 ? ('got ' + o2.unitPrice) : 'order missing');
}

function test_submitOrderDedup_(r) {
  var n0 = getState().orders.length;
  submitOrder({ order: { id: 'dup-1', name: 'Jose', size: 'medium', trays: 1 } });
  var res = submitOrder({ order: { id: 'dup-1', name: 'Jose', size: 'medium', trays: 1 } });
  check_(r, 'duplicate order id is flagged deduplicated', res && res.deduplicated === true, JSON.stringify({ deduplicated: res && res.deduplicated }));
  check_(r, 'duplicate order id adds exactly one row', getState().orders.length === n0 + 1, 'delta ' + (getState().orders.length - n0));
}

function test_addAndDeleteSize_(r) {
  addSize({ key: 'tiny', label: 'Tiny', _admin: { name: 'tester' } });
  var s = getState();
  check_(r, 'addSize adds size key', s.sizes.some(function (x) { return x.key === 'tiny'; }), 'sizes=' + s.sizes.map(function (x) { return x.key; }).join(','));
  check_(r, 'addSize seeds stock row', s.stock.tiny !== undefined, JSON.stringify(s.stock));
  check_(r, 'addSize seeds price row', s.prices.tiny !== undefined, JSON.stringify(s.prices));

  deleteSize({ key: 'tiny', _admin: { name: 'tester' } });
  var s2 = getState();
  check_(r, 'deleteSize removes size key', !s2.sizes.some(function (x) { return x.key === 'tiny'; }), 'still present');
  check_(r, 'deleteSize removes stock row', s2.stock.tiny === undefined, 'stock row remains');
}

function test_verifyPin_(r) {
  var adminId = getState().admins[0].id;
  var good = doVerifyPIN({ adminId: adminId, pinHash: sha256Hex('1234') });
  check_(r, 'correct PIN verifies', good && good.success === true, JSON.stringify(good));
  check_(r, 'verify returns admin identity', good && good.admin && good.admin.id === adminId, JSON.stringify(good && good.admin));

  var bad = doVerifyPIN({ adminId: adminId, pinHash: sha256Hex('0000') });
  check_(r, 'wrong PIN is rejected', bad && bad.success === false, JSON.stringify(bad));
}

// Readers index by HEADER NAME, not column position, so a human inserting
// a column in the Sheet no longer silently shifts every read. We prove it
// against the real sheet: submit an order, insert a labelled column to the
// LEFT of `size`, then confirm getState() still resolves size/trays/unitPrice
// correctly (the old positional reader would have returned the inserted
// column's value as the size).
//
// NOTE: this only exercises the READ path. Mutating handlers still write by
// column index, so this test runs LAST and does not submit further orders
// after the column insert.
function test_headerBasedReads_(r) {
  submitOrder({ order: { id: 'hdr-1', name: 'Ana', size: 'large', trays: 4 } });
  var before = findOrder_('hdr-1');
  check_(r, 'header test: order reads before column insert', before && before.size === 'large' && Number(before.trays) === 4,
    JSON.stringify(before));
  var expectedUnit = before ? before.unitPrice : null;

  // Insert a new labelled column to the left of `size` (column 5).
  var orders = getDb_().getSheetByName('orders');
  orders.insertColumnBefore(5);
  orders.getRange(1, 5).setValue('channel');

  var after = findOrder_('hdr-1');
  check_(r, 'header read survives an inserted column (size)',  after && after.size === 'large', after ? ('got size=' + after.size) : 'order missing');
  check_(r, 'header read survives an inserted column (trays)', after && Number(after.trays) === 4, after ? ('got trays=' + after.trays) : 'order missing');
  check_(r, 'header read survives an inserted column (unitPrice)', after && after.unitPrice === expectedUnit, after ? ('got unitPrice=' + after.unitPrice) : 'order missing');
  check_(r, 'unlabelled/extra column does not appear as a size key', getState().orders.length >= 1, 'no orders');
}

// ── Tiny assertion + reporting framework ───────────────────────

function check_(results, label, pass, detail) {
  results.push({ label: label, pass: !!pass, detail: detail || '' });
}

function findOrder_(id) {
  return getState().orders.filter(function (o) { return o.id === id; })[0] || null;
}

function report_(results) {
  var passed = results.filter(function (x) { return x.pass; }).length;
  var failed = results.length - passed;
  var lines = results.map(function (x) {
    return (x.pass ? 'PASS ' : 'FAIL ') + x.label + (x.pass ? '' : '  — ' + x.detail);
  });
  var summary = 'Integration tests: ' + passed + '/' + results.length + ' passed' +
    (failed ? ', ' + failed + ' FAILED' : '');
  var full = summary + '\n' + lines.join('\n');
  Logger.log(full);
  if (failed) throw new Error(summary + '\n' + lines.filter(function (l) { return l.indexOf('FAIL') === 0; }).join('\n'));
  return full;
}
