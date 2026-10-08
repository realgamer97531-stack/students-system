// عناوين تطبيق الكول سنتر. لو أي عنوان اتغير، غيّره هنا بس.
class AppConfig {
  // سيستم الكول سنتر (نفس الموقع اللي بيتفتح من الكمبيوتر)
  static const callCenterUrl = String.fromEnvironment('CALLCENTER_URL', defaultValue: 'https://callcenter-system-production.up.railway.app');

  // مكان نشر تحديثات التطبيق (ملفات APK)
  static const releasesOwner = 'realgamer97531-stack';
  static const releasesRepo = 'callcenter-mobile-releases';

  static const appName = 'Shady Elsharkawy — Call Center';
}
