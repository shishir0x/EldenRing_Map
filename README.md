# Elden Ring Interactive Map & Progress Tracker (Self-Hosted)

A lightweight, high-performance, and self-hosted alternative to MapGenie for **Elden Ring** and **Shadow of the Erdtree (DLC)**.

Zero paywalls, no tracking limits, no ads, and unlimited character save slots.

![Elden Ring Map Preview](public/preview_placeholder.jpg)

---

## ✨ Features

- **7,550 Total Verified Locations**:
  - **The Lands Between**: 5,681 pins (Surface + Underground)
  - **Realm of Shadow (DLC)**: 1,869 pins
- **Unlimited Progress Tracking**: Check off every Site of Grace, Boss, Talisman, Weapon, and Golden Seed with zero item caps.
- **Multiple Character Save Slots**: Maintain separate playthroughs/builds (e.g. *Strength/Faith*, *Dex/Bleed*, *NG+*) and switch instantly.
- **Smart Tile Proxy & Offline Disk Cache**: High-resolution zoomable tiles with automatic local caching in `storage/tiles_cache/` so it runs smoothly offline.
- **Option B — DevTools Payload Ingestion**: Built-in UI to paste raw JSON responses directly from your browser's Network tab (`F12 -> Network -> /maps/:id/data`).
- **Comprehensive Filtering**: Filter by category (Bosses, Equipment, Graces, NPCs, Key Items), Region, and Found/Unfound status.
- **Instant Search**: Real-time fuzzy search across titles and item descriptions.
- **Backup & Restore**: One-click JSON export/import of all your save slots and marked progress.

---

## 🚀 Quick Start

### Option 1: Run with Node.js

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Sync/update latest locations from MapGenie
npm run sync

# 3. Start the server
npm start
```

Open your browser at **`http://localhost:3000`**.

---

### Option 2: Run with Docker Compose

```bash
docker compose up -d
```

Your map will be running at **`http://localhost:3000`** with persistent save files in `./storage` and map databases in `./data`.

---

## 📥 Using "Option B" (DevTools JSON Ingestion)

If you wish to update or customize map data directly from browser payloads:
1. Open MapGenie in your browser (e.g. `https://mapgenie.io/elden-ring/maps/the-lands-between`).
2. Press `F12` to open Developer Tools and select the **Network** tab.
3. Filter by **Fetch/XHR** and refresh the page.
4. Locate the request to `/api/v1/maps/413/data` or `/api/v1/games/111/full`.
5. Right-click the request &rarr; **Copy** &rarr; **Copy response**.
6. On your self-hosted map, click the **"📥 Option B"** button in the top header.
7. Paste the JSON into the box and click **"Ingest & Save to Database"**.

---

## 🛠 Project Structure

```
├── data/                       # Offline JSON databases (7,550 locations & categories)
├── storage/                    # Persistent character saves & cached map tiles
│   ├── profiles.json           # Character save slots
│   └── tiles_cache/            # Locally cached slippy tiles
├── public/                     # Frontend client (Vanilla JS, CSS, Leaflet)
├── scripts/                    # Ingestion & icon download scripts
├── server.js                   # Express backend & tile proxy
├── Dockerfile                  # Container definition
└── docker-compose.yml          # 1-command Docker deployment
```
