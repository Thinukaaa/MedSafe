# MedSafe — Sell it before it expires.

**Zero waste, zero risk.** MedSafe is an expiry and cold-chain tracker for small Sri Lankan pharmacies.
Staff scan a box, MedSafe tells them what to **sell first**, what to **return to the supplier** and by when,
what must **come off the shelf now**, and whether the **insulin fridge** stayed at 2–8 °C — all in rupees, with the formula one tap away.

**Stack:** plain HTML/CSS/JS (no frameworks, no CDNs) · Google Apps Script + Google Sheet · ESP32 (Arduino).
Libraries are vendored in `public/vendor/` (html5-qrcode 2.3.8 / ZXing, Apache-2.0 · bwip-js 4.5.1, MIT).

---

## Features

| Area | What it does |
|---|---|
| Start + sign-in | Shop ID + 4–6 digit PIN, **owner** / **staff** roles (staff cannot delete batches, change settings or edit the business case — the server checks too). **Try demo pharmacy** runs locally with a DEMO banner. |
| Dashboard | One-sentence headline, 4 KPI tiles (Expired / Critical / Warning / Total, Rs + batches + units), Sell-first list, Supplier returns, Money saved, Cold-chain card. |
| Scan | Laptop webcam, Android, iPhone (back camera, torch, beep + vibrate) and USB scanners on any screen. EAN-13, EAN-8, Code128, QR, DataMatrix. |
| Scan router | **EAN-13** → catalogue product → add batch · **MedSafe label QR** `MS1|batch|ean|YYYY-MM|qty|supplier|shelf` → new: one-tap *Add to stock*, existing: Sold / Returned / Disposed with a qty stepper · **GS1 DataMatrix / GS1-128** (AI 01, 17, 10, 21, FNC1/GS) → pre-filled form. |
| Catalogue | 52 medicines with **real NMRA maximum retail prices** (Gazette 2336/53, 15 Jun 2023). DEMO in-store EAN-13 codes in the GS1 RCN range 200–299. |
| Supplier returns | Return by = expiry − return window (ASSUMPTION 60 days), grouped by supplier, **Copy for WhatsApp**. |
| Entry checks | Duplicate batch, expiry already passed, cost Rs 0 → confirm; negative qty → blocked. |
| Business case | Monthly loss, share prevented (or measured recovery rate), package price, support — each with a source. Yearly saving, payback months, 3-year net benefit. |
| Cold chain | ESP32 + DS18B20 every 60 s. Current °C, Safe / Too warm / Too cold, 24 h min/max, minutes out of range, 24 h SVG chart, *Device offline* after 10 min. |
| Morning digest | 08:00 Sri Lanka email: counts + Rs per status, top 10 sell-first, returns due this week, yesterday's fridge excursions. |
| Sources & assumptions | Every data source and every ASSUMPTION with its current value. |
| Sync | *Update now*, auto-refresh every 60 s while the tab is visible, “Last synced HH:MM Sri Lanka time”. |
| Labels | `labels.html`: A4 sheet of 24 DEMO box labels (EAN-13 + MedSafe QR) to stick on empty boxes and scan live. |

---

## Folder structure

```
public/                  ← the website (GitHub Pages serves this folder)
  index.html  labels.html
  css/style.css
  js/  calc.js (every formula)  codes.js (EAN/GS1/MS1)  store.js  demo-data.js  scanner.js  cold.js  app.js  config.js
  data/catalogue.json    ← built from data/nmra_mrp_2023.csv
  vendor/                ← html5-qrcode, bwip-js (+ licences)
apps-script/Code.gs      ← backend (Google Sheet as database)
data/nmra_mrp_2023.csv   ← NMRA MRP gazette extract
scripts/build-catalogue.js
hardware/                ← ESP32 sketch, Wokwi files, WIRING.md
tests/                   ← npm test
docs/field-visit-checklist.md
```

---

## Run locally

Needs Node.js 18+.

```powershell
npm install
npm start          # → http://localhost:5500
npm test           # formula, parser and data tests
npm run build:data # rebuild public/data/catalogue.json from the CSV
```

Open http://localhost:5500 → **Try demo pharmacy** (or sign in with `DEMO` / `1234`; `DEMO-STAFF` / `1234` shows the staff view).
Then More → Settings → **Load demo pharmacy**. `http://localhost:5500/#demo` opens the demo directly.
The camera works on `localhost`; on a phone use the GitHub Pages (https) link.

## GitHub Pages

Push to `main`. `.github/workflows/pages.yml` runs the tests and deploys `./public`.
One-time: repo → **Settings → Pages → Source: GitHub Actions**.
URL: `https://<your-username>.github.io/<repo-name>/` (labels: `…/labels.html`).

---

## Backend setup (Google Sheet + Apps Script)

