# EggTrack — Detailed Technical Design

## 1. Overview

EggTrack is a mobile-first web app (single HTML file, PWA-installable) for a Philippine poultry farm. It tracks egg inventory by size, manages pricing, and handles customer orders. The backend is Firebase Firestore, hosted in the Singapore region (`asia-southeast1`) to minimize latency from the Philippines (~50–150ms).

**Users:**
- **Customers** — view stock, view prices, submit orders (no login required)
- **Admins** — all of the above + manage stock, confirm/close orders, edit prices, change PIN

---

## 2. Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Single HTML file (vanilla JS) | No build step; works as PWA; deployable anywhere |
| Database | Firebase Firestore | Singapore region; offline-first SDK; free tier sufficient; real-time listeners |
| Auth | PIN + SHA-256 hash (no Firebase Auth) | No accounts needed; simple for farm staff; hash verified server-side via Security Rules |
| Hosting | Firebase Hosting or GitHub Pages | Free; global CDN; HTTPS |

**Free tier limits** (Firebase Spark plan):
- 50,000 reads/day, 20,000 writes/day — ample for a small farm
- 1 GB storage
- 10 GB/month bandwidth

---

## 3. Firestore Data Model

All data lives in a single Firestore database in `asia-southeast1`.

### 3.1 `/config` (document)

```
{
  adminPinHash:  string,   // SHA-256 of the 4-digit PIN (hex string)
  eggsPerTray:   number,   // default: 30
  updatedAt:     timestamp
}
```

PIN is never stored in plain text. The client hashes the entered PIN with SHA-256 before any comparison or transmission. Security Rules compare the submitted hash against the stored hash.

### 3.2 `/stock` (document)

```
{
  small:   number,  // tray count
  medium:  number,
  large:   number,
  xl:      number,
  jumbo:   number,
  updatedAt: timestamp
}
```

All stock changes go through a **Firestore transaction** to prevent race conditions (e.g., two admins deducting at the same time).

### 3.3 `/prices` (document)

```
{
  small:   number,  // price per tray in PHP
  medium:  number,
  large:   number,
  xl:      number,
  jumbo:   number,
  updatedAt: timestamp
}
```

### 3.4 `/orders/{orderId}` (collection)

`orderId` is a UUID generated **on the client before the request is sent**. This makes order submission idempotent — if the network drops after the write succeeds but before the client receives the response, the user can retry and Firestore's `setDoc` will simply overwrite the same document with identical data.

```
{
  id:          string,    // same as document ID (UUID)
  name:        string,
  contact:     string,
  address:     string,
  size:        string,    // 'small' | 'medium' | 'large' | 'xl' | 'jumbo'
  trays:       number,
  notes:       string,
  status:      string,    // 'pending' | 'confirmed' | 'done'
  createdAt:   timestamp,
  updatedAt:   timestamp,
  clientId:    string     // device fingerprint (optional, for analytics)
}
```

### 3.5 `/activity/{autoId}` (collection)

Append-only log. Firestore auto-generates the document ID.

```
{
  action:    string,    // e.g. "+10 trays Large — Morning collection"
  actor:     string,    // 'admin' | 'customer'
  createdAt: timestamp
}
```

---

## 4. Security Model

### 4.1 PIN Handling

1. Admin enters 4-digit PIN in the app
2. App computes `SHA-256(pin)` in the browser using the Web Crypto API
3. For **read-only** security check (login): hash is compared against `/config.adminPinHash` fetched from Firestore
4. For **write operations**: the hash is included in every admin write request as a field (`_pinHash`)
5. Firestore Security Rules verify `_pinHash == /config.adminPinHash` before allowing the write
6. `_pinHash` is stripped or ignored after validation — it's not stored in the final document

### 4.2 Security Rules Summary

