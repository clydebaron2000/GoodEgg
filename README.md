# The Good Egg

A tiny mobile-first web app for a Philippine poultry farm to track egg inventory, prices, and customer orders.

**Live app:** https://clydebaron2000.github.io/GoodEgg/

Add it to your phone's home screen (Share → Add to Home Screen on iOS, ⋮ → Add to Home screen on Android) and it behaves like a native app.

---

## What it does

- **Customers** — view current stock per size, view per-tray prices, and place orders. No login.
- **Admins** — everything above, plus add/deduct stock, confirm/close/delete orders, edit prices, add/remove egg sizes, manage other admins, and change their PIN. Gated by a 4-digit PIN. Multiple admins are supported, and each write is attributed to the admin who made it.

Sizes are runtime-editable (default set: small, medium, large, XL, jumbo). Quantities are in trays (default 30 eggs per tray). Prices are in PHP.

---

## How it's built

| Layer | What it is |
|---|---|
| Frontend | A single `index.html` file — vanilla JS, no build step, PWA-installable |
| Backend | Google Apps Script (`Code.gs`) acting as a JSON API over a Google Sheet |
| Storage | A Google Sheet, one tab per table: `stock`, `prices`, `orders`, `sizes`, `admins`, `stock_events`, `price_events`, `activity`, `config` (+ a generated `Dashboard`) |
| Auth | 4-digit PIN per admin, stored server-side as a SHA-256 hash in the `admins` sheet (re-verified on every write; no session tokens) |
| Hosting | GitHub Pages, deployed automatically by GitHub Actions on push to `main` |

The client polls the Apps Script web app every 30 seconds for fresh state, and writes go through `POST` with the PIN hash for admin actions. Orders use a client-generated UUID so retries on flaky networks don't create duplicates.

---

## Files in this repo

- [index.html](index.html) — the whole app (UI + client logic)
- [Code.gs](Code.gs) — Apps Script backend (paste into a Google Sheet's Apps Script editor)
- [Deployment_Guide.md](Deployment_Guide.md) — step-by-step setup, no coding required
- [Apps_Script_Sync_Setup.md](Apps_Script_Sync_Setup.md) — wiring up clasp + GitHub Actions so `Code.gs` auto-syncs to Apps Script on push
- [Design.md](Design.md) — technical design of the shipped Apps Script + Sheets backend (with a superseded Firebase design noted in an appendix)
- [.github/workflows](.github/workflows) — auto-deploy to GitHub Pages and Apps Script

---

## Deploying your own copy

The short version (full walkthrough in [Deployment_Guide.md](Deployment_Guide.md)):

1. Create a Google Sheet, open **Extensions → Apps Script**, paste in [Code.gs](Code.gs), and run `setupSpreadsheet` once. (For an existing deployment, run `migrate` instead — it's idempotent and brings the schema/data up to date.)
2. **Deploy → New deployment → Web app**, set "Execute as: Me" and "Who has access: Anyone". Copy the resulting `/exec` URL.
3. Either:
   - Paste the URL into `index.html` (replace the `YOUR_APPS_SCRIPT_URL_HERE` placeholder in the `SCRIPT_URL` constant), and host the file anywhere, or
   - Fork this repo, add the URL as a GitHub Actions secret named `SCRIPT_URL`, and push to `main` — the workflow injects it on deploy.
4. Open the app, tap **Admin**, log in with the default PIN `1234`, and immediately change it from the Inventory tab.

---

## Notes

- To reset an admin's PIN, edit (or delete) their row in the `admins` sheet tab. A fresh `setupSpreadsheet()`/`migrate()` seeds a default admin with PIN `1234`. (The legacy `adminPinHash` value in the `config` tab is kept only for backward compatibility.)
- "Anyone with the URL can read" is intentional — customers need to see stock and prices. Only admin writes require the PIN.
- `Design.md` now documents the shipped Apps Script + Sheets backend. The earlier Firestore design was never built and survives only as a clearly-marked appendix. Treat `Code.gs` + the Sheet as the source of truth for backend behaviour.
- A future **Sheets → Firestore migration plan** (for when the app needs to scale past Apps Script) lives on the [`firebase-migration`](../../tree/firebase-migration) branch as `Firebase_Migration_Plan.md`. It's an on-the-shelf plan — nothing is built on `main`.
