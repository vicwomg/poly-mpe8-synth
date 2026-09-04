// scripts/build-ipa.js - Automates building and packaging the iOS App.ipa
import { execSync } from 'child_process';
import fs from 'fs';

console.log('Compiling iOS App and packaging IPA ...');
try {
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
  
  if (fs.existsSync('App.ipa')) fs.unlinkSync('App.ipa');
  execSync('zip -qr App.ipa Payload');

  // Clean up temporary files
  fs.rmSync('Payload', { recursive: true, force: true });
  fs.rmSync('.derivedData', { recursive: true, force: true });

  console.log('\n✓ IPA successfully built: ./App.ipa');
} catch (err) {
  console.error('\n✗ Failed to build IPA:', err.message);
  if (fs.existsSync('Payload')) fs.rmSync('Payload', { recursive: true, force: true });
  if (fs.existsSync('.derivedData')) fs.rmSync('.derivedData', { recursive: true, force: true });
  process.exit(1);
}