```
/config       — read: open, write: require valid pinHash
/stock        — read: open, write: require valid pinHash (+ transaction)
/prices       — read: open, write: require valid pinHash
/orders/{id}  — read: open (admin sees all), write:
                  create: open (customers submit)
                  update/delete: require valid pinHash
/activity     — read: open, write: open (append-only from client)
```

### 4.3 Why This Is Acceptable

- A 4-digit PIN has 10,000 possibilities. An attacker brute-forcing the endpoint would need 10,000 write requests. Firebase's built-in abuse detection and rate limiting makes this impractical.
- The worst-case breach is someone modifying stock counts. For a farm app, this is tolerable. If higher security is ever needed, migrate to Firebase Authentication with a proper login.
- Customers can only submit orders and read data — no PIN required, by design.

---

## 5. Deduplication Strategy

This is the core engineering challenge for unreliable Philippine mobile connections.

### 5.1 Order Submission (most critical)

```
User taps "Submit Order"
  → App generates UUID (e.g. "ord_a3f9b2c1") BEFORE sending
  → Button disabled, spinner shown
  → Firestore setDoc("/orders/ord_a3f9b2c1", orderData)
     ↓ network drop?
  → SDK queues write in IndexedDB, retries automatically
  → If user taps again → same UUID → same setDoc → no duplicate
  → On success: button re-enabled, form cleared, toast shown
```

Key: the UUID is generated once per form fill, not per tap. It resets only when the form is intentionally cleared after success.

### 5.2 Stock Changes (race conditions)

Stock add/deduct uses a **Firestore transaction**:

```
transaction:
  1. Read current /stock document
  2. Verify new value won't go negative
  3. Write updated value
  (Firestore retries automatically if another write happened between steps 1 and 3)
```

This prevents two admins deducting the same stock simultaneously.

### 5.3 Price and Config Updates

These are simple `setDoc` / `updateDoc` calls — last write wins. Acceptable because only one admin is expected to edit prices at a time.

### 5.4 UI-Level Protection

| Situation | Handling |
|---|---|
| Slow network on submit | Button disabled + spinner until response or timeout |
| Request times out | Toast: "Retrying…" — SDK retries automatically |
| Confirmed success but offline | Write queued in IndexedDB, applied on reconnect |
| Double-tap before disable kicks in | UUID prevents duplicate in Firestore |
| Admin deducts more than available | Transaction checks balance before writing, returns error |

---

## 6. Offline Behaviour

Firebase SDK's `enableIndexedDbPersistence()` is enabled on startup.

| Scenario | Behaviour |
|---|---|
| Phone goes offline mid-session | Reads serve from IndexedDB cache |
| Admin adds stock while offline | Write queued locally, synced on reconnect |
| Customer submits order while offline | Order queued, submitted on reconnect |
| Two devices diverge while offline | Firestore merges on reconnect (last-write-wins for scalars; transactions re-verify stock) |
| App opened cold offline | Last-cached data shown; stale indicator displayed |

**Trade-off:** An order submitted offline might be for a size that ran out while the customer was offline. Admin review catches this — the confirmation step before stock deduction handles it gracefully.

---

## 7. Operations Design

### 7.1 App Load

```
1. Initialize Firebase SDK (Singapore endpoint)
2. enableIndexedDbPersistence()
3. onSnapshot("/stock") → live inventory updates
4. onSnapshot("/prices") → live price updates
5. onSnapshot("/orders") → live order list (admin) or filtered (customer)
6. Fetch /config for PIN hash (cached by SDK)
7. Render UI with cached data immediately, update as snapshots arrive
```

`onSnapshot` means the app auto-updates in real time when another device makes a change — no manual refresh needed.

### 7.2 Admin Login

```
1. User enters PIN on PIN screen
2. SHA-256(PIN) computed in browser
3. Compare against /config.adminPinHash (already cached from step 6)
4. Match → enter admin mode (client-side state only)
5. All subsequent admin writes include the hash for server-side re-verification
```

