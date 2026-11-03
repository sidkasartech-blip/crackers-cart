# Crackers Cart

A simple scan-and-shop web app for a crackers stall.

**Customers** scan the shop QR → pick crackers → checkout (offers apply automatically, coupons optional) → get a bill with a **UPI QR** to pay. The bill flips to **PAID** on their phone once the shop confirms.

**Admin** (`/admin`) manages everything: inventory and stock, rates, offers and coupons, categories, bills, shop settings, and a printable store QR poster.

## Run it

Requires **Node.js 22**. Locally it stores everything in a SQLite file; on Vercel it uses a hosted [Turso](https://turso.tech) database (also SQLite).

```bash
npm install
```

```bash
npm start
```

- Shop: http://localhost:3000
- Admin: http://localhost:3000/admin — default password `admin123` (change it in **Settings**, or start with `ADMIN_PASSWORD=yourpass npm start`)

The first start loads a small sample catalog and offers so you can try it right away. Set `SEED_DEMO=0` to start empty. Delete or edit the sample items from the admin panel when you add your own.

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Local database folder (`shop.db`, photos included). **Back this folder up.** |
| `cc_TURSO_DATABASE_URL` / `cc_TURSO_AUTH_TOKEN` | — | Hosted Turso database instead of the local file (required on Vercel). Unprefixed `TURSO_*` names also work. |
| `SHOP_TZ_OFFSET_MINUTES` | `330` | Shop's timezone offset from UTC, used for "today" on the dashboard (330 = India) |
| `ADMIN_PASSWORD` | `admin123` | Initial admin password (first run only) |
| `SEED_DEMO` | on | `0` to skip the sample catalog |

## First-time setup (5 minutes)

1. Open `/admin` and log in.
2. **Settings**: enter the shop name, phone, address and your **UPI ID** (e.g. `name@okaxis`) and payee name. Change the admin password.
3. **Categories**: add your categories (Sparklers, Rockets…).
4. **Inventory → Add item**: name, rate, stock, and a photo — tap **Take photo** on your phone to use the camera, pick one **From gallery**, or paste an image link from the web. Photos are shrunk on the phone before upload so it stays fast.
5. **Offers**: add discounts (see below).
6. **Store QR**: print the poster and stick it at the counter. If the app is behind a domain, put that URL in Settings → *Public shop URL* first.

## Day-to-day

- **Change a rate or add stock**: type straight into the Inventory list; it saves as you leave the box. **Change rates** raises or lowers every rate (or one category's) by a percentage.
- **Hide an item** without deleting it: untick *Visible*.
- **Payments**: when a customer shows the paid UPI screen, open **Bills** → *Mark paid*. Their bill page updates to PAID within a few seconds.
- **Cancel a bill**: its items go back into stock automatically.
- **Pause the shop**: untick *Taking orders* in Settings.
- **Export**: Bills → *Export CSV* for accounts.

## How discounts work

- An offer is **% off** or **₹ off**, on the **whole cart** or **one category**, with an optional **minimum order**, **maximum discount**, and **start/end time** (so festival offers switch themselves on and off).
- Offers **without a code** apply automatically and are shown as banners in the shop. Offers **with a code** are coupons the customer types at checkout.
- **Only the single best offer applies** to a bill, so the price is always easy to understand. The cart also nudges customers: *"Add ₹500 more for 10% off"*.
- Optional **tax %** is added after the discount, and totals are rounded to the nearest rupee.

## About UPI payments

The bill shows a standard `upi://pay` QR with the exact amount, which any UPI app (GPay, PhonePe, Paytm, BHIM…) can scan. On phones there's also a one-tap *Pay with UPI app* button. A plain UPI ID can't tell the app that money arrived, so a person confirms it by pressing **Mark paid**. Automatic confirmation would need a payment gateway (Razorpay, Cashfree, etc.), which can be added later.

Stock is reserved as soon as a bill is generated. If a customer walks away without paying, cancel the bill to put the items back.

## Deploy to Vercel

Vercel doesn't keep files between requests, so the app stores its data (including product photos) in a free hosted **Turso** database.

1. Go to [vercel.com/new](https://vercel.com/new) → import the `crackers-cart` GitHub repo → **Deploy**. Leave every build setting at its default; `vercel.json` handles them. The first deploy will show a "No database configured" error. That's expected.
2. In the Vercel project, open **Storage → Create Database → Turso** (from the Marketplace) and connect it to the project. This adds `cc_TURSO_DATABASE_URL` and `cc_TURSO_AUTH_TOKEN` (or the same names without the `cc_` prefix — both work).
   *Or* create a database at [turso.tech](https://turso.tech) yourself and add those two variables under **Settings → Environment Variables**.
3. Optional but recommended: add `ADMIN_PASSWORD` under **Settings → Environment Variables** so the admin password isn't `admin123` from the start. To start with an empty catalog, also add `SEED_DEMO` = `0`.
4. **Deployments → ⋯ → Redeploy**. Open `https://<your-app>.vercel.app/admin`, set your UPI ID, and print the **Store QR**.

Tables are created on the first request. To move from a local install to Turso, you can upload your local file with `turso db create shop --from-file data/shop.db`.

### Other hosts

Any server that runs Node works with no database setup (Render, Railway, a small VPS, or a laptop at the stall on the same Wi-Fi). Keep `DATA_DIR` on persistent storage and use HTTPS so the admin login is protected.

## Project layout

```
server.js           start-up for local/VPS
api/index.js        Vercel entry point (vercel.json routes /api and /img here)
src/boot.js         picks the database (local file or Turso) and builds the app
src/app.js          all HTTP routes (public + admin)
src/pricing.js      bill / discount calculation (pure, unit-tested)
src/db.js           schema, settings, and a small async DB wrapper
src/auth.js         admin password + sessions
src/seed.js         sample catalog
public/             shop, checkout, bill and admin pages (plain HTML/CSS/JS, no build step)
test/               npm test
```
