const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

async function testDomUI() {
  console.log('=== RUNNING JSDOM MAPGENIE FRONTEND UI TEST ===\n');
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

  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf-8');
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000',
    runScripts: 'dangerously',
    resources: 'usable'
  });

  const { document } = dom.window;

  // Verify MapGenie core elements
  assert(document.querySelector('.mg-main-title')?.textContent === 'ELDEN RING MAP', 'Main title is "ELDEN RING MAP"');
  assert(document.querySelector('.mg-sub-title')?.textContent === 'ELDEN RING INTERACTIVE MAP', 'Subtitle is "ELDEN RING INTERACTIVE MAP"');
  assert(document.getElementById('map') !== null, 'Fullscreen map canvas exists');
  assert(document.getElementById('mg-sidebar') !== null, 'MapGenie floating sidebar exists');
  assert(document.getElementById('btn-toggle-sidebar') !== null, 'Sidebar collapse tab exists');
  assert(document.getElementById('btn-open-settings') !== null, 'Settings button exists');
  assert(document.querySelectorAll('.mg-map-tab').length === 2, '2 Map switcher tabs (Lands Between & Realm of Shadow)');
  assert(document.getElementById('btn-toggle-regions') !== null, 'SHOW REGIONS button exists');
  assert(document.getElementById('btn-select-all')?.textContent === 'SHOW ALL', 'SHOW ALL button exists');
  assert(document.getElementById('btn-deselect-all')?.textContent === 'HIDE ALL', 'HIDE ALL button exists');
  assert(document.getElementById('search-input') !== null, 'Search input exists');
  assert(document.getElementById('btn-search-submit')?.textContent === 'SEARCH', 'SEARCH button exists');
  assert(document.querySelector('.mg-tip')?.textContent.includes('Right click the map'), 'Tip text matches MapGenie');
  assert(document.getElementById('category-groups-list') !== null, 'Category groups container exists');
  assert(document.getElementById('btn-fullscreen') !== null, 'Floating fullscreen button exists');
  assert(document.getElementById('btn-zoom-in') !== null, 'Floating zoom in button exists');
  assert(document.getElementById('btn-zoom-out') !== null, 'Floating zoom out button exists');
  assert(document.getElementById('btn-custom-pin-mode') !== null, 'Floating custom pin button exists');

  // Test Sidebar Toggle
  const sidebar = document.getElementById('mg-sidebar');
  sidebar.classList.add('collapsed');
  assert(sidebar.classList.contains('collapsed'), 'Sidebar can collapse');
  sidebar.classList.remove('collapsed');
  assert(!sidebar.classList.contains('collapsed'), 'Sidebar can expand');

  console.log(`\n================================`);
  console.log(`MAPGENIE UI DOM TESTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`================================`);
}

testDomUI();
