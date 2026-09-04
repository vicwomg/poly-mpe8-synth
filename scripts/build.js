// scripts/build.js - Zero-dependency build script for Capacitor distribution
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'www');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

console.log('Building web bundle into www/ ...');

// Clean www directory
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

// Copy essential directories and files
const itemsToCopy = ['index.html', 'midisteel_settings.html', 'css', 'js', 'assets'];

for (const item of itemsToCopy) {
  const srcPath = path.join(rootDir, item);
  const destPath = path.join(outDir, item);
  if (fs.existsSync(srcPath)) {
    copyRecursive(srcPath, destPath);
    console.log(`  ✓ Copied ${item}`);
  }
}

// Ensure midisteel-bridge.js script tag is present in destination midisteel_settings.html
const destSettingsPath = path.join(outDir, 'midisteel_settings.html');
if (fs.existsSync(destSettingsPath)) {
  let content = fs.readFileSync(destSettingsPath, 'utf8');
  if (!content.includes('midisteel-bridge.js')) {
    content = content.replace('</head>', '  <script src="js/midisteel-bridge.js"></script>\n</head>');
    fs.writeFileSync(destSettingsPath, content, 'utf8');
    console.log('  ✓ Injected midisteel-bridge.js into www/midisteel_settings.html');
  }
}

console.log('✓ Build completed successfully.');
