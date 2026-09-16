const fs = require('fs');
const path = require('path');
const https = require('https');

const FONTS_DIR = path.join(__dirname, '..', 'public', 'fonts');
const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
fs.mkdirSync(FONTS_DIR, { recursive: true });
fs.mkdirSync(CSS_DIR, { recursive: true });

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed ${url}: ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function run() {
  console.log('Downloading icon fonts...');
  await downloadFile('https://cdn.mapgenie.io/fonts/elden-ring/icons/icomoon.ttf?2z096z', path.join(FONTS_DIR, 'icomoon.ttf'));
  await downloadFile('https://cdn.mapgenie.io/fonts/elden-ring/icons/icomoon.woff?2z096z', path.join(FONTS_DIR, 'icomoon.woff'));
  
  // Download CSS and adjust font paths to local
  https.get('https://cdn.mapgenie.io/css/themes/icons/elden-ring-icons.css', { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      const fixedCss = d.replace(/url\(['"]?\.\.\/\.\.\/\.\.\/fonts\/elden-ring\/icons\/(icomoon\.[a-z0-9]+)(\?[^'"]*)?['"]?\)/g, "url('../fonts/$1')");
      fs.writeFileSync(path.join(CSS_DIR, 'elden-ring-icons.css'), fixedCss, 'utf-8');
      console.log('Icons CSS and fonts saved successfully!');
    });
  });
}

run();
