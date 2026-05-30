# The Good Egg — Deployment Guide

Estimated time: **30–40 minutes**. No coding required — just copy-paste steps.

---

## What you'll need
- A Google account (Gmail)
- The two files from this folder: `Code.gs` and `index.html`
- A place to host the HTML (covered in Part 3)

---

## Part 1 — Set up the Google Sheet

**Step 1.** Go to [sheets.google.com](https://sheets.google.com) and click **Blank spreadsheet**.

**Step 2.** Name it something memorable — click "Untitled spreadsheet" at the top and type **The Good Egg**.

**Step 3.** Open the Apps Script editor: click the menu **Extensions → Apps Script**.

> A new browser tab opens with a code editor. This is where your backend lives.

**Step 4.** Delete everything in the editor (select all with Ctrl+A / Cmd+A, then Delete).

**Step 5.** Open the `Code.gs` file from this folder in any text editor (Notepad, TextEdit, etc.). Select all the text, copy it, and paste it into the Apps Script editor.

**Step 6.** Click the **Save** button (floppy disk icon, or Ctrl+S / Cmd+S). Name the project **The Good Egg** when prompted.

---

## Part 2 — Run the one-time setup

**Step 7.** In the Apps Script editor, find the function dropdown at the top (it may say "myFunction" or "doGet"). Click it and select **setupSpreadsheet**.

**Step 8.** Click the **Run** button (▶ play icon).

> The first time you run it, Google will ask for permissions. Click **Review permissions → Choose your Google account → Allow**. This lets the script read and write to your spreadsheet.

**Step 9.** After it runs, you should see an alert popup saying **"The Good Egg setup complete! Default admin PIN is: 1234"**. Click OK.

**Step 10.** Go back to your spreadsheet tab and refresh the page. You should now see several new sheets at the bottom: **stock**, **prices**, **orders**, **sizes**, **admins**, **stock_events**, **price_events**, **activity**, and **config**. Each one has the correct column headers and starting data. (A **Dashboard** tab can be generated later by running `buildDashboard`.)

---

## Part 3 — Deploy the Apps Script as a web app

**Step 11.** Go back to the Apps Script editor tab.

**Step 12.** Click **Deploy → New deployment** (top right corner).

**Step 13.** Click the gear icon ⚙ next to "Select type" and choose **Web app**.

**Step 14.** Fill in the settings:
- **Description:** The Good Egg API
- **Execute as:** Me
- **Who has access:** Anyone

> "Anyone" means anyone with the URL can read your data (stock, prices). That's intentional — customers need to see stock. Admin writes are protected by your PIN.

**Step 15.** Click **Deploy**.

**Step 16.** Google will ask for permissions again — click **Authorize access**, choose your account, and click **Allow**.

**Step 17.** You'll see a screen with **Web app URL**. It looks like:
```
https://script.google.com/macros/s/AKfycb.../exec
```
**Copy this URL** — you'll need it in the next step. Keep this tab open.

---

## Part 4 — Connect the HTML app to your spreadsheet

**Step 18.** Open the `index.html` file in a text editor (Notepad on Windows, TextEdit on Mac — make sure TextEdit is in plain text mode: Format → Make Plain Text).

**Step 19.** Find this line in the `<script>` section (search the file for `SCRIPT_URL` — it's the `const SCRIPT_URL` near the top of the script):
```
const SCRIPT_URL = 'YOUR_APPS_SCRIPT_URL_HERE';
```

**Step 20.** Replace `YOUR_APPS_SCRIPT_URL_HERE` with the URL you copied in Step 17. Make sure to keep the single quotes around it. It should look like:
```
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
```

**Step 21.** Save the file (Ctrl+S / Cmd+S).

**Step 22.** Test it locally first — open `index.html` directly in Chrome or Safari by double-clicking it. The app should load, show your stock (all zeros), and the sync bar should disappear after a few seconds. If you see "Could not reach server", double-check the URL in Step 20.

---

## Part 5 — Host the app online

You need to put `index.html` somewhere online so others can open it on their phones. Two free options:

---

### Option A — GitHub Pages (recommended for non-technical users)

**Step 23.** Go to [github.com](https://github.com) and create a free account if you don't have one.

**Step 24.** Click **New repository** (the + icon, top right → New repository).

**Step 25.** Name it **eggtrack**, set it to **Public**, and click **Create repository**.

**Step 26.** On the next screen, click **uploading an existing file**.

**Step 27.** Drag your `index.html` file into the upload area. In the "Commit changes" section at the bottom, click **Commit changes**.

**Step 28.** Go to **Settings → Pages** (left sidebar).

**Step 29.** Under "Source", select **Deploy from a branch**. Set Branch to **main**, folder to **/ (root)**. Click **Save**.

**Step 30.** Wait about 2 minutes, then refresh. You'll see a green banner with your URL:
```
https://your-username.github.io/eggtrack/index.html
```
That's your live app URL. Share it with staff and customers.

---

### Option B — Fork this repo and let GitHub Actions deploy (how the live app ships)

This is how the maintained copy at `clydebaron2000.github.io/GoodEgg` deploys:
push to GitHub, and a workflow builds and publishes automatically — so you
don't have to paste the Apps Script URL into the file by hand.

**Step 23b.** Fork (or push your copy of) this repo to GitHub.

**Step 24b.** Add the Apps Script `/exec` URL from Step 17 as a repository
**secret** named `SCRIPT_URL` (Settings → Secrets and variables → Actions →
New repository secret). The deploy workflow injects it in place of
`YOUR_APPS_SCRIPT_URL_HERE` at build time, so you can leave the placeholder in
`index.html` (you can skip Part 4 if you go this route).

**Step 25b.** In **Settings → Pages**, set Source to **Deploy from a branch**,
branch **`gh-pages`**, folder **/ (root)**.

**Step 26b.** Push to `main`. The workflow at `.github/workflows/deploy.yml`
stages the site, injects `SCRIPT_URL`, stamps the build version, and publishes
to the `gh-pages` branch. Your live URL is
`https://<your-username>.github.io/<repo>/`.

> Bonus: pushing **any other branch** publishes a preview at
> `…/<repo>/preview/<branch>/`, so you can try changes before they hit the
> production root. A second workflow (`sync-appscript.yml`) can also auto-sync
> `Code.gs` to Apps Script on push — see `Apps_Script_Sync_Setup.md`.

---

## Part 6 — Install as a mobile app (PWA)

Once the app is live online, staff and customers can install it on their phone home screen like a real app:

**On iPhone (Safari):**
1. Open the app URL in Safari
2. Tap the Share button (box with arrow pointing up)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add**

**On Android (Chrome):**
1. Open the app URL in Chrome
2. Tap the three-dot menu (⋮)
3. Tap **Add to Home screen**
4. Tap **Add**

The app icon will appear on the home screen. It opens full-screen, like a native app.

---

## Part 7 — First login and PIN change

**Step 31.** Open your live app and tap **Admin**.

**Step 32.** Enter the default PIN: **1 2 3 4**

**Step 33.** Once logged in, go to the **Inventory** tab and scroll down to the **Security** card. Tap **Change admin PIN** and set a new PIN that only you know.

> Keep your PIN somewhere safe. There is no "forgot PIN" — if lost, open the spreadsheet's **admins** tab and edit (or delete) your row, then re-run `migrate()` in the Apps Script editor to re-seed a default admin with PIN 1234.

---

## Part 8 — Updating the app in the future

If you make changes to `index.html` and want to push them live:
- **Manual upload (Option A):** upload the new file to your repo (same steps as Part 5A). Changes go live within ~2 minutes.
- **GitHub Actions (Option B):** just `git push`. The deploy workflow rebuilds and republishes automatically.

If you make changes to `Code.gs`:
1. Paste the new code into the Apps Script editor
2. Save
3. Click **Deploy → Manage deployments**
4. Click the pencil icon next to your deployment
5. Change "Version" to **New version**
6. Click **Deploy**

> Important: you must create a new version — redeploying the same version won't pick up code changes.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not reach server" on load | Check that SCRIPT_URL is correct in the HTML. Make sure the deployment is set to "Anyone" access. |
| PIN works locally but not online | Clear browser cache and reload. The script URL must not have extra spaces. |
| Stock changes don't appear | Wait 30 seconds (the app polls every 30s). Or reload the page. |
| Orders tab is empty | Expected on first run — no orders yet. |
| "Exception: Timed out waiting for lock" in Apps Script logs | Two writes happened at exactly the same time. The next attempt will succeed — the app retries automatically. |
| Admin PIN forgotten | Open the spreadsheet's **admins** tab, edit or delete the relevant row, then run `migrate()` in the Apps Script editor to re-seed a default admin with PIN 1234. |
| Apps Script deployment shows old code | You need to create a **New version** (not redeploy the same version). See Part 8. |
