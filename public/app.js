// === ELDEN RING MAP CLIENT APPLICATION (MAPGENIE UI ENGINE) ===

const MAPGENIE_BOUNDS = [-1.4, 0, 0, 1.4];

const state = {
  activeMapId: 413,
  activeMapSlug: 'the-lands-between',
  mapMetadata: null,
  mapConfig: null,
  groups: [],
  categories: [],
  categoriesById: {},
  regions: [],
  regionsById: {},
  locations: [],
  locationsById: {},
  locationsByCategory: new Map(), // category_id -> Location[]
  activeCategoryIds: new Set(),
  selectedRegionId: 'all',
  searchQuery: '',
  filterFoundState: 'all', // 'all', 'unfound', 'found'
  profilesData: { activeProfileId: 'slot_1', profiles: [] },
  activeProfile: null,
  map: null,
  markersMap: new Map(), // locationId -> maplibregl.Marker
  customMarkersMap: new Map(), // markerId -> maplibregl.Marker
  pendingCustomPinCoords: null,
  pendingBatchAction: null
};

// --- UTILITIES ---
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setupSettingsAndModals();
  await loadProfiles();
  await switchMap(413, 'the-lands-between');
});

// --- MAPLIBRE SETUP & SWITCHER ---
function initOrUpdateMap(startLng, startLat, initialZoom) {
  if (!state.map) {
    state.map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {
          'elden-tiles': {
            type: 'raster',
            tiles: [`/api/tiles/${state.activeMapSlug}/{z}/{x}/{y}.jpg`],
            tileSize: 256,
            bounds: MAPGENIE_BOUNDS
          }
        },
        layers: [
          {
            id: 'elden-tiles-layer',
            type: 'raster',
            source: 'elden-tiles',
            minzoom: 0,
            maxzoom: 18
          }
        ]
      },
      center: [startLng, startLat],
      zoom: initialZoom,
      minZoom: 9,
      maxZoom: 17,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: false,
      attributionControl: false
    });

    state.map.on('mousemove', (e) => {
      const lat = e.lngLat.lat.toFixed(4);
      const lng = e.lngLat.lng.toFixed(4);
      const z = state.map.getZoom().toFixed(1);
      const hud = document.getElementById('hud-coords');
      if (hud) hud.textContent = `Zoom: ${z} | Lat: ${lat}, Lng: ${lng}`;
    });

    // Right-click map to place custom pin
    state.map.on('contextmenu', (e) => {
      openCustomMarkerModal(e.lngLat.lat, e.lngLat.lng);
    });
  } else {
    // Switch tile source
    if (state.map.getSource('elden-tiles')) {
      state.map.removeLayer('elden-tiles-layer');
      state.map.removeSource('elden-tiles');
    }

    state.map.addSource('elden-tiles', {
      type: 'raster',
      tiles: [`/api/tiles/${state.activeMapSlug}/{z}/{x}/{y}.jpg`],
      tileSize: 256,
      bounds: MAPGENIE_BOUNDS
    });

    state.map.addLayer({
      id: 'elden-tiles-layer',
      type: 'raster',
      source: 'elden-tiles',
      minzoom: 0,
      maxzoom: 18
    });

    state.map.jumpTo({
      center: [startLng, startLat],
      zoom: initialZoom
    });
  }
}

// --- PROFILES MANAGEMENT ---
async function loadProfiles() {
  try {
    const res = await fetch('/api/profiles');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.profilesData = await res.json();
    updateProfileUI();
  } catch (err) {
    console.error('Failed to load profiles:', err);
    showToast('Failed to load character profiles');
  }
}

function updateProfileUI() {
  state.activeProfile = state.profilesData?.profiles?.find(p => p.id === state.profilesData.activeProfileId) 
    || state.profilesData?.profiles?.[0] 
    || { id: 'slot_1', name: 'Tarnished (Slot 1)', completedLocationIds: [], customMarkers: [] };

  const charNameEl = document.getElementById('edit-profile-name');
  if (charNameEl) charNameEl.value = state.activeProfile.name || '';

  renderProfileSwitcher();
  updateProgressStats();
}

function updateProgressStats() {
  if (!state.activeProfile) return;

  const completedSet = new Set(state.activeProfile.completedLocationIds || []);
  const total = state.locations.length;
  
  let completedCurrentMap = 0;
  state.locations.forEach(loc => {
    if (completedSet.has(loc.id)) completedCurrentMap++;
  });

  const percent = total > 0 ? Math.round((completedCurrentMap / total) * 100) : 0;
  
  const stats = document.getElementById('progress-stats');
  if (stats) stats.textContent = `${completedCurrentMap} / ${total} (${percent}%)`;

  const bar = document.getElementById('progress-bar-fill');
  if (bar) bar.style.width = `${percent}%`;
}

