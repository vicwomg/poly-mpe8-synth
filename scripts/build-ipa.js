// scripts/build-ipa.js - Automates building and packaging the iOS App.ipa
import { execSync } from 'child_process';
import fs from 'fs';

console.log('Compiling iOS App and packaging IPA ...');
try {
  // 0. Ensure CoreMidiPlugin is registered in packageClassList of ios capacitor.config.json
  const capConfigPath = 'ios/App/App/capacitor.config.json';
  if (fs.existsSync(capConfigPath)) {
    const cfg = JSON.parse(fs.readFileSync(capConfigPath, 'utf8'));
    if (!cfg.packageClassList || !cfg.packageClassList.includes('CoreMidiPlugin')) {
      cfg.packageClassList = Array.from(new Set([...(cfg.packageClassList || []), 'CoreMidiPlugin']));
      fs.writeFileSync(capConfigPath, JSON.stringify(cfg, null, '\t'), 'utf8');
      console.log('✓ Injected CoreMidiPlugin into ios/App/App/capacitor.config.json');
    }
  }

  // 1. Compile iOS application without requiring signing certificates
  execSync(
    'xcodebuild -project ios/App/App.xcodeproj -scheme App -destination "generic/platform=iOS" -derivedDataPath .derivedData build CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO',
    { stdio: 'inherit' }
  );

  // 2. Package into IPA structure (Payload/App.app)
  if (fs.existsSync('Payload')) fs.rmSync('Payload', { recursive: true, force: true });
  fs.mkdirSync('Payload', { recursive: true });

  const appPath = '.derivedData/Build/Products/Debug-iphoneos/App.app';
  if (!fs.existsSync(appPath)) {
    throw new Error(`Could not find built App.app at ${appPath}`);
  }

  execSync(`cp -R "${appPath}" Payload/`);
  
  if (!fs.existsSync('builds')) fs.mkdirSync('builds', { recursive: true });
  if (fs.existsSync('builds/App.ipa')) fs.unlinkSync('builds/App.ipa');
  execSync('zip -qr builds/App.ipa Payload');

  // Clean up temporary files
  fs.rmSync('Payload', { recursive: true, force: true });
  // Retain .derivedData for inspection and fast incremental builds

  console.log('\n✓ IPA successfully built: ./builds/App.ipa');
} catch (err) {
  console.error('\n✗ Failed to build IPA:', err.message);
  if (fs.existsSync('Payload')) fs.rmSync('Payload', { recursive: true, force: true });
  if (fs.existsSync('.derivedData')) fs.rmSync('.derivedData', { recursive: true, force: true });
  process.exit(1);
}
