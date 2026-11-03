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

When running locally, the first start loads a small sample catalog so you can try it right away (`SEED_DEMO=0` to start empty). Hosted databases never get sample items unless you set `SEED_DEMO=1`.

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Local database folder (`shop.db`, photos included). **Back this folder up.** |
| `cc_TURSO_DATABASE_URL` / `cc_TURSO_AUTH_TOKEN` | — | Hosted Turso database instead of the local file (required on Vercel). Unprefixed `TURSO_*` names also work. |
| `SHOP_TZ_OFFSET_MINUTES` | `330` | Shop's timezone offset from UTC, used for "today" on the dashboard (330 = India) |
| `ADMIN_PASSWORD` | `admin123` | Initial admin password (first run only) |
| `SEED_DEMO` | on locally, off when hosted | `1` to add the sample catalog to an empty database, `0` to never add it |

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

## Online stock and offline store stock

Every item has two stock counts:

- **Online**: what customers can buy on the website. Online bills reduce it automatically, and cancelling a bill puts it back.
- **Store**: stock at your offline shop. Customers never see this number.

The Inventory tab shows Online, Store and **Total** for every item, plus overall totals and value. Type into **+ Online** or **+ Store** to add stock, or a negative number to reduce it (e.g. `-5` when 5 boxes sell at the counter). Open **Edit** to move stock between the two (*Online → Store* or *Store → Online*); the total stays the same. **Export** downloads the inventory as a spreadsheet (CSV).

## Keeping your data safe

- Updates never delete or rewrite your data. Database changes only ever *add* new tables or columns.
- On a hosted database, sample items are **never** added unless you set `SEED_DEMO=1`. If you ever see the sample items (Baby Rocket, Pencil Crackers…) on your live site, the app is connected to a different, empty database. Your data has not been changed. Check the database settings in Vercel.
- **Settings → Your data & backups** shows which database the app is connected to and how many items, bills and photos it holds. Check it after every deployment.
- **Automatic snapshots** of all your data are saved in the database: before every app upgrade (kept forever), before any delete or bulk rate change, and once a day when the admin panel is opened (the last 60 are kept). Download any of them from Settings.
- **Download full backup** saves everything (items, stock, photos, offers, bills, settings) as one file on your device. Take one before big changes, and keep a copy outside the app now and then.

### Selling store stock online

With **Settings → Stock → Online shop can also sell offline-store stock** switched on (the default), customers see Online + Store as available. An online bill takes from Online stock first, then from Store stock, and remembers which, so cancelling puts each unit back where it came from. Switch it off to sell only Online stock on the website.

## Home delivery

At checkout customers choose **Pickup at store** or **Home delivery**. For delivery they must give their name, a 10-digit mobile number and their address (landmark and pincode are optional). The phone remembers these for next time. Settings → **Home delivery** lets you switch it on or off, set a delivery charge, make delivery free above an order value, and show a note (e.g. "We deliver within 5 km"). Delivery bills show a 🚚 tag in **Bills**, with the address, a call link and an *Open in Maps* link. The CSV export includes the address.

## Payments: UPI or cash

At checkout customers choose **UPI** or **Cash** (at the counter for pickup, on delivery for home delivery). Switch cash off in Settings → Payment.

The bill shows the UPI QR (works with any UPI app) plus buttons for **Google Pay, PhonePe, Paytm** and *Other UPI app*, so payment opens the app the customer actually uses instead of the phone's default (often WhatsApp). Cash bills show the amount to pay in cash, with UPI as a fallback.

In **Bills**, mark a bill paid with **UPI ✓** or **Cash ✓**; the bill view has *Paid by UPI* / *Paid in cash*. The dashboard splits today's takings into UPI and cash, and the CSV export has a *Paid by* column.

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
3. Optional but recommended: add `ADMIN_PASSWORD` under **Settings → Environment Variables** so the admin password isn't `admin123` from the start.
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
