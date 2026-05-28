# GoodEgg — EggTrack

A tiny mobile-first web app for a Philippine poultry farm to track egg inventory, prices, and customer orders.

**Live app:** https://clydebaron2000.github.io/GoodEgg/eggtrack.html

Add it to your phone's home screen (Share → Add to Home Screen on iOS, ⋮ → Add to Home screen on Android) and it behaves like a native app.

---

## What it does

- **Customers** — view current stock per size, view per-tray prices, and place orders. No login.
- **Admins** — everything above, plus add/deduct stock, confirm and close orders, edit prices, and change the admin PIN. Gated by a 4-digit PIN.

Sizes tracked: small, medium, large, XL, jumbo. Quantities are in trays (default 30 eggs per tray). Prices are in PHP.

---

## How it's built

| Layer | What it is |
|---|---|
| Frontend | A single `eggtrack.html` file — vanilla JS, no build step, PWA-installable |
| Backend | Google Apps Script (`Code.gs`) acting as a JSON API over a Google Sheet |
| Storage | A Google Sheet with four tabs: `stock`, `prices`, `orders`, `activity` |
| Auth | 4-digit PIN, stored server-side as a SHA-256 hash in Script Properties |
| Hosting | GitHub Pages, deployed automatically by GitHub Actions on push to `main` |

The client polls the Apps Script web app every 30 seconds for fresh state, and writes go through `POST` with the PIN hash for admin actions. Orders use a client-generated UUID so retries on flaky networks don't create duplicates.

---

## Files in this repo

- [eggtrack.html](eggtrack.html) — the whole app (UI + client logic)
- [Code.gs](Code.gs) — Apps Script backend (paste into a Google Sheet's Apps Script editor)
- [EggTrack_Deployment_Guide.md](EggTrack_Deployment_Guide.md) — step-by-step setup, no coding required
- [Apps_Script_Sync_Setup.md](Apps_Script_Sync_Setup.md) — wiring up clasp + GitHub Actions so `Code.gs` auto-syncs to Apps Script on push
- [EggTrack_Design.md](EggTrack_Design.md) — design notes (describes an alternate Firebase backend that was considered but not implemented; the shipped backend is Apps Script + Sheets)
- [.github/workflows](.github/workflows) — auto-deploy to GitHub Pages and Apps Script

---

## Deploying your own copy

The short version (full walkthrough in [EggTrack_Deployment_Guide.md](EggTrack_Deployment_Guide.md)):

1. Create a Google Sheet, open **Extensions → Apps Script**, paste in [Code.gs](Code.gs), and run `setupSpreadsheet` once.
2. **Deploy → New deployment → Web app**, set "Execute as: Me" and "Who has access: Anyone". Copy the resulting `/exec` URL.
3. Either:
   - Paste the URL into `eggtrack.html` (replace `YOUR_APPS_SCRIPT_URL_HERE` near line 536), and host the file anywhere, or
   - Fork this repo, add the URL as a GitHub Actions secret named `SCRIPT_URL`, and push to `main` — the workflow injects it on deploy.
4. Open the app, tap **Admin**, log in with the default PIN `1234`, and immediately change it from the Inventory tab.

---

## Notes

- The PIN can be reset by deleting the `adminPinHash` row in Apps Script → Project Settings → Script Properties. The default `1234` will work again.
- "Anyone with the URL can read" is intentional — customers need to see stock and prices. Only admin writes require the PIN.
- The Firestore design in `EggTrack_Design.md` is kept for reference but does not match the running code. Treat `Code.gs` + the Sheet as the source of truth for backend behaviour.
