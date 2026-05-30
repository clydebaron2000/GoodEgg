# The Good Egg — Firebase Migration Plan (on the shelf)

> **Status: not started. Speculative.** This is a plan to migrate the backend
> from **Google Apps Script + Google Sheets** to **Firebase Firestore** *if and
> when* the app outgrows the current stack. Nothing here is built. The shipped
> backend (`Code.gs` + the Sheet) remains the source of truth — see
> `Design.md`.

## 1. Why we'd do this (the trigger signals)

Don't migrate for its own sake. The Apps Script + Sheets backend is cheap,
inspectable, and good enough for one small farm. Migrate only when one or more
of these actually bites:

- **Apps Script quotas.** Daily script-runtime / URL-fetch / lock-wait limits
  start throttling. A single Web App is the bottleneck for every read and write.
- **Lock contention.** `LockService.getScriptLock()` serializes *all* writes
  across the whole Sheet. With multiple busy admins (or multiple farms) the
  15s lock wait starts timing out.
- **Polling cost / staleness.** Every client polls `getState` every 30s and
  pulls the *entire* state each time. More clients × bigger sheets = a lot of
  redundant full-payload reads, and a built-in 30s staleness floor.
- **Sheet size.** `orders`, `activity`, `stock_events`, `price_events` grow
  unbounded. `getDataRange().getValues()` reads the whole tab on every call;
  this degrades as rows pile up (events are already capped at 500 in the
  payload as a stopgap).
- **Multi-tenant.** Wanting several farms/locations on one backend.

If none of these hurt, **stay on Sheets.** This doc is insurance, not a roadmap.

## 2. Target architecture

- **Firestore**, single database in **`asia-southeast1` (Singapore)** to
  minimize latency from the Philippines (~50–150 ms).
- **Realtime** via `onSnapshot` listeners → kills the 30s poll and the
  full-state refetch; clients get sub-second deltas.
- **Offline** via the SDK's IndexedDB persistence → orders/stock writes queue
  and replay on reconnect (a capability the current backend lacks).
- **Transactions** replace the global script lock with per-document
  transactions → concurrent writes to *different* docs no longer block.
- **Hosting unchanged** — `index.html` still ships via GitHub Pages (or move to
  Firebase Hosting). Only the data layer changes.

## 3. Data model mapping (Sheet tab → Firestore)

The current Sheet has these tabs (see `Design.md §4`). Proposed Firestore shape:

| Current tab | Firestore | Notes |
|---|---|---|
| `stock` | `/stock/{sizeKey}` docs (or one `/state/stock` map) | Per-size docs reduce write contention vs. a single map |
| `prices` | `/prices/{sizeKey}` docs | Same reasoning |
| `sizes` | `/sizes/{sizeKey}` `{ label, sortOrder }` | Canonical size list stays runtime-editable |
| `orders` | `/orders/{orderId}` collection | `orderId` is already a client UUID → `setDoc` is naturally idempotent |
| `admins` | `/admins/{adminId}` `{ name, pinHash, createdAt, active }` | Or migrate to Firebase Auth (see §5) |
| `activity` | `/activity/{autoId}` | Append-only; consider TTL / archival |
| `stock_events` | `/stock_events/{autoId}` | Append-only; index by `createdAt` |
| `price_events` | `/price_events/{autoId}` | Append-only |
| `config` | `/config/app` doc | `eggsPerTray`, legacy keys |

**Decisions to make:**
- Per-size docs vs. a single map doc for `stock`/`prices`. Per-size docs win on
  write contention; a single doc wins on read simplicity and matches today's
  client shape. Lean per-size if write volume is the reason we're migrating.
- Event log retention: Firestore charges per read/write/storage. Add a TTL
  policy or periodic archival to BigQuery/Storage for `*_events` and `activity`.

## 4. Concurrency & dedup (how today's guarantees carry over)

| Today (Apps Script) | Firestore equivalent |
|---|---|
| Global `LockService` script lock | Per-doc `runTransaction` (read-modify-write on `stock/{size}`) |
| `deductStock` refuses to go negative under lock | Transaction re-reads the doc and aborts if `after < 0` |
| `submitOrder` checks existing `id`, returns `deduplicated` | `setDoc(/orders/{uuid})` is idempotent by construction |
| `unitPrice` snapshotted server-side at submit | Read `/prices/{size}` inside the order transaction and write it onto the order |
| `asText_()` formula-injection guard | Not needed — Firestore stores strings as data, never formulas |

The server-side price snapshot and the negative-stock guard **must** move into
Security Rules and/or a Cloud Function, not just client code — otherwise a
tampered client could underreport revenue or oversell (same threat model the
current server-side handlers defend against).

## 5. Auth

Two options, in increasing effort:

1. **Keep the PIN-hash model.** Store `pinHash` per admin in `/admins`. Client
   computes `SHA-256(pin)` (Web Crypto, as today) and includes it on writes;
   Security Rules compare against the stored hash. Lowest-friction, preserves
   the current UX exactly. The catch: Firestore Rules can read another doc to
   compare, but doing it well (and rate-limiting brute force) is fiddlier than
   the current `doPost` check.
2. **Adopt Firebase Auth.** Email-link or phone-OTP sign-in, real per-user
   identity, and Rules become `request.auth != null && isAdmin(uid)`. More
   robust and a better base for multi-farm, but changes the login UX and adds
   an account-management surface. The current `/admins` table already models
   per-user identity, so this is an incremental step, not a rewrite.

Recommendation: start with (1) to de-risk the data migration, then move to (2)
as a separate follow-up if stronger auth is warranted.

## 6. Migration steps (when we pull the trigger)

1. **Stand up Firebase.** Create the project, enable Firestore in
   `asia-southeast1`, wire up the SDK config in a feature branch of `index.html`.
2. **Write Security Rules** mirroring today's access model: reads open;
   writes require a valid admin (PIN hash or Auth). Encode the negative-stock
   and price-snapshot invariants in Rules or a Cloud Function.
3. **One-time data export/import.** Script it: read every tab via the Sheets
   API (or `getState`), transform per §3, batch-write into Firestore. Idempotent
   and re-runnable (use known doc IDs so re-runs upsert, not duplicate).
4. **Dual-run / shadow phase.** Point a preview build (the deploy workflow
   already publishes any branch to `…/preview/<branch>/`) at Firestore while
   production stays on Apps Script. Compare behavior on real devices.
5. **Cut over.** Flip production `index.html` to the Firestore data layer.
   Keep the Sheet read-only as a backup for a while.
6. **Decommission.** Once stable, retire the Apps Script Web App (or keep it as
   a cold standby / export target).

## 7. Rollback

Because cutover is just which data layer `index.html` talks to, rollback =
redeploy the previous (Apps Script) `index.html`. Keep the Sheet authoritative
and in sync until the dual-run phase proves out, so reverting loses nothing.

## 8. Open questions / TODO before committing to this

- [ ] Confirm Firestore free-tier (Spark) headroom vs. expected read volume —
      `onSnapshot` + per-size docs changes the read-count math a lot.
- [ ] Decide per-size docs vs. single map for `stock`/`prices`.
- [ ] Decide auth path (§5 option 1 vs 2).
- [ ] Event-log retention/archival policy so storage + read costs stay bounded.
- [ ] Whether to also move hosting to Firebase Hosting or stay on GitHub Pages.

---

*A fuller from-scratch Firestore design (data shapes, Security Rules sketch,
latency tables) lives in `Design.md` Appendix A and in this repo's git history.
This document is the migration-specific companion to it.*
