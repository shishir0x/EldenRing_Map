const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const CACHE_MAX_SIZE_MB = parseInt(process.env.CACHE_MAX_SIZE_MB || '500', 10);

// --- SECURITY HEADERS (HELMET) ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://tiles.mapgenie.io',
          'https://media.mapgenie.io',
          'https://eldenring.wiki.fextralife.com'
        ],
        connectSrc: ["'self'", 'https://unpkg.com'],
        workerSrc: ["'self'", 'blob:'],
        childSrc: ["'self'", 'blob:']
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

// --- CORS & COMPRESSION ---
app.use(cors());
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- RATE LIMITERS ---
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const writeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many updates, please slow down.' }
});

const importLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many import requests, please try again later.' }
});

app.use('/api/', generalLimiter);

// --- DIRECTORIES & STORAGE ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const TILES_CACHE_DIR = path.join(STORAGE_DIR, 'tiles_cache');
const PROFILES_FILE = path.join(STORAGE_DIR, 'profiles.json');

[DATA_DIR, STORAGE_DIR, TILES_CACHE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- ATOMIC ASYNC PROFILE WRITE QUEUE ---
let inMemoryProfiles = null;
let writeDebounceTimer = null;
let isWritingToFile = false;
let pendingWriteRequested = false;

function initProfiles() {
  if (fs.existsSync(PROFILES_FILE)) {
    try {
      inMemoryProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
    } catch (e) {
      console.error('Error reading profiles file, initializing fallback:', e.message);
    }
  }

  if (!inMemoryProfiles || !Array.isArray(inMemoryProfiles.profiles) || inMemoryProfiles.profiles.length === 0) {
    inMemoryProfiles = {
      activeProfileId: 'slot_1',
      profiles: [
        {
          id: 'slot_1',
          name: 'Tarnished (Slot 1)',
          createdAt: new Date().toISOString(),
          completedLocationIds: [],
          customMarkers: []
        }
      ]
    };
    try {
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(inMemoryProfiles, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to initialize profiles file on disk:', err.message);
    }
  }
}
initProfiles();

function getProfilesData() {
  return inMemoryProfiles;
}

async function flushProfilesToDisk() {
  if (isWritingToFile) {
    pendingWriteRequested = true;
    return;
  }
  isWritingToFile = true;
  pendingWriteRequested = false;

  const tmpFile = `${PROFILES_FILE}.${Date.now()}.tmp`;
  try {
    const payload = JSON.stringify(inMemoryProfiles, null, 2);
    await fs.promises.writeFile(tmpFile, payload, 'utf-8');
    await fs.promises.rename(tmpFile, PROFILES_FILE);
  } catch (err) {
    console.error('Failed atomic profiles write:', err.message);
    try {
      if (fs.existsSync(tmpFile)) await fs.promises.unlink(tmpFile);
    } catch (_) {}
  } finally {
    isWritingToFile = false;
    if (pendingWriteRequested) {
      flushProfilesToDisk();
    }
  }
}

function queueSaveProfilesData(data) {
  if (data) inMemoryProfiles = data;
  if (writeDebounceTimer) clearTimeout(writeDebounceTimer);
  writeDebounceTimer = setTimeout(() => {
    flushProfilesToDisk();
  }, 200);
}

// --- DATASET CACHE ---
let gameMetadata = null;
const mapDataCache = {};

function loadData() {
  try {
    const gameFile = path.join(DATA_DIR, 'game_111_full.json');
    if (fs.existsSync(gameFile)) {
      gameMetadata = JSON.parse(fs.readFileSync(gameFile, 'utf-8'));
    }
    const map413File = path.join(DATA_DIR, 'map_413_the_lands_between.json');
    if (fs.existsSync(map413File)) {
      mapDataCache[413] = JSON.parse(fs.readFileSync(map413File, 'utf-8'));
    }
    const map638File = path.join(DATA_DIR, 'map_638_realm_of_shadow.json');
    if (fs.existsSync(map638File)) {
      mapDataCache[638] = JSON.parse(fs.readFileSync(map638File, 'utf-8'));
    }
    console.log(`[Data] Loaded metadata: ${!!gameMetadata}, Maps cached: [${Object.keys(mapDataCache).join(', ')}]`);
  } catch (err) {
    console.error('Error loading map data from disk:', err.message);
  }
}
loadData();

// --- TILE CACHE LRU PRUNING ---
async function pruneTileCache() {
  const maxBytes = CACHE_MAX_SIZE_MB * 1024 * 1024;
  try {
    const fileEntries = [];
    let totalBytes = 0;

    async function walk(dir) {
      if (!fs.existsSync(dir)) return;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jpg')) {
          const stats = await fs.promises.stat(fullPath);
          totalBytes += stats.size;
          fileEntries.push({
            path: fullPath,
            size: stats.size,
            atime: Math.max(stats.atimeMs, stats.mtimeMs)
          });
        }
      }
    }

    await walk(TILES_CACHE_DIR);

    if (totalBytes > maxBytes) {
      console.log(`[Tile Cache] Exceeds ${CACHE_MAX_SIZE_MB}MB (${(totalBytes / 1024 / 1024).toFixed(1)}MB). Pruning oldest...`);
      fileEntries.sort((a, b) => a.atime - b.atime);

      const targetBytes = maxBytes * 0.8; // Prune down to 80%
      let removedBytes = 0;
      for (const file of fileEntries) {
        if (totalBytes - removedBytes <= targetBytes) break;
        try {
          await fs.promises.unlink(file.path);
          removedBytes += file.size;
        } catch (_) {}
      }
      console.log(`[Tile Cache] Pruning finished. Freed ${(removedBytes / 1024 / 1024).toFixed(1)}MB.`);
    }
  } catch (err) {
    console.error('[Tile Cache] Error during LRU pruning:', err.message);
  }
}

