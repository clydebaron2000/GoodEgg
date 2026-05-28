# Apps Script Auto-Sync Setup

One-time setup to make `git push` automatically deploy `Code.gs` to your Apps Script project (and update the existing `/exec` deployment so the URL stays the same).

The GitHub Actions workflow that does this lives at [.github/workflows/sync-appscript.yml](.github/workflows/sync-appscript.yml). It triggers on any push to `main` that touches `Code.gs`, `appsscript.json`, or the workflow itself, and can also be run manually from the Actions tab.

---

## What you'll need

- Node.js installed locally
- [clasp](https://github.com/google/clasp), Google's Apps Script CLI
- Your existing Apps Script project's **Script ID** and **Deployment ID**

---

## Step 1 — Enable the Apps Script API

Open https://script.google.com/home/usersettings and toggle **Google Apps Script API** to **On**. Without this, `clasp` can't talk to your project.

---

## Step 2 — Install clasp and log in

```bash
npm install -g @google/clasp
clasp login
```

This opens a browser, asks you to approve, and writes credentials to `~/.clasprc.json` (your home directory — **not** the repo).

---

## Step 3 — Clone the project to get the manifest and IDs

In a folder *inside this repo's `tmp/`* (which is already gitignored), run:

```bash
mkdir -p tmp && cd tmp
clasp clone <YOUR_SCRIPT_ID>
```

The **Script ID** is in the Apps Script editor URL:

```
https://script.google.com/d/1TiMw-wMjpjVsPIT2nx5XSSEDd9IQxx03VTHvfSCGj99T5y9QOibqo2VF/edit
                            └────────────────────── this part ──────────────────────────┘
```

After cloning, `tmp/` will contain:
- `.clasp.json` — script ID + clasp project settings
- `appsscript.json` — the Apps Script manifest (also already committed at the repo root, see below)
- `Code.js` — a local mirror of your `Code.gs` (you can ignore this; we push from the repo root)

> The repo's `.gitignore` keeps `tmp/`, `.clasp.json`, and `.clasprc.json` out of git. Don't commit them.

---

## Step 4 — Add three repo secrets

Go to https://github.com/clydebaron2000/GoodEgg/settings/secrets/actions and add each as a **New repository secret**:

| Secret name | Value | Where to find it |
|---|---|---|
| `CLASPRC_JSON` | Full contents of `~/.clasprc.json` | macOS: `pbcopy < ~/.clasprc.json`, then paste |
| `CLASP_JSON` | Full contents of `tmp/.clasp.json` | macOS: `pbcopy < tmp/.clasp.json`, then paste |
| `DEPLOYMENT_ID` | The deployment ID of your existing web app | Apps Script → **Deploy → Manage deployments** → copy the long ID shown under your active deployment (looks like `AKfycb…`) |

The `DEPLOYMENT_ID` is what keeps your `/exec` URL stable. Without it, every sync would create a new deployment with a new URL, and you'd have to re-update the `SCRIPT_URL` secret used by the Pages workflow.

---

## Step 5 — Trigger the sync

Either:

- **Push a change to `Code.gs`** — the workflow runs automatically.
- **Run it manually** — Actions tab → **Sync Code.gs to Apps Script** → **Run workflow**.

On a successful run you should see two steps complete:

- `Push Code.gs to Apps Script` — uploads the local file
- `Update existing deployment` — bumps the deployment to a new version

Open the live app and check the `?action=getState` endpoint, or just admin-login on https://clydebaron2000.github.io/GoodEgg/ — your changes should be live.

---

## What gets pushed

The repo has a `.claspignore` that limits clasp to two files:

- `Code.gs` — the backend
- `appsscript.json` — the manifest

This is important — without it, clasp would also try to push `index.html` and any other matching files into your Apps Script project, which is not what we want (the HTML is the static PWA served by GitHub Pages, not an Apps Script HTML template).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Workflow fails with `Missing required secret(s):` | One of the three secrets isn't set on the repo. Check the spelling — they're case-sensitive. |
| Workflow fails at `clasp push` with auth errors | OAuth token in `CLASPRC_JSON` was invalidated (long inactivity, password change, etc.). Re-run `clasp login` locally and update the `CLASPRC_JSON` secret. |
| Push succeeds but the live app behaves like the old code | The deployment wasn't updated. Check `DEPLOYMENT_ID` matches the deployment whose `/exec` URL you're using. Run **Deploy → Manage deployments** in Apps Script to compare. |
| `index.html` shows up in your Apps Script project | `.claspignore` is missing or wrong. Restore it to: `**/**` then `!Code.gs` then `!appsscript.json`. |
| Workflow fails: `appsscript.json is missing` | Make sure `appsscript.json` is committed at the repo root (not just inside `tmp/`). |