// --- SWITCH ACTIVE MAP ---
async function switchMap(mapId, mapSlug) {
  state.activeMapId = mapId;
  state.activeMapSlug = mapSlug;

  // Clear existing markers
  state.markersMap.forEach(marker => marker.remove());
  state.markersMap.clear();

  state.customMarkersMap.forEach(marker => marker.remove());
  state.customMarkersMap.clear();

  // Update tabs UI
  document.querySelectorAll('.mg-map-tab').forEach(tab => {
    tab.classList.toggle('active', parseInt(tab.dataset.mapId, 10) === mapId);
  });

  try {
    const res = await fetch(`/api/maps/${mapId}/data`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    state.mapMetadata = data.map;
    state.mapConfig = data.mapConfig;
    state.groups = data.groups || [];
    state.categories = data.categories || [];
    state.regions = data.regions || [];
    state.locations = data.locations || [];

    // Group Colors
    const GROUP_COLOR_FALLBACKS = {
      1110: '#34362C', // Locations
      1111: '#582359', // Key Items
      1112: '#1F526B', // Items
      1113: '#39634A', // Equipment
      1114: '#428C7F', // NPC's
      1115: '#631813', // Enemies
      1116: '#807358', // Materials
      1117: '#5C5A5A'  // Other
    };

    const groupColors = {};
    state.groups.forEach(g => {
      let c = g.color;
      if (c && !c.startsWith('#')) c = '#' + c;
      groupColors[g.id] = c || GROUP_COLOR_FALLBACKS[g.id] || '#5C5A5A';
    });

    state.categoriesById = {};
    state.categories.forEach(c => {
      let hex = c.color;
      if (hex && !hex.startsWith('#')) hex = '#' + hex;
      c.color = hex || groupColors[c.group_id] || '#5C5A5A';
      state.categoriesById[c.id] = c;
    });

    state.groups.forEach(g => {
      g.categories?.forEach(c => {
        let hex = c.color;
        if (hex && !hex.startsWith('#')) hex = '#' + hex;
        c.color = hex || groupColors[g.id] || '#5C5A5A';
        if (!state.categoriesById[c.id]) {
          state.categoriesById[c.id] = c;
          state.categories.push(c);
        }
      });
    });

    state.regionsById = {};
    state.regions.forEach(r => state.regionsById[r.id] = r);

    state.locationsById = {};
    state.locationsByCategory = new Map();
    state.locations.forEach(l => {
      state.locationsById[l.id] = l;
      if (!state.locationsByCategory.has(l.category_id)) {
        state.locationsByCategory.set(l.category_id, []);
      }
      state.locationsByCategory.get(l.category_id).push(l);
    });

    // Default: all categories active (show all items by default)
    state.activeCategoryIds = new Set();
    state.categories.forEach(c => state.activeCategoryIds.add(c.id));
    state.groups.forEach(g => {
      g.categories?.forEach(c => state.activeCategoryIds.add(c.id));
    });
    state.locations.forEach(l => {
      state.activeCategoryIds.add(l.category_id);
    });
    state.selectedRegionId = 'all';
    state.filterFoundState = 'all';
    state.searchQuery = '';

    // Coordinates setup
    const startLat = (data.mapConfig && data.mapConfig.start_lat) || 0.6567;
    const startLng = (data.mapConfig && data.mapConfig.start_lng) || -0.7623;
    const initialZoom = (data.mapConfig && data.mapConfig.initial_zoom ? data.mapConfig.initial_zoom - 1 : 12);

    initOrUpdateMap(startLng, startLat, initialZoom);

    // Populate MapGenie UI
    renderRegionSelect();
    renderCategoriesSidebar();
    renderMarkers();
    renderCustomMarkers();
    updateProgressStats();
    updateProfileUI();
    showToast(`Loaded ${data.locations.length} locations for ${data.map.title}`);
  } catch (err) {
    console.error('Failed to load map data:', err);
    showToast('Failed to load map data. Please check server.');
  }
}

// --- RENDER REGIONS SELECT ---
function renderRegionSelect() {
  const select = document.getElementById('region-select');
  if (!select) return;
  select.innerHTML = '<option value="all">All Regions (Full Map)</option>';

  const sortedRegions = [...state.regions].sort((a, b) => a.title.localeCompare(b.title));
  sortedRegions.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.title;
    select.appendChild(opt);
  });
}

