/**
 * Expo config plugin — injects PrivacyInfo.xcprivacy into the iOS build.
 *
 * Required for App Store submission since Xcode 15 / May 2024.
 * Declares the required API types used by this app's dependencies and
 * the data types the app collects.
 *
 * Docs: https://developer.apple.com/documentation/bundleresources/privacy_manifest_files
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PRIVACY_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Required API reasons (https://developer.apple.com/documentation/bundleresources/privacy_manifest_files/describing_use_of_required_reason_api) -->
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <!-- AsyncStorage / expo-sqlite read/write timestamps -->
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>C617.1</string>
      </array>
    </dict>
    <!-- AsyncStorage uses UserDefaults -->
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>CA92.1</string>
      </array>
    </dict>
    <!-- expo-sqlite disk space checks -->
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryDiskSpace</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>E174.1</string>
      </array>
    </dict>
  </array>

  <!-- Data types collected (https://developer.apple.com/app-store/app-privacy-details/) -->
  <key>NSPrivacyCollectedDataTypes</key>
  <array>
    <!-- Voice recordings sent to Whisper for transcription -->
    <dict>
      <key>NSPrivacyCollectedDataType</key>
      <string>NSPrivacyCollectedDataTypeAudioData</string>
      <key>NSPrivacyCollectedDataTypeLinked</key>
      <false/>
      <key>NSPrivacyCollectedDataTypeTracking</key>
      <false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array>
        <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
      </array>
    </dict>
    <!-- App usage analytics (session length, feature use) -->
    <dict>
      <key>NSPrivacyCollectedDataType</key>
      <string>NSPrivacyCollectedDataTypeOtherUsageData</string>
      <key>NSPrivacyCollectedDataTypeLinked</key>
      <false/>
      <key>NSPrivacyCollectedDataTypeTracking</key>
      <false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array>
        <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
        <string>NSPrivacyCollectedDataTypePurposeAnalytics</string>
      </array>
    </dict>
  </array>

  <key>NSPrivacyTracking</key>
  <false/>
  <key>NSPrivacyTrackingDomains</key>
  <array/>
</dict>
</plist>`;

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withPrivacyManifest(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const iosDir = path.join(cfg.modRequest.platformProjectRoot);
      const projectName = cfg.modRequest.projectName;
      const targetDir = path.join(iosDir, projectName);
      if (fs.existsSync(targetDir)) {
        fs.writeFileSync(path.join(targetDir, 'PrivacyInfo.xcprivacy'), PRIVACY_MANIFEST, 'utf8');
      } else {
        // fallback: write to ios/ root
        fs.writeFileSync(path.join(iosDir, 'PrivacyInfo.xcprivacy'), PRIVACY_MANIFEST, 'utf8');
      }
      return cfg;
    },
  ]);
};