// Prune on launch and every 30 minutes
setTimeout(pruneTileCache, 5000);
setInterval(pruneTileCache, 30 * 60 * 1000);

// --- TILE PROXY WITH LOCAL DISK CACHE ---
const TILE_MAP_PATTERNS = {
  'the-lands-between': 'elden-ring/the-lands-between/default-v5',
  'the-shadow-realm': 'elden-ring/the-shadow-lands/asdnlkkveao-v1'
};
const VALID_MAP_SLUGS = new Set(Object.keys(TILE_MAP_PATTERNS));

app.get('/api/tiles/:mapSlug/:z/:x/:y.jpg', (req, res) => {
  const { mapSlug, z, x, y } = req.params;

  // Strict integer and slug validation to prevent path traversal & SSRF
  if (!VALID_MAP_SLUGS.has(mapSlug)) {
    return res.status(400).json({ error: 'Invalid map slug' });
  }

  const intPattern = /^\d+$/;
  if (!intPattern.test(z) || !intPattern.test(x) || !intPattern.test(y)) {
    return res.status(400).json({ error: 'Coordinates z, x, and y must be positive integers' });
  }

  const zInt = parseInt(z, 10);
  if (zInt < 0 || zInt > 18) {
    return res.status(400).json({ error: 'Zoom level out of range' });
  }

  const tilePathInCdn = TILE_MAP_PATTERNS[mapSlug];
  const localDir = path.join(TILES_CACHE_DIR, mapSlug, z, x);
  const localFilePath = path.join(localDir, `${y}.jpg`);

  if (fs.existsSync(localFilePath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return fs.createReadStream(localFilePath).pipe(res);
  }

  const cdnUrl = `https://tiles.mapgenie.io/games/${tilePathInCdn}/${z}/${x}/${y}.jpg`;
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Referer': 'https://mapgenie.io/',
      'Origin': 'https://mapgenie.io'
    }
  };

  https.get(cdnUrl, options, (cdnRes) => {
    if (cdnRes.statusCode !== 200) {
      return res.status(cdnRes.statusCode).end();
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    fs.mkdirSync(localDir, { recursive: true });
    const writeStream = fs.createWriteStream(localFilePath);
    cdnRes.pipe(writeStream);
    cdnRes.pipe(res);
  }).on('error', (err) => {
    console.error(`Tile fetch error for ${cdnUrl}:`, err.message);
    res.status(502).end();
  });
});