// --- RENDER CATEGORIES 2-COLUMN GRID (MAPGENIE STYLE) ---
function renderCategoriesSidebar() {
  const container = document.getElementById('category-groups-list');
  if (!container) return;
  container.innerHTML = '';

  const completedSet = new Set(state.activeProfile?.completedLocationIds || []);

  state.groups.forEach(group => {
    if (!group.categories || group.categories.length === 0) return;

    // Filter categories that have locations on this map
    const activeCats = group.categories.filter(cat => {
      const locs = state.locationsByCategory.get(cat.id) || [];
      return locs.length > 0;
    });

    if (activeCats.length === 0) return;

    const groupBlock = document.createElement('div');
    groupBlock.className = 'mg-group-block';
    groupBlock.dataset.groupId = group.id;

    // Calculate group counts
    let groupTotal = 0;
    let groupCompleted = 0;

    activeCats.forEach(cat => {
      const catLocs = state.locationsByCategory.get(cat.id) || [];
      groupTotal += catLocs.length;
      catLocs.forEach(l => {
        if (completedSet.has(l.id)) groupCompleted++;
      });
    });

    // Group Header Title
    const header = document.createElement('div');
    header.className = 'mg-group-title';
    header.dataset.groupId = group.id;
    header.title = `Click to toggle all in ${group.title}`;
    header.innerHTML = `
      <span>${escapeHtml(group.title.toUpperCase())}</span>
      <span class="mg-group-count">${groupCompleted}/${groupTotal}</span>
    `;

    header.addEventListener('click', () => {
      toggleWholeGroup(group.id);
    });

    // 2-Column Grid of Categories
    const grid = document.createElement('div');
    grid.className = 'mg-category-grid';

    activeCats.forEach(cat => {
      const catLocs = state.locationsByCategory.get(cat.id) || [];
      const catTotal = catLocs.length;
      let catFound = 0;
      catLocs.forEach(l => {
        if (completedSet.has(l.id)) catFound++;
      });

      const isCatActive = state.activeCategoryIds.has(cat.id);
      const iconSlug = cat.icon || 'star';

      const row = document.createElement('div');
      row.className = `mg-cat-row${isCatActive ? '' : ' inactive'}`;
      row.dataset.catId = cat.id;

      row.innerHTML = `
        <div class="mg-cat-left">
          <span class="mg-cat-icon"><i class="icon-${iconSlug}"></i></span>
          <span class="mg-cat-name" title="${escapeHtml(cat.title)}">${escapeHtml(cat.title.toUpperCase())}</span>
        </div>
        <div class="mg-cat-right">
          <button type="button" class="mg-cat-only-btn" title="Show only ${escapeHtml(cat.title)}">ONLY</button>
          <span class="mg-cat-count ${catFound === catTotal ? 'complete' : ''}" data-cat-id="${cat.id}">${catTotal}</span>
        </div>
      `;

      // Toggle category active state on row click
      row.addEventListener('click', (e) => {
        if (e.target.closest('.mg-cat-only-btn')) {
          e.stopPropagation();
          soloCategory(cat.id);
          return;
        }

        const nowActive = !state.activeCategoryIds.has(cat.id);
        if (nowActive) {
          state.activeCategoryIds.add(cat.id);
          row.classList.remove('inactive');
        } else {
          state.activeCategoryIds.delete(cat.id);
          row.classList.add('inactive');
        }
        renderMarkers();
      });

      grid.appendChild(row);
    });

    groupBlock.appendChild(header);
    groupBlock.appendChild(grid);
    container.appendChild(groupBlock);
  });
}

function toggleWholeGroup(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group || !group.categories) return;

  // If all are active, turn off. Otherwise, turn all on.
  const allActive = group.categories.every(cat => state.activeCategoryIds.has(cat.id));
  const newActive = !allActive;

  group.categories.forEach(cat => {
    if (newActive) {
      state.activeCategoryIds.add(cat.id);
    } else {
      state.activeCategoryIds.delete(cat.id);
    }

    const row = document.querySelector(`.mg-cat-row[data-cat-id="${cat.id}"]`);
    if (row) {
      row.classList.toggle('inactive', !newActive);
    }
  });

  renderMarkers();
  showToast(`${newActive ? 'Showing' : 'Hiding'} all ${group.title}`);
}

function soloCategory(categoryId) {
  state.activeCategoryIds.clear();
  state.activeCategoryIds.add(categoryId);

  document.querySelectorAll('.mg-cat-row').forEach(row => {
    const cId = parseInt(row.dataset.catId, 10);
    row.classList.toggle('inactive', cId !== categoryId);
  });

  renderMarkers();
  const cat = state.categoriesById[categoryId];
  const count = (state.locationsByCategory.get(categoryId) || []).length;
  showToast(`Showing only: ${cat?.title || 'Category'} (${count} pins)`);
}

function updateCategoryCountsTargeted(categoryId) {
  const cat = state.categoriesById[categoryId];
  if (!cat) return;

  const completedSet = new Set(state.activeProfile?.completedLocationIds || []);
  const group = state.groups.find(g => g.id === cat.group_id);
  if (group) {
    let groupTotal = 0;
    let groupCompleted = 0;
    group.categories?.forEach(c => {
      const locs = state.locationsByCategory.get(c.id) || [];
      groupTotal += locs.length;
      locs.forEach(l => {
        if (completedSet.has(l.id)) groupCompleted++;
      });
    });

    const groupBlock = document.querySelector(`.mg-group-block[data-group-id="${group.id}"]`);
    const groupBadge = groupBlock?.querySelector('.mg-group-count');
    if (groupBadge) {
      groupBadge.textContent = `${groupCompleted}/${groupTotal}`;
    }
  }
}

