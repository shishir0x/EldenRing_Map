const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://mapgenie.io/elden-ring/maps/the-lands-between'
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    console.log(`[Sync] Fetching: ${url}`);
    const req = https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const data = JSON.parse(raw);
          resolve(data);
        } catch (err) {
          reject(new Error(`JSON Parse Error: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(45000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

async function runSync() {
  try {
    console.log('=== Elden Ring Map Data Synchronizer ===');

    // 1. Fetch Game 111 Full Metadata
    const gameUrl = 'https://mapgenie.io/api/v1/games/111/full';
    const gameData = await fetchJson(gameUrl);
    const gameFile = path.join(DATA_DIR, 'game_111_full.json');
    fs.writeFileSync(gameFile, JSON.stringify(gameData, null, 2), 'utf-8');
    console.log(`[Sync] Saved game metadata -> ${gameFile} (Maps: ${gameData.maps?.length || 0})`);

    // 2. Fetch The Lands Between (Map 413)
    const map413Url = 'https://mapgenie.io/api/v1/maps/413/data';
    const map413Data = await fetchJson(map413Url);
    const map413File = path.join(DATA_DIR, 'map_413_the_lands_between.json');
    fs.writeFileSync(map413File, JSON.stringify(map413Data, null, 2), 'utf-8');
    console.log(`[Sync] Saved The Lands Between -> ${map413File} (${map413Data.locations?.length || 0} locations)`);

    // 3. Fetch Realm of Shadow DLC (Map 638)
    const map638Url = 'https://mapgenie.io/api/v1/maps/638/data';
    const map638Data = await fetchJson(map638Url);
    const map638File = path.join(DATA_DIR, 'map_638_realm_of_shadow.json');
    fs.writeFileSync(map638File, JSON.stringify(map638Data, null, 2), 'utf-8');
    console.log(`[Sync] Saved Realm of Shadow -> ${map638File} (${map638Data.locations?.length || 0} locations)`);

    console.log('=== Sync Complete! Total locations ready: ' + ((map413Data.locations?.length || 0) + (map638Data.locations?.length || 0)) + ' ===');
  } catch (error) {
    console.error('[Sync Error]', error);
    process.exit(1);
  }
}

if (require.main === module) {
  runSync();
}

module.exports = { runSync, fetchJson };
