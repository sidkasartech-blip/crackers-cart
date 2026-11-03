# Crackers Cart

A simple scan-and-shop web app for a crackers stall.

**Customers** scan the shop QR → pick crackers → checkout (offers apply automatically, coupons optional) → get a bill with a **UPI QR** to pay. The bill flips to **PAID** on their phone once the shop confirms.

**Admin** (`/admin`) manages everything: inventory and stock, rates, offers and coupons, categories, bills, shop settings, and a printable store QR poster.

## Run it

Requires **Node.js 22.13+** (uses the built-in SQLite, so nothing to install besides two small packages).

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
| `DATA_DIR` | `./data` | Where the database (`shop.db`) and uploaded photos live. **Back this folder up.** |
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

## Hosting

Any small server or VPS that runs Node works (Render, Railway, a ₹300/month VPS, or a laptop at the stall on the same Wi-Fi). Use HTTPS in production so the admin cookie is protected, and keep `DATA_DIR` on persistent storage.

## Project layout

```
server.js           start-up
src/app.js          all HTTP routes (public + admin)
src/pricing.js      bill / discount calculation (pure, unit-tested)
src/db.js           SQLite schema and settings
src/auth.js         admin password + sessions
src/seed.js         sample catalog
public/             shop, checkout, bill and admin pages (plain HTML/CSS/JS, no build step)
test/               npm test
```