// --- RENDER MARKERS ON MAPLIBRE ---
function renderMarkers() {
  if (!state.map) return;

  const completedSet = new Set(state.activeProfile?.completedLocationIds || []);
  const query = state.searchQuery.trim().toLowerCase();
  const regionId = state.selectedRegionId === 'all' ? null : parseInt(state.selectedRegionId, 10);

  state.locations.forEach(loc => {
    const isCatActive = state.activeCategoryIds.has(loc.category_id);
    const isRegActive = !regionId || loc.region_id === regionId;

    let isSearchActive = true;
    if (query) {
      const matchTitle = (loc.title || '').toLowerCase().includes(query);
      const matchDesc = (loc.description || '').toLowerCase().includes(query);
      isSearchActive = matchTitle || matchDesc;
    }

    const isCompleted = completedSet.has(loc.id);
    let isFoundStateActive = true;
    if (state.filterFoundState === 'unfound' && isCompleted) isFoundStateActive = false;
    if (state.filterFoundState === 'found' && !isCompleted) isFoundStateActive = false;

    const lat = parseFloat(loc.latitude);
    const lng = parseFloat(loc.longitude);
    if (isNaN(lat) || isNaN(lng)) return;

    const shouldShow = isCatActive && isRegActive && isSearchActive && isFoundStateActive;

    if (state.markersMap.has(loc.id)) {
      const marker = state.markersMap.get(loc.id);
      const wrapEl = marker.getElement();
      wrapEl.style.display = shouldShow ? '' : 'none';
      if (shouldShow) {
        wrapEl.classList.toggle('completed', isCompleted);
      }
    } else if (shouldShow) {
      const cat = state.categoriesById[loc.category_id] || {};
      const iconSlug = cat.icon || 'star';
      const pinColor = cat.color || '#5C5A5A';
      const isGreatBoss = iconSlug === 'demigod' || iconSlug === 'great_boss';
      const isGrace = iconSlug === 'site_of_grace';

      let extraClass = '';
      if (isCompleted) extraClass += ' completed';
      if (isGreatBoss) extraClass += ' great-boss';
      if (isGrace) extraClass += ' site-of-grace';

      const wrap = document.createElement('div');
      wrap.className = `custom-pin-wrap${extraClass}`;
      wrap.style.setProperty('--pin-color', pinColor);
      wrap.dataset.locId = loc.id;
      wrap.innerHTML = `
        <div class="mapgenie-pin">
          <svg class="pin-marker-svg" viewBox="0 0 28 38" width="28" height="38">
            <path d="M14 0 C6.27 0 0 6.27 0 14 C0 24.5 14 38 14 38 C14 38 28 24.5 28 14 C28 6.27 21.73 0 14 0 Z" fill="${pinColor}" stroke="rgba(0,0,0,0.3)" stroke-width="0.75"/>
          </svg>
          <div class="pin-icon-inner">
            <i class="icon-${iconSlug}"></i>
          </div>
        </div>
        <div class="pin-hover-tooltip">${escapeHtml(loc.title || '')}</div>
      `;

      const popup = new maplibregl.Popup({
        offset: [0, -36],
        closeButton: true,
        closeOnClick: true,
        maxWidth: '340px'
      });

      const marker = new maplibregl.Marker({
        element: wrap,
        anchor: 'bottom'
      })
        .setLngLat([lng, lat])
        .addTo(state.map);

      wrap.addEventListener('click', (e) => {
        e.stopPropagation();
        const isNowCompleted = (state.activeProfile?.completedLocationIds || []).includes(loc.id);
        popup.setDOMContent(createPopupContent(loc, isNowCompleted));
        popup.setLngLat([lng, lat]).addTo(state.map);
      });

      state.markersMap.set(loc.id, marker);
    }
  });
}

