# Testing the Apps Script backend

`Tests.gs` is an **integration** harness for `Code.gs`. It runs the real
handlers against a real throwaway Google Sheet and then trashes it — no
mocks. The bugs worth catching in this backend (stock flooring, order
dedup, server-side price snapshotting, lock ordering) live in the Sheets
layer, so a faked-Sheet unit test would miss them.

## How it works

`Code.gs` has a one-line testability seam:

```js
var __TEST_DB__ = null;
function getDb_() { return __TEST_DB__ || SpreadsheetApp.getActiveSpreadsheet(); }
```

Every handler reads `getDb_()` instead of
`SpreadsheetApp.getActiveSpreadsheet()`. In production `__TEST_DB__` is
`null`, so nothing changes. `runIntegrationTests()` creates a temporary
spreadsheet, points `__TEST_DB__` at it, runs `setupSpreadsheet()` plus
the handlers under test, asserts, then (in a `finally`) resets
`__TEST_DB__ = null` and trashes the temp sheet.

## Running it

### From the Apps Script editor (simplest)

1. Make sure `Code.gs` **and** `Tests.gs` are both in the project
   (`clasp push`, or paste both).
2. In the function dropdown pick **`runIntegrationTests`** → **Run**.
3. First run prompts for authorization (it creates and trashes a Sheet —
   that needs Drive access). Approve it once.
4. Read the result in **View → Executions** / the Logger output. You get
   a `Integration tests: N/M passed` line and a PASS/FAIL list.
5. On any failure the function **throws**, so the execution is marked
   failed (not just a log line).

### From the command line (`clasp run`)

```bash
clasp push          # uploads Code.gs + Tests.gs (see .claspignore)
clasp run runIntegrationTests
```

`clasp run` surfaces the return value / thrown error, so a failure exits
non-zero — usable as a pre-push or pre-deploy gate.

## Why this is NOT wired into GitHub Actions

Apps Script has **no unattended/headless auth**. `clasp run` needs an
OAuth credential with the right scopes (Drive + Spreadsheets), and the
first invocation always requires an interactive consent screen. A vanilla
CI runner can't click "Allow". To run this in CI you would have to:

- do the interactive auth once locally,
- store the resulting `~/.clasprc.json` refresh token as a secret,
- restore it in the workflow before `clasp run`,
- and enable the Apps Script API + a deployment for `clasp run`.

That's a real setup, not a checkbox, and the token is long-lived
credential material. Until that's worth it, treat `runIntegrationTests()`
as a **manual gate**: run it from the editor (or `clasp run`) before
deploying a backend change.

> Frontend note: backend code only deploys from `main` (see
> `sync-appscript.yml`). This harness lives on the `gs-integration-tests`
> branch and is not on the production path.

## What's covered

| Area | Assertion |
|---|---|
| `setupSpreadsheet` | seeds 5 sizes, default prices, zero stock, one admin, no orders |
| `addStock` / `deductStock` | balances move correctly |
| flooring | over-deduct returns `INSUFFICIENT_STOCK` and leaves stock unchanged |
| `savePrices` + `submitOrder` | order snapshots current `unitPrice`; later price change doesn't rewrite it |
| `submitOrder` dedup | same client `id` flagged `deduplicated`, adds exactly one row |
| `addSize` / `deleteSize` | size + companion stock/price rows added then removed |
| `doVerifyPIN` | correct PIN verifies with identity; wrong PIN rejected |
| `computeRunway_` | reports the conservative (smaller) of overall-14d vs day-of-week runway; `OUT` at 0 trays, `∞` with no recent sales |

## Adding a test

Add a `test_*` function that takes the `results` array and calls
`check_(results, label, condition, detail)`, then list it inside
`runIntegrationTests()`. Use `getState()` to read back the temp sheet and
`findOrder_(id)` to fetch a single order. Keep assertions black-box
(drive handlers, read state) so they survive internal refactors.
