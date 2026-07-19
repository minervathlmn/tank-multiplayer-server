// (If this ever grows into more files or the two repos merge, an npm/yarn workspace with a real tank-shared package is the "grown-up" version of this same idea — but for two files, the copy script is proportionate.)

const fs = require('fs');
const path = require('path');

const CLIENT_DIR = path.resolve(__dirname, '../../website-astro/public/projects/tank/shared');
const SHARED_FILES = [
  'shared/constants.js',
];

fs.mkdirSync(CLIENT_DIR, { recursive: true });

for (const relPath of SHARED_FILES) {
  const src = path.resolve(__dirname, '..', relPath);
  const dest = path.join(CLIENT_DIR, path.basename(relPath));

  const header = `// AUTO-SYNCED from server ${relPath} on ${new Date().toISOString()} — do not edit directly\n`;
  const content = fs.readFileSync(src, 'utf8');

  fs.writeFileSync(dest, header + content);
  console.log(`synced ${relPath} -> ${dest}`);
}