// --- USER CUSTOM MARKERS RENDERING ---
function renderCustomMarkers() {
  if (!state.map) return;

  state.customMarkersMap.forEach(m => m.remove());
  state.customMarkersMap.clear();

  const customList = state.activeProfile?.customMarkers || [];
  customList.forEach(m => {
    if (m.mapId && m.mapId !== state.activeMapId) return;

    const wrap = document.createElement('div');
    wrap.className = 'custom-pin-wrap user-custom-pin';
    wrap.style.setProperty('--pin-color', '#f3d489');
    wrap.innerHTML = `
      <div class="mapgenie-pin">
        <svg class="pin-marker-svg" viewBox="0 0 28 38" width="28" height="38">
          <path d="M14 0 C6.27 0 0 6.27 0 14 C0 24.5 14 38 14 38 C14 38 28 24.5 28 14 C28 6.27 21.73 0 14 0 Z" fill="#f3d489" stroke="#8c6e33" stroke-width="1.2"/>
        </svg>
        <div class="pin-icon-inner">
          <i class="icon-star" style="color:#2b200b !important;"></i>
        </div>
      </div>
      <div class="pin-hover-tooltip">★ ${escapeHtml(m.title)}</div>
    `;

    const popup = new maplibregl.Popup({
      offset: [0, -36],
      closeButton: true,
      closeOnClick: true,
      maxWidth: '320px'
    });

    const marker = new maplibregl.Marker({
      element: wrap,
      anchor: 'bottom'
    })
      .setLngLat([m.longitude, m.latitude])
      .addTo(state.map);

    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      const div = document.createElement('div');
      div.className = 'pin-popup-card';
      div.innerHTML = `
        <div class="popup-header">
          <div class="popup-badges">
            <span class="popup-cat-badge" style="background: rgba(243, 212, 137, 0.25); color: #f3d489;">★ Personal Custom Pin</span>
          </div>
          <h4 class="popup-title">${escapeHtml(m.title)}</h4>
        </div>
        <div class="popup-desc">${escapeHtml(m.description || 'No note details.')}</div>
        <div style="font-size:10px; color:var(--mg-text-muted); margin-top:4px;">Lat: ${m.latitude.toFixed(4)}, Lng: ${m.longitude.toFixed(4)}</div>
        <button class="danger-btn delete-custom-marker-btn" style="margin-top:8px; padding:6px 12px; font-size:11px;">
          Delete Custom Pin
        </button>
      `;

      div.querySelector('.delete-custom-marker-btn')?.addEventListener('click', async () => {
        await deleteCustomMarker(m.id);
        popup.remove();
      });

      popup.setDOMContent(div);
      popup.setLngLat([m.longitude, m.latitude]).addTo(state.map);
    });

    state.customMarkersMap.set(m.id, marker);
  });
}

// --- POPUP HTML GENERATOR ---
function createPopupContent(loc, isCompleted) {
  const cat = state.categoriesById[loc.category_id] || { title: 'Unknown' };
  const reg = state.regionsById[loc.region_id] || { title: 'The Lands Between' };

  let cleanDesc = (loc.description || 'No additional description.')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n- /g, '<br>• ')
    .replace(/\n/g, '<br>');

  let imageHtml = '';
  if (loc.media && loc.media.length > 0) {
    const firstImg = loc.media[0];
    if (firstImg.url) {
      imageHtml = `<a href="${firstImg.url}" target="_blank"><img src="${firstImg.url}" class="popup-img-thumb" alt="Location preview" loading="lazy"></a>`;
    }
  }

  const div = document.createElement('div');
  div.className = 'pin-popup-card';
  div.innerHTML = `
    <div class="popup-header">
      <div class="popup-badges">
        <span class="popup-cat-badge">${cat.title}</span>
        <span class="popup-region-badge">${reg.title}</span>
      </div>
      <h4 class="popup-title">${escapeHtml(loc.title || 'Location')}</h4>
    </div>
    ${imageHtml}
    <div class="popup-desc">${cleanDesc}</div>
    <button class="popup-btn-toggle ${isCompleted ? 'completed' : ''}" data-loc-id="${loc.id}">
      <span class="check-icon">${isCompleted ? '✓ Marked Completed' : '○ Mark as Found'}</span>
    </button>
  `;

  const btn = div.querySelector('.popup-btn-toggle');
  btn.addEventListener('click', async () => {
    await toggleLocationFound(loc.id, loc.category_id);
  });

  return div;
}

