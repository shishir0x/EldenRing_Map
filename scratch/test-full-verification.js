const http = require('http');

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url, 'http://localhost:3000');
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    if (body && typeof body === 'object') {
      body = JSON.stringify(body);
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runTests() {
  console.log('=== STARTING FULL AUTOMATED VERIFICATION ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  try {
    // 1. Health check & CSP headers
    const health = await request('http://localhost:3000/health');
    assert(health.status === 200 && health.json?.status === 'ok', 'GET /health returns 200 with status ok');
    assert(health.headers['content-security-policy']?.includes('default-src'), 'Helmet CSP headers present');

    // 2. Maps summary
    const maps = await request('http://localhost:3000/api/maps');
    assert(maps.status === 200 && Array.isArray(maps.json?.maps) && maps.json.maps.length >= 2, 'GET /api/maps returns 2 maps');

    // 3. Map 413 and 638 full datasets
    const map413 = await request('http://localhost:3000/api/maps/413/data');
    assert(map413.status === 200 && map413.json?.locations?.length > 1000, `GET /api/maps/413/data returns ${map413.json?.locations?.length} locations`);

    const map638 = await request('http://localhost:3000/api/maps/638/data');
    assert(map638.status === 200 && map638.json?.locations?.length > 400, `GET /api/maps/638/data returns ${map638.json?.locations?.length} locations`);

    // 4. Profiles management
    const profiles = await request('http://localhost:3000/api/profiles');
    assert(profiles.status === 200 && Array.isArray(profiles.json?.profiles), 'GET /api/profiles returns profiles');
    const activeId = profiles.json.activeProfileId || profiles.json.profiles[0].id;

    // 5. Toggle location
    const testLocId = map413.json.locations[0].id;
    const toggle1 = await request(`http://localhost:3000/api/profiles/${activeId}/toggle`, { method: 'POST' }, { locationId: testLocId });
    assert(toggle1.status === 200 && toggle1.json?.locationId === testLocId, `POST /api/profiles/:id/toggle marked location ${testLocId}`);

    // Untoggle
    const toggle2 = await request(`http://localhost:3000/api/profiles/${activeId}/toggle`, { method: 'POST' }, { locationId: testLocId });
    assert(toggle2.status === 200 && toggle2.json?.completed === false, `POST /api/profiles/:id/toggle unmarked location ${testLocId}`);

    // 6. Batch operations
    const batchLocs = [map413.json.locations[1].id, map413.json.locations[2].id];
    const batchRes = await request(`http://localhost:3000/api/profiles/${activeId}/batch`, { method: 'POST' }, { locationIds: batchLocs, markAsCompleted: true });
    assert(batchRes.status === 200 && batchRes.json?.completedLocationIds?.includes(batchLocs[0]), 'POST /api/profiles/:id/batch marked locations');

    // 7. Custom markers CRUD
    const createMarker = await request(`http://localhost:3000/api/profiles/${activeId}/custom-markers`, { method: 'POST' }, {
      title: 'Test Cave Note',
      description: 'Find dragon smithing stone',
      latitude: 0.655,
      longitude: -0.762,
      mapId: 413
    });
    assert(createMarker.status === 201 && createMarker.json?.title === 'Test Cave Note', 'POST /api/profiles/:id/custom-markers created custom pin');
    const markerId = createMarker.json.id;

    const deleteMarker = await request(`http://localhost:3000/api/profiles/${activeId}/custom-markers/${markerId}`, { method: 'DELETE' });
    assert(deleteMarker.status === 200 && deleteMarker.json?.success === true, 'DELETE /api/profiles/:id/custom-markers/:markerId deleted custom pin');

    // 8. Backup Export & Import
    const exportRes = await request('http://localhost:3000/api/backup/export');
    assert(exportRes.status === 200 && exportRes.json?.profiles?.length > 0, 'GET /api/backup/export returns valid backup JSON');

    // Malformed backup rejection
    const badImport = await request('http://localhost:3000/api/backup/import', { method: 'POST' }, { malicious: 'data' });
    assert(badImport.status === 400, 'POST /api/backup/import rejects invalid format with 400');

    // Valid backup import
    const validImport = await request('http://localhost:3000/api/backup/import', { method: 'POST' }, exportRes.json);
    assert(validImport.status === 200 && validImport.json?.success === true, 'POST /api/backup/import successfully restores valid backup');

    // 9. Tile Proxy Security & Validation
    const invalidSlugTile = await request('http://localhost:3000/api/tiles/malicious-slug/13/4688/3180.jpg');
    assert(invalidSlugTile.status === 400, 'GET /api/tiles/:badSlug returns 400 (path traversal protection)');

    const badCoordTile = await request('http://localhost:3000/api/tiles/the-lands-between/abc/def/ghi.jpg');
    assert(badCoordTile.status === 400, 'GET /api/tiles non-integer coords return 400');

    console.log(`\n================================`);
    console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`================================`);
  } catch (err) {
    console.error('Fatal test error:', err);
  }
}

runTests();
