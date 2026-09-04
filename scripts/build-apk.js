// scripts/build-apk.js - Automates building and packaging the Android app-debug.apk
import { execSync } from 'child_process';
import fs from 'fs';

console.log('Compiling Android App and packaging APK ...');
try {
  const env = { ...process.env };
  if (!env.JAVA_HOME) {
    const studioJbr = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
    if (fs.existsSync(studioJbr)) {
      env.JAVA_HOME = studioJbr;
      env.PATH = `${studioJbr}/bin:${env.PATH}`;
    }
  }

  execSync('./android/gradlew -p android assembleDebug', {
    stdio: 'inherit',
    env
  });

  const apkSrc = 'android/app/build/outputs/apk/debug/app-debug.apk';
  if (!fs.existsSync(apkSrc)) {
    throw new Error(`Could not find built APK at ${apkSrc}`);
  }

  fs.copyFileSync(apkSrc, 'app-debug.apk');
  console.log('\n✓ APK successfully built: ./app-debug.apk');
} catch (err) {
  console.error('\n✗ Failed to build APK:', err.message);
  process.exit(1);
}