// --- TOGGLE PIN FOUND STATE ---
async function toggleLocationFound(locationId, categoryId) {
  if (!state.activeProfile) return;

  try {
    const res = await fetch(`/api/profiles/${state.activeProfile.id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    const set = new Set(state.activeProfile.completedLocationIds || []);
    if (data.completed) {
      set.add(locationId);
      showToast('Marked as found');
    } else {
      set.delete(locationId);
      showToast('Unmarked location');
    }
    state.activeProfile.completedLocationIds = Array.from(set);

    updateProgressStats();
    if (categoryId) {
      updateCategoryCountsTargeted(categoryId);
    } else {
      renderCategoriesSidebar();
    }

    const marker = state.markersMap.get(locationId);
    if (marker) {
      const wrapEl = marker.getElement();
      wrapEl.classList.toggle('completed', data.completed);
      if (state.filterFoundState !== 'all') {
        const shouldShow = (state.filterFoundState === 'found' && data.completed) ||
                           (state.filterFoundState === 'unfound' && !data.completed);
        wrapEl.style.display = shouldShow ? '' : 'none';
      }
    }

    const openPopupBtn = document.querySelector(`.popup-btn-toggle[data-loc-id="${locationId}"]`);
    if (openPopupBtn) {
      openPopupBtn.classList.toggle('completed', data.completed);
      openPopupBtn.innerHTML = `<span>${data.completed ? '✓ Marked Completed' : '○ Mark as Found'}</span>`;
    }
  } catch (err) {
    console.error('Failed to toggle location:', err);
    showToast('Failed to save progress');
  }
}

// --- CUSTOM MARKERS MODAL & API ---
function openCustomMarkerModal(lat, lng) {
  state.pendingCustomPinCoords = { lat, lng };
  const titleInput = document.getElementById('custom-pin-title');
  const descInput = document.getElementById('custom-pin-desc');
  if (titleInput) titleInput.value = '';
  if (descInput) descInput.value = '';

  const modal = document.getElementById('custom-marker-modal');
  if (modal) {
    modal.style.display = 'flex';
    titleInput?.focus();
  }
}

async function createCustomMarker() {
  if (!state.pendingCustomPinCoords || !state.activeProfile) return;

  const titleInput = document.getElementById('custom-pin-title');
  const descInput = document.getElementById('custom-pin-desc');
  const title = titleInput?.value.trim() || 'Custom Pin';
  const description = descInput?.value.trim() || '';

  try {
    const res = await fetch(`/api/profiles/${state.activeProfile.id}/custom-markers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        latitude: state.pendingCustomPinCoords.lat,
        longitude: state.pendingCustomPinCoords.lng,
        mapId: state.activeMapId
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const newMarker = await res.json();
    state.activeProfile.customMarkers = state.activeProfile.customMarkers || [];
    state.activeProfile.customMarkers.push(newMarker);

    renderCustomMarkers();
    showToast(`Placed custom pin: ${title}`);
  } catch (err) {
    console.error('Failed to create custom marker:', err);
    showToast('Failed to save custom pin');
  } finally {
    state.pendingCustomPinCoords = null;
    const modal = document.getElementById('custom-marker-modal');
    if (modal) modal.style.display = 'none';
  }
}

async function deleteCustomMarker(markerId) {
  if (!state.activeProfile) return;

  try {
    const res = await fetch(`/api/profiles/${state.activeProfile.id}/custom-markers/${markerId}`, {
      method: 'DELETE'
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.activeProfile.customMarkers = (state.activeProfile.customMarkers || []).filter(m => m.id !== markerId);
    
    if (state.customMarkersMap.has(markerId)) {
      state.customMarkersMap.get(markerId).remove();
      state.customMarkersMap.delete(markerId);
    }
    showToast('Custom pin removed');
  } catch (err) {
    console.error('Failed to delete custom marker:', err);
    showToast('Failed to delete custom pin');
  }
}

// --- SEARCH RESULTS & FLY-TO ---
function renderSearchResults() {
  let dropdown = document.getElementById('search-results-dropdown');
  if (!dropdown) return;

  const query = state.searchQuery.trim().toLowerCase();
  if (!query || query.length < 2) {
    dropdown.style.display = 'none';
    return;
  }

  const results = state.locations.filter(loc => {
    const matchTitle = (loc.title || '').toLowerCase().includes(query);
    const matchDesc = (loc.description || '').toLowerCase().includes(query);
    return matchTitle || matchDesc;
  }).slice(0, 12);

  if (results.length === 0) {
    dropdown.innerHTML = '<div class="search-no-results">No results found</div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = results.map(loc => {
    const cat = state.categoriesById[loc.category_id] || { title: '?', icon: 'star' };
    const reg = state.regionsById[loc.region_id] || { title: '' };
    return `
      <div class="search-result-item" data-loc-id="${loc.id}">
        <div class="search-result-icon"><i class="icon-${cat.icon || 'star'}"></i></div>
        <div class="search-result-info">
          <span class="search-result-title">${escapeHtml(loc.title || 'Unknown')}</span>
          <span class="search-result-meta">${escapeHtml(cat.title)}${reg.title ? ' · ' + escapeHtml(reg.title) : ''}</span>
        </div>
      </div>
    `;
  }).join('');

  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const locId = parseInt(item.dataset.locId, 10);
      flyToLocation(locId);
      dropdown.style.display = 'none';
    });
  });
}

function flyToLocation(locationId) {
  const loc = state.locationsById[locationId];
  if (!loc || !state.map) return;

  const lat = parseFloat(loc.latitude);
  const lng = parseFloat(loc.longitude);
  if (isNaN(lat) || isNaN(lng)) return;

  let needsRender = false;

  if (!state.activeCategoryIds.has(loc.category_id)) {
    state.activeCategoryIds.add(loc.category_id);
    const row = document.querySelector(`.mg-cat-row[data-cat-id="${loc.category_id}"]`);
    if (row) row.classList.remove('inactive');
    needsRender = true;
  }

  if (state.selectedRegionId !== 'all' && loc.region_id !== parseInt(state.selectedRegionId, 10)) {
    state.selectedRegionId = 'all';
    const regSelect = document.getElementById('region-select');
    if (regSelect) regSelect.value = 'all';
    needsRender = true;
  }

  const completedSet = new Set(state.activeProfile?.completedLocationIds || []);
  const isCompleted = completedSet.has(locationId);
  if ((state.filterFoundState === 'unfound' && isCompleted) || (state.filterFoundState === 'found' && !isCompleted)) {
    state.filterFoundState = 'all';
    document.querySelectorAll('.mg-filter-pills .mg-filter-pill').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === 'all');
    });
    needsRender = true;
  }

  if (needsRender) {
    renderMarkers();
  }

  state.map.flyTo({
    center: [lng, lat],
    zoom: Math.max(state.map.getZoom(), 15),
    speed: 1.5,
    curve: 1.2
  });

  setTimeout(() => {
    const marker = state.markersMap.get(locationId);
    if (marker) {
      const el = marker.getElement();
      if (el) {
        el.classList.add('pulse-highlight');
        setTimeout(() => el.classList.remove('pulse-highlight'), 2000);
      }
      
      const popup = new maplibregl.Popup({
        offset: [0, -36],
        closeButton: true,
        closeOnClick: true,
        maxWidth: '340px'
      });
      popup.setDOMContent(createPopupContent(loc, isCompleted));
      popup.setLngLat([lng, lat]).addTo(state.map);
    }
  }, 700);
}

