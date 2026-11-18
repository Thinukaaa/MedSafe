# MedSafe — Pharmacy Expiry Tracker

Small pharmacies lose money (and risk patient safety) when medicines expire on the shelf unnoticed.
MedSafe records each stock batch, shows what expires soon, tells staff what to **sell first (FEFO)**,
and measures the money **recovered vs lost** from the actions they take.

**Stack:** HTML · CSS · vanilla JS · Google Apps Script + Google Sheet (database)
**Modes:** `Live · Google Sheet` (when an API URL is set) or `Local mode` (saved in the browser, works offline)

---

## Folder structure

```
medsafe/
├─ public/                 ← the website (served as static files)
│  ├─ index.html
│  ├─ css/style.css
│  └─ js/
│     ├─ config.js         ← paste your Apps Script /exec URL here
│     ├─ calc.js           ← every formula used on screen
│     ├─ store.js          ← Local (browser) or Google Sheet data store
│     ├─ sample-data.js    ← clearly-labelled SAMPLE rows for testing
│     └─ app.js            ← UI logic
├─ apps-script/
│  ├─ Code.gs              ← backend (Sheet as database)
│  └─ appsscript.json
├─ tests/calc.test.js      ← formula checks (npm test)
├─ docs/field-visit-checklist.md
└─ package.json
```

---

## 1. Run it locally (any laptop)

Needs **Node.js 18+** (https://nodejs.org → LTS).

```powershell
cd MedSafe
npm install
npm start
```

Open **http://localhost:5500** in Chrome.

No Node? Use Python instead: `cd public` then `python -m http.server 5500`.

> The app works immediately in **Local mode**. To use the Google Sheet, do step 2.

Run the formula tests: `npm test`

---

## 2. Connect the Google Sheet (Apps Script backend)

1. Create a new Google Sheet named **MedSafe DB**.
2. **Extensions → Apps Script**. Replace `Code.gs` with `apps-script/Code.gs`.
   Project Settings → tick *Show appsscript.json* → replace it with `apps-script/appsscript.json`.
3. Select `setup` in the function dropdown → **Run** → allow permissions.
   (Creates the `Batches` and `Events` tabs.)
4. **Deploy → New deployment → Web app** · Execute as **Me** · Who has access **Anyone** → Deploy.
5. Copy the URL ending in `/exec`.
6. Paste it into `public/js/config.js` **or** in the app: **Settings → Google Sheet API URL → Save**.
   Press **Test connection**.

With clasp instead: `clasp clone <scriptId> --rootDir apps-script` then `clasp push`.

> After changing `Code.gs`, use **Deploy → Manage deployments → Edit → New version** so the same URL gets the update.

---

## 3. Push to GitHub

```powershell
cd MedSafe
git init
git add .
git commit -m "MedSafe: pharmacy expiry tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/medsafe.git
git push -u origin main
```

## 4. Presenting from another laptop

```powershell
git clone https://github.com/<your-username>/medsafe.git
cd MedSafe
npm install
npm start
```

Open http://localhost:5500 → **Settings** → paste the API URL → Save (settings are saved per browser).
If the venue Wi-Fi fails, clear the API URL → the app switches to **Local mode** (load sample data or re-enter a few real batches).

---

## Hackathon design rules — how the app meets them

| Rule | Where |
|---|---|
| No random numbers | All figures come from entered batches and the action log |
| Every number shows its source | Each batch stores *“Where did these numbers come from?”* (box label, invoice, pharmacist) |
| Every score explainable, formula shown | “How is this calculated?” under every tile and list (text lives in `calc.js`) |
| Sample data labelled | Purple **SAMPLE** badge on every sample row + headline |
| Units and time with every reading | Rs, units, days; “Data as of … (Sri Lanka time)” in the header |
| Assumptions labelled | 30/90-day windows marked **ASSUMPTION** in Settings |
| Main screen in ~10 s | One-sentence headline + 4 colour tiles |
| Works live | Google Sheet mode + Local fallback |

## Known limits (say these to the panel)

- Data is only as good as what staff enter; a missed batch is invisible.
- Expiry stored by month when the box shows only month/year (last day of month is used).
- Apps Script Web App is “Anyone with the link”; no login yet. Next step: Google sign-in for staff.
- No supplier integration; returns depend on each supplier's policy.