// --- MAP & LOCATION DATA ENDPOINTS ---
app.get('/api/maps', (req, res) => {
  if (!gameMetadata || !gameMetadata.maps) {
    return res.status(503).json({ error: 'Data not loaded yet. Run sync script first.' });
  }
  const summary = gameMetadata.maps.map(m => ({
    id: m.id,
    title: m.title,
    slug: m.slug,
    locations_count: m.locations_count,
    initial_zoom: m.initial_zoom || 13,
    start_lat: m.initial_latitude || (m.config && m.config.start_lat) || 0.6567,
    start_lng: m.initial_longitude || (m.config && m.config.start_lng) || -0.7623
  }));
  res.json({ maps: summary, activeMapId: 413 });
});

app.get('/api/maps/:id/data', (req, res) => {
  const mapId = parseInt(req.params.id, 10);
  const data = mapDataCache[mapId];
  if (!data) {
    return res.status(404).json({ error: `Map data for ID ${mapId} not found.` });
  }

  let groups = [];
  let categories = [];
  let mapConfig = data.mapConfig;
  if (gameMetadata && gameMetadata.maps) {
    const metaMap = gameMetadata.maps.find(m => m.id === mapId);
    if (metaMap) {
      if (!mapConfig && metaMap.config) {
        mapConfig = metaMap.config;
      }
      if (metaMap.groups) {
        groups = metaMap.groups;
        metaMap.groups.forEach(g => {
          if (g.categories) {
            categories.push(...g.categories);
          }
        });
      }
    }
  }

  if (!mapConfig) {
    mapConfig = {
      start_lat: mapId === 638 ? 0.668514 : 0.656762,
      start_lng: mapId === 638 ? -0.723131 : -0.762348,
      initial_zoom: 13,
      bounds: [-1.4, 0, 0, 1.4]
    };
  }

  res.json({
    map: data.map,
    mapConfig,
    regions: data.regions || [],
    groups,
    categories,
    locations: data.locations || []
  });
});

// --- SAVE PROFILES & TRACKING ---
app.get('/api/profiles', (req, res) => {
  res.json(getProfilesData());
});

app.post('/api/profiles', writeLimiter, (req, res) => {
  const { name } = req.body;
  const store = getProfilesData();
  const newId = 'slot_' + Date.now();
  const newProfile = {
    id: newId,
    name: (name && typeof name === 'string') ? name.trim().slice(0, 50) : `Character ${store.profiles.length + 1}`,
    createdAt: new Date().toISOString(),
    completedLocationIds: [],
    customMarkers: []
  };
  store.profiles.push(newProfile);
  store.activeProfileId = newId;
  queueSaveProfilesData(store);
  res.status(201).json(store);
});

app.post('/api/profiles/active', writeLimiter, (req, res) => {
  const { id } = req.body;
  const store = getProfilesData();
  if (!store.profiles.find(p => p.id === id)) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  store.activeProfileId = id;
  queueSaveProfilesData(store);
  res.json(store);
});

app.put('/api/profiles/:id', writeLimiter, (req, res) => {
  const { name } = req.body;
  const store = getProfilesData();
  const profile = store.profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (name && typeof name === 'string') {
    profile.name = name.trim().slice(0, 50);
  }
  queueSaveProfilesData(store);
  res.json(store);
});