// --- EVENT LISTENERS ---
function setupEventListeners() {
  // Sidebar Collapse / Expand
  const toggleBtn = document.getElementById('btn-toggle-sidebar');
  const sidebar = document.getElementById('mg-sidebar');
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      setTimeout(() => state.map?.resize(), 260);
    });
  }

  // Map Switcher Tabs
  document.querySelectorAll('.mg-map-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const mapId = parseInt(tab.dataset.mapId, 10);
      const slug = tab.dataset.mapSlug;
      switchMap(mapId, slug);
    });
  });

  // Toggle Regions Panel
  const toggleRegionsBtn = document.getElementById('btn-toggle-regions');
  const regionsPanel = document.getElementById('regions-panel');
  toggleRegionsBtn?.addEventListener('click', () => {
    const isOpen = regionsPanel.style.display !== 'none';
    regionsPanel.style.display = isOpen ? 'none' : 'block';
  });

  const regSelect = document.getElementById('region-select');
  regSelect?.addEventListener('change', (e) => {
    state.selectedRegionId = e.target.value;
    renderMarkers();
  });

  // SHOW ALL / HIDE ALL
  document.getElementById('btn-select-all')?.addEventListener('click', () => {
    state.activeCategoryIds.clear();
    state.categories.forEach(c => state.activeCategoryIds.add(c.id));
    state.groups.forEach(g => {
      g.categories?.forEach(c => state.activeCategoryIds.add(c.id));
    });
    document.querySelectorAll('.mg-cat-row').forEach(row => row.classList.remove('inactive'));
    renderMarkers();
    showToast(`Showing all categories (${state.locations.length} pins)`);
  });

  document.getElementById('btn-deselect-all')?.addEventListener('click', () => {
    state.activeCategoryIds.clear();
    document.querySelectorAll('.mg-cat-row').forEach(row => row.classList.add('inactive'));
    renderMarkers();
    showToast('Hidden all categories (0 pins)');
  });

  // Search Input
  const searchInput = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  const debouncedSearch = debounce(() => {
    renderMarkers();
    renderSearchResults();
  }, 200);

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      if (clearBtn) clearBtn.style.display = state.searchQuery ? 'block' : 'none';
      debouncedSearch();
    });

    searchInput.addEventListener('blur', () => {
      setTimeout(() => {
        const dropdown = document.getElementById('search-results-dropdown');
        if (dropdown) dropdown.style.display = 'none';
      }, 250);
    });

    searchInput.addEventListener('focus', () => {
      if (state.searchQuery.trim()) renderSearchResults();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      state.searchQuery = '';
      clearBtn.style.display = 'none';
      renderMarkers();
      const dropdown = document.getElementById('search-results-dropdown');
      if (dropdown) dropdown.style.display = 'none';
    });
  }

  document.getElementById('btn-search-submit')?.addEventListener('click', () => {
    if (state.searchQuery.trim()) {
      renderSearchResults();
      const firstResult = document.querySelector('.search-result-item');
      if (firstResult) {
        const locId = parseInt(firstResult.dataset.locId, 10);
        flyToLocation(locId);
        const dropdown = document.getElementById('search-results-dropdown');
        if (dropdown) dropdown.style.display = 'none';
      }
    }
  });

  // Keyboard shortcut: "/" to focus search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput && !document.activeElement.matches('input, textarea')) {
      e.preventDefault();
      searchInput?.focus();
    }
  });

  // Found State Filters
  document.querySelectorAll('.mg-filter-pills .mg-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mg-filter-pills .mg-filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filterFoundState = btn.dataset.filter;
      renderMarkers();
    });
  });

  // Map Controls (Right Side)
  document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });

  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    state.map?.zoomIn();
  });

  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    state.map?.zoomOut();
  });

  document.getElementById('btn-custom-pin-mode')?.addEventListener('click', () => {
    if (state.map) {
      const center = state.map.getCenter();
      openCustomMarkerModal(center.lat, center.lng);
    }
  });
}