1. New Google Sheet → **Extensions → Apps Script**. Paste `apps-script/Code.gs`. Project Settings → show `appsscript.json` → paste ours (time zone Asia/Colombo).
2. Run **`setup`** once (creates Batches, Events, Users, Settings, Fridge tabs) and allow permissions.
3. Create the owner: run `setupOwner('SHOP1', 'Your name', '482913')` (edit the call in a scratch function or the editor's debugger). Staff: `addStaff('SHOP1', 'Kamala', '7351')`. PINs are stored as SHA-256(salt + PIN).
4. **Project Settings → Script Properties:**
   | Property | Value |
   |---|---|
   | `DEVICE_KEY` | a long random string you make up — also goes in the ESP32 sketch |
   | `DIGEST_EMAIL` | where the 08:00 digest goes |
5. Run `installDigestTrigger` once (daily ~08:00 Asia/Colombo). Test with `sendDailyDigest`.
6. **Deploy → New deployment → Web app** · Execute as **Me** · Who has access **Anyone** → copy the `/exec` URL.
7. In the app: **Sign in → Server** → paste the URL → Shop ID + PIN. (Or set it in `public/js/config.js`.)

API: `POST login` → token (12 h; CacheService, refreshed on use). Every other call sends the token, else `{error:'Unauthorized'}`.
Device: `POST {action:'temp', deviceKey, deviceId, tempC}` and `GET ?action=summary&deviceKey=…`.
After editing `Code.gs`: **Deploy → Manage deployments → Edit → New version** (same URL).

## Hardware

ESP32 + DS18B20 (GPIO 4, 4.7 kΩ pull-up) + SSD1306 OLED (SDA 21, SCL 22) + common-cathode RGB LED (25/26/27, 220 Ω).
Wiring diagram, parts list and the Wokwi simulator (no parts needed): **[hardware/WIRING.md](hardware/WIRING.md)**.

---

## 90-second panel demo

| Time | Do | Say |
|---|---|---|
| 0–10 s | Open the GitHub Pages link on the phone → start screen | “MedSafe — sell it before it expires. Zero waste, zero risk.” |
| 10–25 s | **Try demo pharmacy** → dashboard (demo loaded beforehand) | “In 10 seconds the owner sees: 6 expired batches still on the shelf, Rs X at risk this month. Every number has *How is this calculated?*” — open one. |
| 25–45 s | Tap **Scan** → scan a **NEW DELIVERY** label → **Add to stock** | “One scan, one tap. Real NMRA price; cost is MRP minus our 16 % margin — labelled ASSUMPTION.” |
| 45–60 s | Scan an **IN STOCK** label → **Sold**, stepper +2 → Save | “Selling near-expiry stock first is money recovered — it moves *Money saved*.” |
| 60–70 s | Dashboard → **Supplier returns** → **Copy for WhatsApp** | “Return-by dates per supplier, ready to send.” |
| 70–85 s | **Cold chain** (or the live ESP32: warm the probe in your hand → LED turns red) | “Insulin fridge, 2–8 °C WHO range. Yesterday's 20-minute excursion is caught and counted.” |
| 85–90 s | More → **Sources & assumptions** | “Every source and assumption in one table. Thank you.” |

Before the panel: print `labels.html`, load the demo pharmacy, set the phone brightness high, and keep the laptop's localhost as a backup.

---

## Hackathon rules — how MedSafe meets them

| Rule | Where |
|---|---|
| 1. No random numbers | Demo data uses fixed offset/qty lists and a fixed fridge pattern (`demo-data.js`); IDs use clock + counter. Tested for determinism. |
| 2. Every number shows its source | MRP → NMRA gazette; cost → invoice / box / ASSUMPTION margin; fridge → sensor or DEMO; business inputs each have a Source field. |
| 3. Every score shows its formula | “How is this calculated?” under every tile, list and chart — text lives in `calc.js` `FORMULAS`. |
| 4. Demo data labelled DEMO | DEMO banner, DEMO chips on rows, actions, fridge, labels (“DEMO LABEL – not a real product”), DEMO suppliers. |
| 5. Units + time on every reading | Rs, units, days, °C; “Last synced HH:MM Sri Lanka time”; reading times on the cold chain. |
| 6. Assumptions labelled | Windows, margin, return window, share prevented — ASSUMPTION chips + Sources & assumptions page. |
| 7. Main screen in 10 s | One-sentence headline + 4 colour tiles. |
| 8. Works live | Google Sheet backend, GitHub Pages over https, ESP32 posting every 60 s; DEMO mode works offline. |

## Known limits (say these to the panel)

- One Google Sheet = one pharmacy. Shop ID identifies users, not separate stock books.
- Data is only as good as what staff scan; a batch never entered is invisible.
- Month-only expiry is taken as the last day of that month.
- Cost price falls back to MRP × (1 − margin) — an ASSUMPTION until invoice prices are entered.
- Apps Script tokens live in CacheService (6 h max per entry, refreshed on use, hard limit 12 h).
- The ESP32 uses `setInsecure()` (no certificate check) for a simple demo setup.
- The demo EAN-13 codes are in-store (RCN) codes; real packs use the manufacturer's GTIN — scan those to add them once.
- 4–6 digit PINs: 5 wrong tries lock the shop for 10 minutes. Not bank-grade security.