app.delete('/api/profiles/:id', writeLimiter, (req, res) => {
  const store = getProfilesData();
  if (store.profiles.length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the only profile' });
  }
  store.profiles = store.profiles.filter(p => p.id !== req.params.id);
  if (store.activeProfileId === req.params.id) {
    store.activeProfileId = store.profiles[0].id;
  }
  queueSaveProfilesData(store);
  res.json(store);
});

app.post('/api/profiles/:id/toggle', writeLimiter, (req, res) => {
  const locationId = parseInt(req.body.locationId, 10);
  if (isNaN(locationId)) {
    return res.status(400).json({ error: 'locationId must be a valid integer' });
  }
  const store = getProfilesData();
  const profile = store.profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const idx = profile.completedLocationIds.indexOf(locationId);
  let completed = false;
  if (idx > -1) {
    profile.completedLocationIds.splice(idx, 1);
    completed = false;
  } else {
    profile.completedLocationIds.push(locationId);
    completed = true;
  }
  queueSaveProfilesData(store);
  res.json({
    completed,
    locationId,
    totalCompleted: profile.completedLocationIds.length
  });
});

app.post('/api/profiles/:id/batch', writeLimiter, (req, res) => {
  const { locationIds, markAsCompleted } = req.body;
  if (!Array.isArray(locationIds)) {
    return res.status(400).json({ error: 'locationIds must be an array' });
  }
  const store = getProfilesData();
  const profile = store.profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const set = new Set(profile.completedLocationIds);
  if (markAsCompleted) {
    locationIds.forEach(id => {
      const num = parseInt(id, 10);
      if (!isNaN(num)) set.add(num);
    });
  } else {
    locationIds.forEach(id => {
      const num = parseInt(id, 10);
      if (!isNaN(num)) set.delete(num);
    });
  }
  profile.completedLocationIds = Array.from(set);
  queueSaveProfilesData(store);
  res.json({
    totalCompleted: profile.completedLocationIds.length,
    completedLocationIds: profile.completedLocationIds
  });
});

app.post('/api/profiles/:id/reset', writeLimiter, (req, res) => {
  const store = getProfilesData();
  const profile = store.profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  profile.completedLocationIds = [];
  queueSaveProfilesData(store);
  res.json({ totalCompleted: 0, completedLocationIds: [] });
});

// Custom markers
app.post('/api/profiles/:id/custom-markers', writeLimiter, (req, res) => {
  const { title, description, latitude, longitude, mapId } = req.body;
  const store = getProfilesData();
  const profile = store.profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'Valid latitude and longitude required' });
  }

  const marker = {
    id: 'custom_' + Date.now(),
    title: (title && typeof title === 'string') ? title.trim().slice(0, 100) : 'Custom Pin',
    description: (description && typeof description === 'string') ? description.trim().slice(0, 500) : '',
    latitude: lat,
    longitude: lng,
    mapId: parseInt(mapId, 10) || 413,
    createdAt: new Date().toISOString()
  };
  profile.customMarkers = profile.customMarkers || [];
  profile.customMarkers.push(marker);
  queueSaveProfilesData(store);
  res.status(201).json(marker);
});

app.delete('/api/profiles/:id/custom-markers/:markerId', writeLimiter, (req, res) => {
  const store = getProfilesData();
  const profile = store.profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  profile.customMarkers = (profile.customMarkers || []).filter(m => m.id !== req.params.markerId);
  queueSaveProfilesData(store);
  res.json({ success: true });
});

// Export & Import Backup
app.get('/api/backup/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="elden_ring_map_backup.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(getProfilesData(), null, 2));
});