// --- SETTINGS & BACKUP MODAL SETUP ---
function setupSettingsAndModals() {
  const settingsModal = document.getElementById('settings-modal');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');

  btnOpenSettings?.addEventListener('click', () => {
    updateProfileUI();
    if (settingsModal) settingsModal.style.display = 'flex';
  });

  btnCloseSettings?.addEventListener('click', () => {
    if (settingsModal) settingsModal.style.display = 'none';
  });

  // Rename Character
  document.getElementById('btn-save-profile-name')?.addEventListener('click', async () => {
    const newName = document.getElementById('edit-profile-name')?.value.trim();
    if (!newName || !state.activeProfile) return;

    try {
      const res = await fetch(`/api/profiles/${state.activeProfile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.profilesData = await res.json();
      updateProfileUI();
      showToast(`Character renamed to ${newName}`);
    } catch (err) {
      showToast('Failed to rename character');
    }
  });

  // Delete Character
  document.getElementById('btn-delete-profile')?.addEventListener('click', async () => {
    if (!state.activeProfile) return;
    if (state.profilesData.profiles.length <= 1) {
      showToast('Cannot delete the only character profile');
      return;
    }
    if (!confirm(`Delete character "${state.activeProfile.name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/profiles/${state.activeProfile.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.profilesData = await res.json();
      updateProfileUI();
      renderMarkers();
      renderCustomMarkers();
      renderCategoriesSidebar();
      showToast('Character deleted');
      if (settingsModal) settingsModal.style.display = 'none';
    } catch (err) {
      showToast('Failed to delete character');
    }
  });

  // Reset Progress
  document.getElementById('btn-reset-character')?.addEventListener('click', async () => {
    if (!state.activeProfile) return;
    if (!confirm(`Reset all marked locations for "${state.activeProfile.name}"?`)) return;

    try {
      const res = await fetch(`/api/profiles/${state.activeProfile.id}/reset`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.activeProfile.completedLocationIds = [];
      updateProgressStats();
      renderCategoriesSidebar();
      renderMarkers();
      showToast('Progress reset successfully');
      if (settingsModal) settingsModal.style.display = 'none';
    } catch (err) {
      showToast('Failed to reset progress');
    }
  });

  // Export Backup
  document.getElementById('btn-export-backup')?.addEventListener('click', () => {
    window.location.href = '/api/backup/export';
    showToast('Downloading backup JSON...');
  });

  // Import Backup
  document.getElementById('import-backup-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const backupData = JSON.parse(evt.target.result);
        if (!backupData || !Array.isArray(backupData.profiles)) {
          throw new Error('Invalid backup schema');
        }

        const res = await fetch('/api/backup/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backupData)
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const resData = await res.json();
        state.profilesData = resData.store || backupData;
        updateProfileUI();
        renderMarkers();
        renderCustomMarkers();
        renderCategoriesSidebar();
        showToast(`Successfully restored ${backupData.profiles.length} profiles!`);
        if (settingsModal) settingsModal.style.display = 'none';
      } catch (err) {
        console.error('Import failed:', err);
        showToast('Backup import failed: ' + err.message);
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  });

  // Custom Marker Modal Controls
  document.getElementById('btn-close-custom-marker')?.addEventListener('click', () => {
    document.getElementById('custom-marker-modal').style.display = 'none';
  });
  document.getElementById('btn-cancel-custom-marker')?.addEventListener('click', () => {
    document.getElementById('custom-marker-modal').style.display = 'none';
  });
  document.getElementById('btn-confirm-custom-marker')?.addEventListener('click', createCustomMarker);
}

// --- PROFILE SWITCHER (in sidebar) ---
function renderProfileSwitcher() {
  const select = document.getElementById('profile-select');
  if (!select) return;

  const profiles = state.profilesData?.profiles || [];
  const activeId = state.profilesData?.activeProfileId;

  select.innerHTML = profiles.map(p => 
    `<option value="${p.id}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
  ).join('');

  select.onchange = async (e) => {
    const id = e.target.value;
    try {
      const res = await fetch('/api/profiles/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.profilesData = await res.json();
      updateProfileUI();
      renderMarkers();
      renderCustomMarkers();
      renderCategoriesSidebar();
      showToast(`Switched to ${state.activeProfile.name}`);
    } catch (err) {
      showToast('Failed to switch profile');
    }
  };

  const addBtn = document.getElementById('btn-add-profile');
  if (addBtn) {
    addBtn.onclick = async () => {
      const name = prompt('New character name:');
      if (!name?.trim()) return;
      try {
        const res = await fetch('/api/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.profilesData = await res.json();
        updateProfileUI();
        renderMarkers();
        renderCustomMarkers();
        renderCategoriesSidebar();
        showToast(`Created character: ${name.trim()}`);
      } catch (err) {
        showToast('Failed to create character');
      }
    };
  }
}

// --- TOAST NOTIFICATIONS ---
function showToast(msg) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}
