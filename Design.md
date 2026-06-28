# The Good Egg — Technical Design

> **Source of truth.** This document describes the **shipped** system: a
> Google Apps Script + Google Sheets backend behind a single-file PWA. An
> earlier Firebase/Firestore design was drafted but **never built** — see
> [Appendix A](#appendix-a--superseded-firebase-design-never-shipped). When
> in doubt, `Code.gs` + the Sheet are authoritative over any prose here.

## 1. Overview

The Good Egg is a mobile-first web app (single `index.html`, PWA-installable)
for a Philippine poultry farm. It tracks egg inventory by size, manages
pricing, and handles customer orders.

**Users:**
- **Customers** — view stock, view prices, submit orders (no login)
- **Admins** — all of the above + add/deduct stock (per farm), confirm/close/delete
  orders, edit prices, add/remove egg sizes, manage farms (and which sizes each
  offers), manage other admins, change PIN.
  Gated by a 4-digit PIN.

Quantities are in **trays** (default 30 eggs/tray). Prices are **per tray, in PHP**.

---

## 2. Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Single `index.html`, vanilla JS, no build step | Deployable anywhere; installs as a PWA via `sw.js` |
| Backend | Google Apps Script (`Code.gs`) Web App | Free, no server to run, JSON API over a Sheet |
| Storage | A Google Sheet (one tab per table) | Human-inspectable; the farm owner can read/edit rows directly |
| Auth | 4-digit PIN → SHA-256 hash, verified server-side | No accounts to manage; simple for farm staff |
| Hosting | GitHub Pages, auto-deployed by GitHub Actions | Free, HTTPS, global CDN |

The client **polls** `getState` every 30 seconds (`POLL_INTERVAL` in
`index.html`). There is no realtime socket — polling is simple and robust on
flaky mobile connections.

---

## 3. API

The Apps Script Web App is deployed **Execute as: Me / Who has access: Anyone
(anonymous)**. It exposes exactly two entry points.

### 3.1 `GET ?action=getState`

Returns the entire public state in one payload (the PIN hash is **never**
included):

```
{
  admins,       // active admins, id + name + createdAt only (no pinHash)
  farms,        // [{ id, name, active, sortOrder }] — all farms (client shows active to customers)
  sizes,        // [{ key, label, sortOrder }]
  stock,        // { <farmId>: { <sizeKey>: trays } } — stock is per-farm
  prices,       // { <sizeKey>: pricePerTray } — global, not per-farm
  orders,       // [{ id, name, contact, address, size, trays, notes,
                //    status, time, createdAt, unitPrice, farm }]
  activity,     // freeform human-readable log
  stockEvents,  // structured restock/sale log (last 500)
  priceEvents,  // structured price-change log (last 500)
  ts            // server time, epoch ms
}
```

### 3.2 `POST` `{ action, ... }`

| Action | Auth | Effect |
|---|---|---|
| `verifyPIN` | public | Check a PIN; returns the resolved admin |
| `submitOrder` | public | Create an order (idempotent by client UUID). Validates the farm is active, the size is priced (rejects `UNPRICED`), and reserves stock per `(farm,size)` against pending orders (rejects `INSUFFICIENT_STOCK`) |
| `addStock` / `deductStock` | admin | Adjust tray counts; logs a stock event |
| `savePrices` | admin | Update per-tray prices; logs price events |
| `updateOrderStatus` | admin | pending → confirmed → done |
| `deleteOrder` | admin | Remove an order (full row snapshotted to activity) |
| `addSize` / `deleteSize` | admin | Add/remove an egg size at runtime (global) |
| `addAdmin` / `deleteAdmin` / `renameAdmin` | admin | Manage admins |
| `addFarm` / `renameFarm` / `setFarmActive` / `deleteFarm` | admin | Manage farms. `deleteFarm` is refused while any order references the farm (deactivate instead, to keep order history) |
| `addFarmSize` / `removeFarmSize` | admin | Choose which sizes a farm offers (creates/removes its `(size,farm)` stock row). `addFarmSize` also *creates* a brand-new size inline when given an unknown key + label (it joins the shared catalog) |
| `changePIN` | admin | Rotate the calling admin's PIN |

Every admin action returns the **fresh `state`** so the client updates
without waiting for the next poll.

---

## 4. Data Model (Google Sheet tabs)

`setupSpreadsheet()` creates these tabs; `migrate()` brings an existing Sheet
up to schema idempotently. Column order matters — the readers index by
position.

| Tab | Columns | Notes |
|---|---|---|
| `stock` | `size`, `trays`, `farm` | One row per **(size, farm)**; the row's existence means "this farm offers this size" (trays may be 0). `farm` is appended last so the formula-driven Dashboard keeps reading `size`=A, `trays`=B |
| `prices` | `size`, `perTray` | PHP per tray — **global**, shared across all farms |
| `orders` | `id`, `name`, `contact`, `address`, `size`, `trays`, `notes`, `status`, `time`, `createdAt`, `unitPrice`, `farm` | `id` is a client UUID; `unitPrice` snapshotted at submit time; `farm` is the fulfilling farm |
| `sizes` | `key`, `label`, `sortOrder` | **Canonical, runtime-editable** list of egg sizes (global) |
| `farms` | `id`, `name`, `active`, `sortOrder` | One row per farm; soft-deactivate via `active=false`. Seeded with one default "Main Farm" |
| `admins` | `id`, `name`, `pinHash`, `createdAt`, `active` | One row per admin; soft-delete via `active=false` |
| `stock_events` | `createdAt`, `time`, `size`, `delta`, `reason`, `before`, `after`, `note`, `actor`, `farm` | Append-only, for analytics/dashboard |
| `price_events` | `createdAt`, `time`, `size`, `oldPrice`, `newPrice`, `actor` | Append-only |
| `activity` | `action`, `time`, `createdAt`, `actor` | Freeform human-readable log |
| `config` | `key`, `value` | Legacy `adminPinHash` row (migration), future settings |
| `Dashboard` | — | Generated by `buildDashboard()`: KPIs + formula-driven aggregation tables. Rebuild any time; add charts manually |

**Multiple farms.** Each farm holds its own stock and customers pick a farm
when ordering; an order draws from exactly that farm. Prices and the canonical
size list stay global. A size is **offered per farm** — the presence of a
`(size, farm)` row in `stock` is the declaration, so a farm carries only the
sizes it actually produces. Stock is keyed by `(size, farm)`; `readStock()`
returns it nested as `{ farmId: { size: trays } }`.

Sizes are **not hardcoded**. The seed set is small/medium/large/xl/jumbo, and
the `sizes` tab is a **shared catalog** (keys + labels + global prices) — but
it is **managed per-farm** in the UI: there is no standalone "egg sizes"
screen. From a farm you offer an existing catalog size or create a new one
inline (`addFarmSize` with a new key+label appends to `sizes`, seeds a global
`prices` row at 0, and adds the farm's `(size,farm)` stock row). `removeFarmSize`
stops a farm offering a size; a size offered by no farm simply lingers in the
catalog (its price is remembered if re-offered). The `addSize`/`deleteSize`
handlers remain in the backend for API completeness but are no longer surfaced.
`sizeLabel()` resolves a key to its display label from the `sizes` tab, falling
back to a built-in map then the raw key.

The Inventory page shows stock **both** as a "Total across farms" table and as
a per-farm breakdown; customer-facing totals/availability count **active farms
only** (deactivated-farm stock isn't orderable, so it's excluded there).

All timestamps are written twice: a human-readable **UTC** string (`time`) so
anyone opening the Sheet sees an unambiguous value, plus an epoch-ms
`createdAt` the client converts to local time.

---

## 5. Security Model

### 5.1 PIN handling
1. Admin enters a 4-digit PIN; the browser computes `SHA-256(pin)` via the Web
   Crypto API. The plaintext PIN never leaves the device.
2. Login sends `{ adminId, pinHash }`; the server matches it against the
   `admins` tab and returns `{ id, name }` on success.
3. Every admin **write** re-sends the `pinHash` (and `adminId`). The server
   re-verifies on each request — there are **no session tokens**. The
   resolved admin name is stamped onto activity/event rows for attribution.

### 5.2 Backwards compatibility
A pre-multi-admin client sends only `{ pinHash }`. `verifyLegacyLogin_`
accepts it if it matches **any active admin's** hash (first match wins), and
falls back to the legacy `config.adminPinHash` row for Sheets not yet
re-migrated. This lets the production deploy and feature branches share one
Apps Script backend during rollout.

### 5.3 Why a 4-digit PIN is acceptable
Reads are intentionally open — customers must see stock and prices. The only
thing a PIN guards is writes, whose worst case is someone editing tray counts.
Brute force means thousands of POSTs against Apps Script, which its execution
quotas throttle. If stronger auth is ever needed, the `admins` tab already
models per-user identity to build on.

### 5.4 Spreadsheet-formula injection
Any user-supplied string written to the Sheet passes through `asText_()`,
which prefixes a leading `=`, `+`, `-`, or `@` with an apostrophe so Sheets
stores it as text instead of evaluating it as a formula.

---

## 6. Concurrency & Deduplication

This is the core engineering concern for unreliable Philippine mobile networks.

- **Write serialization.** Every mutating handler takes a
  `LockService.getScriptLock()` (15s wait) so two simultaneous writes can't
  interleave. (The Firestore "transactions" in the old design map to this
  script lock in the shipped backend.)
- **Stock floor.** `deductStock` reads the current value under the lock and
  refuses to go negative (`code: INSUFFICIENT_STOCK`).
- **Order idempotency.** The client generates the order `id` (UUID) *before*
  sending. `submitOrder` checks whether that `id` already exists and, if so,
  returns `{ success: true, deduplicated: true }` silently — so a retry after
  a dropped response never creates a duplicate.
- **Revenue integrity.** `submitOrder` snapshots the current per-tray price
  into the order's `unitPrice` server-side, so a tampered client can't
  underreport and later price edits don't rewrite order history.

---

## 7. Deployment

Both halves deploy automatically from `main` (and every branch) via GitHub
Actions. See `README.md` and `Apps_Script_Sync_Setup.md` for the full
walkthrough; the short version:

### 7.1 Frontend → GitHub Pages (`.github/workflows/deploy.yml`)
- Triggers on push to **any** branch.
  - `main` → site root → `https://clydebaron2000.github.io/GoodEgg/`
  - any other branch → `https://clydebaron2000.github.io/GoodEgg/preview/<branch>/`
- Stages `index.html` (+ `sw.js`, logo) into `dist/`, injects the `SCRIPT_URL`
  repo secret in place of `YOUR_APPS_SCRIPT_URL_HERE`, stamps the commit SHA
  into `__BUILD_VERSION__`, and publishes to the `gh-pages` branch with
  `keep_files: true` (so previews and production don't clobber each other).
- Pages is configured as **Deploy from a branch → `gh-pages` → `/` (root)**.

### 7.2 Backend → Apps Script (`.github/workflows/sync-appscript.yml`)
- On push to `main` touching `Code.gs`/`appsscript.json`, `clasp` pushes the
  code and bumps the **existing** deployment to a new version, so the `/exec`
  URL stays stable. `.claspignore` restricts the push to `Code.gs` +
  `appsscript.json` (never `index.html`).

---

## 8. Operational Helpers (Apps Script editor)

Run these from the Apps Script editor's function dropdown:

| Function | Purpose |
|---|---|
| `setupSpreadsheet()` | One-time: create all tabs, seed defaults, default admin PIN `1234` |
| `migrate()` | Idempotent schema/data upgrade for an existing Sheet |
| `buildDashboard()` | (Re)build the `Dashboard` tab |
| `addAdminQuick()` / `addAdminInteractive()` | Onboard an admin without the in-app UI |
| `listAdmins()` | Print the admin roster to the log |

PIN reset: delete the `adminPinHash` value (legacy `config` row) / the relevant
`admins` row, then the default `1234` works again.

---

## 9. Future Considerations

| Feature | Approach |
|---|---|
| SMS order confirmations | Call a Philippine SMS API (Semaphore/Vonage) from a handler |
| Sales reports | The `Dashboard` tab + `stock_events`/`price_events`; export to CSV |
| Stronger auth | Build on the per-admin `admins` tab (e.g. phone OTP) |
| Per-farm pricing | Prices are currently global; a `(size,farm)` price table would let farms price independently |

> **Shipped:** *Multiple farms* (each farm holds its own stock; orders draw from one farm) is now implemented — see §4. `submitOrder` reserves stock per `(farm,size)` against still-pending orders, so this supersedes the single-farm reservation on `feat/soft-stock-reservation` (that branch's `submitOrder` is the conflict to resolve in multi-farm's favour when the two merge).

§9 is about *new* features. §10 below is about hardening what already ships.

---

## 10. Robustness & Hardening Roadmap

These are known gaps in the **current** Apps Script + Sheets backend, ranked
roughly by payoff-to-effort. None block the farm today; they are the work to do
before the user base or data volume grows. Each is scoped to stay on Apps Script
+ Sheets — the Firebase migration ([Appendix A](#appendix-a--superseded-firebase-design-never-shipped),
and the `firebase-migration` branch) is the separate "we've outgrown this" path.

### 10.1 Correctness & data integrity
- **Server-side input validation.** Handlers trust client-shaped payloads.
  Validate at the `doPost` boundary: `trays` is a positive integer, `size` is a
  known key from the `sizes` tab, free-text fields are length-capped *before*
  `asText_()`. Reject with a typed `code` instead of writing a bad row.
- **Scheduled Sheet backups.** A nightly time-driven trigger that copies the
  Sheet (or exports each tab to CSV in Drive) bounds worst-case data loss to one
  day. Today a fat-fingered manual edit or a bad `migrate()` has no undo beyond
  Google's version history.
- **`migrate()` safety rails.** It is idempotent but unguarded — there's no dry
  run and no record of which migration version a Sheet is on. Stamp a
  `schemaVersion` into `config` and have `migrate()` log a before/after diff so a
  run on production is auditable.

### 10.2 Availability & scale
- **Bounded `getState` payload.** The client refetches the *entire* state every
  30s, including the last 500 stock/price events. As `orders` grows unbounded,
  this is the first thing that will get slow on a flaky phone connection. Options:
  paginate or date-window `orders`, drop the event tails from the default poll
  (fetch on demand for the dashboard), or add a lightweight `?action=getState&since=<ts>`
  delta.
- **Lock contention is global.** One `getScriptLock()` serializes *all* writes
  farm-wide. Fine for one farm; the first real scaling wall. Document the ceiling
  (Apps Script's ~30 simultaneous executions / quota limits) so the trigger to
  migrate is a measured threshold, not a surprise outage.
- **Event-tab growth.** `stock_events` / `price_events` / `activity` append
  forever. Add a retention/rollup job (archive rows older than N months to a
  dated tab or CSV) so the Sheet stays under cell limits.

### 10.3 Security
- **PIN rate-limiting.** `verifyPIN` has no throttle beyond Apps Script's own
  quotas. A per-`adminId` attempt counter in `config` (with a cooldown after N
  failures) raises the cost of brute-forcing a 4-digit space.
- **Salt the PIN hash.** PINs are unsalted `SHA-256(pin)` — a 10k-entry rainbow
  table inverts the whole space instantly if the `admins` tab ever leaks. Store
  `SHA-256(salt + pin)` with a per-admin salt. (Migration needs a re-enroll or a
  one-time client-assisted rehash.)
- **Audit-log the sensitive actions.** `deleteOrder` snapshots to `activity`,
  but admin-management actions (`addAdmin`/`deleteAdmin`/`changePIN`) should also
  leave an attributable trail.

### 10.4 Operability
- **Automated tests + CI.** There is no test suite. The highest-value targets are
  pure and testable: `asText_()` escaping, `deductStock` flooring, `submitOrder`
  idempotency/`unitPrice` snapshotting, `sizeLabel()` fallback. Run them in
  GitHub Actions (clasp can pull, or factor the pure logic into a testable
  module) so a refactor can't silently break the money path.
- **Observability & alerting.** Failures live only in the Apps Script execution
  log. Wire a failure path (or a daily health-check trigger) to email/Slack the
  owner on errors, lock timeouts, or a stale `getState`, so a broken deploy
  isn't discovered by a customer.
- **Client retry/offline UX.** The client polls and posts, but offline handling
  is thin. A small outbox (queue writes in `localStorage`, replay on reconnect —
  the UUID idempotency already makes this safe) would make the app usable through
  the connectivity gaps it's explicitly built for.

---

## Appendix A — Superseded Firebase design (never shipped)

Before the Apps Script + Sheets backend was built, an alternate design
targeted **Firebase Firestore** in the Singapore region (`asia-southeast1`),
using `onSnapshot` realtime listeners, IndexedDB offline persistence, Firestore
transactions, and Security Rules to verify the PIN hash. It was dropped in
favour of Apps Script + Sheets because the Sheet is directly inspectable and
editable by the farm owner, needs no Firebase project or SDK, and hosts free on
GitHub Pages.

The concepts carried over almost one-to-one:

| Firestore design | Shipped equivalent |
|---|---|
| Firestore documents/collections | Google Sheet tabs |
| `onSnapshot` realtime listeners | 30-second `getState` polling |
| Firestore transactions | `LockService` script lock |
| Security Rules check `_pinHash` | Server-side hash check in `doPost` |
| IndexedDB offline persistence | (not implemented) |

The full original Firestore document — data model, Security Rules, latency
tables — remains in this file's git history if needed for reference. It does
**not** describe the running system.

A migration-specific companion — trigger signals, the Sheet-tab → Firestore
mapping, concurrency/auth strategy, and cutover/rollback steps — lives on the
**`firebase-migration`** branch as `Firebase_Migration_Plan.md`, ready to pull
off the shelf when the app needs to scale past Apps Script.