### 7.3 Add Stock

```
1. Admin enters size + tray count + note
2. App generates activityId (UUID)
3. Firestore.runTransaction():
   a. Read /stock
   b. stock[size] += trays
   c. Write /stock with updatedAt
4. Firestore.addDoc("/activity", { action, pinHash }) (parallel)
5. Toast + clear form
```

### 7.4 Deduct Stock (sold)

Same as Add Stock but step 3b verifies `stock[size] - trays >= 0` before writing. Transaction aborts with error if insufficient.

### 7.5 Submit Order (customer)

```
1. Customer fills form
2. UUID generated on first field entry (not on submit tap)
3. On submit: validate fields client-side
4. Firestore.setDoc("/orders/{uuid}", orderData)
   (setDoc is idempotent — safe to retry)
5. Activity log entry written
6. Form cleared, UUID reset
```

### 7.6 Confirm / Complete Order (admin)

```
1. Admin taps Confirm or Mark Done
2. Firestore.updateDoc("/orders/{id}", { status, updatedAt, _pinHash })
3. Security Rules verify pinHash
4. Activity log entry written
```

### 7.7 Change PIN

```
1. Admin enters new 4-digit PIN
2. App computes SHA-256(newPin)
3. Firestore.updateDoc("/config", { adminPinHash: newHash, _pinHash: currentHash })
4. Rules verify _pinHash matches old hash before allowing update
5. Client updates in-memory hash
```

---

## 8. Real-Time Sync

`onSnapshot` listeners mean all connected devices see updates immediately:

- Admin adds stock on desktop → customer's phone stock count updates within ~1 second
- Customer submits order → admin's phone shows new pending order with no refresh
- Admin marks an order done → order disappears from pending list on all devices

This is a significant upgrade over the current localStorage-only approach where each device has its own isolated state.

---

## 9. Performance Expectations (Philippines)

| Operation | Expected latency |
|---|---|
| App load (cached) | < 200ms |
| App load (cold, online) | 800ms – 1.5s |
| Read (onSnapshot, cached) | < 50ms |
| Write (stock change) | 150–400ms |
| Order submit | 150–400ms |
| Offline read | < 20ms (IndexedDB) |

These are estimates for a stable 4G connection in the Philippines to Firebase Singapore. On 3G or congested networks, writes may take 1–2s — the spinner and button-disable handling covers this gracefully.

---

## 10. Deployment

**Option A — Firebase Hosting (recommended)**
- Single command: `firebase deploy`
- Free SSL, global CDN, custom domain support
- URL: `https://your-farm.web.app` or a custom domain like `eggs.yourfarm.com`

**Option B — GitHub Pages**
- Upload `eggtrack.html` as `index.html` to a public repo
- Free, no server needed
- Firebase SDK is loaded from CDN; Firestore calls work from any origin

---

## 11. Setup Steps (high-level)

1. Create a Firebase project at console.firebase.google.com
2. Enable Firestore, select `asia-southeast1` (Singapore) region
3. Paste Security Rules
4. Copy Firebase config (apiKey, projectId, etc.) into `eggtrack.html`
5. Run the one-time seed script to create `/config`, `/stock`, `/prices` documents with defaults
6. Deploy HTML file (Firebase Hosting or GitHub Pages)
7. Open on phone, install as PWA (Add to Home Screen)

Total setup time: ~30 minutes.

---

## 12. Future Considerations

| Feature | Approach |
|---|---|
| SMS confirmation on order | Integrate Semaphore or Vonage (Philippine SMS) via a simple Cloud Function |
| Multiple farms / locations | Add `/farm/{farmId}/` namespace to all collections |
| Sales reports | Query `/orders` by date range + `/activity` log; export to CSV |
| Stronger auth | Migrate to Firebase Authentication (email/password or phone OTP) |
| Push notifications | Firebase Cloud Messaging (FCM) — notify admin of new orders |