app.post('/api/backup/import', importLimiter, (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object' || !Array.isArray(data.profiles) || data.profiles.length === 0) {
    return res.status(400).json({ error: 'Invalid backup format. Expected { profiles: [...] }' });
  }

  const validatedProfiles = [];
  for (const profile of data.profiles) {
    if (!profile.id || typeof profile.id !== 'string') {
      return res.status(400).json({ error: 'Each profile must have a valid string id' });
    }
    if (!profile.name || typeof profile.name !== 'string') {
      return res.status(400).json({ error: 'Each profile must have a valid string name' });
    }
    const cleanCompleted = Array.isArray(profile.completedLocationIds)
      ? profile.completedLocationIds.map(n => parseInt(n, 10)).filter(n => !isNaN(n))
      : [];
    const cleanCustom = Array.isArray(profile.customMarkers)
      ? profile.customMarkers.filter(m => m && typeof m.id === 'string' && !isNaN(m.latitude) && !isNaN(m.longitude))
      : [];

    validatedProfiles.push({
      id: profile.id,
      name: profile.name.slice(0, 50),
      createdAt: profile.createdAt || new Date().toISOString(),
      completedLocationIds: cleanCompleted,
      customMarkers: cleanCustom
    });
  }

  const activeProfileId = (data.activeProfileId && validatedProfiles.find(p => p.id === data.activeProfileId))
    ? data.activeProfileId
    : validatedProfiles[0].id;

  const newStore = {
    activeProfileId,
    profiles: validatedProfiles
  };

  queueSaveProfilesData(newStore);
  flushProfilesToDisk();
  res.json({ success: true, count: validatedProfiles.length, store: newStore });
});

// --- RAW PAYLOAD INGESTION ---
app.post('/api/import-payload', importLimiter, (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'No valid JSON payload provided' });
  }

  try {
    if (payload.maps && Array.isArray(payload.maps) && payload.game_index_logo_filter !== undefined) {
      if (!payload.maps.every(m => m.id && m.title)) {
        return res.status(400).json({ error: 'Invalid game metadata: each map must have id and title' });
      }
      fs.writeFileSync(path.join(DATA_DIR, 'game_111_full.json'), JSON.stringify(payload, null, 2));
      loadData();
      return res.json({ success: true, type: 'game_metadata', mapsCount: payload.maps.length });
    } else if (payload.locations && Array.isArray(payload.locations) && payload.map && payload.map.id) {
      const mapId = parseInt(payload.map.id, 10);
      const VALID_MAP_IDS = { 413: 'map_413_the_lands_between.json', 638: 'map_638_realm_of_shadow.json' };
      const fileName = VALID_MAP_IDS[mapId];
      if (!fileName) {
        return res.status(400).json({ error: `Unknown map ID: ${mapId}. Expected 413 or 638.` });
      }
      fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(payload, null, 2));
      loadData();
      return res.json({
        success: true,
        type: 'map_data',
        mapTitle: payload.map.title,
        locationsCount: payload.locations.length
      });
    } else {
      return res.status(400).json({
        error: 'Unrecognized payload structure. Expected /games/111/full or /maps/:id/data JSON.'
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to write payload: ' + err.message });
  }
});

// --- TRIGGER LIVE SYNC ---
app.post('/api/sync-live', importLimiter, async (req, res) => {
  try {
    const { runSync } = require('./scripts/sync');
    await runSync();
    loadData();
    res.json({ success: true, message: 'Sync completed successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
  const dataLoaded = !!gameMetadata && Object.keys(mapDataCache).length > 0;
  res.json({
    status: dataLoaded ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    mapsLoaded: Object.keys(mapDataCache).length,
    dataLoaded
  });
});

// --- CENTRAL ERROR HANDLER ---
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: 'Internal Server Error' });
});

// --- START SERVER & GRACEFUL SHUTDOWN ---
const server = app.listen(PORT, () => {
  console.log(`[Elden Ring Map Server] Running at http://localhost:${PORT}`);
});

async function handleShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);
  server.close(async () => {
    console.log('[Server] HTTP connections closed.');
    if (writeDebounceTimer) {
      clearTimeout(writeDebounceTimer);
    }
    await flushProfilesToDisk();
    console.log('[Server] Profiles successfully flushed to disk. Exiting.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[Server] Shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
